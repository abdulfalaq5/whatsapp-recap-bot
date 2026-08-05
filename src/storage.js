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

export function initStorage(dbPath, logger) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(MESSAGES_SCHEMA);
  db.exec(CONVERSATION_SCHEMA);
  db.exec(MESSAGES_INDEX);
  logger.info({ dbPath }, 'SQLite storage ready');
  return db;
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

export function pruneOldMessages(daysToKeep) {
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(`DELETE FROM messages WHERE timestamp < ?`);
  return stmt.run(cutoff);
}

export function getLastMessageTimestamp() {
  const row = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages`).get();
  return row && row.ts ? row.ts : null;
}
