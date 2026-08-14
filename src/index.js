import 'dotenv/config';
import fs from 'node:fs';
import pino from 'pino';
import { initOllama } from './ollama.js';
import { initAI } from './ai.js';
import { initStorage, closeStorage, pruneOldMessages, getLastMessageTimestamp } from './storage.js';
import { startWhatsApp } from './whatsapp.js';
import { startScheduler } from './scheduler.js';
import { startHealthCheck } from './health.js';
import { startReminderScheduler } from './reminders.js';
import { initInfo } from './info.js';
import { startServerBatteryMonitor } from './battery.js';
import { startHttpServer } from './httpServer.js';

const logDir = process.env.LOG_DIR || './logs';
fs.mkdirSync(logDir, { recursive: true });

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      { target: 'pino/file', options: { destination: 1 } },
      {
        target: 'pino-roll',
        options: {
          file: `${logDir}/app.log`,
          frequency: 'daily',
          mkdir: true,
          dateFormat: 'yyyy-MM-dd',
        },
      },
    ],
  },
});

async function main() {
  initOllama(process.env, logger);
  initStorage(process.env.DB_PATH || './data/chat_history.db', logger);
  initAI(process.env, logger);

  // Prune histori lama: sekali di startup, lalu harian
  const pruneDays = Number(process.env.PRUNE_DAYS || 30);
  const runPrune = () => {
    if (!pruneDays || pruneDays <= 0) return;
    const result = pruneOldMessages(pruneDays);
    logger.info({ days: pruneDays, removed: result.changes }, 'Old messages pruned');
  };
  runPrune();
  setInterval(runPrune, 24 * 60 * 60 * 1000);

  let batteryMonitor = null;
  const wa = await startWhatsApp(process.env, logger, (msg) => batteryMonitor?.handleIncomingMessage?.(msg));
  const scheduler = startScheduler(() => wa.getSocket(), process.env, logger);
  const health = startHealthCheck(() => wa.getSocket(), () => wa.getConnectionState(), process.env, logger);
  const reminderScheduler = startReminderScheduler(() => wa.getSocket(), logger);
  batteryMonitor = startServerBatteryMonitor(() => wa.getSocket(), logger, process.env);
  initInfo(process.env, logger);
  const httpServer = startHttpServer(process.env, logger);

  logger.info(`Last stored message timestamp: ${getLastMessageTimestamp() ?? 'none'}`);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down...');
    try {
      if (scheduler) scheduler.stop();
      if (health) health.stop();
      if (reminderScheduler) reminderScheduler.stop();
      if (batteryMonitor) batteryMonitor.stop();
      if (httpServer) httpServer.stop();
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
