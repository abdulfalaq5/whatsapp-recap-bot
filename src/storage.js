import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db;

const MESSAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  sender_name TEXT,
  sender_number TEXT,
  message TEXT,
  is_bot_mentioned INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);
`;

const CONVERSATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sender_name TEXT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
`;

const MESSAGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages (group_id, timestamp);
`;

const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const MEMBERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  number TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  preferences TEXT,
  created_at INTEGER NOT NULL
);
`;

const MEMBER_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS member_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
`;

const MEMBER_HISTORY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_member_history_number_time ON member_history (number, timestamp);
`;

const SHARED_CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'note',
  content TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL
);
`;

const REMINDERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  group_id TEXT,
  text TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
`;

const SHOPPING_SCHEMA = `
CREATE TABLE IF NOT EXISTS shopping_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  added_by TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
`;

const EXPENSES_SCHEMA = `
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  amount INTEGER NOT NULL,
  category TEXT,
  note TEXT,
  timestamp INTEGER NOT NULL
);
`;

const WHITELIST_GROUPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS whitelist_groups (
  group_id TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL,
  added_by TEXT
);
`;

export function initStorage(dbPath, logger) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(MESSAGES_SCHEMA);
  db.exec(CONVERSATION_SCHEMA);
  db.exec(MESSAGES_INDEX);
  db.exec(SETTINGS_SCHEMA);
  db.exec(MEMBERS_SCHEMA);
  db.exec(MEMBER_HISTORY_SCHEMA);
  db.exec(MEMBER_HISTORY_INDEX);
  db.exec(SHARED_CONTEXT_SCHEMA);
  db.exec(REMINDERS_SCHEMA);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_status_at ON reminders (status, remind_at);`);
  db.exec(SHOPPING_SCHEMA);
  db.exec(EXPENSES_SCHEMA);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_time ON expenses (timestamp);`);
  db.exec(WHITELIST_GROUPS_SCHEMA);
  logger.info({ dbPath }, 'SQLite storage ready');
  return db;
}

export function getDb() {
  return db;
}

// ---- settings (key-value) ----

export function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// ---- members ----

export function upsertMember({ number, name, role = 'member', preferences = null }) {
  db.prepare(`
    INSERT INTO members (number, name, role, preferences, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(number) DO UPDATE SET
      name = COALESCE(excluded.name, members.name),
      role = COALESCE(excluded.role, members.role),
      preferences = COALESCE(excluded.preferences, members.preferences)
  `).run(number, name ?? null, role, preferences, Date.now());
}

export function getMember(number) {
  return db.prepare(`SELECT * FROM members WHERE number = ?`).get(number);
}

export function getAllMembers() {
  return db.prepare(`SELECT * FROM members ORDER BY name ASC`).all();
}

export function deleteMember(number) {
  return db.prepare(`DELETE FROM members WHERE number = ?`).run(number);
}

// ---- member_history (histori per nomor) ----

export function saveMemberTurn({ number, name, role, content, timestamp }) {
  db.prepare(`
    INSERT INTO member_history (number, name, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(number, name ?? null, role, content, timestamp);
}

export function getRecentMemberHistory(number, limit = 20) {
  const stmt = db.prepare(`
    SELECT * FROM (
      SELECT * FROM member_history
      WHERE number = ?
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `);
  return stmt.all(number, limit);
}

export function clearMemberHistory(number) {
  return db.prepare(`DELETE FROM member_history WHERE number = ?`).run(number);
}

// ---- shared_context (agenda/pengumuman keluarga) ----

export function addSharedContext({ type = 'note', content, author = null }) {
  db.prepare(`
    INSERT INTO shared_context (type, content, author, created_at)
    VALUES (?, ?, ?, ?)
  `).run(type, content, author, Date.now());
}

export function getSharedContext(limit = 50) {
  return db.prepare(`
    SELECT * FROM shared_context ORDER BY id DESC LIMIT ?
  `).all(limit).reverse();
}

export function clearSharedContext() {
  return db.prepare(`DELETE FROM shared_context`).run();
}

export function closeStorage() {
  if (db) db.close();
}

export function saveMessage({ groupId, senderName, senderNumber, message, isBotMentioned, timestamp }) {
  const stmt = db.prepare(`
    INSERT INTO messages (group_id, sender_name, sender_number, message, is_bot_mentioned, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(groupId, senderName, senderNumber, message, isBotMentioned ? 1 : 0, timestamp);
}

export function getMessagesByDateRange(groupId, startTimestamp, endTimestamp) {
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE group_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `);
  return stmt.all(groupId, startTimestamp, endTimestamp);
}

export function saveConversationTurn({ groupId, role, senderName, content, timestamp }) {
  const stmt = db.prepare(`
    INSERT INTO conversation_memory (group_id, role, sender_name, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(groupId, role, senderName, content, timestamp);
}

export function getRecentConversation(groupId, limit = 20) {
  const stmt = db.prepare(`
    SELECT * FROM (
      SELECT * FROM conversation_memory
      WHERE group_id = ?
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `);
  return stmt.all(groupId, limit);
}

export function clearConversation(groupId) {
  const stmt = db.prepare(`DELETE FROM conversation_memory WHERE group_id = ?`);
  return stmt.run(groupId);
}

// Hapus SEMUA memori & riwayat bot: percakapan grup, histori per member,
// daftar member, konteks bersama, dan chat log (rekap mulai dari nol).
// Data fungsional (expenses, reminders, shopping) TIDAK dihapus.
export function clearAllMemory() {
  const t = db.transaction(() => {
    db.prepare(`DELETE FROM conversation_memory`).run();
    db.prepare(`DELETE FROM member_history`).run();
    db.prepare(`DELETE FROM members`).run();
    db.prepare(`DELETE FROM shared_context`).run();
    db.prepare(`DELETE FROM messages`).run();
  });
  return t();
}

export function pruneOldMessages(daysToKeep) {
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(`DELETE FROM messages WHERE timestamp < ?`);
  return stmt.run(cutoff);
}

export function getLastMessageTimestamp() {
  const row = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages`).get();
  return row && row.ts ? row.ts : null;
}

// ---- whitelist group (source of truth sekarang di database) ----

export function addWhitelistGroup(groupId, addedBy = null) {
  const id = String(groupId).trim().toLowerCase();
  if (!id) return null;
  db.prepare(`
    INSERT OR IGNORE INTO whitelist_groups (group_id, added_at, added_by)
    VALUES (?, ?, ?)
  `).run(id, Date.now(), addedBy);
  return id;
}

export function removeWhitelistGroup(groupId) {
  return db.prepare(`DELETE FROM whitelist_groups WHERE group_id = ?`).run(String(groupId).trim().toLowerCase());
}

export function getWhitelistGroups() {
  return db
    .prepare(`SELECT group_id FROM whitelist_groups ORDER BY added_at ASC`)
    .all()
    .map((r) => r.group_id);
}
