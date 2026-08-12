import * as storage from './storage.js';
import * as ai from './ai.js';
import * as expenses from './expenses.js';
import { handleSearchImage, handleGenerateImage } from './imageCommands.js';

export const HELP_TEXT = `Command yang tersedia:
• @kacan <pertanyaan> - panggil asisten AI (tulis di mana saja dalam pesan)
• !ai <pertanyaan> / !tanya <pertanyaan> - alternatif panggil asisten
• @kacan naikan level (mu) - pindahkan chat ini ke mode cloud (langsung pakai model cloud)
• @kacan standarkan level - kembalikan ke mode standar (Ollama dulu, fallback cloud)
• @kacan status level - cek mode AI chat ini saat ini
• !rekap - rekap chat hari ini
• !rekap kemarin - rekap chat kemarin
• !rekap 3hari (atau angka lain) - rekap N hari terakhir
• !lupa / !reset - hapus memori percakapan asisten grup
• !lupakan - hapus histori percakapan kamu sendiri
• ⏰ !ingetin <pesan> | !reminder list | !reminder hapus <id>
• 🛒 !belanja tambah <item> | !belanja list | !belanja selesai <item>
• 💸 !catat <jumlah> <catatan> | !rekap bulan ini | !export
• 🌤️ !cuaca | 🕌 !sholat
• 🖼️ !carigambar <kata kunci> | 🎨 !buatgambar <deskripsi>
• @kacan help / !help / !bantuan - tampilkan daftar command
• 🔎 !cari <topik> - cari info di internet sekarang (selalu pakai Tavily)
• @kacan tambahkan group id ini untuk akses kamu - daftarkan group ini (khusus admin)
Admin: !restart | !log | !broadcast <pesan> | !tambahmember <nomor> <nama> | !tambahgroup | !hapusgroup <group id> | !reset semua`;

function stripPrefix(text, prefixes) {
  for (const p of prefixes) {
    if (text.startsWith(p)) return text.slice(p.length).trim();
  }
  return null;
}

// "help"/"bantuan" setelah trigger (misal "@kacan help", "!ai help") → tampilkan daftar command.
function isHelpRequest(s) {
  return /^(help|bantuan|menu|command|commands|list\s*command|daftar\s*(?:perintah|command))$/i.test(String(s || '').trim());
}

// Command level AI ("@kacan naikan level mu", "standarkan level", "status level").
// Hanya dipicu kalau trigger word bot disebut, dan bisa dipakai semua member.
function matchLevelCommand(text, config) {
  const lower = text.toLowerCase();
  const trigger = (config.ASSISTANT_TRIGGER_WORD || '@kacan').toLowerCase();
  if (!lower.includes(trigger)) return null;
  if (/naik(?:kan?|an)?\s+level/.test(lower)) return { kind: 'ai-level', arg: 'cloud' };
  if (/standar(?:d)?(?:kan?)?\s+level/.test(lower)) return { kind: 'ai-level', arg: 'standard' };
  if (/status\s+provider/.test(lower)) return { kind: 'ai-level', arg: 'provider' };
  if (/status\s+level/.test(lower)) return { kind: 'ai-level', arg: 'status' };
  return null;
}

// Deteksi permintaan admin untuk mendaftarkan group ke daftar akses bot.
// Contoh: "@kacan tambahkan group id ini untuk akses kamu".
const ADD_GROUP_PATTERN = /(?:tambah(?:kan|in)?|daftar(?:kan)?)\s+group|(?:minta|beri|kasih)\s+akses/i;

export function isAddGroupRequest(text) {
  return ADD_GROUP_PATTERN.test(String(text || '').trim());
}

export function parseMessage(text, config) {
  const t = (text ?? '').trim();
  if (!t) return null;

  const lower = t.toLowerCase();
  const triggerWord = (config.ASSISTANT_TRIGGER_WORD || '@kacan').toLowerCase();

  if (lower.startsWith('!help') || lower.startsWith('!bantuan')) {
    return { kind: 'help' };
  }

  // Daftarkan group ini ke whitelist (khusus admin). Wajib pakai trigger word
  // supaya tidak tabrakan dengan pertanyaan biasa ke asisten.
  if (lower.includes(triggerWord) && isAddGroupRequest(t)) {
    return { kind: 'group-add' };
  }

  if (lower.startsWith('!lupakan')) {
    return { kind: 'forget' };
  }

  if (/^!(?:reset|lupa|hapus\s+semua)\s+semua$/.test(lower) || lower.startsWith('!lupa semua') || lower.startsWith('!reset semua')) {
    return { kind: 'reset-all' };
  }

  if (lower.startsWith('!lupa') || lower.startsWith('!reset')) {
    return { kind: 'reset' };
  }

  // Admin commands (diproses handleAdminCommand)
  if (/^!(restart|log|broadcast|tambahmember|tambahgroup|allowgroup|hapusgroup)\b/.test(lower)) {
    return { kind: 'admin', arg: t.slice(1) };
  }

  // Reminder
  if (lower.startsWith('!ingetin')) {
    return { kind: 'reminder', arg: t.slice('!ingetin'.length).trim() };
  }
  if (lower.startsWith('!reminder')) {
    return { kind: 'reminder', arg: t.slice('!reminder'.length).trim() };
  }

  // Shopping list
  if (lower.startsWith('!belanja')) {
    return { kind: 'shopping', arg: t.slice('!belanja'.length).trim() };
  }

  // Expenses
  if (lower.startsWith('!catat')) {
    return { kind: 'expense-add', arg: t.slice('!catat'.length).trim() };
  }
  if (lower.startsWith('!export')) {
    return { kind: 'expense-export', arg: t.slice('!export'.length).trim() };
  }

  // Info cepat
  if (lower.startsWith('!cuaca')) return { kind: 'weather', arg: '' };
  if (lower.startsWith('!sholat')) return { kind: 'prayer', arg: '' };

  // Gambar: cari dari internet / generate dengan AI
  if (lower.startsWith('!carigambar')) {
    return { kind: 'image-search', arg: t.slice('!carigambar'.length).trim() };
  }
  if (lower.startsWith('!buatgambar')) {
    return { kind: 'image-generate', arg: t.slice('!buatgambar'.length).trim() };
  }

  // Pencarian internet paksa (selalu pakai Tavily). Ditaruh SETELAH !carigambar
  // supaya tidak menelan prefix command gambar.
  if (lower.startsWith('!cari')) {
    return { kind: 'web-search', arg: t.slice('!cari'.length).trim() };
  }

  // Rekap chat (tetap backward-compatible). "!rekap bulan ini" → rekap pengeluaran.
  if (lower.startsWith('!rekap')) {
    const arg = t.slice('!rekap'.length).trim();
    if (/\bbulan|pengeluaran|expense/i.test(arg) && !/hari|d$/.test(arg)) {
      return { kind: 'expense-recap', arg };
    }
    return { kind: 'rekap', arg };
  }

  const aiPrefixes = (config.ASSISTANT_TRIGGER_PREFIXES || '!ai,!tanya')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const viaPrefix = stripPrefix(t, aiPrefixes);
  if (viaPrefix !== null) {
    if (isHelpRequest(viaPrefix)) return { kind: 'help' };
    return { kind: 'assistant', question: viaPrefix };
  }

  // Command level AI dicek dulu sebelum pesan diproses sebagai prompt asisten.
  const levelCommand = matchLevelCommand(t, config);
  if (levelCommand) return levelCommand;

  if (lower.includes(triggerWord)) {
    // buang trigger word dari isi pertanyaan (di mana pun posisinya, case-insensitive)
    const question = t.replace(new RegExp(triggerWord, 'gi'), '').trim();
    if (isHelpRequest(question)) return { kind: 'help' };
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

function monthRange(arg) {
  const now = new Date();
  const m = String(arg).toLowerCase().match(/^(jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)/);
  const month = m ? ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'].indexOf(m[1]) : now.getMonth();
  const year = /\b(20\d{2})\b/.test(String(arg)) ? Number(String(arg).match(/\b(20\d{2})\b/)[1]) : now.getFullYear();
  const start = new Date(year, month, 1).getTime();
  const end = new Date(year, month + 1, 1).getTime() - 1;
  return { startTimestamp: start, endTimestamp: end, label: new Date(year, month, 1).toLocaleString('id-ID', { month: 'long', year: 'numeric' }) };
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
    const { text: recap, provider } = await ai.generateRecap(historyText);
    logger.info({ provider }, 'Rekap generated via');
    const header = `📋 *Rekap ${range.label}*\n`;
    await sock.sendMessage(groupId, { text: header + recap });
  } catch (err) {
    logger.error({ err }, 'Rekap generation failed');
    await sock.sendMessage(groupId, { text: ai.aiErrorHint(err) });
  }
}

// ---- Pengeluaran ----

export function parseExpenseArg(arg) {
  const m = String(arg || '').trim().match(/^(\d[\d.,]*)\s*(.*)$/);
  if (!m) return null;
  const amount = Math.round(Number(m[1].replace(/\./g, '').replace(',', '.')));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const note = m[2].trim();
  return { amount, note };
}

export async function handleExpenseAdd(sock, logger, ctx, arg) {
  const parsed = parseExpenseArg(arg);
  if (!parsed) {
    await sock.sendMessage(ctx.groupId, { text: 'Format: !catat <jumlah> <catatan>\nContoh: !catat 50000 belanja bulanan', quoted: ctx.msg });
    return;
  }
  const note = parsed.note;
  const categoryMatch = note.match(/^(?:untuk|kategori\s+)?(.+?)(?:\s+di)?$/i);
  const category = note || 'Lainnya';
  expenses.addExpense({ number: ctx.senderNumber, amount: parsed.amount, category, note });
  const rupiah = parsed.amount.toLocaleString('id-ID');
  logger.info({ number: ctx.senderNumber, amount: parsed.amount, note }, 'Expense recorded');
  await sock.sendMessage(ctx.groupId, {
    text: `💸 *Catatan pengeluaran*\nJumlah: Rp ${rupiah}\nCatatan: ${note}\n\nKalau mau rekap: "!rekap bulan ini"`,
    quoted: ctx.msg,
  });
}

export async function handleExpenseRecap(sock, logger, ctx, arg) {
  const range = monthRange(arg);
  const rows = expenses.getExpensesByRange(range.startTimestamp, range.endTimestamp);
  if (rows.length === 0) {
    await sock.sendMessage(ctx.groupId, { text: `Belum ada pengeluaran tercatat untuk ${range.label}.`, quoted: ctx.msg });
    return;
  }
  const summary = expenses.getExpenseSummary(range.startTimestamp, range.endTimestamp);
  const total = expenses.getExpenseTotal(range.startTimestamp, range.endTimestamp);
  const lines = summary.map((s) => `• ${s.category}: Rp ${Number(s.total).toLocaleString('id-ID')} (${s.count}x)`);
  await sock.sendMessage(ctx.groupId, {
    text: `💸 *Rekap Pengeluaran ${range.label}*\n\n${lines.join('\n')}\n\n💰 *Total: Rp ${total.toLocaleString('id-ID')}*`,
    quoted: ctx.msg,
  });
}

export async function handleExpenseExport(sock, logger, ctx, arg) {
  const range = monthRange(arg);
  const rows = expenses.getExpensesByRange(range.startTimestamp, range.endTimestamp);
  if (rows.length === 0) {
    await sock.sendMessage(ctx.groupId, { text: 'Belum ada pengeluaran untuk di-export.', quoted: ctx.msg });
    return;
  }
  const header = 'tanggal;jumlah;kategori;catatan;nomor';
  const lines = rows.map((r) => [
    new Date(r.timestamp).toISOString(),
    r.amount,
    r.category || '',
    (r.note || '').replace(/;/g, ','),
    r.number,
  ].join(';'));
  const csv = [header, ...lines].join('\n');
  await sock.sendMessage(ctx.groupId, {
    text: `📄 Export pengeluaran ${range.label} (${rows.length} baris).`,
    contextInfo: { externalAdReply: null },
  });
  try {
    await sock.sendMessage(ctx.groupId, {
      document: Buffer.from(csv, 'utf8'),
      fileName: `pengeluaran-${Date.now()}.csv`,
      mimetype: 'text/csv',
      caption: `Pengeluaran ${range.label}`,
    }, { quoted: ctx.msg });
  } catch (err) {
    logger.error({ err }, 'CSV send failed, fallback text');
    await sock.sendMessage(ctx.groupId, { text: `\`\`\`${csv.slice(0, 3000)}\`\`\``, quoted: ctx.msg });
  }
}
