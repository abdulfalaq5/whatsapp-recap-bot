import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getAdminNumbers, normalizeNumber, isAdmin } from './access.js';

const SYSFS_DIR = '/sys/class/power_supply';

async function readInt(file) {
  try {
    return Number((await readFile(file, 'utf8')).trim());
  } catch {
    return null;
  }
}

async function getBatteryInfo() {
  let entries;
  try {
    entries = await readdir(SYSFS_DIR);
  } catch {
    return null;
  }

  const batteries = entries.filter((name) => /^BAT\d*$/i.test(name));
  if (!batteries.length) return null;

  const bats = [];
  for (const name of batteries) {
    const base = path.join(SYSFS_DIR, name);
    const capacity = await readInt(path.join(base, 'capacity'));
    if (capacity == null) continue;
    const status = await readFile(path.join(base, 'status'), 'utf8').then((s) => s.trim()).catch(() => '');
    const chargeFull = await readInt(path.join(base, 'charge_full'));
    const chargeNow = await readInt(path.join(base, 'charge_now'));
    bats.push({ name, capacity, status, chargeFull, chargeNow });
  }
  if (!bats.length) return null;

  let level;
  if (bats.length === 1) {
    level = bats[0].capacity;
  } else if (bats.every((b) => b.chargeFull != null && b.chargeNow != null)) {
    const totalFull = bats.reduce((sum, b) => sum + b.chargeFull, 0);
    const totalNow = bats.reduce((sum, b) => sum + b.chargeNow, 0);
    level = Math.round((totalNow / totalFull) * 100);
  } else {
    level = Math.round(bats.reduce((sum, b) => sum + b.capacity, 0) / bats.length);
  }

  const charging = bats.some((b) => b.status === 'Charging' || b.status === 'Full');

  return { level, charging, batteries: bats.length };
}

export function startServerBatteryMonitor(getSocket, logger, env) {
  const enabled = String(env.SERVER_BATTERY_ALERT_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) {
    logger.info('Server battery monitor disabled (SERVER_BATTERY_ALERT_ENABLED=false)');
    return { stop: () => {}, handleIncomingMessage: () => {} };
  }

  const threshold = Number(env.SERVER_BATTERY_ALERT_THRESHOLD || 20);
  const maxMessages = Number(env.SERVER_BATTERY_ALERT_MAX || 5);
  const intervalMs = Number(env.SERVER_BATTERY_ALERT_INTERVAL_MIN || 2) * 60 * 1000;
  const pollMs = Number(env.SERVER_BATTERY_POLL_SEC || 60) * 1000;

  // `active` = loop pengingat sedang berjalan; `episodeAcked` = episode baterai rendah
  // sudah ditangani (dibalas admin / sudah 5x), jangan ulang sampai baterai normal lagi.
  let active = false;
  let episodeAcked = false;
  let sent = 0;
  let timer = null;

  const stopLoop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    active = false;
  };

  const notifyAdmin = async (text) => {
    const sock = getSocket();
    if (!sock) return false;
    let ok = false;
    for (const admin of getAdminNumbers()) {
      const jid = normalizeNumber(admin) ? `${normalizeNumber(admin)}@s.whatsapp.net` : null;
      if (!jid) continue;
      try {
        await sock.sendMessage(jid, { text });
        ok = true;
      } catch (err) {
        logger.warn({ err }, 'Battery alert: gagal kirim ke admin');
      }
    }
    return ok;
  };

  const buildAlertText = (level) =>
    `🔋 *Peringatan Baterai Server Rendah!*\n\n` +
    `Level baterai laptop: *${level}%* (ambang ${threshold}%)\n` +
    `Status: discharging / tidak dicharge\n` +
    `Server bisa mati kapan saja. Mohon segera colok charger!\n\n` +
    `Balas pesan ini untuk menghentikan pengingat otomatis.`;

  const sendAlert = async (level) => {
    const ok = await notifyAdmin(buildAlertText(level));
    sent += 1;
    logger.info({ level, sent, ok }, 'Battery alert sent to admin');
  };

  const scheduleNext = async (level) => {
    if (!active) return;
    if (sent >= maxMessages) {
      logger.warn({ sent: maxMessages }, 'Battery alert: sudah mencapai batas maksimal, berhenti');
      stopLoop();
      episodeAcked = true;
      return;
    }
    timer = setTimeout(async () => {
      timer = null;
      if (!active) return;
      await sendAlert(level);
      if (active) scheduleNext(level);
    }, intervalMs);
  };

  const startLoop = async (level) => {
    if (active) return;
    active = true;
    sent = 0;
    logger.info({ level, threshold }, 'Battery rendah terdeteksi, memulai loop alert');
    await sendAlert(level);
    if (active) scheduleNext(level);
  };

  const check = async () => {
    const info = await getBatteryInfo();
    if (!info) {
      logger.warn({ dir: SYSFS_DIR }, 'Server battery: tidak bisa membaca sysfs (mungkin belum di-mount di container)');
      return;
    }

    const low = info.level <= threshold;

    if (active) {
      if (!low || info.charging) {
        logger.info({ level: info.level, charging: info.charging }, 'Battery alert loop berhenti (baterai pulih/charging)');
        stopLoop();
      }
      return;
    }

    if (!low || info.charging) {
      if (episodeAcked) {
        episodeAcked = false;
        logger.info({ level: info.level }, 'Baterai kembali normal, alert siap lagi');
      }
      return;
    }

    if (!episodeAcked) await startLoop(info.level);
  };

  const task = setInterval(check, pollMs);
  check();
  logger.info({ threshold, maxMessages, intervalMs, pollMs }, 'Server battery monitor started');

  const handleIncomingMessage = (msg) => {
    if (!active) return;
    const from = (msg.key.participant || msg.key.remoteJid || '').split('@')[0];
    if (isAdmin(from)) {
      logger.info({ from }, 'Admin membalas, battery alert dihentikan');
      stopLoop();
      episodeAcked = true;
    }
  };

  return {
    stop: () => {
      clearInterval(task);
      stopLoop();
    },
    handleIncomingMessage,
  };
}
