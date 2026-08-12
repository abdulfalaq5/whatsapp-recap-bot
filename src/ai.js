import * as storage from './storage.js';
import { PERSONALITY_SYSTEM_PROMPT, RECAP_SYSTEM_PROMPT } from './prompts/personality.js';

let config;
let logger;

// Cooldown per provider (ms): saat kuota/limit habis, provider di-skip selama ini
// sebelum dicoba lagi. Disimpan in-memory.
const cooldowns = new Map();

export function initAI(env, log) {
  const rawOrder = (env.AI_CLOUD_PROVIDERS || '').split(',').map((p) => p.trim()).filter(Boolean);
  const legacyProvider = env.AI_CLOUD_PROVIDER === 'sumopod' ? 'sumopod' : env.AI_CLOUD_PROVIDER === 'anthropic' ? 'anthropic' : '';

  config = {
    ollama: {
      model: env.OLLAMA_MODEL || 'llama3',
      baseUrl: (env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, ''),
      temperature: Number(env.OLLAMA_TEMPERATURE ?? 0.6),
      maxTokens: Number(env.OLLAMA_MAX_TOKENS ?? 1024),
    },
    cloud: {
      order: rawOrder.length > 0 ? rawOrder : legacyProvider ? [legacyProvider] : ['gemini', 'groq', 'openrouter', 'anthropic', 'sumopod'],
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY || '',
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        maxTokens: Number(env.ANTHROPIC_MAX_TOKENS || 1024),
        baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
      },
      sumopod: {
        apiKey: env.SUMOPOD_API_KEY || '',
        model: env.SUMOPOD_MODEL || 'claude-sonnet-4-6',
        maxTokens: Number(env.SUMOPOD_MAX_TOKENS || 1024),
        baseUrl: (env.SUMOPOD_BASE_URL || 'https://ai.sumopod.com/v1').replace(/\/$/, ''),
      },
      gemini: {
        apiKey: env.GEMINI_API_KEY || '',
        model: env.GEMINI_MODEL || 'gemini-2.0-flash',
        maxTokens: Number(env.GEMINI_MAX_TOKENS || 1024),
        baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
      },
      groq: {
        apiKey: env.GROQ_API_KEY || '',
        model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        maxTokens: Number(env.GROQ_MAX_TOKENS || 1024),
        baseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
      },
      openrouter: {
        apiKey: env.OPENROUTER_API_KEY || '',
        model: env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
        maxTokens: Number(env.OPENROUTER_MAX_TOKENS || 1024),
        baseUrl: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
      },
    },
    ollamaTimeoutMs: Number(env.OLLAMA_TIMEOUT_MS || 60000),
    timeoutMs: Number(env.AI_TIMEOUT_MS || 60000),
    cloudCooldownMs: Number(env.AI_CLOUD_COOLDOWN_MS || 60000),
    contextMaxChars: Number(env.AI_CONTEXT_MAX_CHARS || 8000),
    defaultLevel: env.AI_DEFAULT_LEVEL === 'cloud' ? 'cloud' : 'standard',
  };
  logger = log;

  const configured = providerList()
    .map((p) => p.label)
    .join(', ');
  logger.info(
    {
      ollamaModel: config.ollama.model,
      ollamaBaseUrl: config.ollama.baseUrl,
      ollamaTemperature: config.ollama.temperature,
      ollamaMaxTokens: config.ollama.maxTokens,
      cloudProviders: configured,
      cloudOrder: config.cloud.order,
      configuredKeys: providerList().map((p) => p.key),
      ollamaTimeoutMs: config.ollamaTimeoutMs,
      cloudTimeoutMs: config.timeoutMs,
      cloudCooldownMs: config.cloudCooldownMs,
      contextMaxChars: config.contextMaxChars,
      defaultLevel: config.defaultLevel,
    },
    'AI routing ready (Ollama lokal + multi-provider cloud fallback)',
  );
  return config;
}

// Wrapper timeout: settle dengan TimeoutError jika promise belum selesai dalam ms.
export function withTimeout(promise, ms, label = 'AI request') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      err.timedOut = true;
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

// Potong konteks yang terlalu panjang: simpan bagian paling baru (biasanya paling relevan).
function limitContext(text) {
  if (!text) return '';
  const s = String(text);
  if (s.length <= config.contextMaxChars) return s;
  return `...(riwayat panjang, bagian sebelumnya dipangkas — hanya ditampilkan yang terbaru)...\n${s.slice(-config.contextMaxChars)}`;
}

// Bangun system prompt bersama untuk semua provider (cloud + Ollama).
// - Hanya NAMA pengirim yang dikirim ke model (nomor WhatsApp TIDAK dikirim —
//   mencegah model menebak/mengomentari nomor).
// - Konteks = referensi TAMBAHAN (opsional). Model TETAP boleh jawab dari
//   pengetahuan umum kalau konteks tidak relevan (sebelumnya terlalu kaku sampai
//   menolak pertanyaan umum seperti "info Gunung Merapi").
// - Ada aturan jawaban eksplisit: sapa singkat → jawab langsung, tanpa basa-basi.
function buildSystemPrompt({ context = '', senderName = '' }) {
  const greeting = senderName
    ? `\n(Pengirim pesan ini bernama ${senderName}. Panggil/sapa dia dengan nama itu. Jangan menebak nama lain meskipun di riwayat percakapan ada nama lain.)`
    : '';

  let system = PERSONALITY_SYSTEM_PROMPT + greeting;

  if (context) {
    system += `\n\nBerikut konteks percakapan masa lalu sebagai referensi TAMBAHAN (tidak wajib dipakai):\n${limitContext(context)}`;
  }

  system += `\n\nAturan menjawab:\n- Awali jawaban dengan sapaan singkat ke nama pengirim saja (misal "Halo, Falaq!"), lalu langsung jawab pertanyaannya.\n- Kalau konteks di atas relevan dengan pertanyaan, gunakan isinya. Kalau tidak relevan, jawab saja berdasarkan pengetahuan umummu.\n- Jawab ringkas dan langsung, tanpa basa-basi, tanpa komentar tentang percakapan, tanpa mengulang pertanyaan.\n- Jangan menyebut atau mengomentari nomor WhatsApp siapapun.\n- Kalau konteks berisi "Hasil pencarian internet": itu data dari sumber online (Tavily/DuckDuckGo/Wikipedia) dan lebih baru dari pengetahuannya. Untuk informasi yang cepat berubah (harga, berita, skor, jadwal, produk terbaru), UTAMAKAN data hasil pencarian tersebut.\n- Kalau hasil pencarian internet bertentangan dengan pengetahuanmu, JANGAN pilih salah satu diam-diam. Jawab dengan menyebut keduanya supaya pengguna tahu sumbernya, misal: "Menurut ingatan saya ..., tapi data internet menunjukkan ... (sumber: <nama situs>)".\n- Kalau hasil pencarian internet kosong/tidak relevan, jawab normal dari pengetahuanmu tanpa menyebut pencarian.`;
  return system;
}

// Bangun { system, prompt } untuk semua provider cloud.
function buildPrompt({ question, context = '', senderName = '' }) {
  return {
    system: buildSystemPrompt({ context, senderName }),
    prompt: question,
  };
}

// Struktur prompt khusus Ollama (model kecil mudah "nyasar" kalau konteks panjang
// ditaruh bersama pertanyaan — baris mirip pertanyaan di dalam konteks bikin model
// bingung mana yang harus dijawab). Aturannya:
//  - konteks ditaruh di SYSTEM PROMPT sebagai referensi,
//  - pesan user berisi HANYA pertanyaan → model tidak bingung lagi,
//  - pakai /api/chat supaya template chat model (qwen2.5 dll) diterapkan dengan benar.
function buildOllamaMessages({ question, context = '', senderName = '' }) {
  return {
    messages: [
      { role: 'system', content: buildSystemPrompt({ context, senderName }) },
      { role: 'user', content: question },
    ],
  };
}

// helper: ubah HTTP error dari fetch provider menjadi Error dengan field .status
async function httpError(label, res) {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  const err = new Error(`${label} HTTP ${res.status}: ${detail}`);
  err.status = res.status;
  return err;
}

function isQuotaExhaustedError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  const msg = `${err?.message || ''} ${err?.cause?.code || ''} ${err?.cause?.message || ''}`;
  if (status === 429 || status === 402 || status === 403) return true;
  return /rate\s*limit|quota|insufficient|exhausted|limit.{0,20}reached|too many requests|free.{0,15}limit/i.test(msg);
}

function providerInCooldown(key) {
  return (cooldowns.get(key) || 0) > Date.now();
}

function markProviderCooldown(key) {
  cooldowns.set(key, Date.now() + config.cloudCooldownMs);
  logger.warn(
    { provider: key, cooldownMs: config.cloudCooldownMs },
    'Provider kena limit/kuota → di-cooldown sementara, pindah ke provider berikutnya',
  );
}

// ---- provider cloud ----

// Gemini (REST asli Google, bukan OpenAI-compatible).
export async function callGemini({ system, prompt }) {
  if (!config.cloud.gemini.apiKey) throw new Error('GEMINI_API_KEY is not set');
  const url = `${config.cloud.gemini.baseUrl}/models/${config.cloud.gemini.model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.cloud.gemini.apiKey,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: config.cloud.gemini.maxTokens },
    }),
  });
  if (!res.ok) throw await httpError('Gemini', res);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? '';
}

// Groq: OpenAI-compatible.
export async function callGroq({ system, prompt }) {
  if (!config.cloud.groq.apiKey) throw new Error('GROQ_API_KEY is not set');
  const res = await fetch(`${config.cloud.groq.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.cloud.groq.apiKey}`,
    },
    body: JSON.stringify({
      model: config.cloud.groq.model,
      max_tokens: config.cloud.groq.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw await httpError('Groq', res);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// OpenRouter: OpenAI-compatible gateway; model ":free" gratis.
export async function callOpenRouter({ system, prompt }) {
  if (!config.cloud.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const res = await fetch(`${config.cloud.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.cloud.openrouter.apiKey}`,
      'HTTP-Referer': config.cloud.openrouter.referer || 'https://localhost/whatsapp-recap-bot',
      'X-Title': 'WhatsApp Recap Bot',
    },
    body: JSON.stringify({
      model: config.cloud.openrouter.model,
      max_tokens: config.cloud.openrouter.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw await httpError('OpenRouter', res);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// Anthropic (API asli).
export async function callClaude({ system, prompt }) {
  if (!config.cloud.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch(`${config.cloud.anthropic.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.cloud.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.cloud.anthropic.model,
      max_tokens: config.cloud.anthropic.maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw await httpError('Anthropic', res);
  const data = await res.json();
  return data.content?.map((b) => b.text ?? '').join('').trim() ?? '';
}

// SumoPod: OpenAI-compatible gateway (https://ai.sumopod.com/v1/chat/completions).
export async function callSumoPod({ system, prompt }) {
  if (!config.cloud.sumopod.apiKey) throw new Error('SUMOPOD_API_KEY is not set');
  const res = await fetch(`${config.cloud.sumopod.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.cloud.sumopod.apiKey}`,
    },
    body: JSON.stringify({
      model: config.cloud.sumopod.model,
      max_tokens: config.cloud.sumopod.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw await httpError('SumoPod', res);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// Registri provider: urutan sesuai config.cloud.order (env AI_CLOUD_PROVIDERS).
function providerList() {
  const table = {
    gemini: { key: 'gemini', label: 'Gemini', configured: () => !!config.cloud.gemini.apiKey, call: callGemini },
    groq: { key: 'groq', label: 'Groq', configured: () => !!config.cloud.groq.apiKey, call: callGroq },
    openrouter: { key: 'openrouter', label: 'OpenRouter', configured: () => !!config.cloud.openrouter.apiKey, call: callOpenRouter },
    anthropic: { key: 'anthropic', label: 'Anthropic', configured: () => !!config.cloud.anthropic.apiKey, call: callClaude },
    sumopod: { key: 'sumopod', label: 'SumoPod', configured: () => !!config.cloud.sumopod.apiKey, call: callSumoPod },
  };
  return config.cloud.order.map((k) => table[k]).filter(Boolean);
}

// Nama provider cloud yang aktif untuk ditampilkan (urutan prioritas).
export function getCloudProviderName() {
  const names = providerList().filter((p) => !providerInCooldown(p.key)).map((p) => p.label);
  return names.length ? names.join(' → ') : '(semua provider sedang cooldown)';
}

// Status semua provider (dipakai command "status provider").
export function getCloudProviderStatus() {
  return providerList().map((p) => ({
    name: p.label,
    configured: p.configured(),
    cooldownUntil: cooldowns.get(p.key) || 0,
  }));
}

// Coba provider cloud satu per satu sesuai urutan. Provider yang kena limit kuota
// (429/402/403/dll) di-cooldown sementara dan dilewati → otomatis pindah ke berikutnya.
async function callCloudChain(payload) {
  const providers = providerList();
  if (providers.length === 0) {
    const err = new Error('No cloud provider API key configured');
    err.name = 'NoCloudProvider';
    throw err;
  }
  const errors = [];
  for (const p of providers) {
    if (providerInCooldown(p.key)) continue;
    if (!p.configured()) continue;
    try {
      const reply = await withTimeout(p.call(payload), config.timeoutMs, p.label);
      return { reply, provider: p.label };
    } catch (err) {
      errors.push(`${p.label}: ${err?.message || String(err)}`);
      logger.warn({ err, provider: p.key }, `Cloud provider ${p.label} gagal`);
      if (isQuotaExhaustedError(err)) markProviderCooldown(p.key);
    }
  }
  const err = new Error(`All cloud providers failed. ${errors.join(' | ')}`);
  err.name = 'AllProvidersFailed';
  throw err;
}

// ---- Ollama ----

async function chatOllama(messages, options = {}) {
  const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      messages,
      stream: false,
      options: {
        temperature: config.ollama.temperature,
        num_predict: config.ollama.maxTokens,
        ...options,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.message?.content ?? '';
}

export async function callOllama({ question, context = '', senderName = '', senderNumber = '' }) {
  const { messages } = buildOllamaMessages({ question, context, senderName, senderNumber });
  return chatOllama(messages);
}

async function callOllamaRaw(system, prompt, options = {}) {
  return chatOllama(
    [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    options,
  );
}

// ---- state level per-chat (persist ke tabel settings SQLite) ----

export function getLevel(chatId) {
  const stored = storage.getSetting(`ai_level:${chatId}`);
  if (!stored) return config.defaultLevel;
  return stored === 'cloud' ? 'cloud' : 'standard';
}

export function setLevel(chatId, level) {
  const normalized = level === 'cloud' ? 'cloud' : 'standard';
  storage.setSetting(`ai_level:${chatId}`, normalized);
  return normalized;
}

// ---- routing utama ----
// Manual override "cloud" menang: tidak mencoba Ollama sama sekali.
// Mode "standard": coba Ollama dulu (timeout/error → silent fallback ke chain cloud).
// Fallback tidak mengubah state (setLevel tidak pernah dipanggil di sini).
export async function askAI({ chatId, question, context = '', senderName = '', senderNumber = '' }) {
  const level = getLevel(chatId);
  // Cloud pakai format { system, prompt } dari buildPrompt;
  // Ollama pakai param mentah supaya buildOllamaMessages bisa menyusun prompt khusus.
  const payload = buildPrompt({ question, context, senderName, senderNumber });

  if (level === 'cloud') {
    const { reply, provider } = await callCloudChain(payload);
    logger.info({ chatId, level, provider }, 'AI reply via cloud (manual override)');
    return reply;
  }

  try {
    const reply = await withTimeout(
      callOllama({ question, context, senderName, senderNumber }),
      config.ollamaTimeoutMs,
      'Ollama',
    );
    logger.info({ chatId, level, provider: 'ollama' }, 'AI reply via Ollama');
    return reply;
  } catch (err) {
    logger.warn({ err, chatId }, 'Ollama failed/timed out, silent fallback ke chain cloud');
    const { reply, provider } = await callCloudChain(payload);
    logger.info({ chatId, level, provider, fallback: true }, 'AI reply via cloud (fallback)');
    return reply;
  }
}

// Rekap: coba Ollama dulu, kalau gagal/timeout → chain cloud (RECAP prompt).
export async function generateRecap(historyText) {
  const system = RECAP_SYSTEM_PROMPT;
  const prompt = `Berikut adalah percakapan grup yang perlu direkap:\n\n${historyText}`;
  try {
    const text = await withTimeout(callOllamaRaw(system, prompt, { num_predict: 2048 }), config.ollamaTimeoutMs, 'Ollama');
    return { text, provider: 'Ollama' };
  } catch (err) {
    logger.warn({ err }, 'Ollama recap gagal/timeout, fallback ke chain cloud');
    const { reply, provider } = await callCloudChain({ system, prompt });
    return { text: reply, provider };
  }
}

// Fallback cloud generik untuk pesan {role:'system'|'user'} (dipakai parser reminder dll).
export async function chatWithCloudFallback(messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const prompt = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  return callCloudChain({ system, prompt });
}

// ---- command "@kacan ... level" (bisa dipakai semua member) ----

export async function handleLevelCommand(sock, log, cfg, { msg, groupId, arg }) {
  switch (arg) {
    case 'cloud':
      setLevel(groupId, 'cloud');
      log.info({ groupId }, 'AI level set to cloud (manual override)');
      await sock.sendMessage(groupId, {
        text: 'Level asisten di chat ini sudah naik ke mode cloud. Semua request berikutnya langsung pakai model cloud tanpa mencoba Ollama lokal.',
      }, { quoted: msg });
      break;
    case 'standard':
      setLevel(groupId, 'standard');
      log.info({ groupId }, 'AI level set to standard');
      await sock.sendMessage(groupId, {
        text: 'Level asisten di chat ini sudah kembali ke mode standar. Request berikutnya coba Ollama lokal dulu, lalu fallback ke cloud kalau lambat atau gagal.',
      }, { quoted: msg });
      break;
    case 'provider': {
      const list = getCloudProviderStatus()
        .map((p) => {
          const state = !p.configured
            ? 'belum di-set'
            : p.cooldownUntil > Date.now()
              ? `cooldown sampai ${new Date(p.cooldownUntil).toLocaleTimeString('id-ID')}`
              : 'aktif';
          return `• ${p.name}: ${state}`;
        })
        .join('\n');
      await sock.sendMessage(groupId, {
        text: `Provider cloud (urutan: ${config.cloud.order.join(', ')}):\n${list}`,
      }, { quoted: msg });
      break;
    }
    case 'status':
    default: {
      const level = getLevel(groupId);
      const provider = getCloudProviderName();
      const desc = level === 'cloud'
        ? `mode cloud (langsung pakai provider cloud, tanpa Ollama lokal)`
        : `mode standard (Ollama lokal dulu, fallback otomatis ke provider cloud kalau timeout/gagal)`;
      await sock.sendMessage(groupId, { text: `Level asisten di chat ini: *${level}* — ${desc}\nProvider cloud aktif: ${provider}` }, { quoted: msg });
      break;
    }
  }
}

// hint error untuk kasus semua provider gagal (termasuk fallback).
export function aiErrorHint(err) {
  const cause = err?.cause?.code || err?.name || err?.message || String(err);
  logger.error({ err }, 'AI request failed (all providers)');
  if (cause === 'TimeoutError' || /timed out/i.test(cause)) {
    return 'Maaf, asisten lagi lambat dan tidak sempat menjawab dalam waktu tunggu. Coba lagi sebentar.';
  }
  if (cause === 'ECONNREFUSED') {
    return 'Tidak bisa konek ke Ollama dan semua provider cloud. Pastikan Ollama jalan di host dan ada koneksi internet.';
  }
  if (cause === 'NoCloudProvider') {
    return 'Belum ada API key cloud yang di-set di .env (Gemini/Groq/OpenRouter/Anthropic/SumoPod), jadi fallback cloud tidak bisa jalan.';
  }
  if (cause === 'AllProvidersFailed') {
    return 'Semua provider cloud gagal (mungkin kuota/limit gratis habis semua). Tunggu cooldown, lalu coba lagi.';
  }
  if (cause === 'GEMINI_API_KEY is not set') {
    return 'GEMINI_API_KEY belum di-set di .env, jadi fallback ke model cloud tidak bisa jalan.';
  }
  if (cause === 'GROQ_API_KEY is not set') {
    return 'GROQ_API_KEY belum di-set di .env, jadi fallback ke model cloud tidak bisa jalan.';
  }
  if (cause === 'OPENROUTER_API_KEY is not set') {
    return 'OPENROUTER_API_KEY belum di-set di .env, jadi fallback ke model cloud tidak bisa jalan.';
  }
  if (cause === 'ANTHROPIC_API_KEY is not set') {
    return 'ANTHROPIC_API_KEY belum di-set di .env, jadi fallback ke model cloud tidak bisa jalan.';
  }
  if (cause === 'SUMOPOD_API_KEY is not set') {
    return 'SUMOPOD_API_KEY belum di-set di .env, jadi fallback ke model cloud tidak bisa jalan.';
  }
  if (/401|authentication|invalid.*api.*key|insufficient.*quota/i.test(cause)) {
    return 'API key provider cloud tidak valid atau kuota habis. Cek GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY di .env.';
  }
  return 'Maaf, asisten lagi ada gangguan, coba lagi sebentar.';
}
