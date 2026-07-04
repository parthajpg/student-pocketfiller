/* =====================================================
   Student Pocket Filler — API Layer (api.js)
   All HTTP calls to the backend go through this file.
   Change RENDER_URL below after deploying to Render.
===================================================== */

// ── CONFIG ────────────────────────────────────────────────────
// Replace 'YOUR-APP-NAME' with your actual Render app name.
// Find it at: https://dashboard.render.com → your Web Service → URL
const RENDER_URL = 'https://student-pocketfiller.onrender.com';

const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3001'
  : RENDER_URL;

// ── Core fetch wrapper ────────────────────────────────────────
async function apiFetch(endpoint, options = {}) {
  const token = localStorage.getItem('spf_token');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(API_BASE + endpoint, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });

  let data;
  try { data = await res.json(); }
  catch { data = { error: 'Invalid server response' }; }

  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ── Auth ──────────────────────────────────────────────────────
const API = {
  // Auth
  register:       (body) => apiFetch('/api/auth/register',  { method: 'POST', body: JSON.stringify(body) }),
  login:          (body) => apiFetch('/api/auth/login',     { method: 'POST', body: JSON.stringify(body) }),
  me:             ()     => apiFetch('/api/auth/me'),
  updateUpi:      (upiId) => apiFetch('/api/auth/update-upi', { method: 'PUT', body: JSON.stringify({ upiId }) }),

  // Surveys
  submitCode:     (body) => apiFetch('/api/surveys/submit-code', { method: 'POST', body: JSON.stringify(body) }),
  mySubmissions:  ()     => apiFetch('/api/surveys/my-submissions'),
  leaderboard:    ()     => apiFetch('/api/surveys/leaderboard'),

  // Wallet
  wallet:         ()     => apiFetch('/api/wallet'),
  transactions:   ()     => apiFetch('/api/wallet/transactions'),
  withdraw:       (body) => apiFetch('/api/wallet/withdraw', { method: 'POST', body: JSON.stringify(body) }),

  // Admin
  adminDashboard:     ()    => apiFetch('/api/admin/dashboard'),
  adminCodes:         (s)   => apiFetch('/api/admin/codes' + (s ? `?status=${s}` : '')),
  approveCode:        (id)  => apiFetch(`/api/admin/codes/${id}/approve`,         { method: 'PUT' }),
  rejectCode:         (id)  => apiFetch(`/api/admin/codes/${id}/reject`,          { method: 'PUT' }),
  adminWithdrawals:   ()    => apiFetch('/api/admin/withdrawals'),
  markPaid:           (id)  => apiFetch(`/api/admin/withdrawals/${id}/pay`,       { method: 'PUT' }),
  rejectWithdrawal:   (id)  => apiFetch(`/api/admin/withdrawals/${id}/reject`,    { method: 'PUT' }),
  adminUsers:         ()    => apiFetch('/api/admin/users'),
};

// ── Auth helpers ──────────────────────────────────────────────

/** Call on every protected page. Returns user or null (and redirects). */
async function requireAuth(role = 'student') {
  const token = localStorage.getItem('spf_token');
  if (!token) { window.location.href = 'index.html'; return null; }

  try {
    const user = await API.me();
    if (role === 'admin' && user.role !== 'admin') {
      showToast('Admin access required ❌');
      window.location.href = 'index.html';
      return null;
    }
    return user;
  } catch {
    localStorage.removeItem('spf_token');
    window.location.href = 'index.html';
    return null;
  }
}

function saveToken(token) { localStorage.setItem('spf_token', token); }
function logout() {
  localStorage.removeItem('spf_token');
  window.location.href = 'index.html';
}
