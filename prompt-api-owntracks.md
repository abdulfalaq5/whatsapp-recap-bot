# Prompt untuk Claude Code — Endpoint API OwnTracks untuk WhatsApp Bot

Salin seluruh teks di bawah ini dan tempel ke Claude Code di project bot WhatsApp (Baileys) kamu.

---

## PROMPT

Saya punya WhatsApp bot berbasis **Baileys** (Node.js). Saya ingin menambahkan **endpoint API** di project ini untuk menerima data lokasi dari aplikasi **OwnTracks** (mode HTTP) yang terinstall di HP anggota keluarga.

### Yang perlu dibangun

**1. Endpoint `POST /owntracks/pub`**
- Terima request POST dengan body JSON dari OwnTracks
- Autentikasi via **HTTP Basic Auth** — cocokkan `username`/`password` terhadap daftar user yang saya definisikan (misalnya di file config atau tabel `users`)
- Cek field `_type` di body:
  - Kalau `_type === "location"` → proses dan simpan
  - Kalau tipe lain (misal `transition`, `waypoint`, dsb) → abaikan saja, tetap balas 200
- Dari payload location, ambil field: `lat`, `lon`, `tst` (unix timestamp), `batt` (opsional, level baterai), `acc` (opsional, akurasi dalam meter)
- Simpan/update ke database — **upsert** berdasarkan `user_id` (dari username Basic Auth), jadi tabel `locations` hanya menyimpan lokasi TERBARU per orang (tidak perlu histori penuh untuk versi awal)
- Response wajib: status `200` dengan body `[]` (array kosong) — ini sesuai spesifikasi OwnTracks HTTP mode, kalau tidak sesuai app OwnTracks bisa retry terus atau error di device

**2. Skema database**
Gunakan database yang sudah dipakai project ini (kalau belum ada, pakai SQLite untuk kesederhanaan). Buat tabel:
```
locations:
  - user_id (text, primary key)
  - latitude (float)
  - longitude (float)
  - accuracy (float, nullable)
  - battery (int, nullable)
  - updated_at (datetime)

owntracks_users:
  - username (text, primary key)   -- untuk Basic Auth
  - password_hash (text)
  - display_name (text)            -- nama yang dipakai di bot, misal "A"
```

**3. Keamanan**
- Password JANGAN disimpan plain text — hash dengan bcrypt
- Buatkan juga script/command kecil untuk generate user baru (tambah ke `owntracks_users`) dari CLI, supaya saya gampang tambah anggota keluarga baru
- Tambahkan rate limiting sederhana di endpoint ini (misal max 1 request per beberapa detik per user) untuk jaga-jaga dari spam/misconfigured client
- Kalau project ini nanti di-deploy, endpoint ini HARUS bisa diakses via HTTPS — kalau reverse proxy (nginx/caddy) belum ada, kasih catatan/rekomendasi setup-nya juga

**4. Fungsi helper untuk dipakai command bot lain**
Buatkan fungsi `getLastLocation(userId)` yang query tabel `locations` dan return `{ latitude, longitude, updatedAt, battery }` atau `null` kalau belum ada data — supaya nanti gampang dipakai di command bot seperti `!lokasi A` atau fitur rekam perjalanan.

**5. Testing**
- Kasih saya cara tes endpoint ini pakai `curl` (simulasi payload OwnTracks) sebelum saya coba dari HP asli
- Setelah endpoint jalan, saya akan ganti URL di app OwnTracks (yang sebelumnya saya arahkan ke webhook.site untuk tes awal) ke URL endpoint asli ini

### Struktur file yang saya harapkan
Pisahkan kode dengan rapi, kira-kira:
- `routes/owntracks.js` — endpoint handler
- `db/locations.js` — query database (insert/upsert/get)
- `db/owntracksUsers.js` — kelola user OwnTracks + auth
- `scripts/addOwntracksUser.js` — CLI untuk tambah user baru

Tolong mulai dengan tunjukkan struktur file yang diusulkan (sesuaikan dengan struktur project saya yang sudah ada — cek dulu file yang ada di project ini), lalu implementasikan mulai dari skema database dan endpoint API-nya.

---
