// Handler command pantau lokasi: !carilokasi <nama> dan !stopcarilokasi.
import { listOwnTracksUsers, getLastLocation } from './owntracks.js';

const WATCH_INTERVAL_MS = 5 * 60 * 1000;

// groupId -> Map(username -> { timer, displayName })
const activeWatches = new Map();

function findUser(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;

  const users = listOwnTracksUsers();
  const exact = users.find((u) => u.username.toLowerCase() === q || (u.display_name || '').toLowerCase() === q);
  if (exact) return exact;

  const partial = users.filter((u) => u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return { ambiguous: partial };
  return null;
}

function labelFor(user) {
  return user.display_name && user.display_name !== user.username ? `${user.display_name} (${user.username})` : user.username;
}

function formatLocationCaption(user, loc) {
  const updated = new Date(loc.updatedAt).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const battery = loc.battery != null ? `\n🔋 Baterai: ${Math.round(loc.battery)}%` : '';
  const accuracy = loc.accuracy != null ? `\n🎯 Akurasi: ±${Math.round(loc.accuracy)}m` : '';
  return `📍 Lokasi ${labelFor(user)}\n🕒 Update: ${updated} WIB${battery}${accuracy}`;
}

async function sendLocationUpdate(sock, groupId, user) {
  const loc = getLastLocation(user.username);
  if (!loc) return false;
  await sock.sendMessage(groupId, {
    location: { degreesLatitude: loc.latitude, degreesLongitude: loc.longitude, name: labelFor(user) },
  });
  await sock.sendMessage(groupId, { text: formatLocationCaption(user, loc) });
  return true;
}

export async function handleCariLokasi(sock, logger, { msg, groupId, arg }) {
  const query = String(arg || '').trim();
  if (!query) {
    await sock.sendMessage(groupId, { text: 'Format: !carilokasi <nama>\nContoh: !carilokasi falaq', quoted: msg });
    return;
  }

  const found = findUser(query);
  if (!found) {
    await sock.sendMessage(groupId, { text: `User "${query}" tidak ditemukan. Cek nama terdaftar dengan !regislokasilist`, quoted: msg });
    return;
  }
  if (found.ambiguous) {
    const names = found.ambiguous.map(labelFor).join(', ');
    await sock.sendMessage(groupId, { text: `Nama "${query}" cocok dengan beberapa user: ${names}. Tulis nama yang lebih spesifik ya.`, quoted: msg });
    return;
  }

  const sent = await sendLocationUpdate(sock, groupId, found);
  if (!sent) {
    await sock.sendMessage(groupId, { text: `Belum ada data lokasi untuk "${labelFor(found)}". Pastikan app OwnTracks di HP-nya sudah mengirim update.`, quoted: msg });
    return;
  }

  if (!activeWatches.has(groupId)) activeWatches.set(groupId, new Map());
  const chatWatches = activeWatches.get(groupId);

  const existing = chatWatches.get(found.username);
  if (existing) clearInterval(existing.timer);

  const timer = setInterval(async () => {
    try {
      const ok = await sendLocationUpdate(sock, groupId, found);
      if (!ok) logger.warn({ groupId, username: found.username }, 'Watch lokasi: belum ada data terbaru');
    } catch (err) {
      logger.error({ err, groupId, username: found.username }, 'Gagal kirim update lokasi berkala');
    }
  }, WATCH_INTERVAL_MS);

  chatWatches.set(found.username, { timer, displayName: labelFor(found) });
  logger.info({ groupId, username: found.username }, 'Location watch started');

  await sock.sendMessage(groupId, {
    text: `🔄 Bot akan kirim update lokasi *${labelFor(found)}* tiap 5 menit di chat ini.\nKetik !stopcarilokasi untuk menghentikan.`,
  });
}

export async function handleStopCariLokasi(sock, logger, { msg, groupId }) {
  const chatWatches = activeWatches.get(groupId);
  if (!chatWatches || chatWatches.size === 0) {
    await sock.sendMessage(groupId, { text: 'Tidak ada proses pantau lokasi yang sedang berjalan di chat ini.', quoted: msg });
    return;
  }

  const names = [...chatWatches.values()].map((w) => w.displayName);
  for (const w of chatWatches.values()) clearInterval(w.timer);
  activeWatches.delete(groupId);

  logger.info({ groupId, count: names.length }, 'Location watch stopped');
  await sock.sendMessage(groupId, { text: `🛑 Pantau lokasi dihentikan untuk: ${names.join(', ')}.`, quoted: msg });
}
