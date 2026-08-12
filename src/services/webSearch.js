// Pencarian internet untuk asisten AI (pertanyaan yang butuh info terbaru).
// Provider utama: Tavily (API key, hasil paling akurat/terbaru).
// Kalau Tavily tidak di-set / gagal → fallback gratis tanpa API key:
//   1. DuckDuckGo Instant Answer API (resmi, JSON)
//   2. Wikipedia (id.wikimedia, JSON) — bagus untuk fakta/ensiklopedia
//   3. DuckDuckGo HTML (fallback untuk hasil pencarian "hidup")
// Semua sumber dijalankan paralel; kalau semua gagal → string kosong (asisten tetap normal).

const TAVILY_URL = 'https://api.tavily.com/search';
const DDG_INSTANT_URL = 'https://api.duckduckgo.com/';
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const WIKI_API = 'https://id.wikipedia.org/w/api.php';

const SOURCE_TIMEOUT_MS = 5000;
const MAX_RESULTS = 6;

async function fetchJson(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res.json();
}

// Buang tag HTML + decode entitas (DuckDuckGo & Wikipedia memakai HTML kecil).
function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Tavily: provider utama (perlu TAVILY_API_KEY di .env).
// Hasilnya berupa daftar { title, url, content } — sudah ringkas dan terbaru.
async function searchTavily(query, apiKey) {
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set');
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: 5,
      search_depth: 'basic',
      include_answer: true,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const results = [];
  if (data.answer) results.push(`• ${data.answer}`);
  for (const r of data.results || []) {
    const content = String(r.content || '').replace(/\s+/g, ' ').trim();
    results.push(`• ${r.title}: ${content.slice(0, 300)}${r.url ? `\n  (${r.url})` : ''}`);
  }
  return results.slice(0, MAX_RESULTS);
}

async function searchDuckDuckGoInstant(query) {
  const url = `${DDG_INSTANT_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const data = await fetchJson(url, 'DuckDuckGo');
  const results = [];
  if (data.Heading) {
    const parts = [];
    if (data.AbstractText) parts.push(data.AbstractText);
    if (data.AbstractURL) parts.push(`Sumber: ${data.AbstractURL}`);
    if (parts.length) results.push(`• ${data.Heading}: ${parts.join(' ')}`);
  }
  const stack = [...(data.RelatedTopics || [])];
  while (stack.length && results.length < MAX_RESULTS) {
    const item = stack.shift();
    if (!item) continue;
    if (Array.isArray(item.Topics)) {
      stack.push(...item.Topics);
      continue;
    }
    if (item.Text) results.push(`• ${item.Text}`);
  }
  return results.slice(0, MAX_RESULTS);
}

async function searchWikipedia(query) {
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&srprop=snippet`;
  const data = await fetchJson(url, 'Wikipedia');
  const results = [];
  for (const hit of data.query?.search || []) {
    const snippet = decodeEntities(hit.snippet || '');
    if (!snippet) continue;
    results.push(`• ${hit.title}: ${snippet}`);
  }
  return results.slice(0, 3);
}

async function searchDuckDuckGoHtml(query) {
  const res = await fetch(`${DDG_HTML_URL}?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTML HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const re = /class="result__a"[^>]*>(.*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>(.*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < MAX_RESULTS) {
    const title = decodeEntities(m[1]);
    const snippet = decodeEntities(m[2]);
    if (!title) continue;
    results.push(`• ${title}${snippet ? `: ${snippet}` : ''}`);
  }
  return results.slice(0, MAX_RESULTS);
}

// Hasil pencarian dirangkum jadi teks pendek untuk konteks AI.
// Return string kosong kalau tidak ada hasil / semua sumber gagal.
// tavilyApiKey: diambil dari env TAVILY_API_KEY; kalau kosong langsung lewati Tavily.
export async function searchWeb(query, logger, tavilyApiKey = '') {
  const q = String(query || '').trim();
  if (!q) return '';

  const sources = [
    { name: 'Tavily', fn: () => searchTavily(q, tavilyApiKey) },
    { name: 'DuckDuckGo', fn: () => searchDuckDuckGoInstant(q) },
    { name: 'Wikipedia', fn: () => searchWikipedia(q) },
    { name: 'DuckDuckGo (html)', fn: () => searchDuckDuckGoHtml(q) },
  ];

  // Jalan paralel supaya total waktu tunggu tidak menumpuk per sumber.
  const settled = await Promise.allSettled(sources.map((s) => s.fn(q)));

  const seen = new Set();
  const all = [];
  settled.forEach((outcome, i) => {
    const { name } = sources[i];
    if (outcome.status === 'rejected') {
      logger?.debug?.({ err: outcome.reason?.message, source: name }, 'Web search source gagal');
      return;
    }
    for (const item of outcome.value || []) {
      const key = String(item).slice(0, 80);
      if (item && !seen.has(key)) {
        seen.add(key);
        all.push(item);
      }
    }
  });

  if (!all.length) {
    logger?.info?.({ query: q }, 'Web search kosong (tidak ada hasil)');
    return '';
  }

  const summary = all.slice(0, MAX_RESULTS).join('\n');
  logger?.info?.({ query: q, results: all.length }, 'Web search berhasil');
  return summary;
}
