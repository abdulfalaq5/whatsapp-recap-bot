import 'dotenv/config';
import pino from 'pino';
import { initOllama } from './ollama.js';
import { initStorage, closeStorage, pruneOldMessages, getLastMessageTimestamp } from './storage.js';
import { startWhatsApp } from './whatsapp.js';
import { startScheduler } from './scheduler.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});

async function main() {
  initOllama(process.env, logger);
  initStorage(process.env.DB_PATH || './data/chat_history.db', logger);

  // Prune histori lama: sekali di startup, lalu harian
  const pruneDays = Number(process.env.PRUNE_DAYS || 30);
  const runPrune = () => {
    if (!pruneDays || pruneDays <= 0) return;
    const result = pruneOldMessages(pruneDays);
    logger.info({ days: pruneDays, removed: result.changes }, 'Old messages pruned');
  };
  runPrune();
  setInterval(runPrune, 24 * 60 * 60 * 1000);

  const wa = await startWhatsApp(process.env, logger);
  const scheduler = startScheduler(() => wa.getSocket(), process.env, logger);

  logger.info(`Last stored message timestamp: ${getLastMessageTimestamp() ?? 'none'}`);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down...');
    try {
      if (scheduler) scheduler.stop();
      if (wa.end) wa.end(new Error('bot shutting down'));
      closeStorage();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Bot failed to start');
  process.exit(1);
});
