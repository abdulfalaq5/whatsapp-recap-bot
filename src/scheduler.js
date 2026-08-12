import cron from 'node-cron';
import * as storage from './storage.js';
import { handleRekap } from './commands.js';

export function startScheduler(getSocket, env, logger) {
  const enabled = String(env.AUTO_RECAP_ENABLED || 'false').toLowerCase() === 'true';
  const cronExpr = env.AUTO_RECAP_CRON || '0 21 * * *';
  // Group whitelist sekarang dari database (bukan env lagi).
  const groupIds = storage.getWhitelistGroups();

  if (!enabled) {
    logger.info('Auto recap disabled (AUTO_RECAP_ENABLED=false)');
    return null;
  }

  if (groupIds.length === 0) {
    logger.warn('AUTO_RECAP_ENABLED=true tapi belum ada group terdaftar di database, auto recap di-skip');
    return null;
  }

  // Wildcard '*' tidak cukup untuk auto rekap (bot tidak bisa tahu daftar semua group),
  // jadi wajib daftar ID group eksplisit.
  const explicit = groupIds.filter((id) => id !== '*');
  if (explicit.length === 0) {
    logger.warn('AUTO_RECAP_ENABLED=true tapi daftar group di database kosong. Auto rekap butuh daftar ID group eksplisit.');
    return null;
  }

  if (!cron.validate(cronExpr)) {
    logger.error({ cronExpr }, 'AUTO_RECAP_CRON tidak valid, auto recap di-skip');
    return null;
  }

  const task = cron.schedule(cronExpr, async () => {
    logger.info({ cronExpr, groupIds: explicit }, 'Running auto recap');
    const sock = getSocket();
    if (!sock) {
      logger.warn('Socket WhatsApp belum tersedia, auto recap di-skip');
      return;
    }
    for (const groupId of explicit) {
      try {
        await handleRekap(sock, logger, groupId, ''); // rekap hari ini
      } catch (err) {
        logger.error({ err, groupId }, 'Auto recap failed for group');
      }
    }
  });

  logger.info({ cronExpr, groupIds: explicit }, 'Auto recap scheduler started');
  return task;
}
