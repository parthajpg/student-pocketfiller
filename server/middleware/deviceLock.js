// ============================================================
//  middleware/deviceLock.js
//  ─────────────────────────────────────────────────────────
//  Device-lock fraud detection middleware.
//
//  Reads the X-Device-UUID header sent by useDeviceFingerprint.js
//  and cross-references it against the authenticated user's
//  account in the in-memory device registry.
//
//  Fraud scenario: Two different user accounts present the same
//  X-Device-UUID  →  the second account is flagged for review.
//
//  ⚠️  Usage:
//      Apply AFTER authMiddleware so req.user is populated.
//
//      router.get('/some-protected-route',
//        authMiddleware,
//        deviceLockCheck,    ← add here
//        handler
//      );
//
//  Migration note:
//      Replace the in-memory `deviceRegistry` Map with a real
//      DB query (SELECT user_id FROM device_uuids WHERE uuid = $1)
//      when Postgres is live.  No changes needed in route files.
// ============================================================

'use strict';

// ── In-memory device registry ─────────────────────────────
//   Key  : device UUID string (from X-Device-UUID header)
//   Value: { userId, firstSeenAt, flagged, flaggedAt?, note? }
// ─────────────────────────────────────────────────────────
const deviceRegistry = new Map();

// ── Fraud audit log (append-only) ───────────────────────
const fraudAuditLog = [];

/**
 * deviceLockCheck
 * Express middleware that enforces the hardware UUID lock.
 *
 * Flow:
 *  1. Extract X-Device-UUID from request headers.
 *  2. If the UUID is new → register it to the current user.
 *  3. If the UUID already belongs to this same user → allow.
 *  4. If the UUID belongs to a DIFFERENT user → flag as fraud.
 *     (Log the event; do NOT block in read mode — the admin
 *      reviews the flag.  To hard-block, uncomment the 403 below.)
 *
 * @middleware
 */
function deviceLockCheck(req, res, next) {
  try {
    const deviceUUID = req.headers['x-device-uuid'];
    const isRegen    = req.headers['x-device-uuid-regen'] === 'true';
    const userId     = req.user?.id?.toString();

    // ── No UUID header present ─────────────────────────────
    //    Old clients or requests that bypass the fingerprint
    //    script.  Allow but log a warning.
    if (!deviceUUID || deviceUUID === 'unknown') {
      console.warn(
        `[DeviceLock] No X-Device-UUID on request from user=${userId} ` +
        `${req.method} ${req.path}`
      );
      return next();
    }

    // ── UUID Regen flag ────────────────────────────────────
    //    The client cleared localStorage and generated a new UUID.
    //    This is suspicious — a normal user never does this.
    //    Log it for admin review but do NOT block.
    if (isRegen) {
      _logFraudEvent('UUID_REGEN_DETECTED', {
        userId,
        newDeviceUUID : deviceUUID,
        path          : req.path,
        note          : 'User agent cleared localStorage and regenerated device UUID.',
      });
    }

    const existing = deviceRegistry.get(deviceUUID);

    if (!existing) {
      // ── First time we've seen this UUID → register it ───
      deviceRegistry.set(deviceUUID, {
        userId,
        firstSeenAt : new Date().toISOString(),
        flagged     : false,
      });
      console.info(
        `[DeviceLock] ✅ Registered new device UUID for user=${userId}. ` +
        `UUID: ${deviceUUID.slice(0, 8)}···`
      );
      return next();
    }

    if (existing.userId === userId) {
      // ── Same user on same device → legitimate ───────────
      return next();
    }

    // ── FRAUD: Two different user accounts, same UUID ────
    //    This is the core hardware-lock detection.
    const fraudEntry = {
      deviceUUID      : deviceUUID.slice(0, 8) + '···', // partial — don't log full UUID
      originalUserId  : existing.userId,
      collidingUserId : userId,
      path            : req.path,
      method          : req.method,
      detectedAt      : new Date().toISOString(),
      note            : `UUID originally registered to user ${existing.userId}. ` +
                        `Now being used by user ${userId}. Possible account sharing or device sharing.`,
    };

    _logFraudEvent('DUPLICATE_DEVICE_UUID', fraudEntry);

    // Mark the registry entry as flagged for admin visibility
    deviceRegistry.set(deviceUUID, {
      ...existing,
      flagged   : true,
      flaggedAt : new Date().toISOString(),
    });

    // ── POLICY DECISION ────────────────────────────────────
    //    Option A (soft — current): Allow the request but flag.
    //      Admin reviews the log and takes manual action.
    //    Option B (hard — uncomment below): Block immediately.
    //      Safer but may create false positives if users
    //      legitimately switch devices.
    //
    // OPTION B (hard block) — uncomment to enable:
    // return res.status(403).json({
    //   error  : 'device_lock_violation',
    //   message: 'This device is registered to another account. ' +
    //            'Contact support if you believe this is an error.',
    // });

    // OPTION A (soft flag) — currently active:
    req.deviceFraudFlag = true; // route handlers can check this
    return next();

  } catch (err) {
    // Never let the middleware crash the server
    console.error('[DeviceLock] Unexpected error:', err);
    return next();
  }
}


// ── Internal helpers ─────────────────────────────────────

/**
 * Append a fraud event to the audit log and mirror to console.
 * @param {string} eventType
 * @param {object} details
 */
function _logFraudEvent(eventType, details) {
  const entry = { eventType, ...details, loggedAt: new Date().toISOString() };
  fraudAuditLog.push(entry);
  console.warn(`[DeviceLock FRAUD] ${eventType}:`, JSON.stringify(entry));
}


// ── Public helpers ───────────────────────────────────────

/**
 * getDeviceFraudLog
 * Returns a copy of the full fraud audit log.
 * Used by the admin audit-log endpoint.
 * @returns {object[]}
 */
function getDeviceFraudLog() {
  return [...fraudAuditLog];
}

/**
 * getDeviceRegistry
 * Returns a copy of the device registry for admin inspection.
 * @returns {object[]}
 */
function getDeviceRegistry() {
  return Array.from(deviceRegistry.entries()).map(([uuid, data]) => ({
    uuidPrefix : uuid.slice(0, 8) + '···',
    ...data,
  }));
}


module.exports = {
  deviceLockCheck,
  getDeviceFraudLog,
  getDeviceRegistry,
};
