// ============================================================
//  routes/cpx.js
//  ─────────────────────────────────────────────────────────
//  CPX Research anti-fraud webhook routes.
//
//  Endpoints exposed:
//    GET  /api/v1/cpx-webhook      — CPX server-to-server postback
//    POST /api/v1/request-survey   — Student survey iframe loader
//    GET  /api/v1/admin/audit-log  — Internal admin fraud log viewer
//
//  Security pipeline (applied in order):
//    validateCpxParams → verifyCpxHash → guardDuplicateTransaction
//    → detectSpeedRun → [route handler]
//
//  Anti-fraud features implemented:
//    1. Duplicate transaction check  (guardDuplicateTransaction)
//    2. Speed-running algorithm      (detectSpeedRun)
//    3. Reversal / chargeback        (handled inside the route)
//    4. 15-minute cooldown           (/api/v1/request-survey)
// ============================================================

'use strict';

const router = require('express').Router();
const crypto = require('crypto');

// ── Internal modules ──────────────────────────────────────
const store = require('../store/cpxStore');
const {
  validateCpxParams,
  verifyCpxHash,
  guardDuplicateTransaction,
  detectSpeedRun,
  SPEED_THRESHOLD_MS,
} = require('../middleware/cpxValidation');

// ── Auth middleware — protect the admin route ─────────────
const authMiddleware            = require('../middleware/auth');
const { adminOnly }             = require('../middleware/auth');


// ════════════════════════════════════════════════════════════
//  ROUTE 1: GET /api/v1/cpx-webhook
//  ──────────────────────────────────────────────────────────
//  Called automatically by CPX Research servers when a student
//  completes or reverses a survey.
//
//  Query params (all required):
//    user_id   — the student's platform account ID
//    trans_id  — unique transaction identifier from CPX
//    revenue   — gross USD revenue (we credit 50% in INR)
//    status    — '1' | 'completed' → credit
//                'reversed'        → chargeback
//
//  Security middleware applied:
//    1. validateCpxParams        (sanitise & parse input)
//    2. verifyCpxHash            (HMAC MD5 signature check)
//    3. guardDuplicateTransaction (block replayed trans_ids)
//    4. detectSpeedRun           (flag bots completing in < 2 min)
// ════════════════════════════════════════════════════════════

router.get(
  '/cpx-webhook',
  validateCpxParams,        // Step 1 — input validation
  verifyCpxHash,            // Step 2 — HMAC integrity
  guardDuplicateTransaction,// Step 3 — duplicate guard
  detectSpeedRun,           // Step 4 — speed-run flag
  async (req, res) => {
    // All four middleware layers have passed — safe to proceed.
    const { userId, transId, revenue, status, fraudFlags } = req.cpx;

    try {
      // ── BRANCH A: REVERSAL / CHARGEBACK ──────────────────
      // CPX Research sends status='reversed' when a survey
      // respondent is found to be fraudulent on their end, or
      // when a quality-control failure triggers a chargeback.
      if (status === 'reversed') {
        return await handleReversal(req, res, { userId, transId, revenue });
      }

      // ── BRANCH B: SURVEY COMPLETED — SPEED-RUN DETECTED ──
      // If the fraud flag was raised by detectSpeedRun, we still
      // record the transaction (to prevent a double-credit if
      // CPX retries), but we do NOT credit the wallet.
      if (fraudFlags.speedRun) {
        return await handleFraudulentSpeedRun(req, res, { userId, transId, revenue, fraudFlags });
      }

      // ── BRANCH C: LEGITIMATE COMPLETION ──────────────────
      return await handleLegitimateCompletion(req, res, { userId, transId, revenue });

    } catch (err) {
      // Log the full error for debugging — never expose internals to caller
      console.error(`[CPX Webhook] Unhandled error for trans_id=${transId}:`, err);
      return res.status(500).json({
        error  : 'internal_error',
        message: 'An unexpected error occurred. Please retry.',
      });
    }
  }
);


// ════════════════════════════════════════════════════════════
//  PRIVATE HANDLER — Legitimate Completion
//  Credits the student's wallet with the 50 % revenue split
//  converted from USD to INR.
// ════════════════════════════════════════════════════════════

/**
 * handleLegitimateCompletion
 * Processes a genuine, non-fraudulent survey completion:
 *  - Credits the student's wallet
 *  - Logs the transaction in the ledger
 *  - Stamps the 15-minute cooldown timer
 *  - Clears the active survey session
 * @param {object} req
 * @param {object} res
 * @param {{ userId, transId, revenue }} params
 */
async function handleLegitimateCompletion(req, res, { userId, transId, revenue }) {
  // Credit the student's share to their in-memory wallet
  const creditedINR = store.creditWallet(userId, revenue);

  // Record this transaction in the dedup ledger to prevent replay
  store.recordTransaction(transId, {
    userId,
    revenue,
    status     : 'completed',
    creditedINR,
  });

  // Begin the 15-minute cooldown before they can request a new survey
  store.stampCooldown(userId);

  // Clear the active survey session (speed-run window is now closed)
  store.clearSurveySession(userId);

  // Read back the updated wallet state to include in the response
  const wallet = store.getWallet(userId);

  console.log(
    `[CPX Webhook] ✅ Credited ₹${creditedINR.toFixed(2)} to user=${userId} | ` +
    `trans=${transId} | newBalance=₹${wallet.balanceINR}`
  );

  return res.status(200).json({
    success     : true,
    message     : 'Survey completion processed. Wallet credited.',
    transId,
    userId,
    creditedINR : parseFloat(creditedINR.toFixed(2)),
    wallet,
  });
}


// ════════════════════════════════════════════════════════════
//  PRIVATE HANDLER — Fraudulent Speed-Run
//  Logs and rejects the credit without crediting the wallet.
// ════════════════════════════════════════════════════════════

/**
 * handleFraudulentSpeedRun
 * Records the transaction as flagged and denies the credit.
 * The student is informed their account has been flagged.
 * @param {object} req
 * @param {object} res
 * @param {{ userId, transId, revenue, fraudFlags }} params
 */
async function handleFraudulentSpeedRun(req, res, { userId, transId, revenue, fraudFlags }) {
  const deltaSeconds = (fraudFlags.deltaMs / 1000).toFixed(1);

  // Record in the dedup ledger to block any retry credit
  store.recordTransaction(transId, {
    userId,
    revenue,
    status    : 'flagged',
    flaggedFor: 'FRAUDULENT_SPEEDING',
    deltaMs   : fraudFlags.deltaMs,
  });

  // Write a detailed audit entry for admin review
  store.logAdminEvent('FRAUD_SPEED_RUN', {
    userId,
    transId,
    revenue,
    completionDeltaSeconds : deltaSeconds,
    thresholdSeconds       : (SPEED_THRESHOLD_MS / 1000).toFixed(0),
    note                   : `Survey completed in ${deltaSeconds}s — minimum threshold is ` +
                             `${SPEED_THRESHOLD_MS / 1000}s.`,
  });

  // Clear the session so the user can't exploit the open window
  store.clearSurveySession(userId);

  console.warn(
    `[CPX Webhook] 🚨 FRAUD — user=${userId} trans=${transId} completed in ${deltaSeconds}s. ` +
    `Wallet NOT credited.`
  );

  // Respond 200 to CPX (so they don't retry), but flag internally
  // Return 200 to prevent CPX retry storms — the fraud is our internal concern.
  return res.status(200).json({
    success      : false,
    flagged      : true,
    status       : 'Fraudulent Speeding',
    message      : 'Transaction flagged for speed-running. Reward withheld pending review.',
    transId,
    userId,
    deltaSeconds : parseFloat(deltaSeconds),
    thresholdSeconds: SPEED_THRESHOLD_MS / 1000,
  });
}


// ════════════════════════════════════════════════════════════
//  PRIVATE HANDLER — Reversal / Chargeback
//  Subtracts the original credit from the student's wallet
//  and writes an admin loss-adjustment audit entry.
// ════════════════════════════════════════════════════════════

/**
 * handleReversal
 * Processes a CPX Research chargeback (status='reversed'):
 *  1. Looks up the original transaction in the ledger.
 *  2. Debits the student's wallet by the same 50% INR split.
 *  3. Records an admin loss-adjustment entry.
 *  4. Updates the transaction record with 'reversed' status.
 * @param {object} req
 * @param {object} res
 * @param {{ userId, transId, revenue }} params
 */
async function handleReversal(req, res, { userId, transId, revenue }) {
  // ── 1. Look up the original transaction ──────────────────
  //    If we have no record of the original credit, the reversal
  //    may be a spoofed request.  We log it and proceed cautiously.
  const originalTx = store.getTransaction(transId);

  if (!originalTx) {
    console.warn(
      `[CPX Reversal] ⚠️ trans_id=${transId} not found in ledger. ` +
      `May be a spoofed reversal or pre-dates this server session.`
    );

    store.logAdminEvent('REVERSAL_UNKNOWN_TRANSACTION', {
      userId,
      transId,
      revenue,
      note: 'Reversal received for a trans_id not in the in-memory ledger.',
    });

    // We still debit the wallet based on the revenue param as a
    // precautionary measure to avoid keeping fraudulent funds.
  }

  // ── 2. Debit the wallet ───────────────────────────────────
  const debitedINR = store.debitWallet(userId, revenue);

  // ── 3. Update the ledger to mark this trans as reversed ───
  store.recordTransaction(`${transId}_reversal`, {
    userId,
    revenue,
    status        : 'reversed',
    originalTransId: transId,
    debitedINR,
  });

  // ── 4. Write admin loss-adjustment audit entry ────────────
  const wallet = store.getWallet(userId);

  store.logAdminEvent('REVERSAL_CHARGEBACK', {
    userId,
    transId,
    revenue,
    debitedINR,
    newWalletBalance    : wallet.balanceINR,
    originalTransaction : originalTx || 'NOT_FOUND_IN_LEDGER',
    note: `Admin loss adjustment: ₹${debitedINR.toFixed(2)} debited from user ${userId}'s wallet.`,
  });

  console.log(
    `[CPX Reversal] ⚠️ Reversed ₹${debitedINR.toFixed(2)} for user=${userId} | ` +
    `trans=${transId} | newBalance=₹${wallet.balanceINR}`
  );

  return res.status(200).json({
    success        : true,
    message        : 'Reversal processed. Wallet debited and admin log updated.',
    transId,
    userId,
    debitedINR     : parseFloat(debitedINR.toFixed(2)),
    wallet,
  });
}


// ════════════════════════════════════════════════════════════
//  ROUTE 2: POST /api/v1/request-survey
//  ──────────────────────────────────────────────────────────
//  Called by the frontend when a student clicks "Load Survey".
//  Enforces a 15-minute cooldown after each completed survey
//  to ensure survey data quality and prevent gaming.
//
//  Body params (JSON):
//    user_id  — the student's platform account ID
//
//  Responses:
//    200 — { surveyUrl, surveyToken, expiresAt }
//    429 — cooldown active, with remainingMinutes
// ════════════════════════════════════════════════════════════

router.post('/request-survey', async (req, res) => {
  try {
    const { user_id } = req.body;

    // ── Input validation ──────────────────────────────────
    if (!user_id) {
      return res.status(400).json({
        error  : 'missing_user_id',
        message: 'user_id is required in the request body.',
      });
    }

    const userId = String(user_id).trim();

    // ── Cooldown enforcement ──────────────────────────────
    const cooldown = store.checkCooldown(userId);

    if (cooldown.active) {
      console.log(
        `[CPX Survey Request] ⏳ Cooldown active for user=${userId}. ` +
        `${cooldown.remainingMinutes} minutes remaining.`
      );

      return res.status(429).json({
        error           : 'cooldown_active',
        message         : 'Cooldown active. Please wait 15 minutes to ensure survey data quality.',
        remainingMinutes: parseFloat(cooldown.remainingMinutes),
        remainingMs     : cooldown.remainingMs,
        // Helper field for the frontend to render a countdown timer
        cooldownEndsAt  : new Date(Date.now() + cooldown.remainingMs).toISOString(),
      });
    }

    // ── Generate a unique survey session token ────────────
    //    This token is embedded in the CPX iframe URL so we can
    //    tie the postback back to a specific session.
    const surveyToken = crypto.randomBytes(24).toString('hex');

    // Build the CPX survey URL (adjust params to your CPX app settings)
    const appId     = process.env.CPX_APP_ID     || 'YOUR_CPX_APP_ID';
    const secureKey = process.env.CPX_SECURE_KEY || '';

    const surveyUrl = buildCpxSurveyUrl(appId, userId, surveyToken, secureKey);

    // ── Register the survey session for speed-run timing ──
    store.startSurveySession(userId, surveyToken);

    const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hr expiry

    console.log(
      `[CPX Survey Request] 🔗 Survey session started for user=${userId} | token=${surveyToken}`
    );

    return res.status(200).json({
      success       : true,
      message       : 'Survey session initialized. Load the survey URL in the iframe.',
      surveyUrl,
      surveyToken,
      sessionStartedAt: new Date().toISOString(),
      sessionExpiresAt,
    });

  } catch (err) {
    console.error('[CPX request-survey] Unexpected error:', err);
    return res.status(500).json({
      error  : 'internal_error',
      message: 'Failed to initialize survey session. Please try again.',
    });
  }
});


// ════════════════════════════════════════════════════════════
//  PRIVATE HELPER — Build CPX Survey URL
//  Assembles the full CPX Research iframe URL with user
//  identification and optional secure hash.
// ════════════════════════════════════════════════════════════

/**
 * buildCpxSurveyUrl
 * Constructs the CPX Research survey wall URL for an iframe.
 * @param {string} appId       — CPX publisher app ID
 * @param {string} userId      — student's platform user ID
 * @param {string} sessionToken — our internal session tracking token
 * @param {string} secureKey  — CPX secure key (optional)
 * @returns {string}  the full iframe-embeddable survey URL
 */
function buildCpxSurveyUrl(appId, userId, sessionToken, secureKey) {
  // Build secure hash if the secure key is available
  // CPX Research standard: MD5(user_id + secureKey)
  const secureHash = secureKey
    ? crypto.createHash('md5').update(userId + secureKey).digest('hex')
    : '';

  const params = new URLSearchParams({
    app_id      : appId,
    ext_user_id : userId,
    // Embed our session token in the subid for callback correlation
    subid_1     : sessionToken,
  });

  if (secureHash) {
    params.append('secure_hash', secureHash);
  }

  return `https://offers.cpx-research.com/index.php?${params.toString()}`;
}


// ════════════════════════════════════════════════════════════
//  ROUTE 3: GET /api/v1/admin/audit-log
//  ──────────────────────────────────────────────────────────
//  Admin-only endpoint to view the full fraud / chargeback
//  audit log without needing a database viewer.
//
//  Protected by: JWT authMiddleware + adminOnly guard
// ════════════════════════════════════════════════════════════

router.get('/admin/audit-log', authMiddleware, adminOnly, (req, res) => {
  try {
    const log = store.getAuditLog();
    return res.status(200).json({
      total  : log.length,
      entries: log,
    });
  } catch (err) {
    console.error('[CPX admin/audit-log] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve audit log.' });
  }
});


// ════════════════════════════════════════════════════════════
//  ROUTE 4: GET /api/v1/wallet/:userId
//  ──────────────────────────────────────────────────────────
//  Developer / admin convenience: inspect a user's in-memory
//  wallet balance without touching the frontend.
//  Protected by authMiddleware.
// ════════════════════════════════════════════════════════════

router.get('/wallet/:userId', authMiddleware, (req, res) => {
  try {
    const wallet = store.getWallet(req.params.userId);
    return res.status(200).json({ userId: req.params.userId, wallet });
  } catch (err) {
    console.error('[CPX wallet] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve wallet.' });
  }
});


module.exports = router;
