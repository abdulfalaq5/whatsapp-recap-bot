import * as storage from './storage.js';

let config = {};

export function initAccess(env, logger) {
  const admins = new Set(
    (env.ADMIN_NUMBERS || '')
      .split(',')
      .map((n) => normalizeNumber(n))
      .filter(Boolean)
  );
  const family = new Set(
    (env.FAMILY_MEMBERS || '')
      .split(',')
      .map((n) => normalizeNumber(n))
      .filter(Boolean)
  );
  config = { admins, family };
  logger.info(
    {
      adminCount: admins.size,
      familyCount: family.size,
      familyRestricted: family.size > 0,
    },
    'Access config loaded'
  );
}

export function normalizeNumber(number) {
  if (!number) return '';
  let n = String(number).trim().replace(/\D/g, '');
  if (n.startsWith('62')) n = `0${n.slice(2)}`;
  return n;
}

export function isAdmin(number) {
  const n = normalizeNumber(number);
  if (!n) return false;
  if (config.admins.has('*')) return true;
  return config.admins.has(n) || storage.getMember(n)?.role === 'admin';
}

// Nama paling tepercaya: nama tersimpan di tabel members (bisa diatur lewat
// !tambahmember), baru fallback ke pushName dari WhatsApp.
export function resolveMemberName(number, fallback = '') {
  const n = normalizeNumber(number);
  if (!n) return fallback || '';
  const member = storage.getMember(n);
  return member?.name || fallback || '';
}

export function isFamilyMember(number, groupId) {
  const n = normalizeNumber(number);
  if (!n) return false;

  // Kalau ada daftar FAMILY_MEMBERS eksplisit → wajib ada di daftar itu.
  if (config.family.size > 0) return config.family.has(n);

  // Default: siapa pun yang ada di group yang sudah di-whitelist adalah anggota keluarga.
  if (groupId && groupId.endsWith('@g.us')) {
    if (config.whitelist?.allowAll) return true;
    if (config.whitelist?.ids.has(groupId.toLowerCase())) return true;
  }
  // Nomor yang terdaftar di tabel members juga dianggap anggota.
  return !!storage.getMember(n);
}

export function setWhitelist(whitelist) {
  config.whitelist = whitelist;
}

export function getAdminNumbers() {
  return [...config.admins];
}
