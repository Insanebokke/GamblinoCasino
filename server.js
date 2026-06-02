'use strict';
require('dotenv').config();

const express = require('express');
const path    = require('path');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const limits  = require('./middleware/rateLimit');

/* ── Validate required environment variables ── */
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('[fatal] JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}

const app = express();

/* ── Security headers ──
   Helmet sets ~14 HTTP headers that block common web attacks.
   CSP is disabled here because the frontend uses inline scripts and CDN assets.
   Re-enable and configure properly before production. */
app.use(helmet({ contentSecurityPolicy: false }));

/* ── CORS ── */
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) ?? '*';
app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));

/* ── Body parsing — 16 KB limit prevents large-payload DoS ── */
app.use(express.json({ limit: '16kb' }));

/* ── HTTP request logging ── */
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

/* ── Block direct HTTP access to server-side source files ── */
app.use((req, res, next) => {
  const blocked = /^\/(\.env|routes|middleware|db|lib|node_modules)(\/|$)/i;
  if (blocked.test(req.path)) return res.status(403).json({ error: 'Forbidden' });
  next();
});

/* ── Static: serve only the casino page ── */
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'tokabu.html')));

/* ── API Routes ── */
app.use('/api/auth',        limits.auth,        require('./routes/auth'));
app.use('/api/user',        limits.api,         require('./routes/user'));
app.use('/api/deposit',     limits.api,         require('./routes/deposit'));
app.use('/api/withdraw',    limits.withdraw,    require('./routes/withdraw'));
app.use('/api/games',         limits.games,       require('./routes/games'));
app.use('/api/leaderboard',   limits.leaderboard, require('./routes/leaderboard'));
app.use('/api/notifications', limits.api,         require('./routes/notifications'));
app.use('/api/live',                              require('./routes/live'));

/* ── Catch-all for unknown /api/* paths ── */
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

/* ── Health / readiness check ── */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now(), env: process.env.NODE_ENV ?? 'development' });
});

/* ── Global error handler ── */
app.use((err, _req, res, _next) => {
  const status  = err.status ?? err.statusCode ?? 500;
  const message = status < 500 ? err.message : 'Internal server error';
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: message });
});

/* ── Start ── */
const PORT = parseInt(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
  console.log(`\n🎰  Tokabu Casino  →  http://localhost:${PORT}  [${process.env.NODE_ENV ?? 'development'}]\n`);
});

/* ── Graceful shutdown ── */
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app; // for testing
