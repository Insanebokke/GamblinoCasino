'use strict';
const express     = require('express');
const db          = require('../db/db');
const requireAuth = require('../middleware/auth');
const { checkWithdrawDuplicate } = require('../middleware/security');
const { createNotification }     = require('../lib/notify');

const router = express.Router();

/* ── Supported coins ── */
const COINS = {
  BTC: { name: 'Bitcoin',  network: 'Bitcoin Network',  minAmount: 20,  feeUsd: 2.50 },
  ETH: { name: 'Ethereum', network: 'Ethereum Mainnet', minAmount: 15,  feeUsd: 1.80 },
  SOL: { name: 'Solana',   network: 'Solana Mainnet',   minAmount: 10,  feeUsd: 0.50 },
};

/* ── Withdrawal address format validation ── */
const ADDR_RE = {
  BTC: /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,87}$/,
  ETH: /^0x[a-fA-F0-9]{40}$/,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

/* ── Audit log ── */
function audit(userId, action, details) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)`)
      .run(userId, action, JSON.stringify(details));
  } catch (e) {
    console.error('[audit]', e.message);
  }
}

/* ── POST /api/withdraw ── */
router.post('/', requireAuth, checkWithdrawDuplicate, (req, res) => {
  const { coin, address, amount_usd } = req.body ?? {};

  if (!COINS[coin])
    return res.status(400).json({ error: 'Unsupported cryptocurrency' });

  const usd = parseFloat(amount_usd);
  if (!isFinite(usd) || usd < COINS[coin].minAmount || usd > 50000)
    return res.status(400).json({
      error: `Amount must be between $${COINS[coin].minAmount} and $50,000`,
    });

  if (!address || typeof address !== 'string')
    return res.status(400).json({ error: 'Wallet address is required' });

  const re = ADDR_RE[coin];
  if (re && !re.test(address.trim()))
    return res.status(400).json({ error: `Invalid ${coin} wallet address format` });

  const feeUsd = COINS[coin].feeUsd;
  const netUsd = Math.round((usd - feeUsd) * 100) / 100;
  if (netUsd <= 0)
    return res.status(400).json({ error: 'Amount too small after network fee' });

  /* Anti-spam: one active withdrawal at a time */
  const pending = db.prepare(
    `SELECT id FROM withdrawals WHERE user_id = ? AND status IN ('pending_review','approved') LIMIT 1`
  ).get(req.userId);
  if (pending)
    return res.status(409).json({
      error: 'You already have a pending withdrawal under review',
      withdrawalId: pending.id,
    });

  /* Anti-spam: max 3 withdrawals per 24 hours */
  const recentCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM withdrawals WHERE user_id = ? AND created_at > unixepoch() - 86400`
  ).get(req.userId).cnt;
  if (recentCount >= 3)
    return res.status(429).json({ error: 'Maximum 3 withdrawals per 24 hours' });

  /* Atomically deduct balance and record withdrawal */
  let withdrawalId;
  try {
    db.transaction(() => {
      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.userId);
      if (!user || user.balance < usd) {
        const err = new Error('Insufficient balance');
        err.statusCode = 400;
        throw err;
      }
      db.prepare('UPDATE users SET balance = balance - ?, last_seen = unixepoch() WHERE id = ?')
        .run(usd, req.userId);
      const { lastInsertRowid } = db.prepare(
        `INSERT INTO withdrawals (user_id, coin, address, amount_usd, fee_usd, net_usd, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_review')`
      ).run(req.userId, coin, address.trim(), usd, feeUsd, netUsd);
      withdrawalId = lastInsertRowid;
    })();
  } catch (err) {
    if (err.statusCode === 400)
      return res.status(400).json({ error: err.message });
    console.error('[withdraw]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  audit(req.userId, 'withdrawal_requested', {
    withdrawalId, coin, address: address.trim(), amountUsd: usd, feeUsd, netUsd,
  });

  createNotification(req.userId, 'withdraw', 'Withdrawal Request Received 📋',
    `Your ${coin} withdrawal of $${netUsd.toFixed(2)} is under review. We will process it within 24 hours.`);

  const newBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.userId)?.balance ?? 0;

  res.status(201).json({
    id: withdrawalId,
    coin,
    address: address.trim(),
    amount_usd: usd,
    fee_usd:    feeUsd,
    net_usd:    netUsd,
    status:     'pending_review',
    balance:    newBalance,
    estimated_processing: '24 hours',
  });
});

/* ── GET /api/withdraw/:id/status ── */
router.get('/:id/status', requireAuth, (req, res) => {
  const w = db.prepare(
    `SELECT id, coin, address, amount_usd, fee_usd, net_usd, tx_hash, status, failure_reason, created_at, processed_at
     FROM withdrawals WHERE id = ? AND user_id = ?`
  ).get(parseInt(req.params.id, 10), req.userId);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  res.json(w);
});

/* ── GET /api/withdraw/history ── */
router.get('/history', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  res.json(
    db.prepare(
      `SELECT id, coin, address, amount_usd, fee_usd, net_usd, tx_hash, status, failure_reason, created_at, processed_at
       FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(req.userId, limit)
  );
});

module.exports = router;
