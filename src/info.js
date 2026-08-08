// Informasi cepat: cuaca (Open-Meteo, tanpa API key) & jadwal sholat (Aladhan).

let config = {};

export function initInfo(env, logger) {
  config = {
    lat: env.WEATHER_LAT || null,
    lon: env.WEATHER_LON || null,
    city: env.PRAYER_CITY || null,
  };
  logger.info(
    { hasWeather: !!(config.lat && config.lon), city: config.city },
    'Info module loaded'
  );
}

const WMO_CODES = {
  0: 'Cerah',
  1: 'Cerah berawan',
  2: 'Berawan',
  3: 'Mendung',
  45: 'Kabut',
  48: 'Kabut beku',
  51: 'Gerimis ringan',
  53: 'Gerimis',
  55: 'Gerimis lebat',
  61: 'Hujan ringan',
  63: 'Hujan',
  65: 'Hujan lebat',
  71: 'Salju ringan',
  73: 'Salju',
  75: 'Salju lebat',
  80: 'Hujan lokal ringan',
  81: 'Hujan lokal',
  82: 'Hujan lokal lebat',
  95: 'Badai petir',
  96: 'Badai petir + hujan es',
  99: 'Badai petir + hujan es lebat',
};

function describeWeather(code) {
  return WMO_CODES[code] || `Cuaca (kode ${code})`;
}

function formatNumber(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(1) : '?';
}

export async function getWeather() {
  if (!config.lat || !config.lon) {
    throw new Error('WEATHER_LAT / WEATHER_LON belum diisi di .env');
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.lat}&longitude=${config.lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  const c = data.current || {};
  const d = data.daily || {};
  const max = d.temperature_2m_max?.[0];
  const min = d.temperature_2m_min?.[0];
  return `🌤️ *Cuaca hari ini*\n${describeWeather(c.weather_code)} | ${formatNumber(c.temperature_2m)}°C\nMin ${formatNumber(min)}°C · Maks ${formatNumber(max)}°C\n💧 Kelembapan ${formatNumber(c.relative_humidity_2m)}% · 💨 Angin ${formatNumber(c.wind_speed_10m)} km/jam`;
}

// Versi lengkap (hari ini + besok) — dipakai asisten AI biar bisa jawab
// pertanyaan cuaca dengan data asli, bukan menebak.
export async function getWeatherForecast() {
  if (!config.lat || !config.lon) {
    throw new Error('WEATHER_LAT / WEATHER_LON belum diisi di .env');
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.lat}&longitude=${config.lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  const c = data.current || {};
  const d = data.daily || {};
  const lines = [
    `Saat ini: ${describeWeather(c.weather_code)} | ${formatNumber(c.temperature_2m)}°C, kelembapan ${formatNumber(c.relative_humidity_2m)}%, angin ${formatNumber(c.wind_speed_10m)} km/jam`,
  ];
  (d.time || []).forEach((date, i) => {
    const label = i === 0 ? 'Hari ini' : 'Besok';
    lines.push(`${label} (${date}): ${describeWeather(d.weather_code?.[i])} | Min ${formatNumber(d.temperature_2m_min?.[i])}°C · Maks ${formatNumber(d.temperature_2m_max?.[i])}°C`);
  });
  return lines.join('\n');
}

export async function getPrayerTimes() {
  if (!config.city) {
    throw new Error('PRAYER_CITY belum diisi di .env');
  }
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const url = `https://api.aladhan.com/v1/timingsByCity/${date}?city=${encodeURIComponent(config.city)}&country=ID&method=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Aladhan HTTP ${res.status}`);
  const data = await res.json();
  const t = data.data?.timings;
  if (!t) throw new Error('Data jadwal sholat kosong');
  const day = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `🕌 *Jadwal Sholat — ${config.city}*\n📅 ${day}\n\n🌅 Subuh: ${t.Fajr}\n☀️ Terbit: ${t.Sunrise}\n🕛 Dzuhur: ${t.Dhuhr}\n🌇 Ashar: ${t.Asr}\n🌆 Maghrib: ${t.Maghrib}\n🌙 Isya: ${t.Isha}`;
}
