import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { readdir, rm } from 'fs/promises';
import * as storage from './storage.js';
import * as access from './access.js';
import { parseMessage, handleRekap, HELP_TEXT, handleExpenseAdd, handleExpenseRecap, handleExpenseExport } from './commands.js';
import { handleAssistant } from './assistant.js';
import { handleLevelCommand } from './ai.js';
import { handleAdminCommand } from './admin.js';
import { handleVoiceNote } from './voice.js';
import { handleReminderCommand } from './reminders.js';
import { handleShoppingCommand } from './shopping.js';
import { getWeather, getPrayerTimes } from './info.js';

let config;
let logger;
let connectionState = 'connecting';

const seenGroups = new Set();
const RECONNECT_DELAY_MS = 5000;

// Reason yang berarti sesi tidak bisa dilanjutkan → jangan auto-reconnect (butuh QR ulang / intervensi admin).
const NO_RECONNECT_REASONS = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.connectionReplaced,
]);

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
  const parts = (raw || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  // Wildcard '*' → izinkan semua group
  const allowAll = parts.includes('*');
  const ids = new Set(parts.filter((id) => id !== '*').map((id) => id.toLowerCase()));
  return { allowAll, ids };
}

function isGroupAllowed(groupId) {
  return config.whitelist.allowAll || config.whitelist.ids.has(groupId.toLowerCase());
}

function getSenderNumber(msg) {
  return (msg.key.participant || msg.key.remoteJid || '').split('@')[0];
}

async function handleIncomingMessage(sock, msg) {
  if (msg.key.fromMe) return;

  // Hook untuk modul lain (misal monitor baterai server yang menunggu balasan admin).
  config.onMessage?.(msg);

  const groupId = msg.key.remoteJid;
  const isGroup = groupId.endsWith('@g.us');
  const senderNumber = getSenderNumber(msg);
  const senderName = access.resolveMemberName(senderNumber, msg.pushName);

  // Voice note → tangani terpisah (transcribe di-skip, fallback sopan).
  if (msg.message?.audioMessage || msg.message?.pttMessage) {
    await handleVoiceNote(sock, logger, config, msg);
    return;
  }

  const text = extractMessageText(msg);
  if (!text) return;

  // Pesan privat ke bot dari nomor yang tidak dikenal → balas sopan.
  if (!isGroup) {
    if (access.isFamilyMember(senderNumber, groupId)) {
      await handleDirectMessage(sock, msg, senderNumber, senderName, text);
    } else {
      await sock.sendMessage(groupId, { text: 'Maaf, ini bot keluarga privat. Nomor kamu belum terdaftar sebagai anggota keluarga.' });
    }
    return;
  }

  // Log SEMUA group yang mengirim pesan (whitelisted atau tidak),
  // supaya pengguna bisa menemukan ID group asli lalu menambahkannya ke .env.
  if (!seenGroups.has(groupId)) {
    seenGroups.add(groupId);
    const isWhitelisted = isGroupAllowed(groupId);
    logger.info({ groupId, whitelisted: isWhitelisted },
      isWhitelisted
        ? 'Whitelisted group detected. Bot aktif di group ini.'
        : 'Pesan dari group yang BELUM di-whitelist. Tambahkan ID ini ke WHITELIST_GROUP_IDS di .env supaya bot merespons di sini.');
  }

  if (!isGroupAllowed(groupId)) return;
  // Akses kontrol: nomor yang tidak terdaftar sebagai anggota keluarga tidak diproses.
  if (!access.isFamilyMember(senderNumber, groupId)) {
    logger.debug({ senderNumber }, 'Non-family member message ignored');
    return;
  }

  const isBotMentioned = text.toLowerCase().includes(config.triggerWord);

  // Daftarkan otomatis supaya bot mengenal nama + nomor yang chat.
  storage.upsertMember({ number: senderNumber, name: senderName || null, role: 'member' });
  storage.saveMessage({
    groupId,
    senderName,
    senderNumber,
    message: text,
    isBotMentioned,
    timestamp: Date.now(),
  });
  logger.debug({ groupId, senderName, senderNumber, text }, 'Message saved');

  const parsed = parseMessage(text, config);
  if (!parsed) return; // pesan biasa tanpa trigger → tidak direspons

  logger.info({ groupId, kind: parsed.kind, sender: senderName, senderNumber }, 'Command/trigger processed');

  try {
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
          senderName,
          senderNumber,
          text: question,
          original: msg,
        });
        break;
      }
      case 'help':
        await sock.sendMessage(groupId, { text: HELP_TEXT }, { quoted: msg });
        break;
      case 'ai-level':
        await handleLevelCommand(sock, logger, config, { msg, groupId, arg: parsed.arg });
        break;
      case 'reset':
        storage.clearConversation(groupId);
        await sock.sendMessage(groupId, { text: 'Memori percakapan asisten sudah di-reset. Mulai dari nol lagi ya!' }, { quoted: msg });
        break;
      case 'reset-all':
        if (!access.isAdmin(senderNumber)) {
          await sock.sendMessage(groupId, { text: 'Command ini khusus admin keluarga.', quoted: msg });
          return;
        }
        storage.clearAllMemory();
        logger.info({ groupId, senderNumber }, 'All bot memory cleared by admin');
        await sock.sendMessage(groupId, { text: '🧠 Seluruh memori & riwayat bot sudah dihapus: percakapan, histori per member, daftar member, dan chat log. Bot mulai dari nol ya!', quoted: msg });
        break;
      case 'forget':
        storage.clearMemberHistory(senderNumber);
        await sock.sendMessage(groupId, { text: 'Histori percakapan kamu sudah dihapus.' }, { quoted: msg });
        break;
      case 'reminder':
        await handleReminderCommand(sock, logger, config, { msg, groupId, senderNumber, arg: parsed.arg });
        break;
      case 'shopping':
        await handleShoppingCommand(sock, logger, { msg, groupId, senderNumber, arg: parsed.arg });
        break;
      case 'expense-add':
        await handleExpenseAdd(sock, logger, { msg, groupId, senderNumber }, parsed.arg);
        break;
      case 'expense-recap':
        await handleExpenseRecap(sock, logger, { msg, groupId, senderNumber }, parsed.arg);
        break;
      case 'expense-export':
        await handleExpenseExport(sock, logger, { msg, groupId, senderNumber }, parsed.arg);
        break;
      case 'weather':
        try {
          await sock.sendMessage(groupId, { text: await getWeather(), quoted: msg });
        } catch (err) {
          logger.error({ err }, 'Weather failed');
          await sock.sendMessage(groupId, { text: `Gagal ambil data cuaca: ${err.message}`, quoted: msg });
        }
        break;
      case 'prayer':
        try {
          await sock.sendMessage(groupId, { text: await getPrayerTimes(), quoted: msg });
        } catch (err) {
          logger.error({ err }, 'Prayer times failed');
          await sock.sendMessage(groupId, { text: `Gagal ambil jadwal sholat: ${err.message}`, quoted: msg });
        }
        break;
      case 'admin':
        await handleAdminCommand(sock, logger, config, { msg, groupId, senderNumber, arg: parsed.arg });
        break;
      default:
        break;
    }
  } catch (err) {
    logger.error({ err, kind: parsed.kind }, 'Handler error (caught, bot keeps running)');
    try {
      await sock.sendMessage(groupId, { text: 'Maaf, ada kendala saat memproses command tadi. Coba lagi ya.' }, { quoted: msg });
    } catch (sendErr) {
      logger.error({ err: sendErr }, 'Failed to send error message');
    }
  }
}

async function handleDirectMessage(sock, msg, senderNumber, senderName, text) {
  const parsed = parseMessage(text, config);
  if (!parsed) return;

  logger.info({ kind: parsed.kind, senderNumber, senderName }, 'Direct message command processed');

  const jid = msg.key.remoteJid;
  try {
    switch (parsed.kind) {
      case 'help':
        await sock.sendMessage(jid, { text: HELP_TEXT });
        break;
      case 'assistant':
        await handleAssistant(sock, logger, config, {
          key: msg.key,
          senderName,
          senderNumber,
          text: parsed.question || text,
          original: msg,
        });
        break;
      case 'admin':
        await handleAdminCommand(sock, logger, config, { msg, groupId: jid, senderNumber, arg: parsed.arg });
        break;
      default:
        break;
    }
  } catch (err) {
    logger.error({ err, kind: parsed.kind }, 'Direct handler error (caught)');
  }
}

export async function startWhatsApp(env, log, onMessage) {
  config = {
    whitelist: buildWhitelist(env.WHITELIST_GROUP_IDS),
    triggerWord: (env.ASSISTANT_TRIGGER_WORD || '@kacan').toLowerCase(),
    env,
    onMessage,
  };
  logger = log;
  access.initAccess(env, logger);
  access.setWhitelist(config.whitelist);
  logger.info({ whitelist: [...config.whitelist.ids], allowAll: config.whitelist.allowAll }, 'WhatsApp config loaded');

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Baileys version resolved');

  let sock = null;
  let reconnectTimer = null;

  const connect = async () => {
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'warn' }), // redam log internal Baileys, kita pakai logger sendiri
      browser: ['WhatsApp Bot', 'Chrome', 'Linux'],
      markOnlineOnConnect: true,
      // Matikan init queries (fetchProps/fetchBlocklist/fetchPrivacySettings) yang
      // sering timeout dan memicu error internal "unexpected error in 'init queries'".
      // Bot ini tidak butuh props/blocklist/privacy, jadi aman dimatikan.
      fireInitQueries: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('Scan QR berikut dengan WhatsApp di HP (WhatsApp > Linked Devices):');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        connectionState = 'open';
        logger.info('WhatsApp terhubung. Bot siap.');
      }

      if (connection === 'connecting') {
        connectionState = 'connecting';
      }

      if (connection === 'close') {
        connectionState = 'close';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const noReconnect = NO_RECONNECT_REASONS.has(statusCode);
        logger.error({ statusCode, noReconnect }, 'Koneksi WhatsApp tertutup' + (noReconnect ? ' (sesi tidak bisa dilanjutkan)' : ''));

        if (noReconnect) {
          // Sesi sudah mati: hapus isi auth_session (folder itu sendiri adalah mount point,
          // jadi tidak boleh dihapus) supaya restart berikutnya muncul QR baru.
          logger.info('Sesi WhatsApp tidak valid. Menghapus auth_session untuk scan QR baru...');
          try {
            for (const entry of await readdir('auth_session')) {
              await rm(`auth_session/${entry}`, { recursive: true, force: true });
            }
            logger.info('auth_session dihapus. Container akan restart dan menampilkan QR.');
          } catch (err) {
            logger.error({ err }, 'Gagal menghapus auth_session');
          }
          process.exit(1);
        }

        // 515 = restartRequired, dan alasan lain (network blip dll): reconnect otomatis
        logger.info({ statusCode, retryInSeconds: RECONNECT_DELAY_MS / 1000 }, 'Mencoba koneksi ulang WhatsApp...');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleIncomingMessage(sock, msg);
        } catch (err) {
          logger.error({ err }, 'Message handler error (caught, bot keeps running)');
        }
      }
    });
  };

  await connect();

  return {
    getSocket: () => sock,
    getConnectionState: () => connectionState,
    end: (err) => sock?.end?.(err),
  };
}
