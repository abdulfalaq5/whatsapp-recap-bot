// Generate gambar dengan fallback berurutan:
// Pollinations.ai (tanpa API key) → Cloudflare Workers AI.
import { saveBuffer } from '../utils/downloadImage.js';

const POLLINATIONS_TIMEOUT_MS = 30000;
const CLOUDFLARE_TIMEOUT_MS = 60000;

async function generatePollinations(prompt, env) {
  const base = (env.POLLINATIONS_BASE_URL || 'https://image.pollinations.ai/prompt').replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(prompt)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Pollinations HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf || buf.length === 0) throw new Error('Respons Pollinations kosong');
  return buf;
}

async function generateCloudflare(prompt, env) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN belum diisi');
  }
  const model = env.CLOUDFLARE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${model}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Cloudflare HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    throw new Error(`Cloudflare error: ${data.errors?.[0]?.message || JSON.stringify(data).slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf || buf.length === 0) throw new Error('Respons Cloudflare kosong');
  return buf;
}

const PROVIDERS = [
  { name: 'pollinations', generate: generatePollinations },
  { name: 'cloudflare', generate: generateCloudflare },
];

// Generate gambar dari provider berurutan lalu simpan ke IMAGE_DOWNLOAD_DIR.
// Return { filePath, provider, buffer }. Throw jika semua provider gagal.
export async function generateImage(prompt, env, logger) {
  let lastErr = null;
  for (const p of PROVIDERS) {
    try {
      const buffer = await p.generate(prompt, env);
      const filePath = saveBuffer(buffer, { env, prefix: 'buatgambar' });
      logger?.info({ provider: p.name }, 'Image generate berhasil');
      return { filePath, provider: p.name, buffer };
    } catch (err) {
      lastErr = err;
      logger?.warn({ provider: p.name, err: err.message }, 'Image generate provider gagal, coba provider berikutnya');
    }
  }
  throw lastErr || new Error('Semua provider generate gambar gagal');
}
