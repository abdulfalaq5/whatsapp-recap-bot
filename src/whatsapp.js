import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { readdir, rm } from 'fs/promises';
import * as storage from './storage.js';
import * as access from './access.js';
import { parseMessage, isAddGroupRequest, handleRekap, HELP_TEXT, handleExpenseAdd, handleExpenseRecap, handleExpenseExport } from './commands.js';
import { handleAssistant } from './assistant.js';
import { handleLevelCommand, askAI, analyzeImage, extractReceiptData, aiErrorHint } from './ai.js';
import * as expenses from './expenses.js';
import { handleAdminCommand } from './admin.js';
import { handleVoiceNote } from './voice.js';
import { handleReminderCommand } from './reminders.js';
import { handleShoppingCommand } from './shopping.js';
import { handleSearchImage, handleGenerateImage } from './imageCommands.js';
import { searchWeb } from './services/webSearch.js';
import { getWeather, getPrayerTimes } from './info.js';

let config;
let logger;
let connectionState = 'connecting';

const seenGroups = new Set();
const RECONNECT_DELAY_MS = 5000;

// Struk difoto → simpan sementara (in-memory) menunggu user konfirmasi sebelum insert DB.
// Key: "<jid>:<senderNumber>". Hilang otomatis setelah EXPENSE_CONFIRM_TTL_MS.
const pendingExpenseConfirm = new Map();
const EXPENSE_CONFIRM_TTL_MS = 5 * 60 * 1000;
const RECEIPT_KEYWORDS = /struk|nota|kwitansi|invoice|resi|bon\b|harga|belanja|pengeluaran|catat/i;
const CONFIRM_YES = /^(ya|iya|yo|yoi|yup|yes|ok|oke|okay|sip|betul|benar|setuju|simpan|lanjut)\b/i;
const CONFIRM_NO = /^(tidak|gak|ga\b|kagak|nggak|no|batal|cancel|skip|jangan)\b/i;

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

// Whitelist group bersumber dari database (tabel whitelist_groups).
// 'allowAll' ('*') tetap dari env: bukan ID group, jadi tidak masuk akal disimpan di DB.
function loadWhitelist(env) {
  const parts = (env.WHITELIST_GROUP_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const allowAll = parts.includes('*');
  const ids = new Set(storage.getWhitelistGroups().map((id) => id.toLowerCase()));
  return { allowAll, ids };
}

// Migrasi sekali jalan: kalau tabel whitelist masih kosong, isi dari env
// WHITELIST_GROUP_IDS supaya config lama tetap berlaku. Setelah itu DB jadi sumber utama.
function seedWhitelistFromEnv(env, logger) {
  if (storage.getWhitelistGroups().length > 0) return;
  const ids = (env.WHITELIST_GROUP_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && id !== '*');
  for (const id of ids) storage.addWhitelistGroup(id, 'env-migration');
  if (ids.length) logger.info({ migrated: ids.length }, 'Whitelist groups migrated dari WHITELIST_GROUP_IDS ke database');
}

function refreshWhitelist() {
  config.whitelist = access.refreshWhitelistFromDb();
  return config.whitelist;
}

async function addGroupToWhitelist(sock, logger, groupId, senderNumber, msg) {
  storage.addWhitelistGroup(groupId, senderNumber);
  refreshWhitelist();
  const total = storage.getWhitelistGroups().length;
  logger.info({ groupId, senderNumber }, 'Group ditambahkan ke whitelist');
  await sock.sendMessage(groupId, {
    text: `✅ Group ini (${groupId}) sudah ditambahkan ke daftar akses bot.\nBot sekarang aktif di sini. Total group terdaftar: ${total}.`,
    quoted: msg,
  });
}

function isGroupAllowed(groupId) {
  return config.whitelist.allowAll || config.whitelist.ids.has(groupId.toLowerCase());
}

// "!cari <topik>" → cari internet sekarang (selalu pakai Tavily), lalu hasilnya
// dirangkum AI jadi jawaban yang enak dibaca. Kalau AI gagal → tampilkan hasil mentah.
async function handleWebSearchCommand(sock, logger, config, { msg, jid, query, senderName, senderNumber }) {
  if (!query) {
    await sock.sendMessage(jid, { text: 'Format: !cari <topik>\nContoh: !cari harga iphone 17', quoted: msg });
    return;
  }
  await sock.sendMessage(jid, { text: `🔎 Mencari "${query}" di internet...` });
  try {
    const data = await searchWeb(query, logger, config.env.TAVILY_API_KEY || '');
    if (!data) {
      await sock.sendMessage(jid, { text: `Tidak ada hasil ditemukan untuk "${query}".`, quoted: msg });
      return;
    }

    const context = `Hasil pencarian internet (SUMBER: Tavily/DuckDuckGo/Wikipedia) untuk query "${query}":\n${data}`;
    const question =
      `Rangkum hasil pencarian di atas menjadi jawaban untuk pertanyaan: "${query}". ` +
      'Aturan:\n' +
      '- Jawab HANYA berdasarkan data hasil pencarian yang diberikan, jangan menambah pengetahuan/angka dari luar.\n' +
      '- Bahasa Indonesia yang enak dibaca, ringkas tapi lengkap.\n' +
      '- Sebutkan sumbernya (nama situs) untuk tiap poin penting.\n' +
      '- Kalau antar sumber bertentangan, sebutkan perbedaannya.\n' +
      '- Kalau data tidak memuat jawabannya, katakan hasil pencarian tidak menemukan data yang relevan.';

    try {
      const reply = await askAI({
        chatId: jid,
        question,
        context,
        senderName,
        senderNumber,
      });
      await sock.sendMessage(jid, { text: reply, quoted: msg });
    } catch (aiErr) {
      logger.warn({ err: aiErr, query }, 'AI rangkum untuk !cari gagal, tampilkan hasil mentah');
      const lines = data.split('\n').slice(0, 8).join('\n');
      await sock.sendMessage(jid, { text: `🔎 *Hasil pencarian: "${query}"*\n\n${lines}`, quoted: msg });
    }
  } catch (err) {
    logger.error({ err, query }, 'Web search command failed');
    await sock.sendMessage(jid, { text: 'Pencarian gagal. Coba lagi sebentar.', quoted: msg });
  }
}

function getImageMessage(msg) {
  return msg.message?.imageMessage || msg.message?.ephemeralMessage?.message?.imageMessage || null;
}

// Gambar dikirim + trigger kata ("@kacan", "!ai", dst) di caption → unduh gambar,
// lempar ke Gemini vision, fallback otomatis ke Ollama lokal (qwen2.5vl) kalau Gemini
// tidak tersedia (lihat resolveVisionText di ai.js untuk aturan fallback-nya).
async function handleImageQuestion(sock, logger, config, { msg, jid, question, senderName }) {
  await sock.sendMessage(jid, { text: '🖼️ Menganalisis gambar...' });
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const mimeType = getImageMessage(msg)?.mimetype || 'image/jpeg';
    const { text: reply, source } = await analyzeImage({
      chatId: jid,
      question: question || 'Apa isi gambar ini? Jelaskan singkat dan jelas.',
      imageBase64: buffer.toString('base64'),
      mimeType,
      senderName,
    });
    const note = source === 'ollama-fallback' ? '\n\n_(dibaca via Ollama lokal, Gemini sedang tidak tersedia)_' : '';
    await sock.sendMessage(jid, { text: reply + note, quoted: msg });
  } catch (err) {
    await sock.sendMessage(jid, { text: aiErrorHint(err), quoted: msg });
  }
}

function getSenderNumber(msg) {
  return (msg.key.participant || msg.key.remoteJid || '').split('@')[0];
}

// Foto struk/nota + caption mengandung kata kunci harga/belanja → baca via Gemini vision,
// TAPI belum langsung insert ke DB. Hasil scan ditaruh pending, minta konfirmasi user dulu.
async function handleReceiptScan(sock, logger, { msg, jid, senderNumber, senderName }) {
  await sock.sendMessage(jid, { text: '🧾 Membaca struk...' });
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const mimeType = getImageMessage(msg)?.mimetype || 'image/jpeg';
    const { total, toko, catatan, source } = await extractReceiptData({ chatId: jid, imageBase64: buffer.toString('base64'), mimeType });

    const note = [toko, catatan].filter(Boolean).join(' - ') || 'belanja (dari struk)';
    const category = toko || catatan || 'Lainnya';
    const key = `${jid}:${senderNumber}`;
    pendingExpenseConfirm.set(key, { amount: total, category, note, expiresAt: Date.now() + EXPENSE_CONFIRM_TTL_MS });

    const rupiah = total.toLocaleString('id-ID');
    const sourceNote = source === 'ollama-fallback' ? '\n_(dibaca via Ollama lokal, Gemini sedang tidak tersedia)_' : '';
    await sock.sendMessage(jid, {
      text: `🧾 *Hasil scan struk*\nTotal: Rp ${rupiah}${toko ? `\nToko: ${toko}` : ''}${catatan ? `\nCatatan: ${catatan}` : ''}${sourceNote}\n\nSimpan ke catatan pengeluaran? Balas *ya* untuk simpan, *batal* untuk buang. (berlaku 5 menit)`,
      quoted: msg,
    });
  } catch (err) {
    if (err.name === 'ReceiptUnreadable') {
      await sock.sendMessage(jid, { text: `Maaf, struknya belum kebaca jelas (${err.message}). Coba foto ulang yang lebih terang/jelas, atau catat manual: !catat <jumlah> <catatan>`, quoted: msg });
      return;
    }
    logger.error({ err }, 'Receipt scan failed');
    await sock.sendMessage(jid, { text: aiErrorHint(err), quoted: msg });
  }
}

// Cek apakah pesan ini balasan konfirmasi ("ya"/"batal") untuk struk yang baru di-scan.
// Return true kalau sudah ditangani di sini (jangan lanjut ke parseMessage/command biasa).
async function tryHandleExpenseConfirmReply(sock, logger, { jid, senderNumber, text, msg }) {
  const key = `${jid}:${senderNumber}`;
  const pending = pendingExpenseConfirm.get(key);
  if (!pending) return false;

  if (pending.expiresAt < Date.now()) {
    pendingExpenseConfirm.delete(key);
    return false;
  }

  const t = text.trim();
  if (CONFIRM_YES.test(t)) {
    pendingExpenseConfirm.delete(key);
    expenses.addExpense({ number: senderNumber, amount: pending.amount, category: pending.category, note: pending.note });
    logger.info({ senderNumber, amount: pending.amount }, 'Expense recorded via receipt scan confirm');
    const rupiah = pending.amount.toLocaleString('id-ID');
    await sock.sendMessage(jid, { text: `✅ Tersimpan: Rp ${rupiah} - ${pending.note}`, quoted: msg });
    return true;
  }
  if (CONFIRM_NO.test(t)) {
    pendingExpenseConfirm.delete(key);
    await sock.sendMessage(jid, { text: '❌ Dibuang, tidak disimpan.', quoted: msg });
    return true;
  }
  return false;
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
  // supaya admin tahu ada group baru yang butuh akses.
  if (!seenGroups.has(groupId)) {
    seenGroups.add(groupId);
    const isWhitelisted = isGroupAllowed(groupId);
    logger.info({ groupId, whitelisted: isWhitelisted },
      isWhitelisted
        ? 'Whitelisted group detected. Bot aktif di group ini.'
        : `Pesan dari group yang BELUM di-whitelist (${groupId}). Admin bisa mendaftarkannya dari group itu dengan perintah: "@kacan tambahkan group id ini untuk akses kamu".`);
  }

  // Group belum di-whitelist → bot tidak merespons, KECUALI admin meminta akses:
  // "@kacan tambahkan group id ini untuk akses kamu" → daftarkan group ini ke DB.
  if (!isGroupAllowed(groupId)) {
    const isAddCmd = /^!(?:tambahgroup|allowgroup)\b/i.test(text);
    if (isAddCmd || (text.toLowerCase().includes(config.triggerWord) && isAddGroupRequest(text))) {
      if (access.isAdmin(senderNumber)) {
        await addGroupToWhitelist(sock, logger, groupId, senderNumber, msg);
      } else {
        await sock.sendMessage(groupId, { text: 'Maaf, hanya admin keluarga yang bisa menambahkan group ini ke daftar akses bot.' });
      }
    }
    return;
  }

  // Akses kontrol: nomor yang tidak terdaftar sebagai anggota keluarga tidak diproses.
  if (!access.isFamilyMember(senderNumber, groupId)) {
    logger.debug({ senderNumber }, 'Non-family member message ignored');
    return;
  }

  // Balasan konfirmasi struk ("ya"/"batal") → tangani duluan, sebelum command biasa.
  if (await tryHandleExpenseConfirmReply(sock, logger, { jid: groupId, senderNumber, text, msg })) return;

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
        if (getImageMessage(msg)) {
          if (RECEIPT_KEYWORDS.test(question || '')) {
            await handleReceiptScan(sock, logger, { msg, jid: groupId, senderNumber, senderName });
          } else {
            await handleImageQuestion(sock, logger, config, { msg, jid: groupId, question, senderName });
          }
          break;
        }
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
      case 'image-search':
        await handleSearchImage(sock, logger, config, { msg, groupId, senderNumber, arg: parsed.arg });
        break;
      case 'image-generate':
        await handleGenerateImage(sock, logger, config, { msg, groupId, senderNumber, arg: parsed.arg });
        break;
      case 'web-search':
        await handleWebSearchCommand(sock, logger, config, { msg, jid: groupId, query: parsed.arg, senderName, senderNumber });
        break;
      case 'admin':
        await handleAdminCommand(sock, logger, config, { msg, groupId, senderNumber, arg: parsed.arg });
        break;
      case 'group-add':
        if (!access.isAdmin(senderNumber)) {
          await sock.sendMessage(groupId, { text: 'Maaf, command ini khusus admin keluarga.', quoted: msg });
          return;
        }
        await addGroupToWhitelist(sock, logger, groupId, senderNumber, msg);
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
  const jid = msg.key.remoteJid;

  // Balasan konfirmasi struk ("ya"/"batal") → tangani duluan, sebelum command biasa.
  if (await tryHandleExpenseConfirmReply(sock, logger, { jid, senderNumber, text, msg })) return;

  const parsed = parseMessage(text, config);
  if (!parsed) return;

  logger.info({ kind: parsed.kind, senderNumber, senderName }, 'Direct message command processed');

  try {
    switch (parsed.kind) {
      case 'help':
        await sock.sendMessage(jid, { text: HELP_TEXT });
        break;
      case 'assistant':
        if (getImageMessage(msg)) {
          if (RECEIPT_KEYWORDS.test(parsed.question || '')) {
            await handleReceiptScan(sock, logger, { msg, jid, senderNumber, senderName });
          } else {
            await handleImageQuestion(sock, logger, config, { msg, jid, question: parsed.question, senderName });
          }
          break;
        }
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
      case 'group-add':
        await sock.sendMessage(jid, { text: 'Perintah tambah group harus dijalankan di dalam group yang mau diaktifkan, contoh: "@kacan tambahkan group id ini untuk akses kamu".' });
        break;
      case 'image-search':
        await handleSearchImage(sock, logger, config, { msg, groupId: jid, senderNumber, arg: parsed.arg });
        break;
      case 'image-generate':
        await handleGenerateImage(sock, logger, config, { msg, groupId: jid, senderNumber, arg: parsed.arg });
        break;
      case 'web-search':
        await handleWebSearchCommand(sock, logger, config, { msg, jid, query: parsed.arg, senderName, senderNumber });
        break;
      default:
        break;
    }
  } catch (err) {
    logger.error({ err, kind: parsed.kind }, 'Direct handler error (caught)');
  }
}

export async function startWhatsApp(env, log, onMessage) {
  seedWhitelistFromEnv(env, log);
  config = {
    whitelist: loadWhitelist(env),
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
