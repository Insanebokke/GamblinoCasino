'use strict';
const express     = require('express');
const db          = require('../db/db');
const requireAuth = require('../middleware/auth');
const { createNotification } = require('../lib/notify');
const { getRate }             = require('../lib/rates');
const { verifyBTC, verifyETH, verifySOL } = require('../lib/blockchain');

const router = express.Router();

/* ── Company treasury addresses ── */
const TREASURY = {
  BTC: process.env.BTC_DEPOSIT_ADDRESS,
  ETH: process.env.ETH_DEPOSIT_ADDRESS,
  SOL: process.env.SOL_DEPOSIT_ADDRESS,
};

/* ── Supported coins ── */
const COINS = {
  BTC: { name: 'Bitcoin',  network: 'Bitcoin Network',   minConfirms: 2,  symbol: 'BTC' },
  ETH: { name: 'Ethereum', network: 'Ethereum Mainnet',  minConfirms: 12, symbol: 'ETH' },
  SOL: { name: 'Solana',   network: 'Solana Mainnet',    minConfirms: 1,  symbol: 'SOL' },
};

/* ── TX hash format patterns ── */
const TX_RE = {
  BTC: /^[a-fA-F0-9]{64}$/,
  ETH: /^0x[a-fA-F0-9]{64}$/,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{80,100}$/,
};

const VERIFIERS = { BTC: verifyBTC, ETH: verifyETH, SOL: verifySOL };

/* ── Audit log ── */
function audit(userId, action, details) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)`)
      .run(userId, action, JSON.stringify(details));
  } catch (e) {
    console.error('[audit]', e.message);
  }
}

/* ── Background poller: check confirming deposits every 30s ── */
async function pollConfirmingDeposits() {
  let deposits;
  try {
    deposits = db.prepare(`SELECT * FROM deposits WHERE status = 'confirming'`).all();
  } catch (e) {
    return;
  }
  for (const dep of deposits) {
    const verify = VERIFIERS[dep.coin];
    if (!verify || !dep.tx_hash) continue;
    try {
      const result = await verify(dep.tx_hash);
      if (!result) continue;
      if (result.error) {
        console.warn(`[deposit:poll] deposit ${dep.id}: ${result.error}`);
        continue;
      }
      const confirmations = result.confirmations || 0;
      const required      = dep.required_confirms || COINS[dep.coin]?.minConfirms || 3;

      db.prepare(`UPDATE deposits SET confirmations = ? WHERE id = ?`).run(confirmations, dep.id);

      if (result.confirmed && confirmations >= required) {
        const rateUsd   = dep.rate_usd || 1;
        const creditUsd = Math.round(result.amount * rateUsd * 100) / 100;
        if (creditUsd <= 0) continue;

        db.transaction(() => {
          db.prepare(
            `UPDATE deposits SET status='confirmed', confirmations=?, confirmed_at=unixepoch(), credited_usd=?, verified_amount_crypto=? WHERE id=?`
          ).run(confirmations, creditUsd, result.amount, dep.id);
          db.prepare(`UPDATE users SET balance = balance + ?, last_seen = unixepoch() WHERE id = ?`)
            .run(creditUsd, dep.user_id);
        })();

        createNotification(dep.user_id, 'deposit', 'Deposit Confirmed 💰',
          `Your ${dep.coin} deposit of $${creditUsd.toFixed(2)} has been credited to your account.`);

        audit(dep.user_id, 'deposit_confirmed', {
          depositId: dep.id, coin: dep.coin, txHash: dep.tx_hash,
          cryptoAmount: result.amount, creditedUsd: creditUsd,
        });
        console.log(`[deposit] confirmed id=${dep.id} coin=${dep.coin} credited=$${creditUsd}`);
      }
    } catch (e) {
      console.error(`[deposit:poll] deposit ${dep.id}:`, e.message);
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  setInterval(pollConfirmingDeposits, 30_000);
}

/* ── GET /api/deposit/rate?coin=BTC ── */
router.get('/rate', requireAuth, async (req, res) => {
  const coin = (req.query.coin || '').toUpperCase();
  if (!COINS[coin]) return res.status(400).json({ error: 'Unsupported coin' });
  try {
    const rate = await getRate(coin);
    if (!rate) return res.status(503).json({ error: 'Exchange rate temporarily unavailable' });
    res.json({ coin, rate, updated_at: Date.now() });
  } catch (e) {
    res.status(503).json({ error: 'Exchange rate service error' });
  }
});

/* ── POST /api/deposit/address ── */
router.post('/address', requireAuth, async (req, res) => {
  const { coin, amount_usd } = req.body ?? {};

  if (!COINS[coin]) return res.status(400).json({ error: 'Unsupported cryptocurrency' });
  if (!TREASURY[coin]) return res.status(503).json({ error: `Deposit temporarily unavailable for ${coin}` });

  const usd = parseFloat(amount_usd);
  if (!isFinite(usd) || usd < 50 || usd > 50000)
    return res.status(400).json({ error: 'Amount must be between $50 and $50,000' });

  /* One active deposit at a time — auto-cancel pending (unsubmitted) deposits so user can change coin/amount */
  const active = db.prepare(
    `SELECT id, status FROM deposits WHERE user_id = ? AND status IN ('pending','confirming') LIMIT 1`
  ).get(req.userId);
  if (active) {
    if (active.status === 'confirming')
      return res.status(409).json({ error: 'You have a deposit being confirmed on-chain — wait for it to complete', depositId: active.id });
    db.prepare(`UPDATE deposits SET status='cancelled' WHERE id=?`).run(active.id);
  }

  /* Live exchange rate */
  let rate;
  try {
    rate = await getRate(coin);
  } catch (e) { /* handled below */ }
  if (!rate) return res.status(503).json({ error: 'Exchange rate temporarily unavailable — please try again in a moment' });

  const coinAmount   = usd / rate;
  const address      = TREASURY[coin];
  const network      = COINS[coin].network;
  const required     = COINS[coin].minConfirms;

  const { lastInsertRowid } = db.prepare(
    `INSERT INTO deposits (user_id, coin, address, amount_usd, coin_amount, rate_usd, network, required_confirms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.userId, coin, address, usd, coinAmount, rate, network, required);

  audit(req.userId, 'deposit_initiated', {
    depositId: lastInsertRowid, coin, amountUsd: usd, coinAmount, rate,
  });

  res.status(201).json({
    id:         lastInsertRowid,
    address,
    coin,
    network,
    amount_usd: usd,
    coin_amount: coinAmount,
    rate_usd:   rate,
    required_confirms: required,
  });
});

/* ── POST /api/deposit/:id/confirm ── instant credit, no TX hash needed ── */
router.post('/:id/confirm', requireAuth, (req, res) => {
  const depositId = parseInt(req.params.id, 10);

  const dep = db.prepare('SELECT * FROM deposits WHERE id = ? AND user_id = ?')
    .get(depositId, req.userId);
  if (!dep)                     return res.status(404).json({ error: 'Deposit not found' });
  if (dep.status !== 'pending') return res.status(409).json({ error: 'Deposit already processed' });

  const creditUsd = dep.amount_usd;

  db.transaction(() => {
    db.prepare(
      `UPDATE deposits SET status='confirmed', confirmed_at=unixepoch(), credited_usd=? WHERE id=?`
    ).run(creditUsd, depositId);
    db.prepare(`UPDATE users SET balance = balance + ?, last_seen = unixepoch() WHERE id = ?`)
      .run(creditUsd, req.userId);
  })();

  const newBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.userId)?.balance ?? 0;

  audit(req.userId, 'deposit_confirmed', { depositId, coin: dep.coin, creditedUsd: creditUsd });

  createNotification(req.userId, 'deposit', 'Deposit Confirmed 💰',
    `Your ${dep.coin} deposit of $${creditUsd.toFixed(2)} has been credited to your account.`);

  res.json({ ok: true, credited_usd: creditUsd, balance: newBalance });
});

/* ── GET /api/deposit/active ── */
router.get('/active', requireAuth, (req, res) => {
  const dep = db.prepare(
    `SELECT id, coin, address, amount_usd, coin_amount, rate_usd, network,
            tx_hash, status, confirmations, required_confirms, created_at
     FROM deposits WHERE user_id = ? AND status IN ('pending','confirming')
     ORDER BY created_at DESC LIMIT 1`
  ).get(req.userId);
  res.json(dep || null);
});

/* ── POST /api/deposit/:id/cancel ── */
router.post('/:id/cancel', requireAuth, (req, res) => {
  const dep = db.prepare('SELECT id, status FROM deposits WHERE id = ? AND user_id = ?')
    .get(parseInt(req.params.id, 10), req.userId);
  if (!dep) return res.status(404).json({ error: 'Deposit not found' });
  if (dep.status !== 'pending')
    return res.status(409).json({ error: 'Only pending (unsubmitted) deposits can be cancelled' });
  db.prepare(`UPDATE deposits SET status='cancelled' WHERE id=?`).run(dep.id);
  audit(req.userId, 'deposit_cancelled', { depositId: dep.id });
  res.json({ ok: true });
});

/* ── GET /api/deposit/:id/status ── */
router.get('/:id/status', requireAuth, (req, res) => {
  const dep = db.prepare(
    `SELECT id, coin, network, amount_usd, coin_amount, rate_usd, tx_hash, status,
            confirmations, required_confirms, credited_usd, created_at, confirmed_at
     FROM deposits WHERE id = ? AND user_id = ?`
  ).get(parseInt(req.params.id, 10), req.userId);

  if (!dep) return res.status(404).json({ error: 'Deposit not found' });

  let balance = null;
  if (dep.status === 'confirmed')
    balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.userId)?.balance ?? null;

  res.json({ ...dep, balance });
});

/* ── GET /api/deposit/history ── */
router.get('/history', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  res.json(
    db.prepare(
      `SELECT id, coin, network, amount_usd, coin_amount, rate_usd, tx_hash, status,
              confirmations, required_confirms, credited_usd, created_at, confirmed_at
       FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(req.userId, limit)
  );
});

module.exports = router;
