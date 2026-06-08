const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onMessagePublished } = require('firebase-functions/v2/pubsub');

admin.initializeApp();
const db = admin.firestore();
const callableOpts = { cpu: 1, memory: '512MiB', timeoutSeconds: 60 };

// =========================================================================
// FUNCTION 1: SUBMIT SCORE & SOLVE TIES (Asynchronous Leaderboard Rule)
// =========================================================================
exports.submitTournamentScore = onCall(callableOpts, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const { tournamentId, finalScore } = request.data;
  
  const leaderboardRef = db.collection('tournament_leaderboards')
                           .where('tournament_id', '==', tournamentId)
                           .where('player_id', '==', uid)
                           .limit(1);

  const snapshot = await leaderboardRef.get();

  if (!snapshot.empty) {
    const existingDoc = snapshot.docs[0];
    const currentBest = existingDoc.data().highest_score;

    if (finalScore > currentBest) {
      await existingDoc.ref.update({
        highest_score: finalScore,
        achieved_at: admin.firestore.FieldValue.serverTimestamp()
      });
      return { status: 'new_personal_best', score: finalScore };
    }
    return { status: 'score_not_beaten', score: currentBest };
  } else {
    await db.collection('tournament_leaderboards').add({
      tournament_id: tournamentId,
      player_id: uid,
      highest_score: finalScore,
      achieved_at: admin.firestore.FieldValue.serverTimestamp()
    });
    return { status: 'first_score_posted', score: finalScore };
  }
});

// =========================================================================
// FUNCTION 2: FETCH LEADERBOARD WITH STRICT NO-TIE ORDERING
// =========================================================================
exports.getTournamentLeaderboard = onCall(callableOpts, async (request) => {
  const { tournamentId, limitAmount = 50 } = request.data;

  const leaderboardSnapshot = await db.collection('tournament_leaderboards')
    .where('tournament_id', '==', tournamentId)
    .orderBy('highest_score', 'desc')
    .orderBy('achieved_at', 'asc')
    .limit(limitAmount)
    .get();

  return leaderboardSnapshot.docs.map((doc, index) => ({
    rank: index + 1, ...doc.data()
  }));
});

// =========================================================================
// FUNCTION 3: 1V1 MATCHMAKING & AI COMPETITOR BACKUP
// =========================================================================
exports.matchMakeAndDeal = onCall(callableOpts, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const wager = request.data.wager || 2.50;
  const playMode = request.data.mode || 'multiplayer';
  const aiDifficulty = request.data.difficulty || 'medium';
  
  const queueRef = db.collection('matchmaking_queue');
  const gameRef = db.collection('games').doc();

  const deck = Array.from({ length: 28 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  if (playMode === 'ai_tournament') {
    let botName = 'Brickyard Grinder';
    if (aiDifficulty === 'easy') botName = 'Brickyard Rookie';
    if (aiDifficulty === 'hard') botName = 'The Dominator';

    const botId = `bot_${aiDifficulty}_${Math.floor(Math.random() * 1000)}`;

    await gameRef.set({
      players: [uid, botId],
      status: 'active',
      mode: 'ai_tournament',
      botProfile: { id: botId, name: botName, difficulty: aiDifficulty },
      hands: { [uid]: deck.slice(0, 7), [botId]: deck.slice(7, 14) },
      pot: wager * 2,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { status: 'matched', gameId: gameRef.id, isAI: true, opponentName: botName };
  }

  const snapshot = await queueRef.where('wager', '==', wager).limit(1).get();

  if (!snapshot.empty && snapshot.docs[0].id !== uid) {
    const opponentDoc = snapshot.docs[0];
    await db.runTransaction(async (t) => {
      t.set(gameRef, {
        players: [uid, opponentDoc.id],
        status: 'active',
        mode: 'multiplayer',
        hands: { [uid]: deck.slice(0, 7), [opponentDoc.id]: deck.slice(7, 14) },
        pot: wager * 2,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      t.delete(opponentDoc.ref);
    });
    return { status: 'matched', gameId: gameRef.id, isAI: false };
  }

  await queueRef.doc(uid).set({ wager, joinedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { status: 'waiting' };
});

// =========================================================================
// FUNCTION 4: AUTOMATED TOURNAMENT PRIZE DISTRIBUTION
// =========================================================================
exports.distributeTournamentPrizes = onMessagePublished('payout-topic', async (event) => {
  let tournamentId = 'big_time_30';
  let prizes = [500, 250, 100];

  try {
    const payload = event.data.message.json;
    if (payload && payload.tournamentId) tournamentId = payload.tournamentId;
    if (payload && payload.prizes) prizes = payload.prizes;
  } catch (e) {
    console.log('Using default tournament parameters.');
  }

  const leaderboardRef = db.collection('tournament_leaderboards')
                           .where('tournament_id', '==', tournamentId)
                           .orderBy('highest_score', 'desc')
                           .orderBy('achieved_at', 'asc')
                           .limit(prizes.length);

  const snapshot = await leaderboardRef.get();
  if (snapshot.empty) return null;

  const batch = db.batch();
  snapshot.docs.forEach((doc, index) => {
    const winnerId = doc.data().player_id;
    const walletRef = db.collection('player_wallets').doc(winnerId);
    batch.set(walletRef, {
      balance: admin.firestore.FieldValue.increment(prizes[index]),
      last_payout: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  await batch.commit();
  return null;
});

// =========================================================================
// FUNCTION 5: EXECUTE PLAYER MOVE & CALCULATE ALL FIVES SCORE
// =========================================================================
exports.playTileMove = onCall(callableOpts, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const { gameId, tile, edge, tileId } = request.data;
  
  const gameRef = db.collection('games').doc(gameId);

  return db.runTransaction(async (transaction) => {
    const gameDoc = await transaction.get(gameRef);
    if (!gameDoc.exists) throw new HttpsError('not-found', 'Game instance not found.');

    const game = gameDoc.data();
    if (game.status !== 'active') throw new HttpsError('failed-precondition', 'Game is not active.');
    if (game.players[game.turnIndex || 0] !== uid) throw new HttpsError('failed-precondition', 'Not your turn.');

    let board = game.board || [];
    let scoreGained = 0;

    if (board.length === 0) {
      if (tile[0] !== 6 || tile[1] !== 6) {
        throw new HttpsError('invalid-argument', 'Traditional Rules: Must open with the Big 6.');
      }
      board.push(tile);
    } else {
      const leftBoardEdge = board[0][0];
      const rightBoardEdge = board[board.length - 1][1];

      if (edge === 'left') {
        if (tile[1] === leftBoardEdge) board.unshift(tile);
        else if (tile[0] === leftBoardEdge) board.unshift([tile[1], tile[0]]);
        else throw new HttpsError('invalid-argument', 'Tile does not match left edge.');
      } else if (edge === 'right') {
        if (tile[0] === rightBoardEdge) board.push(tile);
        else if (tile[1] === rightBoardEdge) board.push([tile[1], tile[0]]);
        else throw new HttpsError('invalid-argument', 'Tile does not match right edge.');
      }

      const boardSum = board[0][0] + board[board.length - 1][1];
      if (boardSum % 5 === 0) scoreGained = boardSum;
    }

    const updatedHand = game.hands[uid].filter(tId => tId !== tileId);
    const nextTurnIndex = (game.turnIndex === 0) ? 1 : 0;
    
    const currentScores = game.scores || { [game.players[0]]: 0, [game.players[1]]: 0 };
    currentScores[uid] += scoreGained;

    let finalStatus = (currentScores[uid] >= 150) ? 'completed' : 'active';

    transaction.update(gameRef, {
      board: board,
      [`hands.${uid}`]: updatedHand,
      turnIndex: nextTurnIndex,
      scores: currentScores,
      status: finalStatus
    });

    return { status: finalStatus, scoreGained: scoreGained, totalScore: currentScores[uid], boardState: board };
  });
});

// =========================================================================
// FUNCTION 6: GLOBAL CHAT & GIFTING ENGINE
// =========================================================================
exports.sendChatWithGift = onCall(callableOpts, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const { message, giftItemId, giftCost, recipientId } = request.data;

  return db.runTransaction(async (t) => {
    if (giftItemId && giftCost > 0) {
      const walletRef = db.collection('player_stats').doc(uid);
      const walletDoc = await t.get(walletRef);
      const currentBalance = walletDoc.exists ? walletDoc.data().balance : 0;

      if (currentBalance < giftCost) {
        throw new HttpsError('failed-precondition', 'Insufficient cash for this gift.');
      }
      t.update(walletRef, { balance: currentBalance - giftCost });

      if (recipientId) {
        const inventoryRef = db.collection('user_inventory').doc(recipientId);
        t.set(inventoryRef, { [giftItemId]: admin.firestore.FieldValue.increment(1) }, { merge: true });
      }
    }

    const chatRef = db.collection('global_chat').doc();
    t.set(chatRef, {
      senderId: uid,
      recipientId: recipientId || null,
      message: message,
      attachedGift: giftItemId || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return { status: 'success', message: 'Chat posted.' };
  });
});

// =========================================================================
// FUNCTION 7: GENERATE REFERRAL INVITE
// =========================================================================
exports.generateInviteCode = onCall(callableOpts, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
  const inviteCode = request.auth.uid.substring(0, 6).toUpperCase();
  return { code: inviteCode, link: `https://brickyard-dominoes.com/invite/${inviteCode}` };
});

// =========================================================================
// FUNCTION 8: PROCESS DEPOSIT & $20 REFERRAL BONUS
// =========================================================================
exports.processDeposit = onCall(callableOpts, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const { depositAmount } = request.data;
  const playerRef = db.collection('player_stats').doc(uid);

  return db.runTransaction(async (t) => {
    const playerDoc = await t.get(playerRef);
    const playerData = playerDoc.data() || {};
    let bonusAmount = 0;

    if (depositAmount >= 20.00 && playerData.referredBy && !playerData.referralBonusPaid) {
      bonusAmount = 20.00;
      const referrerRef = db.collection('player_stats').doc(playerData.referredBy);
      t.set(referrerRef, { balance: admin.firestore.FieldValue.increment(20.00) }, { merge: true });
      t.set(playerRef, { referralBonusPaid: true }, { merge: true });
    }

    const finalCredit = depositAmount + bonusAmount;
    t.set(playerRef, { balance: admin.firestore.FieldValue.increment(finalCredit) }, { merge: true });

    return { status: 'success', credited: finalCredit, bonusApplied: bonusAmount > 0 };
  });
});
