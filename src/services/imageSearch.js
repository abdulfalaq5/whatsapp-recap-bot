// Pencarian gambar dengan fallback berurutan:
// Google CSE → Unsplash → Pexels → Pixabay.
import { saveBuffer } from '../utils/downloadImage.js';

const SEARCH_TIMEOUT_MS = 10000;

async function fetchJson(url, { headers = {}, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function downloadImageBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf || buf.length === 0) throw new Error('Respons gambar kosong');
  return buf;
}

async function searchGoogle(query, env) {
  if (!env.GOOGLE_CSE_API_KEY || !env.GOOGLE_CSE_ENGINE_ID) {
    throw new Error('GOOGLE_CSE_API_KEY / GOOGLE_CSE_ENGINE_ID belum diisi');
  }
  const url =
    `https://www.googleapis.com/customsearch/v1` +
    `?key=${encodeURIComponent(env.GOOGLE_CSE_API_KEY)}` +
    `&cx=${encodeURIComponent(env.GOOGLE_CSE_ENGINE_ID)}` +
    `&searchType=image&q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url);
  const link = data.items?.[0]?.link;
  if (!link) throw new Error('Tidak ada hasil dari Google CSE');
  return link;
}

async function searchUnsplash(query, env) {
  if (!env.UNSPLASH_ACCESS_KEY) throw new Error('UNSPLASH_ACCESS_KEY belum diisi');
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&client_id=${encodeURIComponent(env.UNSPLASH_ACCESS_KEY)}`;
  const data = await fetchJson(url);
  const link = data.results?.[0]?.urls?.regular;
  if (!link) throw new Error('Tidak ada hasil dari Unsplash');
  return link;
}

async function searchPexels(query, env) {
  if (!env.PEXELS_API_KEY) throw new Error('PEXELS_API_KEY belum diisi');
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}`;
  const data = await fetchJson(url, { headers: { Authorization: env.PEXELS_API_KEY } });
  const link = data.photos?.[0]?.src?.large;
  if (!link) throw new Error('Tidak ada hasil dari Pexels');
  return link;
}

async function searchPixabay(query, env) {
  if (!env.PIXABAY_API_KEY) throw new Error('PIXABAY_API_KEY belum diisi');
  const url = `https://pixabay.com/api/?key=${encodeURIComponent(env.PIXABAY_API_KEY)}&q=${encodeURIComponent(query)}&image_type=photo`;
  const data = await fetchJson(url);
  const link = data.hits?.[0]?.largeImageURL;
  if (!link) throw new Error('Tidak ada hasil dari Pixabay');
  return link;
}

const PROVIDERS = [
  { name: 'google', search: searchGoogle },
  { name: 'unsplash', search: searchUnsplash },
  { name: 'pexels', search: searchPexels },
  { name: 'pixabay', search: searchPixabay },
];

// Cari URL gambar dari provider berurutan, download, lalu simpan ke IMAGE_DOWNLOAD_DIR.
// Return { filePath, url, provider }. Throw jika semua provider gagal.
export async function searchImage(query, env, logger) {
  let lastErr = null;
  for (const p of PROVIDERS) {
    try {
      const url = await p.search(query, env);
      const buffer = await downloadImageBuffer(url);
      const filePath = saveBuffer(buffer, { env, prefix: 'carigambar' });
      logger?.info({ provider: p.name }, 'Image search berhasil');
      return { filePath, url, provider: p.name, buffer };
    } catch (err) {
      lastErr = err;
      logger?.warn({ provider: p.name, err: err.message }, 'Image search provider gagal, coba provider berikutnya');
    }
  }
  throw lastErr || new Error('Semua provider pencarian gambar gagal');
}
