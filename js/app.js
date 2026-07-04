/* =====================================================
   Student Pocket Filler — Shared Utilities (app.js)
   Toast, formatters, survey data, CPX config.
   Auth/localStorage functions are in api.js
===================================================== */

// ── Toast Notification ────────────────────────────────────────
function showToast(msg, duration = 3000) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

// ── Formatters ────────────────────────────────────────────────
function formatINR(amount) {
  return '₹' + parseFloat(amount || 0).toFixed(2);
}
function formatUSD(amount) {
  return '$' + parseFloat(amount || 0).toFixed(2);
}
function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Survey Catalogue ──────────────────────────────────────────
const SURVEYS = {
  quick: [
    { id: 'q1', name: 'Daily Habits Poll',        duration: '2-3 min',   grossINR: 26,  yourINR: 13,  icon: '⚡', type: 'quick' },
    { id: 'q2', name: 'Brand Awareness Check',    duration: '2-3 min',   grossINR: 30,  yourINR: 15,  icon: '🎯', type: 'quick' },
    { id: 'q3', name: 'App Usage Survey',         duration: '2-3 min',   grossINR: 24,  yourINR: 12,  icon: '📱', type: 'quick' },
    { id: 'q4', name: 'Food Preferences Poll',    duration: '2-3 min',   grossINR: 26,  yourINR: 13,  icon: '🍕', type: 'quick' },
  ],
  standard: [
    { id: 's1', name: 'Student Lifestyle Study',  duration: '10-15 min', grossINR: 105, yourINR: 52,  icon: '💼', type: 'standard' },
    { id: 's2', name: 'E-Commerce Habits',        duration: '10-15 min', grossINR: 115, yourINR: 57,  icon: '🛒', type: 'standard' },
    { id: 's3', name: 'Technology Usage Study',   duration: '12-15 min', grossINR: 120, yourINR: 60,  icon: '💻', type: 'standard' },
    { id: 's4', name: 'Social Media Behaviour',   duration: '10-12 min', grossINR: 100, yourINR: 50,  icon: '📸', type: 'standard' },
  ],
  mega: [
    { id: 'm1', name: 'Career & Future Goals',   duration: '25-30 min', grossINR: 262, yourINR: 131, icon: '🏆', type: 'mega' },
    { id: 'm2', name: 'Financial Literacy Study', duration: '25+ min',   grossINR: 300, yourINR: 150, icon: '💰', type: 'mega' },
    { id: 'm3', name: 'Campus Life Report',       duration: '30 min',    grossINR: 280, yourINR: 140, icon: '🎓', type: 'mega' },
  ]
};

function getAllSurveys() {
  return [...SURVEYS.quick, ...SURVEYS.standard, ...SURVEYS.mega];
}

// ── CPX Research Config ───────────────────────────────────────
const CPX_CONFIG = {
  appId: '34184',

  /**
   * Build the CPX Research survey wall URL for the iframe / new tab.
   * Appends the device UUID as subid_1 so postbacks can be correlated
   * to the session started by useDeviceFingerprint → /api/v1/request-survey.
   *
   * @param {string|number} userId   — the student's platform account ID
   * @returns {string}  full survey wall URL
   */
  getSurveyUrl(userId) {
    const uuid = (typeof DeviceFingerprint !== 'undefined')
      ? DeviceFingerprint.getUUID() || ''
      : '';

    const params = new URLSearchParams({
      app_id      : this.appId,
      ext_user_id : userId,
      subid_1     : uuid,            // device UUID — ties postback to hardware session
    });

    return `https://offers.cpx-research.com/index.php?${params.toString()}`;
  }
};
