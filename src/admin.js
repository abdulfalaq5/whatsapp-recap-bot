import fs from 'node:fs';
import * as storage from './storage.js';
import * as access from './access.js';

const LOG_TAIL_LINES = 50;

function getWhitelistedGroupIds(config) {
  if (!config?.whitelist) return [];
  if (config.whitelist.allowAll) return []; // '*' tidak bisa di-broadcast ke semua group
  return [...config.whitelist.ids].map((id) => (id.endsWith('@g.us') ? id : `${id}@g.us`));
}

export async function handleAdminCommand(sock, logger, config, { msg, groupId, senderNumber, arg }) {
  const isAdmin = access.isAdmin(senderNumber);
  if (!isAdmin) {
    logger.info({ senderNumber }, 'Non-admin tried admin command');
    await sock.sendMessage(groupId, { text: 'Maaf, command ini khusus admin keluarga.' });
    return;
  }

  const lower = (arg || '').trim().toLowerCase();

  try {
    if (lower === 'restart') {
      await sock.sendMessage(groupId, { text: '🔄 Restarting bot... tunggu sebentar.' });
      logger.info('Restart requested by admin');
      setTimeout(() => process.exit(0), 1500);
      return;
    }

    if (lower === 'log') {
      const text = await tailLog(LOG_TAIL_LINES);
      await sock.sendMessage(groupId, { text: `📋 *Log terakhir*:\n\`\`\`\n${text}\n\`\`\`` });
      return;
    }

    if (lower.startsWith('broadcast')) {
      const message = arg.trim().slice('broadcast'.length).trim();
      if (!message) {
        await sock.sendMessage(groupId, { text: 'Format: !broadcast <pesan>', quoted: msg });
        return;
      }
      const targets = new Set(getWhitelistedGroupIds(config));
      for (const m of storage.getAllMembers()) targets.add(`${access.normalizeNumber(m.number)}@s.whatsapp.net`);
      if (targets.size === 0) {
        await sock.sendMessage(groupId, { text: 'Tidak ada group/anggota untuk broadcast. Pastikan ada group terdaftar di database atau ada anggota terdaftar.' });
        return;
      }
      let sent = 0;
      for (const jid of targets) {
        try {
          await sock.sendMessage(jid, { text: `📢 *Pengumuman keluarga*:\n${message}` });
          sent++;
        } catch (err) {
          logger.error({ err, jid }, 'Broadcast failed to target');
        }
      }
      logger.info({ sent, targets: targets.size }, 'Broadcast sent');
      await sock.sendMessage(groupId, { text: `📢 Broadcast terkirim ke ${sent} target.` });
      return;
    }

    if (lower.startsWith('tambahmember')) {
      const rest = arg.trim().slice('tambahmember'.length).trim();
      const m = rest.match(/^(\d[\d\s-]*)\s+(.+)$/);
      if (!m) {
        await sock.sendMessage(groupId, { text: 'Format: !tambahmember <nomor> <nama>', quoted: msg });
        return;
      }
      const number = access.normalizeNumber(m[1]);
      const name = m[2].trim();
      if (!number || !name) {
        await sock.sendMessage(groupId, { text: 'Format: !tambahmember <nomor> <nama>', quoted: msg });
        return;
      }
      storage.upsertMember({ number, name, role: 'member' });
      logger.info({ number, name }, 'Member added by admin');
      await sock.sendMessage(groupId, { text: `✅ ${name} (${number}) ditambahkan sebagai anggota keluarga.` });
      return;
    }

    if (lower.startsWith('tambahgroup') || lower.startsWith('allowgroup')) {
      if (!groupId.endsWith('@g.us')) {
        await sock.sendMessage(groupId, { text: 'Command ini hanya bisa dijalankan di dalam group yang mau diaktifkan.', quoted: msg });
        return;
      }
      storage.addWhitelistGroup(groupId, senderNumber);
      config.whitelist = access.refreshWhitelistFromDb();
      logger.info({ groupId, senderNumber }, 'Group added to whitelist via admin command');
      await sock.sendMessage(groupId, { text: `✅ Group ini (${groupId}) sudah ditambahkan ke daftar akses bot.\nBot sekarang aktif di sini.`, quoted: msg });
      return;
    }

    if (lower.startsWith('hapusgroup')) {
      const id = arg.trim().slice('hapusgroup'.length).trim();
      if (!id) {
        await sock.sendMessage(groupId, { text: 'Format: !hapusgroup <group id>\nContoh: !hapusgroup 120363419070921605@g.us', quoted: msg });
        return;
      }
      const cleanId = id.endsWith('@g.us') ? id : `${id}@g.us`;
      const result = storage.removeWhitelistGroup(cleanId);
      config.whitelist = access.refreshWhitelistFromDb();
      logger.info({ groupId: cleanId, senderNumber, removed: result.changes }, 'Group removed from whitelist by admin');
      await sock.sendMessage(groupId, {
        text: result.changes > 0
          ? `✅ Group ${cleanId} dihapus dari daftar akses bot. Bot tidak akan merespons di group itu lagi.`
          : `Group ${cleanId} tidak ada di daftar akses bot.`,
        quoted: msg,
      });
      return;
    }

    await sock.sendMessage(groupId, { text: 'Command admin: !restart | !log | !broadcast <pesan> | !tambahmember <nomor> <nama> | !tambahgroup | !hapusgroup <group id>', quoted: msg });
  } catch (err) {
    logger.error({ err }, 'Admin command failed');
    await sock.sendMessage(groupId, { text: 'Gagal menjalankan command admin. Cek log.' });
  }
}

function tailLog(lines) {
  const logFile = process.env.LOG_DIR ? `${process.env.LOG_DIR}/app.log` : './logs/app.log';
  try {
    if (!fs.existsSync(logFile)) return 'Belum ada file log.';
    const content = fs.readFileSync(logFile, 'utf8').trim();
    const arr = content.split('\n').filter(Boolean);
    return arr.slice(-lines).join('\n') || 'Log kosong.';
  } catch (err) {
    return `Gagal membaca log: ${err.message}`;
  }
}
