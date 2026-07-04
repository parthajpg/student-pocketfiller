// ============================================================
//  store/cpxStore.js
//  ─────────────────────────────────────────────────────────
//  In-memory data store that acts as a stand-in for our future
//  PostgreSQL tables.  Replace each Map/Set with real DB calls
//  once the Postgres schema is live.
//
//  ⚠️  IMPORTANT: This store is PROCESS-LOCAL and EPHEMERAL.
//      Data will reset on every server restart.
//      It is intentionally designed to be swapped out for a
//      persistent layer (Redis / Postgres) with zero changes
//      to the route logic, because all access goes through
//      the exported helper functions below.
// ============================================================

'use strict';

// ────────────────────────────────────────────────────────────
//  1.  PROCESSED TRANSACTIONS (Duplicate-guard ledger)
//      Key  : trans_id  (string)
//      Value: { user_id, revenue, status, processedAt, flaggedFor? }
// ────────────────────────────────────────────────────────────
const processedTransactions = new Map();

// ────────────────────────────────────────────────────────────
//  2.  SURVEY SESSION REGISTRY (Speed-run detection)
//      Records the Unix-ms timestamp when a user was handed
//      a survey URL via /api/v1/request-survey.
//      Key  : user_id  (string)
//      Value: { startedAt: <Date.now()>, surveyToken: <string> }
// ────────────────────────────────────────────────────────────
const activeSurveySessions = new Map();

// ────────────────────────────────────────────────────────────
//  3.  SURVEY COOLDOWN REGISTRY (15-minute cooldown enforcement)
//      Records the Unix-ms timestamp of a user's last COMPLETED
//      survey so we can block a new survey request too soon.
//      Key  : user_id  (string)
//      Value: { completedAt: <Date.now()> }
// ────────────────────────────────────────────────────────────
const surveyCompletionCooldowns = new Map();

// ────────────────────────────────────────────────────────────
//  4.  IN-MEMORY WALLET (simulates the `users` table balance)
//      Key  : user_id  (string)
//      Value: { balanceINR: <number>, totalEarned: <number> }
// ────────────────────────────────────────────────────────────
const walletBalances = new Map();

// ────────────────────────────────────────────────────────────
//  5.  ADMIN AUDIT LOG (chargeback / fraud event journal)
//      Append-only array of plain objects — mirrors what we'd
//      INSERT into an `admin_audit_log` table.
// ────────────────────────────────────────────────────────────
const adminAuditLog = [];


// ════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS — Transaction Ledger
// ════════════════════════════════════════════════════════════

/**
 * Check whether a trans_id has already been processed.
 * @param {string} transId
 * @returns {boolean}
 */
function hasTransaction(transId) {
  return processedTransactions.has(transId);
}

/**
 * Record a newly processed transaction into the ledger.
 * @param {string} transId
 * @param {object} payload  — { user_id, revenue, status, flaggedFor? }
 */
function recordTransaction(transId, payload) {
  processedTransactions.set(transId, {
    ...payload,
    processedAt: new Date().toISOString(),
  });
}

/**
 * Retrieve the full record for a known transaction.
 * Returns undefined if not found.
 * @param {string} transId
 * @returns {object|undefined}
 */
function getTransaction(transId) {
  return processedTransactions.get(transId);
}


// ════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS — Survey Session (Speed-run detection)
// ════════════════════════════════════════════════════════════

/**
 * Log the moment a user requests a new survey link.
 * @param {string} userId
 * @param {string} surveyToken  — unique token generated for the iframe URL
 */
function startSurveySession(userId, surveyToken) {
  activeSurveySessions.set(userId, {
    startedAt: Date.now(),
    surveyToken,
  });
}

/**
 * Retrieve the open survey session for a user.
 * @param {string} userId
 * @returns {{ startedAt: number, surveyToken: string }|undefined}
 */
function getSurveySession(userId) {
  return activeSurveySessions.get(userId);
}

/**
 * Remove the survey session after it has been consumed
 * (either credited or flagged as fraud).
 * @param {string} userId
 */
function clearSurveySession(userId) {
  activeSurveySessions.delete(userId);
}


// ════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS — Cooldown Enforcement
// ════════════════════════════════════════════════════════════

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes in milliseconds

/**
 * Stamp the moment a survey was completed so the cooldown timer begins.
 * @param {string} userId
 */
function stampCooldown(userId) {
  surveyCompletionCooldowns.set(userId, { completedAt: Date.now() });
}

/**
 * Check whether a user is still within their cooldown window.
 * @param {string} userId
 * @returns {{ active: boolean, remainingMs: number, remainingMinutes: string }}
 */
function checkCooldown(userId) {
  const record = surveyCompletionCooldowns.get(userId);
  if (!record) return { active: false, remainingMs: 0, remainingMinutes: '0' };

  const elapsed   = Date.now() - record.completedAt;
  const remaining = COOLDOWN_MS - elapsed;

  if (remaining <= 0) {
    // Cooldown has naturally expired — clean up the stale entry
    surveyCompletionCooldowns.delete(userId);
    return { active: false, remainingMs: 0, remainingMinutes: '0' };
  }

  return {
    active           : true,
    remainingMs      : remaining,
    remainingMinutes : (remaining / 60000).toFixed(1),
  };
}


// ════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS — In-Memory Wallet
// ════════════════════════════════════════════════════════════

const INR_RATE   = 87.5; // USD → INR conversion (refresh periodically)
const USER_SHARE = 0.5;  // 50 % revenue split to student

/**
 * Ensure a wallet entry exists for the given user.
 * (In production this would be a SELECT / INSERT DEFAULT.)
 * @param {string} userId
 */
function ensureWallet(userId) {
  if (!walletBalances.has(userId)) {
    walletBalances.set(userId, { balanceINR: 0, totalEarned: 0 });
  }
}

/**
 * Credit the student's share of the survey revenue.
 * @param {string} userId
 * @param {number} revenueUSD  — gross CPX `revenue` param value
 * @returns {number}  creditedINR — actual INR amount added to the wallet
 */
function creditWallet(userId, revenueUSD) {
  ensureWallet(userId);
  const creditINR = parseFloat(revenueUSD) * INR_RATE * USER_SHARE;
  const wallet    = walletBalances.get(userId);

  wallet.balanceINR  = parseFloat((wallet.balanceINR  + creditINR).toFixed(2));
  wallet.totalEarned = parseFloat((wallet.totalEarned + creditINR).toFixed(2));

  return creditINR;
}

/**
 * Debit the student's wallet during a reversal chargeback.
 * Balance is floored at ₹0 to prevent negative balances.
 * @param {string} userId
 * @param {number} revenueUSD  — original CPX revenue being reversed
 * @returns {number}  debitedINR — actual INR amount subtracted
 */
function debitWallet(userId, revenueUSD) {
  ensureWallet(userId);
  const debitINR = parseFloat(revenueUSD) * INR_RATE * USER_SHARE;
  const wallet   = walletBalances.get(userId);

  wallet.balanceINR  = parseFloat(Math.max(0, wallet.balanceINR  - debitINR).toFixed(2));
  wallet.totalEarned = parseFloat(Math.max(0, wallet.totalEarned - debitINR).toFixed(2));

  return debitINR;
}

/**
 * Read a user's current wallet snapshot.
 * @param {string} userId
 * @returns {{ balanceINR: number, totalEarned: number }}
 */
function getWallet(userId) {
  ensureWallet(userId);
  return { ...walletBalances.get(userId) };
}


// ════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS — Admin Audit Log
// ════════════════════════════════════════════════════════════

/**
 * Append an immutable event record to the admin audit log.
 * @param {string} eventType  — e.g. 'REVERSAL_CHARGEBACK' | 'FRAUD_SPEED_RUN'
 * @param {object} details    — arbitrary key-value context object
 */
function logAdminEvent(eventType, details) {
  const entry = {
    eventType,
    ...details,
    loggedAt: new Date().toISOString(),
  };
  adminAuditLog.push(entry);

  // Mirror to server console for real-time admin visibility
  console.warn(`[ADMIN AUDIT] ${eventType}:`, JSON.stringify(entry));
}

/**
 * Expose the full audit log (for an admin dashboard endpoint).
 * @returns {object[]}
 */
function getAuditLog() {
  return [...adminAuditLog]; // shallow copy — protects the internal array
}


// ════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════
module.exports = {
  // ── Constants ─────────────────────────────
  INR_RATE,
  USER_SHARE,
  COOLDOWN_MS,

  // ── Transaction ledger ────────────────────
  hasTransaction,
  recordTransaction,
  getTransaction,

  // ── Survey session (speed-run detection) ──
  startSurveySession,
  getSurveySession,
  clearSurveySession,

  // ── Cooldown enforcement ──────────────────
  stampCooldown,
  checkCooldown,

  // ── Wallet ────────────────────────────────
  creditWallet,
  debitWallet,
  getWallet,

  // ── Admin audit log ───────────────────────
  logAdminEvent,
  getAuditLog,
};
