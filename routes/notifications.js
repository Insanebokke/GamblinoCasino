'use strict';
const express     = require('express');
const db          = require('../db/db');
const requireAuth = require('../middleware/auth');
const validate    = require('../middleware/validate');

const router = express.Router();

const VALID_TYPES = ['win', 'deposit', 'withdraw', 'promo', 'alert', 'info'];

/* ── GET /api/notifications ──
   Returns the authenticated user's last 50 notifications, newest first. */
router.get('/', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const rows = db.prepare(
    `SELECT id, type, title, body, read, created_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  ).all(req.userId, limit);
  res.json(rows);
});

/* ── POST /api/notifications ──
   Creates a notification for the authenticated user (called by frontend push() to persist). */
router.post('/',
  requireAuth,
  validate.body({
    type:  { required: true, type: 'string', enum: VALID_TYPES },
    title: { required: true, type: 'string', minLen: 1, maxLen: 120, trim: true },
    body:  { type: 'string', maxLen: 400, trim: true },
  }),
  (req, res) => {
    const { type, title, body = '' } = req.body;
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)`
    ).run(req.userId, type, title, body);
    res.status(201).json({ id: lastInsertRowid, type, title, body, read: 0 });
  }
);

/* ── PATCH /api/notifications/read-all ── */
router.patch('/read-all', requireAuth, (req, res) => {
  db.prepare(
    `UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0`
  ).run(req.userId);
  res.json({ ok: true });
});

/* ── DELETE /api/notifications/clear ── */
router.delete('/clear', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM notifications WHERE user_id = ?`).run(req.userId);
  res.json({ ok: true });
});

/* ── PATCH /api/notifications/:id/read ── */
router.patch('/:id/read', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
  db.prepare(
    `UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`
  ).run(id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
