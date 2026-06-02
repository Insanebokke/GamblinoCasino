'use strict';
const db = require('../db/db');

const BET_WINDOW_SEC   = 60;
const MAX_BETS_PER_MIN = 60;

/* ── Bet velocity check ──
   Rejects requests if the authenticated user has placed >= 60 bets in the last minute.
   This prevents scripted rapid-fire betting that exploits floating-point timing. */
function betVelocity(req, res, next) {
  if (!req.userId) return next();
  const since = Math.floor(Date.now() / 1000) - BET_WINDOW_SEC;
  const { cnt } = db.prepare(
    `SELECT COUNT(*) AS cnt FROM bets WHERE user_id = ? AND created_at > ?`
  ).get(req.userId, since);
  if (cnt >= MAX_BETS_PER_MIN) {
    return res.status(429).json({ error: 'Too many bets — slow down' });
  }
  next();
}

/* ── Suspicious win-rate audit ──
   Called asynchronously (setImmediate) after every settled bet.
   Flags users whose win rate is statistically impossible given the house edge. */
function auditWinRate(userId) {
  try {
    const user = db.prepare(
      `SELECT total_bets, total_wins FROM users WHERE id = ?`
    ).get(userId);
    if (!user || user.total_bets < 100) return; // need a meaningful sample
    const rate = user.total_wins / user.total_bets;
    // >70% sustained win rate against 1% house edge is a red flag
    if (rate > 0.70) {
      db.prepare(
        `INSERT OR IGNORE INTO fraud_flags (user_id, reason) VALUES (?, ?)`
      ).run(userId, `High win rate: ${(rate * 100).toFixed(1)}% over ${user.total_bets} bets`);
    }
  } catch (e) {
    console.error('[security] auditWinRate error:', e.message);
  }
}

/* ── Large-bet alert ──
   Logs (and optionally flags) bets above a configurable threshold.
   Extend this to send webhook alerts in production. */
const LARGE_BET_USD = parseFloat(process.env.LARGE_BET_THRESHOLD ?? '5000');

function auditLargeBet(userId, betAmount, game) {
  if (betAmount < LARGE_BET_USD) return;
  console.warn(`[security] large-bet: user=${userId} amount=$${betAmount} game=${game}`);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO fraud_flags (user_id, reason) VALUES (?, ?)`
    ).run(userId, `Large single bet: $${betAmount} on ${game}`);
  } catch (e) {
    console.error('[security] auditLargeBet error:', e.message);
  }
}

/* ── Duplicate withdrawal guard ──
   Extra check beyond the route-level pending check — verifies same amount+address
   wasn't submitted twice within 5 minutes (catches race conditions). */
function checkWithdrawDuplicate(req, res, next) {
  if (!req.userId) return next();
  const { address, amount_usd } = req.body ?? {};
  if (!address || !amount_usd) return next();
  const since = Math.floor(Date.now() / 1000) - 300; // 5 min
  const dup = db.prepare(
    `SELECT id FROM withdrawals WHERE user_id = ? AND address = ? AND amount_usd = ? AND created_at > ?`
  ).get(req.userId, address, parseFloat(amount_usd), since);
  if (dup) {
    return res.status(409).json({
      error: 'Identical withdrawal submitted recently — please wait before retrying',
      withdrawalId: dup.id,
    });
  }
  next();
}

module.exports = { betVelocity, auditWinRate, auditLargeBet, checkWithdrawDuplicate };
