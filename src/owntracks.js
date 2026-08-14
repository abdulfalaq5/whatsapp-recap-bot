import bcrypt from 'bcryptjs';
import { getDb } from './storage.js';

const SALT_ROUNDS = 10;

// ---- owntracks_users (Basic Auth) ----

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function getOwnTracksUser(username) {
  return getDb().prepare(`SELECT * FROM owntracks_users WHERE username = ?`).get(username);
}

export function listOwnTracksUsers() {
  return getDb().prepare(`SELECT username, display_name, created_at FROM owntracks_users ORDER BY username ASC`).all();
}

export function upsertOwnTracksUser({ username, passwordHash, displayName }) {
  getDb().prepare(`
    INSERT INTO owntracks_users (username, password_hash, display_name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      display_name = COALESCE(excluded.display_name, owntracks_users.display_name)
  `).run(username, passwordHash, displayName ?? null, Date.now());
}

// Cocokkan username/password Basic Auth. Return user row kalau valid, null kalau tidak.
export async function verifyOwnTracksAuth(username, password) {
  const user = getOwnTracksUser(username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  return ok ? user : null;
}

// ---- locations (lokasi terbaru per user) ----

export function upsertLocation({ userId, latitude, longitude, accuracy = null, battery = null, updatedAt }) {
  getDb().prepare(`
    INSERT INTO locations (user_id, latitude, longitude, accuracy, battery, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      accuracy = excluded.accuracy,
      battery = excluded.battery,
      updated_at = excluded.updated_at
  `).run(userId, latitude, longitude, accuracy, battery, updatedAt);
}

// Dipakai command bot lain, misal `!lokasi <nama>`.
export function getLastLocation(userId) {
  const row = getDb().prepare(`SELECT * FROM locations WHERE user_id = ?`).get(userId);
  if (!row) return null;
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy: row.accuracy,
    battery: row.battery,
    updatedAt: row.updated_at,
  };
}
