import { getDb } from './storage.js';
import { rawChat } from './ollama.js';
import { chatWithCloudFallback } from './ai.js';
import * as storage from './storage.js';

const PARSE_SYSTEM_PROMPT = `Kamu adalah parser tanggal/waktu untuk fitur reminder keluarga.
Tugasmu mengubah teks natural menjadi waktu pengingat.
Hari ini tanggal: {today} (gunakan zona waktu lokal).
Aturan:
- "jam 9 pagi" = 09:00, "jam 9 malam" = 21:00, "jam 9" tanpa keterangan = 09:00.
- "tgl 20", "tanggal 20" = hari 20 bulan ini (atau bulan depan kalau sudah lewat).
- Relatif: "besok", "lusa", "sabtu", "minggu depan", "nanti malam", dst.
- Kalau tidak ada tanggal spesifik tapi ada jam, pakai hari ini (atau besok kalau sudah lewat).
- Jawab HANYA dengan JSON satu baris: {"datetime":"YYYY-MM-DDTHH:mm:ss"}
- Kalau tidak bisa ditentukan sama sekali: {"error":"<alasan singkat>"}
Jangan tambahkan teks lain di luar JSON.`;

function parseJsonLoose(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export async function parseReminderText(text, logger) {
  const today = new Date().toLocaleString('id-ID', { dateStyle: 'full', timeZone: process.env.TZ || 'Asia/Jakarta' });
  const messages = [
    { role: 'system', content: PARSE_SYSTEM_PROMPT.replace('{today}', today) },
    { role: 'user', content: text },
  ];
  try {
    const reply = await rawChat(messages);
    const parsed = parseJsonLoose(reply);
    if (!parsed?.datetime) {
      logger.warn({ reply }, 'Reminder parse failed');
      return { error: parsed?.error || 'Tidak bisa memahami waktu yang diminta.' };
    }
    const t = new Date(parsed.datetime);
    if (Number.isNaN(t.getTime())) return { error: 'Format waktu tidak valid.' };
    return { at: t.getTime() };
  } catch (err) {
    // Ollama gagal → fallback ke chain cloud (Gemini/Groq/OpenRouter/...)
    logger.warn({ err }, 'Ollama reminder parse failed, fallback ke cloud');
    try {
      const { reply } = await chatWithCloudFallback(messages);
      const parsed = parseJsonLoose(reply);
      if (!parsed?.datetime) {
        logger.warn({ reply }, 'Reminder parse failed (cloud)');
        return { error: parsed?.error || 'Tidak bisa memahami waktu yang diminta.' };
      }
      const t = new Date(parsed.datetime);
      if (Number.isNaN(t.getTime())) return { error: 'Format waktu tidak valid.' };
      return { at: t.getTime() };
    } catch (cloudErr) {
      logger.error({ err: cloudErr }, 'Reminder parse LLM error (all providers)');
      return { error: 'LLM sedang bermasalah, coba lagi sebentar.' };
    }
  }
}

const HELP_TEXT = `Format reminder:
• !ingetin <pesan> — buat reminder, contoh: "!ingetin bayar listrik tgl 20 jam 9 pagi"
• !reminder list — daftar reminder aktif
• !reminder hapus <id> — hapus reminder`;

export async function handleReminderCommand(sock, logger, config, { msg, groupId, senderNumber, arg }) {
  const lower = (arg || '').trim().toLowerCase();

  if (!lower || lower === 'help' || lower === 'bantuan') {
    await sock.sendMessage(groupId, { text: HELP_TEXT, quoted: msg });
    return;
  }

  if (lower === 'list') {
    const rows = listRemindersByNumber(senderNumber);
    if (rows.length === 0) {
      await sock.sendMessage(groupId, { text: 'Tidak ada reminder aktif. Buat dengan: !ingetin <pesan>', quoted: msg });
      return;
    }
    const lines = rows.map((r) => {
      const when = new Date(r.remind_at).toLocaleString('id-ID');
      return `• [${r.id}] ${r.text} — ${when}`;
    });
    await sock.sendMessage(groupId, { text: `⏰ *Reminder aktif kamu*:\n${lines.join('\n')}\n\nHapus: !reminder hapus <id>`, quoted: msg });
    return;
  }

  const hapus = lower.match(/^hapus\s+(\d+)$/);
  if (hapus) {
    const id = Number(hapus[1]);
    const row = getReminder(id);
    if (!row || row.number !== senderNumber) {
      await sock.sendMessage(groupId, { text: `Reminder ${id} tidak ditemukan.`, quoted: msg });
      return;
    }
    deleteReminder(id);
    await sock.sendMessage(groupId, { text: `🗑️ Reminder "${row.text}" dihapus.`, quoted: msg });
    return;
  }

  // Fallback: "!ingetin <teks>" → buat reminder
  const result = await parseReminderText(arg, logger);
  if (result.error) {
    await sock.sendMessage(groupId, { text: `Gagal membuat reminder: ${result.error}\n\n${HELP_TEXT}`, quoted: msg });
    return;
  }
  addReminder({ number: senderNumber, groupId, text: arg, remindAt: result.at });
  const when = new Date(result.at).toLocaleString('id-ID');
  logger.info({ senderNumber, remindAt: result.at }, 'Reminder created');
  await sock.sendMessage(groupId, { text: `⏰ Oke! Aku ingetin kamu: "${arg}"\n📅 ${when}`, quoted: msg });
}

// Cek reminder yang jatuh tempo tiap menit.
export function startReminderScheduler(getSocket, logger) {
  const run = async () => {
    const now = Date.now();
    let due;
    try {
      due = listReminders('pending').filter((r) => r.remind_at <= now);
    } catch (err) {
      logger.error({ err }, 'Reminder query failed');
      return;
    }
    if (due.length === 0) {
      deleteOldReminders();
      return;
    }
    const sock = getSocket();
    if (!sock) {
      logger.warn('Socket belum tersedia, reminder tertunda');
      return;
    }
    for (const r of due) {
      try {
        const target = r.group_id || `${r.number}@s.whatsapp.net`;
        await sock.sendMessage(target, { text: `⏰ *Reminder*: ${r.text}\n🗓️ ${new Date(r.remind_at).toLocaleString('id-ID')}` });
        markReminderDone(r.id);
        logger.info({ id: r.id, target }, 'Reminder fired');
      } catch (err) {
        logger.error({ err, id: r.id }, 'Failed to fire reminder');
      }
    }
  };

  run();
  const task = setInterval(run, 60 * 1000);
  logger.info('Reminder scheduler started (tiap 1 menit)');
  return { stop: () => clearInterval(task) };
}

export function addReminder({ number, groupId, text, remindAt }) {
  getDb().prepare(`
    INSERT INTO reminders (number, group_id, text, remind_at, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(number, groupId || null, text, remindAt, Date.now());
}

export function getReminder(id) {
  return getDb().prepare(`SELECT * FROM reminders WHERE id = ?`).get(id);
}

export function listReminders(status = 'pending') {
  return getDb().prepare(`
    SELECT * FROM reminders WHERE status = ? ORDER BY remind_at ASC
  `).all(status);
}

export function listRemindersByNumber(number, status = 'pending') {
  return getDb().prepare(`
    SELECT * FROM reminders WHERE number = ? AND status = ? ORDER BY remind_at ASC
  `).all(number, status);
}

export function markReminderDone(id) {
  getDb().prepare(`UPDATE reminders SET status = 'done' WHERE id = ?`).run(id);
}

export function deleteReminder(id) {
  return getDb().prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
}

export function deleteOldReminders(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return getDb().prepare(`DELETE FROM reminders WHERE status = 'done' AND remind_at < ?`).run(cutoff);
}
