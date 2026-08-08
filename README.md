# WhatsApp Family Assistant Bot (Baileys + Ollama)

Asisten keluarga WhatsApp berbasis Baileys + Ollama: tanya-jawab (`@kacan`, `!ai`, `!tanya`), rekap chat (`!rekap`), reminder, shopping list, catatan pengeluaran, cuaca, dan jadwal sholat. Berjalan di Docker.

Mode AI punya fallback otomatis multi-provider: Ollama lokal dulu, lalu kalau gagal/timeout atau kuota limit habis, otomatis pindah ke provider cloud gratis (Gemini → Groq → OpenRouter `:free`), dan kalau semua habis baru ke Anthropic/SumoPod. Cek status dengan `@kacan status provider`.

## Prasyarat

- Server Ubuntu dengan **Docker** & **Docker Compose** (`docker --version`, `docker compose version`)
- **Ollama** sudah jalan di host (bukan container): `ollama list` harus menampilkan model. Pull model bila belum ada, mis. `ollama pull llama3.1` (atau `qwen2.5:3b` untuk server kecil).
- Port Ollama `11434` di host hanya bind ke localhost (`127.0.0.1:11434`).

## Setup

1. Copy config dan isi sesuai kebutuhan:

   ```bash
   cp .env.example .env
   nano .env
   ```

   Isi minimal yang wajib:
   - `WHITELIST_GROUP_IDS` — ID grup yang boleh dipakai bot (pisahkan koma untuk beberapa grup). Bisa diisi kosong dulu lalu tambahkan setelah mendapat ID dari log (lihat "Cara Mendapatkan Group ID"). Bisa juga diisi `*` untuk mengizinkan semua group — tapi ini tidak disarankan karena siapa pun yang menambahkan nomor bot ke group-nya bisa langsung memakai AI ini.
   - `OLLAMA_MODEL` — nama model yang sudah di-pull.
   - `OLLAMA_BASE_URL` — biarkan `http://host.docker.internal:11434` (khusus Docker). Kalau jalan langsung tanpa Docker, ganti `http://localhost:11434`.

2. Build & jalankan **tanpa `-d`** dulu (biar QR terlihat):

   ```bash
   docker compose up
   ```

3. Scan QR dengan WhatsApp di HP (Settings > Linked Devices > Link a Device). Setelah terhubung dan muncul log `WhatsApp terhubung. Bot siap.`, hentikan dengan `Ctrl+C`.

4. Jalankan ulang sebagai background service:

   ```bash
   docker compose up -d
   ```

## Operasi Harian

| Perintah | Fungsi |
|---|---|
| `docker compose logs -f` | Lihat log real-time |
| `docker compose up -d` | Start background |
| `docker compose restart` | Restart |
| `docker compose down` | Stop container |
| `docker compose logs -f whatsapp-assistant` | Log container tertentu |

## Cara Mendapatkan Group ID

Bot kini menampilkan **semua** ID group yang mengirim pesan ke log, walau belum di-whitelist (format `123456789-123456@g.us`). Caranya:

1. Tambahkan nomor bot ke group WhatsApp.
2. Kirim pesan apa pun dari group itu (bot akan menyimpan ID-nya di log, meski belum membalas).
3. Cek log: `docker compose logs -f` → cari baris `Pesan dari group yang BELUM di-whitelist. Tambahkan ID ini ke WHITELIST_GROUP_IDS...` dan salin ID-nya.
4. Tempel ID asli ke `.env`, lalu `docker compose up -d --force-recreate` (atau `docker compose restart`).

## Command Bot

| Command | Aksi |
|---|---|
| `@kacan <pertanyaan>` | Panggil asisten AI (bisa di tengah kalimat) |
| `!ai <pertanyaan>` / `!tanya <pertanyaan>` | Alternatif panggil asisten |
| `@kacan naikan level mu` | Pindahkan chat ini ke mode cloud (langsung pakai provider cloud, tidak coba Ollama) |
| `@kacan standarkan level` | Kembalikan ke mode standar (coba Ollama dulu, fallback otomatis ke cloud) |
| `@kacan status level` | Cek level AI chat ini saat ini (standard/cloud) |
| `@kacan status provider` | Cek status provider cloud (aktif / cooldown / belum di-set) |
| `!rekap` | Rekap chat hari ini |
| `!rekap kemarin` | Rekap chat kemarin |
| `!rekap 3hari` | Rekap 3 hari terakhir |
| `!lupa` / `!reset` | Hapus memori percakapan asisten grup |
| `!lupakan` | Hapus histori percakapan kamu sendiri |
| `!ingetin <pesan>` | Buat reminder, contoh: `!ingetin bayar listrik tgl 20 jam 9 pagi` |
| `!reminder list` / `!reminder hapus <id>` | Lihat / hapus reminder |
| `!belanja tambah <item>` | Tambah item ke daftar belanja (shared keluarga) |
| `!belanja list` / `!belanja selesai <item>` | Lihat daftar / tandai selesai |
| `!catat <jumlah> <catatan>` | Catat pengeluaran, contoh: `!catat 50000 belanja bulanan` |
| `!rekap bulan ini` | Rekap pengeluaran bulan ini per kategori |
| `!export` | Export pengeluaran bulan ini ke file CSV |
| `!cuaca` | Info cuaca hari ini (Open-Meteo) |
| `!sholat` | Jadwal sholat hari ini (Aladhan) |
| `!help` / `!bantuan` | Daftar command |

**Command admin (nomor di `ADMIN_NUMBERS`):**
| Command | Aksi |
|---|---|
| `!restart` | Restart bot |
| `!log` | Kirim log terakhir |
| `!broadcast <pesan>` | Kirim pengumuman ke semua group/anggota |
| `!tambahmember <nomor> <nama>` | Daftarkan anggota keluarga |

Catatan: bot hanya merespons saat ada trigger (`@kacan`/`!ai`/`!tanya`) atau command. Pesan biasa hanya disimpan sebagai histori, tidak dijawab. Nomor yang tidak terdaftar sebagai anggota keluarga tidak diproses.

## Konfigurasi `.env`

| Key | Default | Deskripsi |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.1` | Model Ollama |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | URL Ollama |
| `OLLAMA_TEMPERATURE` | `0.6` | Suhu model Ollama (rendah = jawaban lebih fokus/tidak nyasar) |
| `OLLAMA_MAX_TOKENS` | `1024` | Batas token jawaban Ollama (rekap otomatis 2048) |
| `GEMINI_API_KEY` | — | API key Gemini (free tier). Urutan teratas di chain cloud. |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Model Gemini |
| `GEMINI_MAX_TOKENS` | `1024` | Batas token jawaban Gemini |
| `GROQ_API_KEY` | — | API key Groq (free tier). |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Model Groq |
| `GROQ_MAX_TOKENS` | `1024` | Batas token jawaban Groq |
| `OPENROUTER_API_KEY` | — | API key OpenRouter (pakai model `:free` untuk gratis). |
| `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct:free` | Model OpenRouter |
| `OPENROUTER_MAX_TOKENS` | `1024` | Batas token jawaban OpenRouter |
| `ANTHROPIC_API_KEY` | — | API key Anthropic Claude (opsional, cadangan). |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Model Anthropic |
| `ANTHROPIC_MAX_TOKENS` | `1024` | Batas token jawaban Anthropic |
| `SUMOPOD_API_KEY` | — | API key SumoPod `sk-...` (opsional, cadangan). |
| `SUMOPOD_MODEL` | `claude-sonnet-4-6` | Model SumoPod |
| `SUMOPOD_MAX_TOKENS` | `1024` | Batas token jawaban SumoPod |
| `AI_CLOUD_PROVIDERS` | `gemini,groq,openrouter,anthropic,sumopod` | Urutan chain provider cloud. Provider tanpa API key otomatis di-skip. |
| `AI_CLOUD_COOLDOWN_MS` | `60000` | Cooldown (ms) provider yang kena limit kuota sebelum dicoba lagi |
| `AI_TIMEOUT_MS` | `8000` | Timeout request per provider cloud (ms) |
| `AI_DEFAULT_LEVEL` | `standard` | Level default per-chat: `standard` (Ollama + fallback) atau `cloud` |
| `WHITELIST_GROUP_IDS` | — | ID grup yang diizinkan, pisahkan koma. Isi `*` untuk semua group (tidak disarankan). |
| `ADMIN_NUMBERS` | — | Nomor admin (pisahkan koma). Kosong = belum ada admin. Contoh `6281234567890`. |
| `FAMILY_MEMBERS` | — | Daftar nomor anggota keluarga. Kosong = semua orang di group whitelist dianggap anggota. |
| `AUTO_RECAP_ENABLED` | `false` | Aktifkan rekap otomatis |
| `AUTO_RECAP_CRON` | `0 21 * * *` | Jadwal rekap harian (jam 21:00) |
| `ASSISTANT_TRIGGER_WORD` | `@kacan` | Trigger word asisten |
| `ASSISTANT_TRIGGER_PREFIXES` | `!ai,!tanya` | Prefix alternatif |
| `CONVERSATION_MEMORY_LIMIT` | `20` | Sliding window konteks percakapan grup |
| `PERSONAL_MEMORY_LIMIT` | `20` | Sliding window histori pribadi per nomor |
| `ASSISTANT_RATE_LIMIT_SECONDS` | `5` | Rate limit per grup |
| `HEALTH_CHECK_ENABLED` | `true` | Notifikasi admin saat koneksi turun |
| `HEALTH_CHECK_INTERVAL_MIN` | `5` | Interval cek kesehatan |
| `LOG_DIR` | `./logs` | Folder log (rotasi harian) |
| `LOG_LEVEL` | `info` | Level log |
| `WEATHER_LAT` / `WEATHER_LON` | — | Koordinat untuk `!cuaca` |
| `PRAYER_CITY` | — | Kota untuk `!sholat` (contoh: `Jakarta`) |
| `BOT_NAME` | `Kacan` | Nama bot (kepribadian di `src/prompts/personality.js`) |
| `DB_PATH` | `./data/chat_history.db` | Lokasi SQLite |
| `PRUNE_DAYS` | `30` | Hapus histori lebih tua dari N hari |

## Struktur Data

- `auth_session/` — kredensial sesi WhatsApp (jangan di-commit, jangan di-share).
- `data/chat_history.db` — SQLite: tabel `messages`, `conversation_memory`, `members`, `member_history`, `shared_context`, `reminders`, `shopping_list`, `expenses`, `settings`.
- `logs/` — log harian (rotasi otomatis).
- Kedua folder `auth_session/` dan `data/` di-mount sebagai volume, jadi persist saat container rebuild.

## Troubleshooting

- **`host.docker.internal` gagal resolve**: pastikan `extra_hosts: host.docker.internal:host-gateway` ada di `docker-compose.yml` (sudah disediakan). Pastikan juga Ollama bind ke `127.0.0.1:11434`, bukan port lain.
- **`MODEL NOT FOUND`**: jalankan `ollama pull <nama-model>` di host.
- **Bot tidak merespons**: pastikan ID grup benar di `WHITELIST_GROUP_IDS` dan pesan memakai trigger (`@kacan`/`!ai`/`!tanya`).
- **Session logout**: hapus `auth_session/` (atau `docker compose down` lalu `rm -rf auth_session`) dan ulangi scan QR.

## Peringatan

Baileys memakai protokol WhatsApp Web yang tidak resmi. Risiko nomor di-ban rendah untuk penggunaan grup internal, tapi disarankan pakai nomor sekunder, bukan nomor pribadi utama.
