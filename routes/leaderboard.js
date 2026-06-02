'use strict';
const express = require('express');
const db      = require('../db/db');

const router = express.Router();

/* ── Simple in-process cache ── */
const _cache = new Map();

function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  const data = fn();
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

function limitParam(req, def = 10, max = 50) {
  return Math.min(Math.max(1, parseInt(req.query.limit) || def), max);
}

/* ── GET /api/leaderboard/top-winners ──
   Players with the highest net profit (minimum 10 bets to qualify). */
router.get('/top-winners', (req, res) => {
  const limit = limitParam(req, 10, 50);
  const rows  = cached(`top-winners:${limit}`, 30_000, () =>
    db.prepare(`
      SELECT u.username,
             u.total_bets,
             u.total_wins,
             ROUND(u.total_wins * 100.0 / NULLIF(u.total_bets, 0), 1) AS win_rate,
             u.biggest_win,
             ROUND(COALESCE((SELECT SUM(profit) FROM bets WHERE user_id = u.id), 0), 2) AS net_profit
      FROM   users u
      WHERE  u.total_bets >= 10
      ORDER  BY net_profit DESC
      LIMIT  ?
    `).all(limit)
  );
  res.json(rows);
});

/* ── GET /api/leaderboard/high-rollers ──
   Players ordered by total amount wagered. */
router.get('/high-rollers', (req, res) => {
  const limit = limitParam(req, 10, 50);
  const rows  = cached(`high-rollers:${limit}`, 30_000, () =>
    db.prepare(`
      SELECT username,
             total_bets,
             total_wagered,
             biggest_win,
             ROUND(total_wins * 100.0 / NULLIF(total_bets, 0), 1) AS win_rate
      FROM   users
      WHERE  total_bets >= 5
      ORDER  BY total_wagered DESC
      LIMIT  ?
    `).all(limit)
  );
  res.json(rows);
});

/* ── GET /api/leaderboard/big-wins ──
   All-time top individual winning bets ranked by profit. */
router.get('/big-wins', (req, res) => {
  const limit = limitParam(req, 20, 100);
  const rows  = cached(`big-wins:${limit}`, 15_000, () =>
    db.prepare(`
      SELECT b.id,
             u.username,
             b.game,
             b.emoji,
             b.bet_amount,
             b.multiplier,
             b.payout,
             b.profit,
             b.created_at
      FROM   bets b
      JOIN   users u ON u.id = b.user_id
      WHERE  b.is_win = 1 AND b.profit > 0
      ORDER  BY b.profit DESC
      LIMIT  ?
    `).all(limit)
  );
  res.json(rows);
});

/* ── GET /api/leaderboard/recent ──
   Live feed of the most recent bets (public, usernames only). */
router.get('/recent', (req, res) => {
  const limit = limitParam(req, 20, 50);
  const rows  = cached(`recent:${limit}`, 5_000, () =>
    db.prepare(`
      SELECT b.id,
             u.username,
             b.game,
             b.emoji,
             b.bet_amount,
             b.is_win,
             b.multiplier,
             b.payout,
             b.profit,
             b.created_at
      FROM   bets b
      JOIN   users u ON u.id = b.user_id
      ORDER  BY b.created_at DESC, b.id DESC
      LIMIT  ?
    `).all(limit)
  );
  res.json(rows);
});

/* ── GET /api/leaderboard/stats ──
   Platform-wide aggregate stats (total bets, volume, players). */
router.get('/stats', (_req, res) => {
  const data = cached('platform-stats', 60_000, () =>
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users)            AS total_players,
        (SELECT COUNT(*) FROM bets)             AS total_bets,
        ROUND((SELECT SUM(bet_amount) FROM bets), 2) AS total_wagered,
        ROUND((SELECT MAX(profit) FROM bets), 2)     AS biggest_win_ever,
        (SELECT COUNT(*) FROM users WHERE last_seen > unixepoch() - 3600) AS active_last_hour
    `).get()
  );
  res.json(data);
});

module.exports = router;
