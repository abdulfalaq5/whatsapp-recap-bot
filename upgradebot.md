# Prompt untuk opencode — Upgrade Bot WA Baileys jadi Family Assistant

Copy-paste blok di bawah ini ke opencode. Kalau codebase besar, jalankan **per fase** (jangan sekaligus semua) supaya opencode bisa fokus dan hasilnya lebih stabil.

---

## PROMPT UTAMA (context awal — kirim ini duluan)

```
Saya punya bot WhatsApp yang dibuat dengan Baileys, fungsinya sebagai personal assistant keluarga.
Bot ini sudah jalan dan bisa membalas pertanyaan di group WA.

Sebelum menulis kode apapun, tolong:
1. Baca dan pahami struktur project ini (package.json, entry point, folder structure).
2. Identifikasi bagaimana bot ini menangani koneksi Baileys, auth session, dan message handler saat ini.
3. Ringkas ke saya: bagaimana arsitektur saat ini bekerja (connection handling, message flow, ada database atau belum, pakai LLM API apa).

Setelah itu saya akan minta kamu menambahkan fitur secara bertahap. Jangan ubah struktur besar yang sudah ada kecuali benar-benar diperlukan — tambahkan secara modular.
```

---

## FASE 1 — Reliability & Fondasi (kerjakan ini duluan, karena fitur lain bergantung ke sini)

```
Tambahkan reliability improvements ke bot Baileys ini:

1. Auto-reconnect yang solid: tangani event 'connection.update', deteksi DisconnectReason,
   dan reconnect otomatis kecuali reason-nya logged out (butuh scan ulang QR).
2. Backup/persist auth session folder (multi-file auth state) supaya restart server
   tidak perlu scan QR ulang, kecuali memang logout.
3. Health check: buat mekanisme sederhana (misal cron tiap 5 menit atau event listener)
   yang mendeteksi kalau koneksi Baileys down, lalu kirim notifikasi WA ke nomor admin saya.
4. Logging terstruktur: pakai pino atau winston untuk log koneksi, error, dan pesan masuk/keluar,
   simpan ke file log dengan rotasi harian.
5. Wrap semua message handler dengan try-catch supaya satu error tidak bikin bot crash total.

Setup database ringan (pakai lowdb atau better-sqlite3, pilih yang lebih cocok dengan project ini)
untuk menyimpan: session state, daftar nomor admin, dan daftar nomor anggota keluarga yang diizinkan.
Buat file config terpisah (.env atau config.js) untuk nomor admin dan nomor keluarga, jangan hardcode.
```

---

## FASE 2 — Memory & Konteks Keluarga

```
Tambahkan sistem memory/konteks ke bot:

1. Buat tabel/koleksi "members" di database: nomor WA, nama panggilan, role (admin/anggota),
   dan preferensi opsional (misal: makanan favorit, panggilan khusus).
2. Simpan histori percakapan per-nomor WA (chat history), batasi misal 20 pesan terakhir per orang,
   supaya bisa dikirim sebagai context ke LLM API tanpa membengkak.
3. Buat "shared context" terpisah untuk hal-hal keluarga bersama (agenda, pengumuman) yang
   bisa diakses semua anggota saat bot menjawab, terlepas dari histori personal masing-masing.
4. Saat memanggil LLM API, gabungkan: system prompt (lihat Fase 5) + shared context ringkas +
   histori personal user tersebut + pesan baru.
5. Buat command untuk anggota keluarga menghapus histori mereka sendiri, misal `!lupakan`.

Pastikan data member dan histori TIDAK bisa dibaca/diubah oleh nomor yang bukan terdaftar
sebagai anggota keluarga (validasi di awal setiap message handler).
```

---

## FASE 3 — Fitur Utama Keluarga

```
Tambahkan fitur-fitur berikut sebagai command handler terpisah (modular, satu file per fitur
kalau memungkinkan):

1. REMINDER & JADWAL
   - Command untuk membuat reminder, contoh: "!ingetin bayar listrik tgl 20 jam 9 pagi"
   - Gunakan LLM untuk parse teks natural jadi tanggal/waktu terstruktur, lalu simpan ke database.
   - Pakai node-cron untuk cek reminder yang jatuh tempo tiap menit, kirim pesan WA ke
     group/nomor yang buat reminder saat waktunya tiba.
   - Command untuk lihat daftar reminder aktif dan hapus reminder, misal "!reminder list", "!reminder hapus <id>".

2. SHARED SHOPPING LIST
   - Command tambah item: "!belanja tambah telur"
   - Command lihat list: "!belanja list"
   - Command hapus/centang item: "!belanja selesai telur"
   - List ini shared untuk semua anggota keluarga (bukan per-user).

3. CATATAN PENGELUARAN RINGAN
   - Command catat pengeluaran: "!catat 50000 belanja bulanan"
   - Simpan ke database dengan nomor pencatat, jumlah, kategori/deskripsi, timestamp.
   - Command rekap: "!rekap bulan ini" -> total pengeluaran + breakdown per kategori.
   - (Opsional kalau ada Google Sheets API key tersedia) sync ke Google Sheets, kalau tidak
     ada, cukup simpan di database dan bisa export ke CSV via command.

4. INFO CEPAT
   - Cuaca: integrasi ke API cuaca gratis (misal Open-Meteo, tidak perlu API key) berdasarkan
     lokasi yang dikonfigurasi di .env.
   - Jadwal sholat: integrasi ke API jadwal sholat (misal Aladhan API) berdasarkan kota di config.
   - Buat command jelas: "!cuaca", "!sholat"

5. VOICE NOTE HANDLING
   - Deteksi kalau pesan masuk berupa audio/voice note dari Baileys.
   - Download audio, transcribe pakai Whisper API (OpenAI) atau alternatif yang saya sudah
     punya akses, lalu proses teks hasil transcribe sebagai pesan biasa (masuk ke flow LLM).
   - Kalau gagal transcribe, balas dengan pesan error yang jelas ke user.

Untuk semua command di atas, pastikan ada fallback: kalau format command salah, bot balas
contoh format yang benar, jangan diam saja atau error mentah.
```

---

## FASE 4 — Keamanan & Kontrol Akses

```
Tambahkan lapisan akses berikut:

1. Middleware/fungsi helper `isFamilyMember(number)` dan `isAdmin(number)` yang dicek di
   awal setiap handler sebelum command dijalankan.
2. Command sensitif admin-only: "!restart" (restart bot service), "!log" (kirim log terakhir),
   "!broadcast <pesan>" (kirim ke semua anggota keluarga terdaftar), "!tambahmember <nomor> <nama>".
3. Command dari nomor yang tidak terdaftar sebagai anggota keluarga diabaikan (tidak dibalas
   sama sekali) untuk command sensitif, atau dibalas pesan sopan "maaf, ini bot keluarga privat"
   untuk pesan biasa — pilihkan mana yang lebih masuk akal untuk struktur project ini dan jelaskan alasannya.
4. Pastikan API key (LLM, Whisper, dsb) hanya dibaca dari .env, tidak pernah ter-log atau
   ter-expose ke pesan balasan bot, bahkan saat terjadi error.
```

---

## FASE 5 — Personality & Tone

```
Buat system prompt untuk LLM yang mendefinisikan kepribadian bot sebagai asisten keluarga:

- Nama bot: [ISI NAMA BOT]
- Gaya bicara: santai, hangat, seperti anggota keluarga sendiri, boleh pakai bahasa Indonesia
  sehari-hari, tidak kaku/formal seperti bot corporate.
- Bot tahu daftar nama anggota keluarga dan bisa menyapa sesuai siapa yang chat (dari data member).
- Bot proaktif mengingatkan (misal kalau ada reminder yang mendekati waktu) tapi tidak spam.
- Simpan system prompt ini di file terpisah (misal `prompts/personality.js`) supaya gampang diedit
  tanpa harus utak-atik logic utama.

Terapkan system prompt ini ke semua pemanggilan LLM API di seluruh fitur (Fase 2 dan 3).
```

---

## Cara pakai
1. Kirim **PROMPT UTAMA** dulu ke opencode, tunggu ringkasan arsitekturnya.
2. Kirim Fase 1 → review hasilnya, test bot masih jalan normal.
3. Lanjut Fase 2, 3, 4, 5 satu-satu — jangan loncat, karena tiap fase saling bergantung.
4. Di tiap fase, kalau opencode butuh keputusan (misal nama library, struktur folder), biarkan dia tanya balik atau kasih rekomendasi — jangan biarkan asumsi besar tanpa konfirmasi.
