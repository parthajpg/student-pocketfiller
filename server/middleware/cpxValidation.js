// ============================================================
//  middleware/cpxValidation.js
//  ─────────────────────────────────────────────────────────
//  Reusable Express middleware pipeline for the CPX Research
//  webhook endpoint.  Each function handles one discrete
//  security concern and is independently unit-testable.
//
//  Middleware order on the route MUST be:
//    1. validateCpxParams        — basic input sanitisation
//    2. verifyCpxHash            — HMAC integrity check
//    3. guardDuplicateTransaction — duplicate trans_id block
//    4. detectSpeedRun           — speed-running detection
//
//  The reversal and credit logic live in the route handler
//  itself because they have side-effects (wallet mutations).
// ============================================================

'use strict';

const crypto = require('crypto');
const store  = require('../store/cpxStore');

// ────────────────────────────────────────────────────────────
//  SPEED-RUN THRESHOLD
//  A survey that returns a completion postback in less than
//  SPEED_THRESHOLD_MS milliseconds since the session started
//  is treated as fraudulent speed-running.
// ────────────────────────────────────────────────────────────
const SPEED_THRESHOLD_MS = 120 * 1000; // 2 minutes = 120 seconds


// ════════════════════════════════════════════════════════════
//  MIDDLEWARE 1 — Parameter Validation & Sanitisation
//  Ensures all required query params are present and that
//  revenue is a valid positive number.
// ════════════════════════════════════════════════════════════

/**
 * validateCpxParams
 * Rejects requests that are missing required CPX parameters
 * or that contain malformed values.
 */
function validateCpxParams(req, res, next) {
  try {
    const { user_id, trans_id, revenue, status } = req.query;

    // ── Presence check ─────────────────────────────────────
    if (!user_id || !trans_id || !revenue || !status) {
      return res.status(400).json({
        error  : 'invalid_request',
        message: 'Missing required parameters: user_id, trans_id, revenue, status.',
      });
    }

    // ── Type / sanity check on revenue ─────────────────────
    const parsedRevenue = parseFloat(revenue);
    if (isNaN(parsedRevenue) || parsedRevenue < 0) {
      return res.status(400).json({
        error  : 'invalid_revenue',
        message: 'Revenue must be a non-negative number.',
      });
    }

    // ── Whitelist status values accepted by this handler ───
    const ALLOWED_STATUSES = ['1', 'completed', 'reversed'];
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        error  : 'invalid_status',
        message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}.`,
      });
    }

    // Attach parsed values to req so downstream middleware/handlers
    // don't need to re-parse the same strings.
    req.cpx = {
      userId     : String(user_id).trim(),
      transId    : String(trans_id).trim(),
      revenue    : parsedRevenue,
      status     : String(status).trim(),
    };

    next();
  } catch (err) {
    console.error('[CPX validateCpxParams] Unexpected error:', err);
    next(err); // hand off to the global Express error handler
  }
}


// ════════════════════════════════════════════════════════════
//  MIDDLEWARE 2 — HMAC Hash Verification
//  CPX Research signs every postback with an MD5 HMAC of
//  (trans_id + HASH_KEY).  Reject any request whose `hash`
//  query param doesn't match the expected digest.
//
//  Skip this check if CPX_HASH_KEY is not configured
//  (e.g. local dev without a real CPX account).
// ════════════════════════════════════════════════════════════

/**
 * verifyCpxHash
 * Validates the HMAC signature on the inbound postback.
 * Uses a timing-safe comparison to prevent timing-oracle attacks.
 */
function verifyCpxHash(req, res, next) {
  try {
    const hashKey = process.env.CPX_HASH_KEY;

    // If HASH_KEY is not set, skip signature verification
    // (useful in development / unit-test environment).
    if (!hashKey) {
      console.warn('[CPX verifyCpxHash] CPX_HASH_KEY not set — skipping HMAC verification.');
      return next();
    }

    const { hash } = req.query;

    if (!hash) {
      return res.status(403).json({
        error  : 'missing_signature',
        message: 'Request is missing the CPX HMAC hash signature.',
      });
    }

    // Compute the expected MD5 digest: MD5(trans_id + HASH_KEY)
    const expectedHash = crypto
      .createHash('md5')
      .update(req.cpx.transId + hashKey)
      .digest('hex');

    // Timing-safe comparison prevents timing-oracle attacks
    const providedBuffer  = Buffer.from(hash, 'hex');
    const expectedBuffer  = Buffer.from(expectedHash, 'hex');

    // Buffers must be the same length for timingSafeEqual
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      console.warn(`[CPX verifyCpxHash] Invalid hash for trans_id=${req.cpx.transId}`);
      return res.status(403).json({
        error  : 'invalid_signature',
        message: 'HMAC hash verification failed. Request rejected.',
      });
    }

    next();
  } catch (err) {
    console.error('[CPX verifyCpxHash] Unexpected error:', err);
    next(err);
  }
}


// ════════════════════════════════════════════════════════════
//  MIDDLEWARE 3 — Duplicate Transaction Guard
//  SECURITY CONCERN: Reward farmers may replay the same CPX
//  postback URL to trigger multiple credits for one survey.
//
//  Strategy: Keep a Set/Map of every processed trans_id.
//  If we see the same trans_id again, reject immediately.
//
//  NOTE: For reversed transactions we deliberately ALLOW the
//  trans_id to come in again (the original credit trans_id is
//  used in the chargeback), so we let reversals skip this guard.
// ════════════════════════════════════════════════════════════

/**
 * guardDuplicateTransaction
 * Blocks any postback whose trans_id was already processed
 * as a completed or credited transaction.
 */
function guardDuplicateTransaction(req, res, next) {
  try {
    const { transId, status } = req.cpx;

    // Reversals legitimately reference an existing trans_id —
    // let the route handler deal with them separately.
    if (status === 'reversed') {
      return next();
    }

    if (store.hasTransaction(transId)) {
      const existing = store.getTransaction(transId);
      console.warn(
        `[CPX DUPLICATE] trans_id=${transId} already processed on ${existing.processedAt}`
      );

      // Log the attempt in the admin audit log for investigation
      store.logAdminEvent('DUPLICATE_TRANSACTION_ATTEMPT', {
        transId,
        userId         : req.cpx.userId,
        originalRecord : existing,
        attemptedAt    : new Date().toISOString(),
      });

      return res.status(400).json({
        error  : 'duplicate_transaction',
        message: `Transaction ${transId} has already been processed. Duplicate reward farming detected.`,
      });
    }

    next();
  } catch (err) {
    console.error('[CPX guardDuplicateTransaction] Unexpected error:', err);
    next(err);
  }
}


// ════════════════════════════════════════════════════════════
//  MIDDLEWARE 4 — Speed-Run Detection
//  SECURITY CONCERN: Bots can complete a survey in seconds by
//  auto-filling or skipping questions.
//
//  Strategy: Compare the time the survey session was opened
//  (stamped in /api/v1/request-survey) with the current
//  webhook timestamp.  If Δt < SPEED_THRESHOLD_MS, flag the
//  transaction as "Fraudulent Speeding".
//
//  Result: req.cpx.fraudFlags.speedRun = true/false
//  The route handler reads this flag and decides whether to
//  credit the wallet.
// ════════════════════════════════════════════════════════════

/**
 * detectSpeedRun
 * Attaches a `fraudFlags` object to req.cpx with a `speedRun`
 * boolean.  Does NOT reject the request itself so the route
 * handler can record the flagged transaction in the ledger
 * before returning a response.
 */
function detectSpeedRun(req, res, next) {
  try {
    // Default: no fraud flags detected
    req.cpx.fraudFlags = { speedRun: false, deltaMs: null };

    // Reversals don't need a speed check
    if (req.cpx.status === 'reversed') {
      return next();
    }

    const session = store.getSurveySession(req.cpx.userId);

    if (!session) {
      // No session found — user may have restarted the server
      // or accessed the survey outside our /request-survey flow.
      // Flag as anomalous but not as outright fraud (could be a
      // legitimate user who hit the CPX iframe directly).
      console.warn(
        `[CPX SPEED_RUN] No active session found for user_id=${req.cpx.userId}. ` +
        `Cannot verify survey duration. Proceeding with caution.`
      );
      return next();
    }

    const deltaMs = Date.now() - session.startedAt;
    req.cpx.fraudFlags.deltaMs = deltaMs;

    if (deltaMs < SPEED_THRESHOLD_MS) {
      // Survey completed suspiciously fast — flag it
      req.cpx.fraudFlags.speedRun = true;
      console.warn(
        `[CPX SPEED_RUN] 🚨 user_id=${req.cpx.userId} completed survey in ` +
        `${(deltaMs / 1000).toFixed(1)}s — below ${SPEED_THRESHOLD_MS / 1000}s threshold.`
      );
    }

    next();
  } catch (err) {
    console.error('[CPX detectSpeedRun] Unexpected error:', err);
    next(err);
  }
}


// ════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════
module.exports = {
  validateCpxParams,
  verifyCpxHash,
  guardDuplicateTransaction,
  detectSpeedRun,
  SPEED_THRESHOLD_MS,
};
