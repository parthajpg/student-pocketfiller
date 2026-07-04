// routes/admin.js — Admin dashboard, code review, withdrawals, users
const router = require('express').Router();
const { pool } = require('../db');
const authMiddleware           = require('../middleware/auth');
const { adminOnly }            = require('../middleware/auth');
const { getDeviceFraudLog,
        getDeviceRegistry }    = require('../middleware/deviceLock');

// All admin routes require auth + admin role
router.use(authMiddleware, adminOnly);

// ── GET /api/admin/dashboard ─────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const [users, pendingCodes, approvedCodes, pendingWd] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users WHERE role = 'student'"),
      pool.query("SELECT COUNT(*) FROM survey_codes WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*), COALESCE(SUM(amount_inr), 0) AS total FROM survey_codes WHERE status = 'approved'"),
      pool.query("SELECT COUNT(*), COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'pending'"),
    ]);

    res.json({
      totalUsers:           parseInt(users.rows[0].count),
      pendingCodes:         parseInt(pendingCodes.rows[0].count),
      approvedSurveys:      parseInt(approvedCodes.rows[0].count),
      platformRevenue:      parseFloat(approvedCodes.rows[0].total),   // 50% share paid to students = same as platform revenue
      pendingWithdrawals:   parseInt(pendingWd.rows[0].count),
      pendingWithdrawalAmt: parseFloat(pendingWd.rows[0].total),
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/admin/codes ─────────────────────────────────────
router.get('/codes', async (req, res) => {
  try {
    const { status } = req.query; // optional filter: ?status=pending
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE sc.status = $1';
    }

    const { rows } = await pool.query(
      `SELECT sc.*, u.name AS user_name, u.phone AS user_phone, u.email AS user_email
       FROM survey_codes sc
       JOIN users u ON sc.user_id = u.id
       ${where}
       ORDER BY sc.submitted_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin codes error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── PUT /api/admin/codes/:id/approve ────────────────────────
router.put('/codes/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const codeRes = await client.query(
      'SELECT * FROM survey_codes WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!codeRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Submission not found.' });
    }
    const code = codeRes.rows[0];
    if (code.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This submission is already ${code.status}.` });
    }

    // Mark code approved
    await client.query(
      "UPDATE survey_codes SET status = 'approved', reviewed_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    // Credit student's wallet
    await client.query(
      `UPDATE users
       SET wallet_balance    = wallet_balance    + $1,
           total_earned      = total_earned      + $1,
           surveys_completed = surveys_completed + 1,
           updated_at        = NOW()
       WHERE id = $2`,
      [code.amount_inr, code.user_id]
    );

    // Add to transaction ledger
    await client.query(
      `INSERT INTO transactions (user_id, amount, type, note, status)
       VALUES ($1, $2, 'credit', $3, 'approved')`,
      [code.user_id, code.amount_inr, `Survey Completed: ${code.survey_name}`]
    );

    await client.query('COMMIT');
    res.json({ message: `Approved! ₹${code.amount_inr} credited to student.` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Approve code error:', err);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    client.release();
  }
});

// ── PUT /api/admin/codes/:id/reject ─────────────────────────
router.put('/codes/:id/reject', async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE survey_codes SET status = 'rejected', reviewed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id",
      [req.params.id]
    );
    if (!result.rowCount) {
      return res.status(400).json({ error: 'Submission not found or already processed.' });
    }
    res.json({ message: 'Submission rejected.' });
  } catch (err) {
    console.error('Reject code error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/admin/withdrawals ───────────────────────────────
router.get('/withdrawals', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.*, u.name AS user_name, u.phone AS user_phone
       FROM withdrawals w
       JOIN users u ON w.user_id = u.id
       ORDER BY w.requested_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin withdrawals error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── PUT /api/admin/withdrawals/:id/pay ───────────────────────
router.put('/withdrawals/:id/pay', async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE withdrawals SET status = 'paid', processed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *",
      [req.params.id]
    );
    if (!result.rowCount) {
      return res.status(400).json({ error: 'Withdrawal not found or already processed.' });
    }
    res.json({ message: 'Marked as paid!', withdrawal: result.rows[0] });
  } catch (err) {
    console.error('Mark paid error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── PUT /api/admin/withdrawals/:id/reject ────────────────────
router.put('/withdrawals/:id/reject', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const wdRes = await client.query(
      "SELECT * FROM withdrawals WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [req.params.id]
    );
    if (!wdRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Withdrawal not found or already processed.' });
    }
    const wd = wdRes.rows[0];

    // Reject withdrawal
    await client.query(
      "UPDATE withdrawals SET status = 'rejected', processed_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    // Refund the amount back to user wallet
    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [wd.amount, wd.user_id]
    );
    await client.query(
      "INSERT INTO transactions (user_id, amount, type, note, status) VALUES ($1, $2, 'credit', $3, 'approved')",
      [wd.user_id, wd.amount, 'Withdrawal Refunded (Rejected)']
    );

    await client.query('COMMIT');
    res.json({ message: 'Withdrawal rejected and amount refunded to user.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reject withdrawal error:', err);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    client.release();
  }
});

// ── GET /api/admin/users ─────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, college, upi_id,
              wallet_balance, total_earned, surveys_completed, created_at
       FROM users
       WHERE role = 'student'
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/admin/device-fraud-log ──────────────────────────
// Returns every fraud event detected by deviceLockCheck:
//   DUPLICATE_DEVICE_UUID — two accounts on one device
//   UUID_REGEN_DETECTED   — user cleared localStorage
router.get('/device-fraud-log', (req, res) => {
  try {
    const log = getDeviceFraudLog();
    res.json({ total: log.length, events: log });
  } catch (err) {
    console.error('Admin device-fraud-log error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/admin/device-registry ──────────────────────────
// Returns all registered device UUID → user mappings.
// Flagged entries indicate detected fraud.
router.get('/device-registry', (req, res) => {
  try {
    const registry = getDeviceRegistry();
    const flagged  = registry.filter(r => r.flagged);
    res.json({
      totalDevices  : registry.length,
      flaggedDevices: flagged.length,
      registry,
    });
  } catch (err) {
    console.error('Admin device-registry error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
