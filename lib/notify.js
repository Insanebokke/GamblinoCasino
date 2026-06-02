'use strict';
const db = require('../db/db');

const VALID_TYPES = new Set(['win', 'deposit', 'withdraw', 'promo', 'alert', 'info']);

/**
 * Persist a notification for a user. Fire-and-forget — errors are logged, not rethrown.
 * @param {number}  userId
 * @param {string}  type   — win | deposit | withdraw | promo | alert | info
 * @param {string}  title
 * @param {string}  body
 */
function createNotification(userId, type, title, body) {
  if (!VALID_TYPES.has(type)) type = 'info';
  try {
    db.prepare(
      `INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)`
    ).run(userId, type, String(title).slice(0, 120), String(body).slice(0, 400));
  } catch (e) {
    console.error('[notify] createNotification error:', e.message);
  }
}

module.exports = { createNotification };
