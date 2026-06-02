'use strict';
const express     = require('express');
const db          = require('../db/db');
const liveEvents  = require('../lib/liveEvents');

const router = express.Router();

/* ── GET /api/live/feed ──
   Server-Sent Events stream. Sends recent bet history on connect, then pushes
   each new bet as it lands. No auth required — usernames are already public
   on the leaderboard. Clients should reconnect automatically (EventSource does this). */
router.get('/feed', (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',  // disable Nginx proxy buffering
  });
  res.flushHeaders();

  /* Warm up with the 20 most recent bets */
  try {
    const recent = db.prepare(`
      SELECT b.id, u.username, b.game, b.emoji,
             b.bet_amount AS betAmount, b.is_win AS isWin,
             b.multiplier, b.payout, b.profit, b.created_at
      FROM   bets b
      JOIN   users u ON u.id = b.user_id
      ORDER  BY b.created_at DESC, b.id DESC
      LIMIT  20
    `).all();
    res.write(`data: ${JSON.stringify({ type: 'history', bets: recent })}\n\n`);
  } catch (e) {
    console.error('[sse] history error:', e.message);
  }

  /* Forward live bet events to this client */
  const onBet = (bet) => {
    try { res.write(`data: ${JSON.stringify({ type: 'bet', bet })}\n\n`); }
    catch { /* client already disconnected */ }
  };
  liveEvents.on('bet', onBet);

  /* Heartbeat every 25 s keeps the connection alive through load-balancer timeouts */
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    liveEvents.off('bet', onBet);
    clearInterval(heartbeat);
  });
});

/* ── GET /api/live/stats ──
   Real-time platform counters: total players, recent-hour actives, biggest wins. */
router.get('/stats', (_req, res) => {
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users)                                              AS total_players,
      (SELECT COUNT(*) FROM users WHERE last_seen > unixepoch() - 3600)        AS active_last_hour,
      (SELECT COUNT(*) FROM users WHERE last_seen > unixepoch() - 300)         AS active_last_5min,
      (SELECT COUNT(*) FROM bets)                                               AS total_bets,
      ROUND(COALESCE((SELECT SUM(bet_amount) FROM bets), 0), 2)                AS total_wagered,
      ROUND(COALESCE((SELECT MAX(profit)     FROM bets), 0), 2)                AS biggest_win_ever
  `).get();
  res.json(stats);
});

module.exports = router;
