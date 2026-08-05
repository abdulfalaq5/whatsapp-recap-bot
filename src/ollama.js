import { format } from 'node:util';

let config;
let logger;

const RECAP_SYSTEM_PROMPT = `Kamu adalah asisten yang membuat rekap ringkas dari percakapan grup WhatsApp.
Tugasmu:
- Rangkum topik-topik utama yang dibahas.
- Sebutkan poin-poin penting/keputusan/tugas yang muncul (jika ada).
- Gunakan format list yang rapi, bahasa Indonesia santai tapi jelas.
- Jangan mengarang informasi yang tidak ada di percakapan.
- Jika chat berisi data/angka (misal laporan penjualan, rekap kegiatan), tampilkan sebagai ringkasan terstruktur.`;

const ASSISTANT_SYSTEM_PROMPT = `Kamu adalah asisten AI yang aktif membantu di dalam grup WhatsApp ini.
Tugasmu:
- Jawab pertanyaan anggota grup dengan jelas, ringkas, dan akurat.
- Bantu analisis data/angka yang dibagikan di grup jika diminta.
- Kalau pertanyaan butuh konteks dari chat sebelumnya di grup ini, gunakan konteks yang diberikan.
- Sebutkan nama pengirim jika relevan untuk menjawab secara personal (mis. "Untuk [nama], ...").
- Jawab dalam bahasa Indonesia, gaya santai tapi informatif, jangan bertele-tele.
- Kalau tidak tahu jawabannya atau informasinya tidak ada di konteks, katakan terus terang, jangan mengarang.`;

export function initOllama(env, log) {
  config = {
    model: env.OLLAMA_MODEL || 'llama3.1',
    baseUrl: (env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, ''),
    timeoutMs: Number(env.OLLAMA_TIMEOUT_MS || 120000),
  };
  logger = log;
  logger.info({ model: config.model, baseUrl: config.baseUrl }, 'Ollama wrapper ready');
  return config;
}

async function chat(messages, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        ...options,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

export async function generateRecap(chatHistoryText) {
  const messages = [
    { role: 'system', content: RECAP_SYSTEM_PROMPT },
    { role: 'user', content: `Berikut adalah percakapan grup yang perlu direkap:\n\n${chatHistoryText}` },
  ];
  return chat(messages);
}

export async function generateAssistantReply(question, conversationHistory) {
  const contextBlock = conversationHistory.length
    ? `\n\nKonteks percakapan terakhir di grup ini:\n${conversationHistory}\n`
    : '';
  const messages = [
    { role: 'system', content: ASSISTANT_SYSTEM_PROMPT },
    { role: 'user', content: `${question}${contextBlock}` },
  ];
  return chat(messages);
}

export { chat as rawChat };

// helper: format error untuk pesan ke grup
export function ollamaErrorHint(err) {
  const cause = err?.cause?.code || err?.name || err?.message || String(err);
  logger.warn({ err }, 'Ollama call failed');
  if (cause === 'ECONNREFUSED') {
    return 'Tidak bisa konek ke Ollama. Pastikan Ollama jalan di host dan OLLAMA_BASE_URL benar.';
  }
  if (cause === 'ENOTFOUND') {
    return format('Gagal resolve host dari OLLAMA_BASE_URL (%s). Pastikan extra_hosts host.docker.internal:host-gateway ada di docker-compose.', config.baseUrl);
  }
  if (cause === 'AbortError') {
    return 'Waktu tunggu Ollama habis, model mungkin sedang sibuk atau terlalu lambat. Coba lagi sebentar.';
  }
  if (/MODEL NOT FOUND|not found/i.test(String(err?.message ?? ''))) {
    return `Model ${config.model} belum di-pull. Jalankan: ollama pull ${config.model}`;
  }
  return 'Maaf, asisten lagi ada gangguan, coba lagi sebentar.';
}
