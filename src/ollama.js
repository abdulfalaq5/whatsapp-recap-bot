import { format } from 'node:util';
import { PERSONALITY_SYSTEM_PROMPT, RECAP_SYSTEM_PROMPT } from './prompts/personality.js';

let config;
let logger;

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

export async function generateAssistantReply(question, conversationHistory, senderName = '') {
  const greeting = senderName ? `\n(Pengirim pesan ini bernama ${senderName}. Sambut/sebut namanya kalau wajar.)` : '';
  const contextBlock = conversationHistory.length
    ? `\n\nKonteks percakapan terakhir di grup ini:\n${conversationHistory}\n`
    : '';
  const messages = [
    { role: 'system', content: PERSONALITY_SYSTEM_PROMPT + greeting },
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
