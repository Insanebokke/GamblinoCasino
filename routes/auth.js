const express     = require('express');
const bcrypt      = require('bcrypt');
const jwt         = require('jsonwebtoken');
const db          = require('../db/db');
const requireAuth = require('../middleware/auth');

const router      = express.Router();
const SALT_ROUNDS = 12;
const TOKEN_TTL   = '30d';

const SAFE_COLS = 'id, username, email, balance, total_bets, total_wins, total_wagered, biggest_win, created_at, last_seen';

function sign(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function safeUser(row) {
  const { password_hash, ...rest } = row;
  return rest;
}

/* ── POST /api/auth/signup ── */
router.post('/signup', async (req, res) => {
  const { username, email, password } = req.body ?? {};

  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields are required' });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 3–20 characters' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, _ . -' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, email, password_hash, balance) VALUES (?, ?, ?, 1000)')
      .run(username.trim(), email.toLowerCase().trim(), hash);

    const user = db.prepare(`SELECT ${SAFE_COLS} FROM users WHERE id = ?`).get(lastInsertRowid);
    res.status(201).json({ token: sign(lastInsertRowid), user });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const field = err.message.includes('username') ? 'Username' : 'Email';
      return res.status(409).json({ error: `${field} already taken` });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── POST /api/auth/login ── */
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body ?? {};

  if (!identifier || !password)
    return res.status(400).json({ error: 'All fields are required' });

  const id = identifier.trim();
  const row = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(id, id.toLowerCase());

  /* Constant-time rejection to prevent user enumeration */
  const valid = row ? await bcrypt.compare(password, row.password_hash) : false;
  if (!row || !valid)
    return res.status(401).json({ error: 'Invalid username or password' });

  db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(row.id);
  res.json({ token: sign(row.id), user: safeUser(row) });
});

/* ── GET /api/auth/me ── */
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(`SELECT ${SAFE_COLS} FROM users WHERE id = ?`).get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

module.exports = router;
