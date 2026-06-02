'use strict';

const CACHE_MS = 5 * 60 * 1000;
const COIN_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' };

let _cache = {};

async function _fetchAll() {
  const ids = Object.values(COIN_IDS).join(',');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { headers: { Accept: 'application/json' }, signal: ctrl.signal }
    );
    if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getRate(coin) {
  const now = Date.now();
  const entry = _cache[coin];
  if (entry && now - entry.ts < CACHE_MS) return entry.rate;
  try {
    const data = await _fetchAll();
    const now2 = Date.now();
    for (const [c, id] of Object.entries(COIN_IDS)) {
      if (data[id]?.usd) _cache[c] = { rate: data[id].usd, ts: now2 };
    }
    return _cache[coin]?.rate ?? null;
  } catch (e) {
    console.error('[rates]', e.message);
    return entry?.rate ?? null; // return stale on error
  }
}

async function getAllRates() {
  const coins = Object.keys(COIN_IDS);
  const results = {};
  for (const coin of coins) {
    results[coin] = await getRate(coin);
  }
  return results;
}

module.exports = { getRate, getAllRates };
