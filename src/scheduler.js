import cron from 'node-cron';
import * as storage from './storage.js';
import { handleRekap } from './commands.js';

export function startScheduler(sock, env, logger) {
  const enabled = String(env.AUTO_RECAP_ENABLED || 'false').toLowerCase() === 'true';
  const cronExpr = env.AUTO_RECAP_CRON || '0 21 * * *';
  const groupIds = (env.WHITELIST_GROUP_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (!enabled) {
    logger.info('Auto recap disabled (AUTO_RECAP_ENABLED=false)');
    return null;
  }

  if (groupIds.length === 0) {
    logger.warn('AUTO_RECAP_ENABLED=true tapi WHITELIST_GROUP_IDS kosong, auto recap di-skip');
    return null;
  }

  if (!cron.validate(cronExpr)) {
    logger.error({ cronExpr }, 'AUTO_RECAP_CRON tidak valid, auto recap di-skip');
    return null;
  }

  const task = cron.schedule(cronExpr, async () => {
    logger.info({ cronExpr, groupIds }, 'Running auto recap');
    for (const groupId of groupIds) {
      try {
        await handleRekap(sock, logger, groupId, ''); // rekap hari ini
      } catch (err) {
        logger.error({ err, groupId }, 'Auto recap failed for group');
      }
    }
  });

  logger.info({ cronExpr, groupIds }, 'Auto recap scheduler started');
  return task;
}
