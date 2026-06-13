
const admin = require('firebase-admin');
const functions = require('firebase-functions');
const { onMessagePublished } = require("firebase-functions/v2/pubsub");

admin.initializeApp();
const db = admin.firestore();

// =========================================================================
// FUNCTION 1: SUBMIT SCORE & SOLVE TIES (Asynchronous Leaderboard Rule)
// =========================================================================
exports.submitTournamentScore = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required.');

  const uid = context.auth.uid;
  const { tournamentId, finalScore } = data;
  
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
exports.getTournamentLeaderboard = functions.https.onCall(async (data, context) => {
  const { tournamentId, limitAmount = 50 } = data;

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
exports.matchMakeAndDeal = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required.');

  const uid = context.auth.uid;
  const wager = data.wager || 2.50;
  const playMode = data.mode || 'multiplayer'; 
  const aiDifficulty = data.difficulty || 'medium'; 
  
  const queueRef = db.collection('matchmaking_queue');
  const gameRef = db.collection('games').doc();

  const deck = Array.from({length: 28}, (_, i) => i);
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
exports.distributeTournamentPrizes = onMessagePublished("payout-topic", async (event) => {
  let tournamentId = 'big_time_30'; 
  let prizes = [500, 250, 100];       

  try {
    const payload = event.data.message.json;
    if (payload && payload.tournamentId) tournamentId = payload.tournamentId;
    if (payload && payload.prizes) prizes = payload.prizes;
  } catch (e) {
    console.log("Using default tournament parameters.");
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
    const walletRef = db.collection('player_stats').doc(winnerId);
    
    // Auto-update wallet balance securely
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
exports.playTileMove = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required.');

  const uid = context.auth.uid;
  const { gameId, tile, edge, tileId } = data; 
  
  const gameRef = db.collection('games').doc(gameId);

  return db.runTransaction(async (transaction) => {
    const gameDoc = await transaction.get(gameRef);
    if (!gameDoc.exists) throw new functions.https.HttpsError('not-found', 'Game instance not found.');

    const game = gameDoc.data();
    if (game.status !== 'active') throw new functions.https.HttpsError('failed-precondition', 'Game is not active.');
    if (game.players[game.turnIndex || 0] !== uid) throw new functions.https.HttpsError('failed-precondition', 'Not your turn.');

    let board = game.board || [];
    let scoreGained = 0;

    if (board.length === 0) {
      if (tile[0] !== 6 || tile[1] !== 6) {
        throw new functions.https.HttpsError('invalid-argument', 'Traditional Rules: Must open with the Big 6.');
      }
      board.push(tile);
    } else {
      const leftBoardEdge = board[0][0];
      const rightBoardEdge = board[board.length - 1][1];

      if (edge === 'left') {
        if (tile[1] === leftBoardEdge) board.unshift(tile);
        else if (tile[0] === leftBoardEdge) board.unshift([tile[1], tile[0]]); 
        else throw new functions.https.HttpsError('invalid-argument', 'Tile does not match left edge.');
      } else if (edge === 'right') {
        if (tile[0] === rightBoardEdge) board.push(tile);
        else if (tile[1] === rightBoardEdge) board.push([tile[1], tile[0]]); 
        else throw new functions.https.HttpsError('invalid-argument', 'Tile does not match right edge.');
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
// FUNCTION 6: GLOBAL CHAT ENGINE
// =========================================================================
exports.sendChatWithGift = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required.');

  const uid = context.auth.uid;
  const { message, giftItemId, giftCost, recipientId } = data;

  return db.runTransaction(async (t) => {
    // Legacy support for basic chat gifting
    if (giftItemId && giftCost > 0) {
      const walletRef = db.collection('player_stats').doc(uid);
      const walletDoc = await t.get(walletRef);
      const currentBalance = walletDoc.exists ? walletDoc.data().balance : 0;

      if (currentBalance < giftCost) {
        throw new functions.https.HttpsError('failed-precondition', 'Insufficient cash for this gift.');
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
exports.generateInviteCode = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required.');
  const inviteCode = context.auth.uid.substring(0, 6).toUpperCase();
  return { code: inviteCode, link: `https://brickyard-dominoes.com/invite/${inviteCode}` };
});

// =========================================================================
// FUNCTION 8: BANK-GRADE DEPOSIT PROCESSING (Ledger Supported)
// =========================================================================
exports.processDeposit = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required.');

  const uid = context.auth.uid;
  const { depositAmount, nuveiTransactionId } = data;

  const playerRef = db.collection('player_stats').doc(uid);
  const ledgerRef = db.collection('transaction_ledger').doc();

  return db.runTransaction(async (t) => {
    const playerDoc = await t.get(playerRef);
    const playerData = playerDoc.data() || {};
    
    let bonusAmount = 0;

    // 1. Calculate Referral Bonuses
    if (depositAmount >= 20.00 && playerData.referredBy && !playerData.referralBonusPaid) {
      bonusAmount = 20.00;
      const referrerRef = db.collection('player_stats').doc(playerData.referredBy);
      const referrerLedgerRef = db.collection('transaction_ledger').doc();

      t.set(referrerLedgerRef, {
        transaction_id: `ref_bonus_${uid}`,
        player_id: playerData.referredBy,
        type: "prize_payout",
        amount: 20.00,
        currency: "USD",
        status: "completed",
        description: "Referral Bonus Payout",
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      t.set(referrerRef, { balance: admin.firestore.FieldValue.increment(20.00) }, { merge: true });
      t.set(playerRef, { referralBonusPaid: true }, { merge: true });
    }

    const finalCredit = depositAmount + bonusAmount;

    // 2. Write the Immutable Ledger Receipt for the player
    t.set(ledgerRef, {
      transaction_id: nuveiTransactionId || `manual_test_${Math.floor(Math.random()*10000)}`,
      player_id: uid,
      type: "deposit",
      amount: finalCredit,
      currency: "USD",
      status: "completed",
      description: bonusAmount > 0 ? "Deposit + Welcome Bonus" : "Standard Deposit",
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Update the Wallet Balance
    t.set(playerRef, { balance: admin.firestore.FieldValue.increment(finalCredit) }, { merge: true });

    return { status: 'success', credited: finalCredit };
  });
});

// =========================================================================
// FUNCTION 9: NUVEI WEBHOOK & IMMUTABLE LEDGER PROTOCOL
// =========================================================================
exports.nuveiWebhookListener = functions.https.onRequest(async (req, res) => {
  // 1. Nuvei will send a POST request. Reject anything else.
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // 2. Extract the payload from Nuvei's Direct Merchant Notification (DMN)
    const { 
      TransactionID, 
      clientUniqueId, 
      TotalAmount, 
      currency, 
      Status 
    } = req.body;

    if (!TransactionID || !clientUniqueId || !TotalAmount) {
      return res.status(400).send('Missing required DMN parameters');
    }

    const uid = clientUniqueId; 
    const amount = parseFloat(TotalAmount);

    // Use the Nuvei Transaction ID as the document ID to ensure idempotency
    const ledgerRef = db.collection('transaction_ledger').doc(TransactionID);
    const playerRef = db.collection('player_stats').doc(uid);

    // 3. Execute the Bank-Grade Transaction
    await db.runTransaction(async (t) => {
      const ledgerDoc = await t.get(ledgerRef);
      
      // Idempotency Check: Ignore duplicates
      if (ledgerDoc.exists) {
        console.log(`Transaction ${TransactionID} already processed.`);
        return; 
      }

      if (Status === 'APPROVED') {
        // Write immutable success receipt
        t.set(ledgerRef, {
          transaction_id: TransactionID,
          player_id: uid,
          type: "deposit",
          amount: amount,
          currency: currency || "USD",
          status: "completed",
          description: "Nuvei Webhook Auto-Deposit",
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Credit the player's wallet
        t.set(playerRef, { 
          balance: admin.firestore.FieldValue.increment(amount) 
        }, { merge: true });

      } else {
        // Log failed attempts for compliance auditing
        t.set(ledgerRef, {
          transaction_id: TransactionID,
          player_id: uid,
          type: "deposit",
          amount: amount,
          currency: currency || "USD",
          status: "failed",
          description: `Nuvei Payment ${Status}`,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    // 4. ALWAYS return a 200 OK so Nuvei knows the message was received
    res.status(200).send('OK');

  } catch (error) {
    console.error('Nuvei Webhook Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// =========================================================================
// FUNCTION 10: SECURE STORE PURCHASES (Ledger Supported)
// =========================================================================
exports.processStorePurchase = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required.');

  const uid = context.auth.uid;
  const { itemName, cost, currencyType } = data; // currencyType: 'cash' or 'stamps'

  const playerRef = db.collection('player_stats').doc(uid);
  const ledgerRef = db.collection('transaction_ledger').doc();

  return db.runTransaction(async (t) => {
    const playerDoc = await t.get(playerRef);
    if (!playerDoc.exists) throw new functions.https.HttpsError('not-found', 'Player profile not found.');

    const currentBalance = currencyType === 'cash' ? (playerDoc.data().balance || 0) : (playerDoc.data().foodStamps || 0);

    if (currentBalance < cost) {
      throw new functions.https.HttpsError('failed-precondition', `Insufficient ${currencyType} for this purchase.`);
    }

    if (currencyType === 'cash') {
      t.update(playerRef, { balance: currentBalance - cost });
    } else {
      t.update(playerRef, { foodStamps: currentBalance - cost });
    }

    t.set(ledgerRef, {
      transaction_id: `store_${Math.floor(Math.random()*100000)}`,
      player_id: uid,
      type: "store_purchase",
      amount: -Math.abs(cost), 
      currency: currencyType === 'cash' ? "USD" : "STAMPS",
      status: "completed",
      description: `Purchased: ${itemName}`,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    const inventoryRef = db.collection('user_inventory').doc(uid);
    t.set(inventoryRef, { [itemName]: admin.firestore.FieldValue.increment(1) }, { merge: true });

    return { status: 'success', remainingBalance: currentBalance - cost };
  });
});
