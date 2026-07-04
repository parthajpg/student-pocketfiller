// routes/wallet.js — Wallet info, transactions, withdraw
const router = require('express').Router();
const { pool } = require('../db');
const authMiddleware = require('../middleware/auth');

// ── GET /api/wallet ──────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const [userRes, pendingRes] = await Promise.all([
      pool.query(
        'SELECT wallet_balance, total_earned, surveys_completed FROM users WHERE id = $1',
        [req.user.id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount_inr), 0) AS pending_amount
         FROM survey_codes WHERE user_id = $1 AND status = 'pending'`,
        [req.user.id]
      )
    ]);

    res.json({
      ...userRes.rows[0],
      pending_amount: parseFloat(pendingRes.rows[0].pending_amount)
    });
  } catch (err) {
    console.error('Wallet error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/wallet/transactions ─────────────────────────────
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Transactions error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/wallet/withdraw ────────────────────────────────
router.post('/withdraw', authMiddleware, async (req, res) => {
  const { upiId, amount } = req.body;
  const amt = parseFloat(amount);

  if (!upiId || !upiId.trim()) {
    return res.status(400).json({ error: 'UPI ID is required.' });
  }
  if (!amt || amt < 50) {
    return res.status(400).json({ error: 'Minimum withdrawal amount is ₹50.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock user row to prevent race conditions
    const userRes = await client.query(
      'SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    const balance = parseFloat(userRes.rows[0].wallet_balance);

    if (amt > balance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient balance. Available: ₹${balance.toFixed(2)}` });
    }

    // Deduct from wallet & save UPI
    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance - $1, upi_id = $2, updated_at = NOW() WHERE id = $3',
      [amt, upiId.trim(), req.user.id]
    );

    // Create withdrawal record
    const wdRes = await client.query(
      'INSERT INTO withdrawals (user_id, upi_id, amount) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, upiId.trim(), amt]
    );

    // Create transaction record
    await client.query(
      `INSERT INTO transactions (user_id, amount, type, note, status)
       VALUES ($1, $2, 'debit', $3, 'pending')`,
      [req.user.id, amt, `Withdrawal to UPI: ${upiId.trim()}`]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Withdrawal requested! We\'ll process within 24 hours.',
      withdrawal: wdRes.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  } finally {
    client.release();
  }
});

module.exports = router;
