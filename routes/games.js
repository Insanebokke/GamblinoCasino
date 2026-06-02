'use strict';
const express     = require('express');
const crypto      = require('crypto');
const db          = require('../db/db');
const requireAuth = require('../middleware/auth');
const validate    = require('../middleware/validate');
const { betVelocity, auditWinRate, auditLargeBet } = require('../middleware/security');
const engine      = require('../lib/gameEngine');
const liveEvents  = require('../lib/liveEvents');
const { createNotification } = require('../lib/notify');

const router = express.Router();

/* ── Per-game configuration ── */
const GAMES = {
  dice: {
    emoji: '🎲', minBet: 0.01, maxBet: 10_000,
    play: (seeds, p) => engine.dice(seeds.server, seeds.client, seeds.nonce, p.target, p.mode),
    validateParams(p) {
      const t = parseInt(p.target);
      if (!['under', 'over'].includes(p.mode)) return 'mode must be under or over';
      if (!Number.isFinite(t) || t < 2 || t > 98) return 'target must be 2–98';
      return null;
    },
  },
  coin: {
    emoji: '🪙', minBet: 0.01, maxBet: 10_000,
    play: (seeds, p) => engine.coin(seeds.server, seeds.client, seeds.nonce, p.choice),
    validateParams(p) {
      if (!['heads', 'tails'].includes(p.choice)) return 'choice must be heads or tails';
      return null;
    },
  },
  limbo: {
    emoji: '📈', minBet: 0.01, maxBet: 5_000,
    play: (seeds, p) => engine.limbo(seeds.server, seeds.client, seeds.nonce, p.target),
    validateParams(p) {
      const t = parseFloat(p.target);
      if (!Number.isFinite(t) || t < 1.01 || t > 1_000_000) return 'target must be 1.01–1,000,000';
      return null;
    },
  },
  crash: {
    emoji: '🚀', minBet: 0.01, maxBet: 5_000,
    play: (seeds, p) => {
      const crash = engine.crashPoint(seeds.server, seeds.client, seeds.nonce);
      const cashout = parseFloat(p.cashout) || 2.00;
      const win = crash >= cashout;
      return { result: crash, win, multiplier: win ? cashout : 0, cashout };
    },
    validateParams(p) {
      const c = parseFloat(p.cashout);
      if (!Number.isFinite(c) || c < 1.01 || c > 1_000_000) return 'cashout must be >= 1.01';
      return null;
    },
  },
  roulette: {
    emoji: '🎡', minBet: 0.01, maxBet: 10_000,
    play: (seeds, p) => {
      const { pocket } = engine.roulette(seeds.server, seeds.client, seeds.nonce);
      const bet = p.bet; // 'red'|'black'|'green'|'even'|'odd'|0-36
      const RED = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
      let win = false, multiplier = 0;
      if (typeof bet === 'number') {
        win = pocket === bet;
        multiplier = 36;
      } else if (bet === 'red') {
        win = RED.includes(pocket);
        multiplier = 2;
      } else if (bet === 'black') {
        win = !RED.includes(pocket) && pocket !== 0;
        multiplier = 2;
      } else if (bet === 'green') {
        win = pocket === 0;
        multiplier = 36;
      } else if (bet === 'even') {
        win = pocket !== 0 && pocket % 2 === 0;
        multiplier = 2;
      } else if (bet === 'odd') {
        win = pocket % 2 === 1;
        multiplier = 2;
      }
      return { pocket, win, multiplier: win ? multiplier * (1 - engine.HOUSE_EDGE) : 0, bet };
    },
    validateParams(p) {
      const valid = ['red','black','green','even','odd'];
      const n = parseInt(p.bet);
      if (Number.isFinite(n) && n >= 0 && n <= 36) return null;
      if (typeof p.bet === 'string' && valid.includes(p.bet)) return null;
      return 'bet must be a pocket number 0–36 or one of: ' + valid.join(', ');
    },
  },
};

/* ── Seed management ── */
function getOrCreateSeed(userId) {
  let row = db.prepare('SELECT * FROM game_seeds WHERE user_id = ?').get(userId);
  if (!row) {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const clientSeed = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO game_seeds (user_id, server_seed, server_seed_hash, client_seed, nonce)
      VALUES (?, ?, ?, ?, 0)
    `).run(userId, serverSeed, sha256(serverSeed), clientSeed);
    row = db.prepare('SELECT * FROM game_seeds WHERE user_id = ?').get(userId);
  }
  return row;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/* ── POST /api/games/play ── */
router.post('/play',
  requireAuth,
  betVelocity,
  validate.body({
    game:      { required: true, type: 'string' },
    betAmount: { required: true, type: 'number', min: 0.01, max: 50_000 },
  }),
  (req, res) => {
    const { game, betAmount, params: gameParams = {} } = req.body;
    const cfg = GAMES[game];
    if (!cfg) return res.status(400).json({ error: `Unknown game. Valid: ${Object.keys(GAMES).join(', ')}` });

    if (betAmount < cfg.minBet || betAmount > cfg.maxBet) {
      return res.status(400).json({ error: `Bet must be $${cfg.minBet}–$${cfg.maxBet} for ${game}` });
    }

    const paramErr = cfg.validateParams(gameParams);
    if (paramErr) return res.status(400).json({ error: paramErr });

    const seedRow = getOrCreateSeed(req.userId);
    const seeds   = { server: seedRow.server_seed, client: seedRow.client_seed, nonce: seedRow.nonce };

    let outcome;
    try { outcome = cfg.play(seeds, gameParams); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const { win, multiplier, ...gameData } = outcome;
    const roundedBet  = Math.round(betAmount * 100) / 100;
    const payout      = win ? Math.round(roundedBet * multiplier * 100) / 100 : 0;
    const profit      = win ? payout - roundedBet : -roundedBet;

    let newBalance, betId;

    try {
      db.transaction(() => {
        const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.userId);
        if (!user || user.balance < roundedBet - 0.001)
          throw Object.assign(new Error('Insufficient balance'), { status: 400 });

        newBalance = Math.max(0, Math.round((user.balance + profit) * 100) / 100);

        const { lastInsertRowid } = db.prepare(`
          INSERT INTO bets (user_id, game, emoji, bet_amount, is_win, multiplier, payout, profit, balance_after)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(req.userId, game, cfg.emoji, roundedBet, win ? 1 : 0,
               multiplier, payout, profit, newBalance);

        db.prepare(`
          UPDATE users SET
            balance       = ?,
            total_bets    = total_bets + 1,
            total_wins    = total_wins + ?,
            total_wagered = total_wagered + ?,
            biggest_win   = MAX(biggest_win, ?),
            last_seen     = unixepoch()
          WHERE id = ?
        `).run(newBalance, win ? 1 : 0, roundedBet, Math.max(0, profit), req.userId);

        db.prepare(`
          UPDATE game_seeds SET nonce = nonce + 1, updated_at = unixepoch() WHERE user_id = ?
        `).run(req.userId);

        betId = lastInsertRowid;
      })();
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[games/play]', err);
      return res.status(500).json({ error: 'Server error' });
    }

    /* Async: emit live event, audit, create win notification */
    setImmediate(() => {
      const u = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId);
      if (u) {
        liveEvents.emit('bet', {
          username:  u.username,
          game,
          emoji:     cfg.emoji,
          betAmount: roundedBet,
          isWin:     win,
          multiplier,
          payout,
          profit,
        });
      }
      auditWinRate(req.userId);
      auditLargeBet(req.userId, roundedBet, game);
      if (win && profit >= 50) {
        const fmtM = multiplier % 1 === 0 ? multiplier + 'x' : multiplier.toFixed(2) + 'x';
        createNotification(
          req.userId, 'win',
          profit >= 500 ? 'Big Win! 🏆' : 'You won! 🎉',
          `${game}: Hit ${fmtM} and won $${profit.toFixed(2)}`
        );
      }
    });

    res.json({
      id:        betId,
      game,
      betAmount: roundedBet,
      win,
      multiplier,
      payout,
      profit,
      balance:   newBalance,
      ...gameData,
      proof: {
        serverSeedHash: seedRow.server_seed_hash,
        clientSeed:     seedRow.client_seed,
        nonce:          seedRow.nonce,
      },
    });
  }
);

/* ── GET /api/games/seed ── */
router.get('/seed', requireAuth, (req, res) => {
  const row = getOrCreateSeed(req.userId);
  res.json({
    serverSeedHash: row.server_seed_hash,
    clientSeed:     row.client_seed,
    nonce:          row.nonce,
  });
});

/* ── POST /api/games/seed/rotate ──
   Reveals the current server seed and rotates to a fresh one. */
router.post('/seed/rotate', requireAuth,
  validate.body({ clientSeed: { type: 'string', maxLen: 64, trim: true } }),
  (req, res) => {
    const row = db.prepare('SELECT * FROM game_seeds WHERE user_id = ?').get(req.userId);
    const oldServerSeed = row?.server_seed ?? null;
    const newServerSeed = crypto.randomBytes(32).toString('hex');
    const newHash       = sha256(newServerSeed);
    const clientSeed    = req.body.clientSeed || crypto.randomBytes(16).toString('hex');

    db.prepare(`
      INSERT INTO game_seeds (user_id, server_seed, server_seed_hash, client_seed, nonce, prev_server_seed)
      VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        prev_server_seed = game_seeds.server_seed,
        server_seed      = excluded.server_seed,
        server_seed_hash = excluded.server_seed_hash,
        client_seed      = excluded.client_seed,
        nonce            = 0,
        updated_at       = unixepoch()
    `).run(req.userId, newServerSeed, newHash, clientSeed, oldServerSeed ?? null);

    res.json({
      revealedServerSeed: oldServerSeed,
      newServerSeedHash:  newHash,
      clientSeed,
      nonce: 0,
    });
  }
);

/* ── POST /api/games/verify ──
   Client can verify any past bet by supplying the revealed server seed, client seed, and nonce. */
router.post('/verify',
  validate.body({
    game:       { required: true, type: 'string' },
    serverSeed: { required: true, type: 'string', minLen: 64, maxLen: 64,
                  pattern: /^[a-f0-9]{64}$/i, patternMsg: 'serverSeed must be 64 hex chars' },
    clientSeed: { required: true, type: 'string', maxLen: 64 },
    nonce:      { required: true, type: 'number', min: 0, integer: true },
    params:     {},
  }),
  (req, res) => {
    const { game, serverSeed, clientSeed, nonce, params: gameParams = {} } = req.body;
    const cfg = GAMES[game];
    if (!cfg) return res.status(400).json({ error: 'Unknown game' });

    let outcome;
    try {
      const seeds = { server: serverSeed, client: clientSeed, nonce };
      outcome = cfg.play(seeds, gameParams);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    res.json({
      game,
      serverSeedHash: sha256(serverSeed),
      clientSeed,
      nonce,
      outcome,
      verified: true,
    });
  }
);

/* ── GET /api/games/config ── */
router.get('/config', (_req, res) => {
  const config = {};
  for (const [name, cfg] of Object.entries(GAMES)) {
    config[name] = { emoji: cfg.emoji, minBet: cfg.minBet, maxBet: cfg.maxBet };
  }
  res.json({ games: config, houseEdge: engine.HOUSE_EDGE });
});

module.exports = router;
