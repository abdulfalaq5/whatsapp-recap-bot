import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import * as storage from './storage.js';
import { parseMessage, handleRekap, HELP_TEXT } from './commands.js';
import { handleAssistant } from './assistant.js';

let config;
let logger;

const seenGroups = new Set();

function extractMessageText(msg) {
  if (!msg.message) return '';
  const m = msg.message;
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.ephemeralMessage?.message?.conversation ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    '';
  return String(text).trim();
}

function buildWhitelist(raw) {
  return new Set(
    (raw || '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getSenderNumber(msg) {
  return (msg.key.participant || msg.key.remoteJid || '').split('@')[0];
}

async function handleIncomingMessage(sock, msg) {
  if (msg.key.fromMe) return;

  const text = extractMessageText(msg);
  if (!text) return;

  const groupId = msg.key.remoteJid;
  if (!groupId || !groupId.endsWith('@g.us')) return;
  if (!config.whitelist.has(groupId.toLowerCase())) return;

  if (!seenGroups.has(groupId)) {
    seenGroups.add(groupId);
    logger.info({ groupId }, 'Whitelisted group detected. Catat ID ini untuk konfigurasi.');
  }

  const senderNumber = getSenderNumber(msg);
  const isBotMentioned = text.toLowerCase().includes(config.triggerWord);

  storage.saveMessage({
    groupId,
    senderName: msg.pushName || null,
    senderNumber,
    message: text,
    isBotMentioned,
    timestamp: Date.now(),
  });
  logger.debug({ groupId, senderName: msg.pushName, text }, 'Message saved');

  const parsed = parseMessage(text, config);
  if (!parsed) return; // pesan biasa tanpa trigger → tidak direspons

  logger.info({ groupId, kind: parsed.kind, sender: msg.pushName }, 'Command/trigger processed');

  switch (parsed.kind) {
    case 'rekap':
      await handleRekap(sock, logger, groupId, parsed.arg);
      break;
    case 'assistant': {
      const question = parsed.question;
      if (!question) {
        await sock.sendMessage(groupId, { text: 'Halo! Mau tanya apa? Contoh: @kacan apa itu inflasi?' }, { quoted: msg });
        return;
      }
      await handleAssistant(sock, logger, config, {
        key: msg.key,
        pushName: msg.pushName,
        text: question,
        original: msg,
      });
      break;
    }
    case 'help':
      await sock.sendMessage(groupId, { text: HELP_TEXT }, { quoted: msg });
      break;
    case 'reset':
      storage.clearConversation(groupId);
      await sock.sendMessage(groupId, { text: 'Memori percakapan asisten sudah di-reset. Mulai dari nol lagi ya!' }, { quoted: msg });
      break;
    default:
      break;
  }
}

export async function startWhatsApp(env, log) {
  config = {
    whitelist: buildWhitelist(env.WHITELIST_GROUP_IDS),
    triggerWord: (env.ASSISTANT_TRIGGER_WORD || '@kacan').toLowerCase(),
  };
  logger = log;
  logger.info({ whitelist: [...config.whitelist] }, 'WhatsApp config loaded');

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Baileys version resolved');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'warn' }), // redam log internal Baileys, kita pakai logger sendiri
    browser: ['WhatsApp Bot', 'Chrome', 'Linux'],
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Scan QR berikut dengan WhatsApp di HP (WhatsApp > Linked Devices):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('WhatsApp terhubung. Bot siap.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      logger.error({ statusCode }, 'Koneksi WhatsApp tertutup' + (isLoggedOut ? ' (logged out)' : ''));
      if (isLoggedOut) {
        logger.info('Session di-logout manual. Jalankan ulang container untuk scan QR baru.');
        process.exit(1);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleIncomingMessage(sock, msg);
    }
  });

  return sock;
}
