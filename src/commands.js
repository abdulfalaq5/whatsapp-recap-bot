import * as storage from './storage.js';
import * as ollama from './ollama.js';

export const HELP_TEXT = `Command yang tersedia:
• @kacan <pertanyaan> - panggil asisten AI (tulis di mana saja dalam pesan)
• !ai <pertanyaan> / !tanya <pertanyaan> - alternatif panggil asisten
• !rekap - rekap chat hari ini
• !rekap kemarin - rekap chat kemarin
• !rekap 3hari (atau angka lain) - rekap N hari terakhir
• !lupa / !reset - hapus memori percakapan asisten
• !help / !bantuan - tampilkan command ini`;

function stripPrefix(text, prefixes) {
  for (const p of prefixes) {
    if (text.startsWith(p)) return text.slice(p.length).trim();
  }
  return null;
}

export function parseMessage(text, config) {
  const t = (text ?? '').trim();
  if (!t) return null;

  const lower = t.toLowerCase();

  if (lower.startsWith('!help') || lower.startsWith('!bantuan')) {
    return { kind: 'help' };
  }

  if (lower.startsWith('!lupa') || lower.startsWith('!reset')) {
    return { kind: 'reset' };
  }

  if (lower.startsWith('!rekap')) {
    const arg = t.slice('!rekap'.length).trim();
    return { kind: 'rekap', arg };
  }

  const aiPrefixes = (config.ASSISTANT_TRIGGER_PREFIXES || '!ai,!tanya')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const viaPrefix = stripPrefix(t, aiPrefixes);
  if (viaPrefix !== null) {
    return { kind: 'assistant', question: viaPrefix };
  }

  const triggerWord = (config.ASSISTANT_TRIGGER_WORD || '@kacan').toLowerCase();
  if (lower.includes(triggerWord)) {
    // buang trigger word dari isi pertanyaan (di mana pun posisinya, case-insensitive)
    const question = t.replace(new RegExp(triggerWord, 'gi'), '').trim();
    return { kind: 'assistant', question };
  }

  return null;
}

// Hitung rentang waktu (ms) untuk argumen rekap
function resolveDateRange(arg) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endNow = now.getTime();

  if (!arg) return { startTimestamp: startOfToday, endTimestamp: endNow, label: 'hari ini' };

  const lower = arg.toLowerCase();
  if (lower === 'kemarin' || lower === 'yesterday') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
    return { startTimestamp: start, endTimestamp: startOfToday, label: 'kemarin' };
  }

  const m = lower.match(/^(\d+)hari$/);
  if (m) {
    const days = Math.max(1, parseInt(m[1], 10));
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
    return { startTimestamp: start, endTimestamp: endNow, label: `${days} hari terakhir` };
  }

  const m2 = lower.match(/^(\d+)d$/);
  if (m2) {
    const days = Math.max(1, parseInt(m2[1], 10));
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
    return { startTimestamp: start, endTimestamp: endNow, label: `${days} hari terakhir` };
  }

  return { startTimestamp: startOfToday, endTimestamp: endNow, label: 'hari ini' };
}

export function formatChatHistory(rows) {
  return rows
    .map((r) => {
      const time = new Date(r.timestamp).toTimeString().slice(0, 5);
      return `[${time}] ${r.sender_name || r.sender_number || '?'}: ${r.message}`;
    })
    .join('\n');
}

export async function handleRekap(sock, logger, groupId, arg) {
  const range = resolveDateRange(arg);
  const rows = storage.getMessagesByDateRange(groupId, range.startTimestamp, range.endTimestamp);

  if (rows.length === 0) {
    await sock.sendMessage(groupId, { text: `Belum ada chat untuk direkap (${range.label}).` });
    return;
  }

  await sock.sendMessage(groupId, { text: `Menyusun rekap untuk ${range.label} (${rows.length} pesan)...` });

  const historyText = formatChatHistory(rows);
  try {
    const recap = await ollama.generateRecap(historyText);
    const header = `📋 *Rekap ${range.label}*\n`;
    await sock.sendMessage(groupId, { text: header + recap });
  } catch (err) {
    logger.error({ err }, 'Rekap generation failed');
    await sock.sendMessage(groupId, { text: ollama.ollamaErrorHint(err) });
  }
}
