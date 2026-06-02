'use strict';
const crypto = require('crypto');

const HOUSE_EDGE = 0.01; // 1% house edge across all games

/* ── Core RNG ──
   Provably fair: HMAC-SHA256(serverSeed, "clientSeed:nonce") → bytes → float [0,1) */
function rollFloat(serverSeed, clientSeed, nonce) {
  const buf = crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest();
  return buf.readUInt32BE(0) / 0x100000000;
}

/* Returns an array of floats for multi-roll games (mines, etc.) */
function rollFloats(serverSeed, clientSeed, nonce, count) {
  return Array.from({ length: count }, (_, i) => rollFloat(serverSeed, clientSeed, nonce * 1000 + i));
}

/* ── Dice ──
   Roll 1–100. Win if result < target (under) or result > target (over). */
function dice(serverSeed, clientSeed, nonce, target, mode) {
  target = Math.max(2, Math.min(98, parseInt(target) || 50));
  if (!['under', 'over'].includes(mode)) throw new Error('mode must be under or over');
  const r = rollFloat(serverSeed, clientSeed, nonce);
  const roll = Math.floor(r * 100) + 1; // 1–100
  const win = mode === 'under' ? roll < target : roll > target;
  const winChance = mode === 'under' ? (target - 1) / 100 : (100 - target) / 100;
  const multiplier = winChance > 0 ? Math.floor((1 - HOUSE_EDGE) / winChance * 100) / 100 : 0;
  const payout = win ? multiplier : 0;
  return { roll, win, multiplier: payout, target, mode };
}

/* ── Coin Flip ── */
function coin(serverSeed, clientSeed, nonce, choice) {
  if (!['heads', 'tails'].includes(choice)) throw new Error('choice must be heads or tails');
  const r = rollFloat(serverSeed, clientSeed, nonce);
  const result = r < 0.5 ? 'heads' : 'tails';
  const win = result === choice;
  const multiplier = win ? 2 * (1 - HOUSE_EDGE) : 0;
  return { result, win, multiplier: Math.round(multiplier * 100) / 100, choice };
}

/* ── Crash / Limbo ──
   Exponential distribution with house edge baked in.
   The house edge is achieved by setting ~1% of results to 1.00 (instant bust). */
function crashPoint(serverSeed, clientSeed, nonce) {
  const r = rollFloat(serverSeed, clientSeed, nonce);
  if (r < HOUSE_EDGE) return 1.00; // house wins this round
  const raw = (1 - HOUSE_EDGE) / (1 - r);
  return Math.max(1.00, Math.floor(raw * 100) / 100);
}

function limbo(serverSeed, clientSeed, nonce, target) {
  target = Math.max(1.01, Math.min(1_000_000, parseFloat(target) || 2));
  const crash = crashPoint(serverSeed, clientSeed, nonce);
  const win = crash >= target;
  return { result: crash, win, multiplier: win ? target : 0, target };
}

/* ── Mines ──
   Returns an array of mine cell indices (0–24) for a 5×5 grid.
   Uses Fisher-Yates shuffle driven by the provably fair RNG. */
function mines(serverSeed, clientSeed, nonce, mineCount) {
  mineCount = Math.max(1, Math.min(24, parseInt(mineCount) || 1));
  const floats = rollFloats(serverSeed, clientSeed, nonce, 25);
  const cells = Array.from({ length: 25 }, (_, i) => i);
  for (let i = 24; i > 0; i--) {
    const j = Math.floor(floats[24 - i] * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, mineCount).sort((a, b) => a - b);
}

/* ── Plinko ──
   Simulates a ball dropping through N rows of pegs, returning the bucket index (0..N). */
function plinko(serverSeed, clientSeed, nonce, rows) {
  rows = Math.max(8, Math.min(16, parseInt(rows) || 12));
  const floats = rollFloats(serverSeed, clientSeed, nonce, rows);
  let pos = 0;
  for (let i = 0; i < rows; i++) {
    pos += floats[i] < 0.5 ? 0 : 1;
  }
  return { bucket: pos, rows };
}

/* ── Roulette ──
   European roulette: 0–36. Returns the pocket number. */
function roulette(serverSeed, clientSeed, nonce) {
  const r = rollFloat(serverSeed, clientSeed, nonce);
  const pocket = Math.floor(r * 37); // 0–36
  return { pocket };
}

/* ── Keno ──
   Draw 20 numbers from 1–80 without replacement. */
function keno(serverSeed, clientSeed, nonce) {
  const floats = rollFloats(serverSeed, clientSeed, nonce, 80);
  const pool = Array.from({ length: 80 }, (_, i) => i + 1);
  for (let i = 79; i > 0; i--) {
    const j = Math.floor(floats[79 - i] * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { draw: pool.slice(0, 20).sort((a, b) => a - b) };
}

module.exports = { rollFloat, rollFloats, dice, coin, crashPoint, limbo, mines, plinko, roulette, keno, HOUSE_EDGE };
