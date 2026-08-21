import * as storage from './storage.js';
import { askAI, aiErrorHint } from './ai.js';
import { formatChatHistory } from './commands.js';
import { getWeatherForecast } from './info.js';
import { searchWeb } from './services/webSearch.js';

// Rate limit per grup: max 1 request tiap N detik
const lastReplyAt = new Map();

// Kata kunci yang menandakan pertanyaan menyinggung obrolan grup
const RECAP_KEYWORDS = /rekap|kemarin|tadi|barusan|tadi dibahas|dibahas|obrolan|chat|pesan|cek/i;

// Kata kunci pertanyaan cuaca → asisten suntik data cuaca asli (Open-Meteo)
const WEATHER_KEYWORDS = /cuaca|hujan|panas|dingin|suhu|berap[a]?[^\s]*derajat|angin|kelembapan|berawan|mendung|cerah|badai|petir|prakiraan|perkiraan|forecast/i;

// Kata kunci pertanyaan yang butuh info TERBARU → asisten cari di internet
// (DuckDuckGo + Wikipedia) lalu jawab pakai hasilnya. Contoh: "harga iphone 17 berapa".
const WEB_SEARCH_KEYWORDS =
  /harga|berapakah|berapa\b|terbaru|terkini|update|berita|kabar|sekarang|hari ini|tahun (ini|depan|202\d|20[2-9]\d)|kapan|tanggal|rilis|launch|release|news|latest|price|skor|hasil pertandingan|jadwal|piala|viral|fenomena|presiden|gubernur|walikota|saham|kurs|dolar|euro|biaya|tarif|\b20(2[4-9]|3\d)\b/i;

function rateLimitOk(groupId, seconds) {
  if (!seconds || seconds <= 0) return true;
  const now = Date.now();
  const last = lastReplyAt.get(groupId) || 0;
  if (now - last < seconds * 1000) return false;
  lastReplyAt.set(groupId, now);
  return true;
}

function buildConversationText(turns, memoryLimit) {
  return turns
    .slice(-memoryLimit)
    .map((t) => {
      if (t.role === 'assistant') return `Asisten: ${t.content}`;
      return `${t.sender_name || 'User'}: ${t.content}`;
    })
    .join('\n');
}

function buildPersonalHistoryText(rows) {
  return rows
    .map((t) => (t.role === 'assistant' ? `Asisten: ${t.content}` : `Kamu (${t.name || 'User'}): ${t.content}`))
    .join('\n');
}

function buildSharedContextText(rows) {
  return rows.map((r) => `• ${r.content}`).join('\n');
}

function shouldAttachGroupContext(question) {
  return RECAP_KEYWORDS.test(question);
}

// Ambil data cuaca asli (Open-Meteo) kalau pertanyaan soal cuaca.
// Gagal (misal WEATHER_LAT/LON belum diisi atau offline) → dikembalikan kosong,
// biar asisten tetap jalan tanpa data cuaca.
async function maybeAttachWeather(question) {
  if (!WEATHER_KEYWORDS.test(question)) return '';
  try {
    const data = await getWeatherForecast();
    return `Data cuaca (akurat dari Open-Meteo):\n${data}`;
  } catch (err) {
    return '';
  }
}

// Cari info terbaru di internet kalau pertanyaannya butuh data kekinian.
// Provider utama Tavily (kalau TAVILY_API_KEY diisi), fallback DuckDuckGo/Wikipedia.
// Gagal/tanpa hasil → dikembalikan kosong, biar asisten tetap jalan normal.
async function maybeAttachWebSearch(question, config, logger) {
  const enabled = (config?.env?.ASSISTANT_WEB_SEARCH_ENABLED ?? 'true') !== 'false';
  if (!enabled) return '';
  if (!WEB_SEARCH_KEYWORDS.test(question)) return '';
  try {
    const data = await searchWeb(question, logger, config?.env?.TAVILY_API_KEY || '');
    if (!data) return '';
    return `Hasil pencarian internet (SUMBER: Tavily/DuckDuckGo/Wikipedia). Data ini yang paling update; utamakan untuk informasi yang berubah-ubah seperti harga, berita, skor, jadwal:\n${data}`;
  } catch (err) {
    logger.debug?.({ err }, 'Web search skipped');
    return '';
  }
}

async function getRecentGroupContext(groupId, minutes = 180) {
  const end = Date.now();
  const start = end - minutes * 60 * 1000;
  const rows = storage.getMessagesByDateRange(groupId, start, end);
  return formatChatHistory(rows);
}

// Bangun konteks (memory grup/personal/shared, cuaca, web search) lalu panggil askAI dan
// simpan hasilnya ke memory. Dipakai oleh handleAssistant (chat teks) dan mode "!dengerin"
// (voice note) — supaya keduanya berbagi flow asisten yang sama persis.
export async function getAssistantReply(logger, config, { groupId, question, senderName, senderNumber }) {
  const memoryLimit = Number(config.CONVERSATION_MEMORY_LIMIT || 20);
  const recentTurns = storage.getRecentConversation(groupId, memoryLimit);
  const conversationText = buildConversationText(recentTurns, memoryLimit);

  let groupContext = '';
  if (shouldAttachGroupContext(question)) {
    groupContext = await getRecentGroupContext(groupId);
  }

  // Memory per-nomor + shared context keluarga
  const personalHistory = senderNumber
    ? buildPersonalHistoryText(storage.getRecentMemberHistory(senderNumber, Number(config.PERSONAL_MEMORY_LIMIT || 20)))
    : '';
  const shared = storage.getSharedContext();
  const sharedText = shared.length ? buildSharedContextText(shared) : '';

  const contextParts = [];
  if (sharedText) contextParts.push(`Konteks keluarga bersama (agenda/pengumuman):\n${sharedText}`);
  if (personalHistory) contextParts.push(`Riwayat obrolan pribadi kamu dengan asisten (${senderName}):\n${personalHistory}`);
  if (groupContext) contextParts.push(`Obrolan grup terbaru (${groupContext.split('\n').length} baris):\n${groupContext}`);
  const weatherData = await maybeAttachWeather(question);
  if (weatherData) contextParts.push(weatherData);
  const webData = await maybeAttachWebSearch(question, config, logger);
  if (webData) contextParts.push(webData);
  const fullContext = contextParts.join('\n\n');

  logger.info({ groupId, question, hasPersonal: !!personalHistory, hasShared: !!sharedText, hasWeather: !!weatherData, hasWebSearch: !!webData }, 'Assistant request');

  const reply = await askAI({
    chatId: groupId,
    question,
    context: fullContext || conversationText,
    senderName,
    senderNumber,
  });
  const now = Date.now();

  storage.saveConversationTurn({ groupId, role: 'user', senderName, content: question, timestamp: now });
  storage.saveConversationTurn({ groupId, role: 'assistant', senderName: null, content: reply, timestamp: now });
  if (senderNumber) {
    storage.saveMemberTurn({ number: senderNumber, name: senderName, role: 'user', content: question, timestamp: now });
    storage.saveMemberTurn({ number: senderNumber, name: null, role: 'assistant', content: reply, timestamp: now });
  }

  return reply;
}

export async function handleAssistant(sock, logger, config, message) {
  const groupId = message.key.remoteJid;
  const senderName = message.senderName || message.pushName || 'User';
  const senderNumber = message.senderNumber || '';

  if (!rateLimitOk(groupId, Number(config.ASSISTANT_RATE_LIMIT_SECONDS || 5))) {
    logger.info({ groupId }, 'Assistant rate limited, skipping');
    return;
  }

  try {
    const reply = await getAssistantReply(logger, config, { groupId, question: message.text, senderName, senderNumber });
    await sock.sendMessage(groupId, { text: reply }, { quoted: message.original });
    logger.info({ groupId }, 'Assistant reply sent');
  } catch (err) {
    logger.error({ err }, 'Assistant generation failed');
    await sock.sendMessage(groupId, { text: aiErrorHint(err) });
  }
}
