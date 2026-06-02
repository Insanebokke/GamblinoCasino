'use strict';
const rateLimit = require('express-rate-limit');

function make(max, windowMs, message) {
  return rateLimit({
    max,
    windowMs,
    message:         { error: message },
    standardHeaders: true,
    legacyHeaders:   false,
    skip:            () => process.env.NODE_ENV === 'test',
  });
}

module.exports = {
  /* Auth endpoints: strict — prevents brute-force */
  auth:        make(10,   60_000,     'Too many auth attempts — try again in 1 minute'),
  /* Game rounds: 90/min ≈ 1.5 rounds/sec, plenty for a browser client */
  games:       make(90,   60_000,     'Slow down — max 90 rounds per minute'),
  /* Bet recording (legacy client-side games) */
  bets:        make(90,   60_000,     'Too many bet submissions'),
  /* Financial ops: conservative to slow down scripted abuse */
  deposit:     make(10,   3_600_000,  'Max 10 deposit requests per hour'),
  withdraw:    make(5,    3_600_000,  'Max 5 withdrawal requests per hour'),
  /* General API read calls */
  api:         make(200,  60_000,     'Rate limit exceeded — try again shortly'),
  /* Public leaderboard: generous, it\'s read-only */
  leaderboard: make(60,   60_000,     'Rate limit exceeded'),
};
