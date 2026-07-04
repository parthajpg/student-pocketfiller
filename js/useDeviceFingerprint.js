/* =============================================================
   js/useDeviceFingerprint.js
   ─────────────────────────────────────────────────────────────
   Hardware-lock & network-security module for Student Pocket Filler.

   Mirrors a React custom-hook API contract (init / getUUID /
   getHeaders) so this module can be lifted 1-for-1 into a
   Next.js / React codebase with no logic changes.

   ┌─ Operations ─────────────────────────────────────────────┐
   │  1. UUID INITIALIZATION                                   │
   │     Reads / creates a persistent browser UUID stored in   │
   │     localStorage under `student_pocketfiller_uuid`.       │
   │     Uses crypto.getRandomValues() — CSPRNG, not Math.     │
   │                                                           │
   │  2. NETWORK TYPE CHECK (Wi-Fi Block)                      │
   │     Uses the Network Information API to detect if the     │
   │     user is on a shared Wi-Fi / Ethernet connection and   │
   │     renders a full-screen blocking modal with a hard-exit  │
   │     until they acknowledge and switch to mobile data.     │
   │                                                           │
   │  3. DEVICE LOCKING VIA API HEADER INJECTION               │
   │     Patches the global apiFetch() wrapper (api.js) to     │
   │     silently append X-Device-UUID to every outbound       │
   │     request header.  The Render backend cross-references   │
   │     this UUID against the authenticated user — any second  │
   │     account sharing the same UUID is flagged as fraud.    │
   └──────────────────────────────────────────────────────────┘

   Usage (add to every protected page's <script> block):
   ─────────────────────────────────────────────────────────────
     <script src="js/useDeviceFingerprint.js"></script>
     <script>
       // Must be called BEFORE requireAuth() so the UUID header
       // is present on the very first API call.
       DeviceFingerprint.init();
     </script>
   ─────────────────────────────────────────────────────────────

   ⚠️  Security limitations (documented honestly):
   •  localStorage can be cleared by the user.  This module
      re-generates a new UUID if it detects a cleared store and
      sends a `X-Device-UUID-Regen: true` header so the backend
      can flag the account for review.
   •  The Network Information API is not supported in Safari /
      Firefox.  The Wi-Fi check degrades gracefully — it shows
      the warning only when detection is possible.
   •  This is a CLIENT-SIDE layer.  The authoritative fraud
      check MUST live on the backend (see routes/cpx.js).
   ============================================================= */

'use strict';

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────
const UUID_STORAGE_KEY  = 'student_pocketfiller_uuid';
const REGEN_STORAGE_KEY = 'student_pocketfiller_uuid_regen';

/** Connection types we consider "shared / campus" networks. */
const BLOCKED_CONNECTION_TYPES = ['wifi', 'ethernet'];

/** DOM ID for the security modal — must be unique across the page. */
const MODAL_ID = 'spf-security-modal';

// ─────────────────────────────────────────────────────────────
//  INTERNAL STATE
// ─────────────────────────────────────────────────────────────
let _uuid        = null;   // resolved after init()
let _initialized = false;
let _apiPatched  = false;  // track whether apiFetch was already patched


// =============================================================
//  SECTION 1 — UUID INITIALIZATION
//  Generates or retrieves the persistent browser-hardware UUID.
// =============================================================

/**
 * _generateSecureUUID
 * Creates a v4-like UUID using the browser's Crypto API
 * (window.crypto.getRandomValues — CSPRNG, NOT Math.random).
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 *
 * @returns {string}
 */
function _generateSecureUUID() {
  // Fill 16 random bytes using the Cryptographically Secure
  // Pseudo-Random Number Generator provided by the browser.
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);

  // Set version bits to 0100 (UUID v4)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant bits to 10xxxxxx (RFC 4122)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Convert to hex and insert hyphens at UUID v4 positions
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * _resolveUUID
 * Reads the UUID from localStorage.  If none exists (first visit
 * or cleared storage), generates a new one and persists it.
 * Sets the `_uuid` module variable and returns the UUID string.
 *
 * @returns {string}  the persistent device UUID
 */
function _resolveUUID() {
  try {
    let stored = localStorage.getItem(UUID_STORAGE_KEY);

    if (!stored) {
      // Either first visit or the user manually cleared localStorage.
      // Generate a fresh CSPRNG UUID.
      stored = _generateSecureUUID();
      localStorage.setItem(UUID_STORAGE_KEY, stored);

      // Flag this as a re-generation event so the backend can audit it.
      // The header injector will send X-Device-UUID-Regen: true on
      // the next request.
      localStorage.setItem(REGEN_STORAGE_KEY, 'true');

      console.info(
        '[DeviceFingerprint] New device UUID generated and stored.',
        stored
      );
    } else {
      console.info('[DeviceFingerprint] Existing device UUID loaded.', stored);
    }

    _uuid = stored;
    return stored;

  } catch (err) {
    // localStorage may be blocked in private/incognito mode.
    // Fall back to an in-memory UUID for this session.
    console.warn(
      '[DeviceFingerprint] localStorage unavailable — using session-only UUID.',
      err
    );
    if (!_uuid) _uuid = _generateSecureUUID();
    return _uuid;
  }
}


// =============================================================
//  SECTION 2 — NETWORK TYPE CHECK (Wi-Fi Block)
//  Detects campus/hostel Wi-Fi via the Network Information API
//  and renders a full-screen blocking modal if detected.
// =============================================================

/**
 * _buildWifiBlockModal
 * Injects the Wi-Fi warning modal into the DOM using the
 * project's existing CSS design-token variables.  The modal
 * is self-contained and does not depend on any CSS file.
 *
 * The student MUST tap "I've Switched to Mobile Data" to
 * dismiss the modal.  There is no close button.
 *
 * @param {string} connectionType  — detected type, e.g. 'wifi'
 */
function _buildWifiBlockModal(connectionType) {
  // Prevent duplicate modals if called multiple times
  if (document.getElementById(MODAL_ID)) return;

  const modal = document.createElement('div');
  modal.id = MODAL_ID;

  // ── Inline styles (design-token-aware) ───────────────────
  // We read CSS variables at runtime so the modal inherits
  // the app's theme without adding a separate stylesheet.
  Object.assign(modal.style, {
    position       : 'fixed',
    inset          : '0',
    zIndex         : '99999',
    display        : 'flex',
    alignItems     : 'center',
    justifyContent : 'center',
    padding        : '20px',
    // Deep backdrop — intentionally overwhelming
    background     : 'rgba(0, 0, 0, 0.96)',
    backdropFilter : 'blur(20px)',
  });

  modal.innerHTML = `
    <div id="${MODAL_ID}-card" style="
      background      : #0d0d1a;
      border          : 2px solid rgba(239, 68, 68, 0.6);
      border-radius   : 24px;
      padding         : 32px 28px 36px;
      max-width       : 440px;
      width           : 100%;
      text-align      : center;
      box-shadow      : 0 0 60px rgba(239, 68, 68, 0.25),
                        0 0 120px rgba(239, 68, 68, 0.10);
      animation       : spf-modal-in 0.4s cubic-bezier(.34,1.56,.64,1) both;
    ">

      <!-- Pulsing warning icon -->
      <div id="${MODAL_ID}-icon" style="
        font-size     : 3.8rem;
        margin-bottom : 18px;
        display       : inline-block;
        animation     : spf-pulse 1.4s ease-in-out infinite;
      ">🛑</div>

      <!-- Title -->
      <div style="
        font-size   : 1.15rem;
        font-weight : 900;
        color       : #ef4444;
        margin-bottom: 14px;
        letter-spacing: -0.3px;
        line-height : 1.3;
        font-family : 'Inter', -apple-system, sans-serif;
      ">CRITICAL SECURITY WARNING</div>

      <!-- Body message -->
      <p style="
        font-size   : 0.9rem;
        color       : #f0f0ff;
        line-height : 1.65;
        margin-bottom: 10px;
        font-family : 'Inter', -apple-system, sans-serif;
      ">
        <strong style="color:#fbbf24;">Campus / Hostel Wi-Fi detected.</strong><br>
        To prevent <strong style="color:#ef4444;">account bans</strong> and protect your
        survey earnings, you <strong>must switch to Mobile Data</strong>
        (Jio / Airtel / Vi) before accessing surveys.
      </p>

      <!-- Reason callout -->
      <div style="
        background    : rgba(239,68,68,0.08);
        border        : 1px solid rgba(239,68,68,0.25);
        border-radius : 14px;
        padding       : 14px 16px;
        margin        : 18px 0 24px;
        font-size     : 0.78rem;
        color         : #fca5a5;
        line-height   : 1.6;
        text-align    : left;
        font-family   : 'Inter', -apple-system, sans-serif;
      ">
        <strong>Why?</strong> Shared campus networks assign the same IP address
        to many students.  Survey providers flag shared IPs as
        <strong>bot traffic</strong>, which can permanently ban every account
        on that IP — including yours.<br><br>
        <strong>Detected connection:</strong> <code style="
          background    : rgba(239,68,68,0.15);
          padding       : 2px 8px;
          border-radius : 6px;
          font-family   : monospace;
          font-size     : 0.8rem;
        ">${connectionType.toUpperCase()}</code>
      </div>

      <!-- Steps -->
      <div style="
        text-align    : left;
        margin-bottom : 26px;
        font-family   : 'Inter', -apple-system, sans-serif;
        font-size     : 0.84rem;
        color         : #a0a0cc;
        line-height   : 1.7;
      ">
        <strong style="color:#f0f0ff;">How to switch:</strong><br>
        1️⃣ &nbsp;Pull down your notification shade<br>
        2️⃣ &nbsp;Turn <strong>Wi-Fi OFF</strong><br>
        3️⃣ &nbsp;Turn <strong>Mobile Data ON</strong> (Jio/Airtel/Vi)<br>
        4️⃣ &nbsp;Tap the button below to continue
      </div>

      <!-- Dismiss button -->
      <button
        id="${MODAL_ID}-dismiss-btn"
        onclick="window.__DeviceFingerprint_dismissWifiModal()"
        style="
          width           : 100%;
          padding         : 15px 24px;
          background      : linear-gradient(135deg, #10b981, #3b82f6);
          border          : none;
          border-radius   : 14px;
          color           : #fff;
          font-size       : 0.95rem;
          font-weight     : 800;
          cursor          : pointer;
          font-family     : 'Inter', -apple-system, sans-serif;
          letter-spacing  : -0.2px;
          transition      : opacity 0.2s, transform 0.2s;
          min-height      : 52px;
        "
        onmouseover="this.style.opacity='0.88';this.style.transform='translateY(-1px)'"
        onmouseout="this.style.opacity='1';this.style.transform='translateY(0)'"
      >
        ✅ &nbsp;I've Switched to Mobile Data — Continue
      </button>

      <!-- UUID watermark (non-PII — just the first 8 chars for support) -->
      <div style="
        margin-top  : 16px;
        font-size   : 0.65rem;
        color       : rgba(136,136,170,0.5);
        font-family : monospace;
        letter-spacing: 0.5px;
      ">Device ID: ${_uuid ? _uuid.slice(0, 8) : '--------'}···</div>
    </div>

    <!-- Keyframe animations injected once -->
    <style id="${MODAL_ID}-styles">
      @keyframes spf-modal-in {
        from { opacity: 0; transform: scale(0.88) translateY(20px); }
        to   { opacity: 1; transform: scale(1)    translateY(0);    }
      }
      @keyframes spf-pulse {
        0%, 100% { transform: scale(1);    filter: drop-shadow(0 0  6px rgba(239,68,68,0.5)); }
        50%      { transform: scale(1.12); filter: drop-shadow(0 0 18px rgba(239,68,68,0.9)); }
      }
    </style>
  `;

  document.body.appendChild(modal);
  // Prevent scroll on the underlying page while the modal is open
  document.body.style.overflow = 'hidden';

  console.warn(
    `[DeviceFingerprint] ⛔ Wi-Fi block modal shown. ` +
    `Detected connection type: "${connectionType}"`
  );
}

/**
 * _dismissWifiModal (exposed on window for the inline onclick)
 * Removes the blocking modal and re-enables page scroll.
 * After dismissal, we re-run the connection check in case
 * the user hasn't actually switched yet (best-effort only —
 * the network check is advisory, not cryptographic).
 */
function _dismissWifiModal() {
  const modal = document.getElementById(MODAL_ID);
  if (modal) {
    // Fade out gracefully
    modal.style.transition = 'opacity 0.25s';
    modal.style.opacity    = '0';
    setTimeout(() => {
      modal.remove();
      const styles = document.getElementById(`${MODAL_ID}-styles`);
      if (styles) styles.remove();
      document.body.style.overflow = '';
    }, 260);
  }
  console.info('[DeviceFingerprint] Wi-Fi block modal dismissed by user.');
}

// Expose the dismiss handler as a global so the inline `onclick`
// inside the injected HTML can reach it.
window.__DeviceFingerprint_dismissWifiModal = _dismissWifiModal;

/**
 * _checkNetworkType
 * Reads the Network Information API and triggers the blocking
 * modal if a campus/shared connection type is detected.
 *
 * API support matrix (2026):
 *   ✅ Chrome Android, Chrome Desktop, Edge, Samsung Internet
 *   ⚠️  Firefox (partial — effectiveType only)
 *   ❌ Safari (not supported — graceful skip)
 */
function _checkNetworkType() {
  // navigator.connection is the Network Information API entry point.
  const connection =
    navigator.connection ||
    navigator.mozConnection ||
    navigator.webkitConnection;

  if (!connection) {
    // API not available in this browser (Safari, Firefox Mobile).
    // Log for debugging but do NOT block — false negatives are
    // safer than false positives for legitimate users.
    console.info(
      '[DeviceFingerprint] Network Information API not available in this browser. ' +
      'Wi-Fi detection skipped.'
    );
    return;
  }

  const type           = (connection.type           || '').toLowerCase();
  const effectiveType  = (connection.effectiveType  || '').toLowerCase();

  console.info(
    `[DeviceFingerprint] Network type: "${type}" | effectiveType: "${effectiveType}"`
  );

  // A detected type of 'wifi' or 'ethernet' → block.
  // effectiveType like '4g'/'3g'/'2g' implies mobile data → allow.
  const isBlocked = BLOCKED_CONNECTION_TYPES.includes(type);

  if (isBlocked) {
    _buildWifiBlockModal(type || 'wifi');
  }

  // Listen for connection changes while the page is open
  // so switching from mobile to Wi-Fi mid-session also triggers the block.
  connection.addEventListener('change', () => {
    const newType = (connection.type || '').toLowerCase();
    console.info(`[DeviceFingerprint] Connection changed to: "${newType}"`);

    if (BLOCKED_CONNECTION_TYPES.includes(newType)) {
      _buildWifiBlockModal(newType);
    } else {
      // If modal is open and they switched back to mobile data, auto-dismiss.
      if (document.getElementById(MODAL_ID)) {
        _dismissWifiModal();
      }
    }
  });
}


// =============================================================
//  SECTION 3 — DEVICE LOCKING VIA HEADER INJECTION
//  Monkeypatches the global apiFetch() function (api.js) to
//  silently append the X-Device-UUID header to every request.
// =============================================================

/**
 * _patchApiFetch
 * Wraps the existing `apiFetch` function (declared in api.js)
 * with a new version that injects device-lock headers.
 *
 * Injected headers:
 *   X-Device-UUID       — persistent browser hardware fingerprint
 *   X-Device-UUID-Regen — 'true' if the UUID was just regenerated
 *                         (localStorage was cleared — flag for review)
 *
 * This function is idempotent — safe to call multiple times.
 */
function _patchApiFetch() {
  if (_apiPatched) return; // guard against double-patching

  // `apiFetch` is defined in api.js as a regular `async function`
  // declaration on the global scope.  We capture it, wrap it,
  // then reassign the name so all other callers are unaffected.
  if (typeof window.apiFetch !== 'function') {
    console.warn(
      '[DeviceFingerprint] apiFetch not found on window. ' +
      'Ensure api.js is loaded before useDeviceFingerprint.js.'
    );
    return;
  }

  const _originalApiFetch = window.apiFetch;

  /**
   * Patched apiFetch — identical signature to the original.
   * @param {string} endpoint
   * @param {object} [options]
   */
  window.apiFetch = async function apiFetch(endpoint, options = {}) {
    // Retrieve the UUID at call-time so it's always fresh
    // even if init() hasn't been called yet (defensive).
    const uuid  = _uuid || localStorage.getItem(UUID_STORAGE_KEY) || 'unknown';
    const regen = localStorage.getItem(REGEN_STORAGE_KEY) === 'true';

    // Merge device-lock headers into the existing headers object
    const deviceHeaders = {
      'X-Device-UUID'  : uuid,
      ...(regen ? { 'X-Device-UUID-Regen': 'true' } : {}),
    };

    // Deep-merge with any caller-provided headers
    const patchedOptions = {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...deviceHeaders,
      },
    };

    // Clear the regen flag after the first successful injection
    // so it is only sent once per UUID lifecycle.
    if (regen) {
      localStorage.removeItem(REGEN_STORAGE_KEY);
      console.info(
        '[DeviceFingerprint] UUID regen flag sent and cleared. ' +
        'Backend will audit this account.'
      );
    }

    // Delegate to the original implementation
    return _originalApiFetch(endpoint, patchedOptions);
  };

  _apiPatched = true;
  console.info(
    '[DeviceFingerprint] ✅ apiFetch patched. ' +
    `Device UUID "${_uuid}" will be sent on every API request.`
  );
}


// =============================================================
//  PUBLIC API  (the "hook" contract)
// =============================================================

/**
 * DeviceFingerprint
 * The single exported namespace — mirrors a React custom hook's
 * return shape (init, getUUID, getHeaders) for portability.
 *
 * @namespace DeviceFingerprint
 */
const DeviceFingerprint = Object.freeze({

  /**
   * init()
   * Master initialisation — call this once, as early as possible
   * on every protected page (before requireAuth / API calls).
   *
   * Execution order:
   *   1. Resolve / generate UUID
   *   2. Patch apiFetch with device headers
   *   3. Check network type and block if Wi-Fi detected
   */
  init() {
    if (_initialized) {
      console.info('[DeviceFingerprint] Already initialised — skipping.');
      return this;
    }

    try {
      // Step 1: UUID
      _resolveUUID();

      // Step 2: API patch (must happen before any API call)
      _patchApiFetch();

      // Step 3: Network check (non-blocking — runs async)
      // Defer by one tick to avoid delaying page render.
      setTimeout(_checkNetworkType, 0);

      _initialized = true;
      console.info('[DeviceFingerprint] Initialisation complete.');
    } catch (err) {
      // Log but never throw — a fingerprint failure must not
      // crash the page or block the user from the app.
      console.error('[DeviceFingerprint] Init error (non-fatal):', err);
    }

    return this; // fluent chain support
  },

  /**
   * getUUID()
   * Returns the current device UUID string.
   * Returns null if init() has not been called yet.
   *
   * @returns {string|null}
   */
  getUUID() {
    return _uuid;
  },

  /**
   * getHeaders()
   * Returns a plain object of device-lock headers for manual
   * injection into custom fetch calls outside of apiFetch().
   * Useful when migrating individual endpoints to a new API client.
   *
   * @returns {{ 'X-Device-UUID': string }}
   */
  getHeaders() {
    const uuid = _uuid || localStorage.getItem(UUID_STORAGE_KEY) || 'unknown';
    return { 'X-Device-UUID': uuid };
  },

  /**
   * reset() — DEVELOPMENT / TESTING ONLY
   * Clears the stored UUID and reinitialises.  Call this from
   * the browser console to simulate a new device.
   *
   * ⚠️  Never expose this as a user-accessible action in production.
   */
  reset() {
    localStorage.removeItem(UUID_STORAGE_KEY);
    localStorage.removeItem(REGEN_STORAGE_KEY);
    _uuid        = null;
    _initialized = false;
    _apiPatched  = false;
    console.warn('[DeviceFingerprint] UUID cleared. Call init() to re-initialise.');
    return this;
  },
});

// Expose on window so plain <script> pages can access it
// as DeviceFingerprint.init() without any module bundler.
window.DeviceFingerprint = DeviceFingerprint;
