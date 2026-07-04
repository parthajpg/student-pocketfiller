// routes/postback.js — CPX Research server-to-server postback
// CPX calls: GET /api/postback?user_id=X&trans_id=Y&amount=Z&status=1&hash=H
const router = require('express').Router();
const crypto = require('crypto');
const { pool } = require('../db');

const INR_RATE   = 87.5;   // USD to INR conversion rate (update periodically)
const USER_SHARE = 0.5;    // 50% goes to student

router.get('/', async (req, res) => {
  const { user_id, trans_id, amount, status, hash } = req.query;

  // ── 1. Validate required params ──────────────────────────
  if (!user_id || !trans_id || !amount || !status || !hash) {
    console.warn('CPX Postback: Missing params', req.query);
    return res.status(400).send('missing_params');
  }

  // ── 2. Verify HMAC hash signature ─────────────────────────
  const expectedHash = crypto
    .createHash('md5')
    .update(trans_id + (process.env.CPX_HASH_KEY || ''))
    .digest('hex');

  if (hash !== expectedHash) {
    console.warn(`CPX Postback: Invalid hash for trans_id=${trans_id}`);
    return res.status(403).send('invalid_hash');
  }

  const amountINR = parseFloat(amount) * INR_RATE * USER_SHARE;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (status === '1') {
      // ── Survey Completed ─────────────────────────────────
      // Dedup: only process each trans_id once
      const dup = await client.query(
        'INSERT INTO cpx_postbacks (trans_id, user_id, amount_inr, status) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING trans_id',
        [trans_id, user_id, amountINR, 'completed']
      );
      if (!dup.rows.length) {
        await client.query('ROLLBACK');
        console.log(`CPX Postback: Already processed trans_id=${trans_id}`);
        return res.send('1'); // Still return success to CPX
      }

      // Verify user exists
      const userRes = await client.query('SELECT id FROM users WHERE id = $1', [user_id]);
      if (!userRes.rows.length) {
        await client.query('ROLLBACK');
        console.warn(`CPX Postback: Unknown user_id=${user_id}`);
        return res.status(404).send('user_not_found');
      }

      // Credit wallet
      await client.query(
        `UPDATE users
         SET wallet_balance    = wallet_balance    + $1,
             total_earned      = total_earned      + $1,
             surveys_completed = surveys_completed + 1,
             updated_at        = NOW()
         WHERE id = $2`,
        [amountINR, user_id]
      );
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, note, status)
         VALUES ($1, $2, 'credit', $3, 'approved')`,
        [user_id, amountINR, `CPX Survey Completed (trans: ${trans_id})`]
      );
      console.log(`CPX Postback: ✅ Credited ₹${amountINR.toFixed(2)} to user ${user_id}`);

    } else if (status === '2') {
      // ── Survey Reversed ──────────────────────────────────
      await client.query(
        'INSERT INTO cpx_postbacks (trans_id, user_id, amount_inr, status) VALUES ($1, $2, $3, $4) ON CONFLICT (trans_id) DO UPDATE SET status = $4',
        [trans_id, user_id, amountINR, 'reversed']
      );

      await client.query(
        `UPDATE users
         SET wallet_balance = GREATEST(0, wallet_balance - $1),
             total_earned   = GREATEST(0, total_earned   - $1),
             updated_at     = NOW()
         WHERE id = $2`,
        [amountINR, user_id]
      );
      await client.query(
        `INSERT INTO transactions (user_id, amount, type, note, status)
         VALUES ($1, $2, 'debit', $3, 'reversed')`,
        [user_id, amountINR, `CPX Survey Reversed (trans: ${trans_id})`]
      );
      console.log(`CPX Postback: ⚠️ Reversed ₹${amountINR.toFixed(2)} for user ${user_id}`);
    }

    await client.query('COMMIT');
    res.send('1'); // CPX Research expects '1' as success response
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('CPX Postback error:', err);
    res.status(500).send('error');
  } finally {
    client.release();
  }
});

module.exports = router;
