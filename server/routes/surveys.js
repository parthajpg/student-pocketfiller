// routes/surveys.js — Survey code submission + leaderboard
const router = require('express').Router();
const { pool } = require('../db');
const authMiddleware = require('../middleware/auth');

// ── POST /api/surveys/submit-code ───────────────────────────
router.post('/submit-code', authMiddleware, async (req, res) => {
  try {
    const { surveyId, surveyName, surveyType, completionCode, amountInr } = req.body;

    if (!surveyId || !surveyName || !surveyType || !completionCode || !amountInr) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!['quick', 'standard', 'mega'].includes(surveyType)) {
      return res.status(400).json({ error: 'Invalid survey type.' });
    }
    if (parseFloat(amountInr) <= 0) {
      return res.status(400).json({ error: 'Invalid amount.' });
    }

    const code = completionCode.trim().toUpperCase();

    const { rows } = await pool.query(
      `INSERT INTO survey_codes (user_id, survey_id, survey_name, survey_type, completion_code, amount_inr)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.id, surveyId, surveyName, surveyType, code, parseFloat(amountInr)]
    );

    res.status(201).json({
      message: 'Code submitted! We\'ll verify within 24 hours and credit your wallet.',
      submission: rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already submitted this code.' });
    }
    console.error('Submit code error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── GET /api/surveys/my-submissions ─────────────────────────
router.get('/my-submissions', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM survey_codes WHERE user_id = $1 ORDER BY submitted_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('My submissions error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/surveys/leaderboard ────────────────────────────
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, college, total_earned, surveys_completed
       FROM users
       WHERE role = 'student'
       ORDER BY total_earned DESC
       LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
