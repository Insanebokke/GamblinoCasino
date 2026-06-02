const express     = require('express');
const bcrypt      = require('bcrypt');
const db          = require('../db/db');
const requireAuth = require('../middleware/auth');
const liveEvents  = require('../lib/liveEvents');

const SAFE_COLS = 'id, username, email, balance, total_bets, total_wins, total_wagered, biggest_win, created_at, last_seen';

const router = express.Router();

/* ── GET /api/user/balance ── */
router.get('/balance', requireAuth, (req, res) => {
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ balance: user.balance });
});

/* ── POST /api/user/bets ── */
router.post('/bets', requireAuth, (req, res) => {
  const { game, emoji, betAmount, isWin, multiplier, payout } = req.body ?? {};

  if (!game || typeof betAmount !== 'number' || betAmount <= 0)
    return res.status(400).json({ error: 'Invalid bet payload' });

  const grossPayout = isWin && typeof payout === 'number' ? payout : 0;
  const profit = isWin ? grossPayout - betAmount : -betAmount;

  let newBalance, betId;

  const txn = db.transaction(() => {
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.userId);
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    if (user.balance < betAmount - 0.001)
      throw Object.assign(new Error('Insufficient balance'), { statusCode: 400 });

    newBalance = Math.max(0, Math.round((user.balance + profit) * 100) / 100);

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO bets (user_id, game, emoji, bet_amount, is_win, multiplier, payout, profit, balance_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.userId, game, emoji ?? '', betAmount, isWin ? 1 : 0, multiplier ?? 0, grossPayout, profit, newBalance);

    db.prepare(`
      UPDATE users SET
        balance       = ?,
        total_bets    = total_bets + 1,
        total_wins    = total_wins + ?,
        total_wagered = total_wagered + ?,
        biggest_win   = MAX(biggest_win, ?),
        last_seen     = unixepoch()
      WHERE id = ?
    `).run(newBalance, isWin ? 1 : 0, betAmount, Math.max(0, profit), req.userId);

    betId = lastInsertRowid;
  });

  try {
    txn();
    res.status(201).json({ id: betId, balance: newBalance });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }

  /* Emit live event so SSE feed updates in real time */
  setImmediate(() => {
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId);
    if (u) {
      liveEvents.emit('bet', {
        username:  u.username,
        game,
        emoji:     emoji || '🎲',
        betAmount: betAmount,
        isWin:     !!isWin,
        multiplier: multiplier ?? 0,
        payout:    grossPayout,
        profit,
      });
    }
  });
});

/* ── GET /api/user/bets ── */
router.get('/bets', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const bets = db.prepare(`
    SELECT * FROM bets WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(req.userId, limit);
  res.json(bets);
});

/* ── GET /api/user/transactions ── */
router.get('/transactions', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const uid = req.userId;
  const rows = db.prepare(`
    SELECT 'bet' AS type, id, game AS label, emoji, profit AS amount, balance_after, created_at
    FROM bets WHERE user_id = ?
    UNION ALL
    SELECT 'deposit' AS type, id, coin AS label, '' AS emoji, amount_usd AS amount,
           NULL AS balance_after, COALESCE(confirmed_at, created_at) AS created_at
    FROM deposits WHERE user_id = ? AND status = 'completed'
    UNION ALL
    SELECT 'withdrawal' AS type, id, coin AS label, '' AS emoji, -net_usd AS amount,
           NULL AS balance_after, COALESCE(processed_at, created_at) AS created_at
    FROM withdrawals WHERE user_id = ? AND status = 'completed'
    ORDER BY created_at DESC LIMIT ?
  `).all(uid, uid, uid, limit);
  res.json(rows);
});

/* ── GET /api/user/stats ── */
router.get('/stats', requireAuth, (req, res) => {
  const overview = db.prepare(`
    SELECT
      total_bets, total_wins, total_wagered, biggest_win,
      ROUND(total_wins * 100.0 / NULLIF(total_bets, 0), 1) AS win_rate,
      COALESCE((SELECT SUM(profit) FROM bets WHERE user_id = ?), 0) AS net_profit
    FROM users WHERE id = ?
  `).get(req.userId, req.userId);

  const byGame = db.prepare(`
    SELECT
      game, emoji,
      COUNT(*)                                          AS count,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END)      AS wins,
      ROUND(SUM(profit), 2)                             AS net_profit,
      MAX(profit)                                       AS best_win
    FROM bets WHERE user_id = ?
    GROUP BY game
    ORDER BY count DESC
  `).all(req.userId);

  res.json({ ...overview, gameBreakdown: byGame });
});

/* ── PATCH /api/user/profile ── */
router.patch('/profile', requireAuth, (req, res) => {
  const { username } = req.body ?? {};
  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 3–20 characters' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username))
    return res.status(400).json({ error: 'Only letters, numbers, _ . - allowed' });

  try {
    db.prepare('UPDATE users SET username = ?, last_seen = unixepoch() WHERE id = ?')
      .run(username.trim(), req.userId);
    const user = db.prepare(`SELECT ${SAFE_COLS} FROM users WHERE id = ?`).get(req.userId);
    res.json(user);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── PATCH /api/user/password ── */
router.patch('/password', requireAuth, async (req, res) => {
  const { current, newPassword } = req.body ?? {};
  if (!current || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.userId);
  const valid = await bcrypt.compare(current, row.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, last_seen = unixepoch() WHERE id = ?')
    .run(hash, req.userId);
  res.json({ ok: true });
});

module.exports = router;
