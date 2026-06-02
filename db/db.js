const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'tokabu.db'));

/* Performance & safety */
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    balance       REAL    NOT NULL DEFAULT 1000.00,
    total_bets    INTEGER NOT NULL DEFAULT 0,
    total_wins    INTEGER NOT NULL DEFAULT 0,
    total_wagered REAL    NOT NULL DEFAULT 0,
    biggest_win   REAL    NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen     INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS bets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game          TEXT    NOT NULL,
    emoji         TEXT    NOT NULL DEFAULT '',
    bet_amount    REAL    NOT NULL,
    is_win        INTEGER NOT NULL,
    multiplier    REAL    NOT NULL DEFAULT 0,
    payout        REAL    NOT NULL DEFAULT 0,
    profit        REAL    NOT NULL,
    balance_after REAL    NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_bets_user    ON bets(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bets_profit  ON bets(profit DESC);

  CREATE TABLE IF NOT EXISTS deposits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coin          TEXT    NOT NULL,
    address       TEXT    NOT NULL,
    amount_usd    REAL    NOT NULL,
    tx_hash       TEXT    UNIQUE,
    status        TEXT    NOT NULL DEFAULT 'pending',
    confirmations INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    confirmed_at  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_deposits_addr ON deposits(address);

  CREATE TABLE IF NOT EXISTS withdrawals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coin            TEXT    NOT NULL,
    address         TEXT    NOT NULL,
    amount_usd      REAL    NOT NULL,
    fee_usd         REAL    NOT NULL DEFAULT 0,
    net_usd         REAL    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    tx_hash         TEXT,
    failure_reason  TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    processed_at    INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, created_at DESC);

  /* ── Provably fair seeds (one active row per user) ── */
  CREATE TABLE IF NOT EXISTS game_seeds (
    user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    server_seed      TEXT    NOT NULL,
    server_seed_hash TEXT    NOT NULL,
    prev_server_seed TEXT,
    client_seed      TEXT    NOT NULL,
    nonce            INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
  );

  /* ── Anti-exploit fraud flags ── */
  CREATE TABLE IF NOT EXISTS fraud_flags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason     TEXT    NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, reason)
  );
  CREATE INDEX IF NOT EXISTS idx_fraud_user ON fraud_flags(user_id, resolved);

  /* ── Per-user notifications ── */
  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT    NOT NULL DEFAULT 'info',
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    read       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);
`);

// Schema migrations for custodial deposit system
const depositMigrations = [
  `ALTER TABLE deposits ADD COLUMN network TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE deposits ADD COLUMN coin_amount REAL DEFAULT 0`,
  `ALTER TABLE deposits ADD COLUMN rate_usd REAL DEFAULT 0`,
  `ALTER TABLE deposits ADD COLUMN credited_usd REAL`,
  `ALTER TABLE deposits ADD COLUMN verified_amount_crypto REAL`,
  `ALTER TABLE deposits ADD COLUMN required_confirms INTEGER NOT NULL DEFAULT 3`,
];
for (const sql of depositMigrations) {
  try { db.exec(sql); } catch(e) { /* column already exists */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    details    TEXT,
    ip         TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
`);

module.exports = db;
