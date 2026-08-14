// Handler command lokasi OwnTracks: !regislokasi, !regislokasilist, !regislokasireset.
import { hashPassword, upsertOwnTracksUser, listOwnTracksUsers, getOwnTracksUser } from './owntracks.js';

const USAGE_REGISTER = 'Format: !regislokasi <username> <password> [nama]\nContoh: !regislokasi falaq Rubysa falaq';
const USAGE_RESET = 'Format: !regislokasireset <username> <password-baru>\nContoh: !regislokasireset falaq PasswordBaru123';

function parseArgs(arg) {
  return String(arg || '').trim().split(/\s+/).filter(Boolean);
}

export async function handleOwnTracksRegister(sock, logger, { msg, groupId, arg }) {
  const [username, password, ...nameParts] = parseArgs(arg);
  if (!username || !password) {
    await sock.sendMessage(groupId, { text: USAGE_REGISTER, quoted: msg });
    return;
  }

  const displayName = nameParts.join(' ') || username;
  const passwordHash = await hashPassword(password);
  upsertOwnTracksUser({ username, passwordHash, displayName });
  logger.info({ username }, 'OwnTracks user registered via WA command');

  const port = process.env.HTTP_PORT || 3009;
  await sock.sendMessage(groupId, {
    text: `✅ User lokasi *${username}* (${displayName}) berhasil didaftarkan.\n\nSetting di app OwnTracks:\n• Mode: HTTP\n• URL: http://<domain-atau-ip-server>:${port}/owntracks/pub\n• Username: ${username}\n• Password: ${password}`,
    quoted: msg,
  });
}

export async function handleOwnTracksList(sock, logger, { msg, groupId }) {
  const users = listOwnTracksUsers();
  if (users.length === 0) {
    await sock.sendMessage(groupId, { text: 'Belum ada user lokasi yang terdaftar. Daftar dengan !regislokasi <username> <password> [nama]', quoted: msg });
    return;
  }

  const lines = users.map((u, i) => `${i + 1}. ${u.username}${u.display_name && u.display_name !== u.username ? ` (${u.display_name})` : ''}`);
  await sock.sendMessage(groupId, { text: `📍 *User lokasi terdaftar (${users.length})*\n${lines.join('\n')}`, quoted: msg });
}

export async function handleOwnTracksReset(sock, logger, { msg, groupId, arg }) {
  const [username, password] = parseArgs(arg);
  if (!username || !password) {
    await sock.sendMessage(groupId, { text: USAGE_RESET, quoted: msg });
    return;
  }

  const existing = getOwnTracksUser(username);
  if (!existing) {
    await sock.sendMessage(groupId, { text: `User "${username}" belum terdaftar. Daftar dulu dengan !regislokasi ${username} <password> [nama]`, quoted: msg });
    return;
  }

  const passwordHash = await hashPassword(password);
  upsertOwnTracksUser({ username, passwordHash, displayName: existing.display_name });
  logger.info({ username }, 'OwnTracks password reset via WA command');
  await sock.sendMessage(groupId, { text: `🔑 Password untuk user *${username}* sudah direset ke password baru. Update juga di app OwnTracks-nya ya.`, quoted: msg });
}
