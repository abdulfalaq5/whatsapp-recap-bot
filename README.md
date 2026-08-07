# WhatsApp AI Assistant Bot (Baileys + Ollama)

Asisten AI serba guna untuk grup WhatsApp: mode tanya-jawab (`@kacan`, `!ai`, `!tanya`) dan mode rekap chat (`!rekap`). Berjalan di Docker, memakai Ollama lokal sebagai LLM.

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
| `!rekap` | Rekap chat hari ini |
| `!rekap kemarin` | Rekap chat kemarin |
| `!rekap 3hari` | Rekap 3 hari terakhir |
| `!lupa` / `!reset` | Hapus memori percakapan asisten grup |
| `!help` / `!bantuan` | Daftar command |

Catatan: bot hanya merespons saat ada trigger (`@kacan`/`!ai`/`!tanya`) atau command. Pesan biasa hanya disimpan sebagai histori, tidak dijawab.

## Konfigurasi `.env`

| Key | Default | Deskripsi |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.1` | Model Ollama |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | URL Ollama |
| `WHITELIST_GROUP_IDS` | — | ID grup yang diizinkan, pisahkan koma. Isi `*` untuk semua group (tidak disarankan). |
| `AUTO_RECAP_ENABLED` | `false` | Aktifkan rekap otomatis |
| `AUTO_RECAP_CRON` | `0 21 * * *` | Jadwal rekap harian (jam 21:00) |
| `ASSISTANT_TRIGGER_WORD` | `@kacan` | Trigger word asisten |
| `ASSISTANT_TRIGGER_PREFIXES` | `!ai,!tanya` | Prefix alternatif |
| `CONVERSATION_MEMORY_LIMIT` | `20` | Sliding window konteks percakapan |
| `ASSISTANT_RATE_LIMIT_SECONDS` | `5` | Rate limit per grup |
| `DB_PATH` | `./data/chat_history.db` | Lokasi SQLite |
| `PRUNE_DAYS` | `30` | Hapus histori lebih tua dari N hari |

## Struktur Data

- `auth_session/` — kredensial sesi WhatsApp (jangan di-commit, jangan di-share).
- `data/chat_history.db` — SQLite: tabel `messages` (histori semua chat) & `conversation_memory` (memori percakapan asisten).
- Kedua folder di-mount sebagai volume, jadi persist saat container rebuild.

## Troubleshooting

- **`host.docker.internal` gagal resolve**: pastikan `extra_hosts: host.docker.internal:host-gateway` ada di `docker-compose.yml` (sudah disediakan). Pastikan juga Ollama bind ke `127.0.0.1:11434`, bukan port lain.
- **`MODEL NOT FOUND`**: jalankan `ollama pull <nama-model>` di host.
- **Bot tidak merespons**: pastikan ID grup benar di `WHITELIST_GROUP_IDS` dan pesan memakai trigger (`@kacan`/`!ai`/`!tanya`).
- **Session logout**: hapus `auth_session/` (atau `docker compose down` lalu `rm -rf auth_session`) dan ulangi scan QR.

## Peringatan

Baileys memakai protokol WhatsApp Web yang tidak resmi. Risiko nomor di-ban rendah untuk penggunaan grup internal, tapi disarankan pakai nomor sekunder, bukan nomor pribadi utama.
