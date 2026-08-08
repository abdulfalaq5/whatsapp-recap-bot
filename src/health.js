import * as storage from './storage.js';
import { getAdminNumbers, normalizeNumber } from './access.js';

const KEY_LAST_DOWN = 'health:last_down_at';
const KEY_LAST_ALERT = 'health:last_alert_at';

export function startHealthCheck(getSocket, getConnectionState, env, logger) {
  const enabled = String(env.HEALTH_CHECK_ENABLED || 'true').toLowerCase() === 'true';
  const intervalMs = Number(env.HEALTH_CHECK_INTERVAL_MIN || 5) * 60 * 1000;

  const notifyAdmin = async (text) => {
    const sock = getSocket();
    if (!sock) return;
    for (const admin of getAdminNumbers()) {
      const jid = normalizeNumber(admin) ? `${normalizeNumber(admin)}@s.whatsapp.net` : null;
      if (!jid) continue;
      try {
        await sock.sendMessage(jid, { text });
        logger.info({ admin: jid }, 'Health notification sent to admin');
      } catch (err) {
        logger.error({ err }, 'Failed to send health notification to admin');
      }
    }
  };

  const check = async () => {
    if (!enabled) return;
    const state = getConnectionState();

    // Recovery hanya dianggap nyata saat koneksi sudah 'open' lagi.
    if (state === 'open') {
      const lastDown = storage.getSetting(KEY_LAST_DOWN);
      if (lastDown) {
        logger.info('Connection recovered after downtime');
        storage.setSetting(KEY_LAST_DOWN, '');
        await notifyAdmin('✅ Koneksi WhatsApp *pulih* kembali. Bot siap dipakai lagi.');
      }
      return;
    }

    // Abaikan fase 'connecting' (startup / reconnect); hanya lapor saat benar-benar tertutup.
    if (state !== 'close') return;

    // Koneksi turun: tandai mulai kapan, dan kirim alert paling sering tiap 30 menit.
    if (!storage.getSetting(KEY_LAST_DOWN)) {
      storage.setSetting(KEY_LAST_DOWN, String(Date.now()));
    }
    const lastAlert = Number(storage.getSetting(KEY_LAST_ALERT) || 0);
    if (Date.now() - lastAlert < 30 * 60 * 1000) return;
    storage.setSetting(KEY_LAST_ALERT, String(Date.now()));

    const downSince = new Date(Number(storage.getSetting(KEY_LAST_DOWN))).toLocaleString('id-ID');
    logger.warn({ state }, 'Health check: connection is down');
    await notifyAdmin(`⚠️ *Bot WhatsApp terputus!*\nStatus: ${state}\nSejak: ${downSince}\nBot akan mencoba reconnect otomatis.`);
  };

  const task = setInterval(check, intervalMs);
  logger.info({ enabled, intervalMs }, 'Health check started');

  // Jalankan sekali langsung supaya status awal ketahuan cepat.
  check();

  return {
    stop: () => clearInterval(task),
  };
}
