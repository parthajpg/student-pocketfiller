// routes/auth.js — Register, Login, Me
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { pool } = require('../db');
const authMiddleware           = require('../middleware/auth');
const { deviceLockCheck }      = require('../middleware/deviceLock');

const SAFE_COLS = 'id, name, email, phone, college, upi_id, wallet_balance, total_earned, surveys_completed, role, created_at';

function makeToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ── POST /api/auth/register ──────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, college } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, phone, college)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SAFE_COLS}`,
      [name.trim(), email.toLowerCase().trim(), hash, phone || null, college || null]
    );

    const user = rows[0];
    res.status(201).json({ user, token: makeToken(user) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This email is already registered. Please login.' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const { rows } = await pool.query(
      `SELECT *, ${SAFE_COLS} FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, token: makeToken(safeUser) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── GET /api/auth/me ────────────────────────────────────────────
// deviceLockCheck runs on every page-load (requireAuth calls /me)
// giving us full hardware-UUID coverage without patching every route.
router.get('/me', authMiddleware, deviceLockCheck, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLS} FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    // Attach fraud flag to response header for admin tooling (not visible to users)
    if (req.deviceFraudFlag) {
      res.setHeader('X-Device-Fraud-Flag', 'true');
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── PUT /api/auth/update-upi ─────────────────────────────────
router.put('/update-upi', authMiddleware, async (req, res) => {
  try {
    const { upiId } = req.body;
    if (!upiId) return res.status(400).json({ error: 'UPI ID is required.' });

    await pool.query('UPDATE users SET upi_id = $1, updated_at = NOW() WHERE id = $2', [upiId, req.user.id]);
    res.json({ message: 'UPI ID updated successfully.' });
  } catch (err) {
    console.error('Update UPI error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
