# Fitur: Voice Note Listening Mode (`!dengerin`)

## Ringkasan
Fitur mode "dengerin" per chat: user trigger dengan `!dengerin`, lalu bot otomatis
memproses tiap voice note (VN) yang dikirim user itu di chat yang sama —
transkrip (whisper.cpp) → proses jawaban (flow assistant yang sudah ada:
Tavily search + Ollama/cloud) → convert jawaban ke audio (ElevenLabs) →
kirim balik sebagai voice note (PTT). Sesi berakhir manual (`!sudahdengerin`),
auto-expire kalau nggak ada VN dalam grace period awal, atau auto-expire
kalau idle terlalu lama setelah sesi aktif.

## State Management

Simpan di memory (Map/object), tidak perlu persist ke DB — sesi bersifat sementara.

```js
// key: chatId (bukan userId — supaya bisa multi-grup jalan bersamaan)
const listeningSessions = new Map();
// listeningSessions.set(chatId, {
//   userId: string,
//   confirmed: boolean,       // true setelah VN pertama masuk
//   lastActivity: number,     // timestamp ms
//   graceTimer: NodeJS.Timeout, // timer 2 menit awal, di-clear saat confirmed
// });
```

## Konfigurasi

```js
const DENGERIN_CONFIG = {
  GRACE_PERIOD_MS: 2 * 60 * 1000,   // 2 menit — waktu tunggu VN pertama setelah !dengerin
  IDLE_TIMEOUT_MS: 10 * 60 * 1000,  // 10 menit — timeout idle setelah sesi confirmed (ganti sesuai kebutuhan)
};
```

## Command Handlers

### `!dengerin`

1. Ambil `chatId` dan `userId` pengirim.
2. Kalau `listeningSessions.has(chatId)`:
   - Clear timer lama (`graceTimer` atau idle timer) punya listener sebelumnya.
   - (Opsional) kirim notif ke user lama bahwa fokus dialihkan.
3. Set session baru:
   ```js
   const graceTimer = setTimeout(() => {
     const session = listeningSessions.get(chatId);
     if (session && !session.confirmed) {
       listeningSessions.delete(chatId);
       sendMessage(chatId, "Sesi dengerin dimatikan karena nggak ada voice note masuk.");
     }
   }, DENGERIN_CONFIG.GRACE_PERIOD_MS);

   listeningSessions.set(chatId, {
     userId,
     confirmed: false,
     lastActivity: Date.now(),
     graceTimer,
   });
   ```
4. Balas: `"Baik, saya dengarkan @{nama} 🎧 (kirim voice note dalam 2 menit)"`

### `!sudahdengerin`

1. Ambil session dari `listeningSessions.get(chatId)`.
2. Kalau tidak ada session, atau `session.userId !== pengirim`: abaikan / balas
   `"Nggak ada sesi dengerin aktif buat kamu di sini."`
3. Kalau valid: clear semua timer terkait, `listeningSessions.delete(chatId)`.
4. Balas: `"Oke, saya berhenti dengarkan."`

## Handler Voice Note Masuk (`messageType === 'audioMessage'`)

```js
async function handleIncomingVoiceNote(msg, chatId, senderId) {
  const session = listeningSessions.get(chatId);

  // Bukan sesi aktif, atau bukan dari user yang sedang difokuskan -> abaikan total
  if (!session || session.userId !== senderId) return;

  // Ini VN pertama -> confirm sesi, clear grace timer, mulai idle timer
  if (!session.confirmed) {
    clearTimeout(session.graceTimer);
    session.confirmed = true;
  }
  session.lastActivity = Date.now();
  resetIdleTimer(chatId);

  try {
    const audioBuffer = await downloadMediaMessage(msg);
    const transcript = await transcribeWithWhisper(audioBuffer); // whisper.cpp lokal

    const answerText = await processAssistantFlow(transcript, chatId); // flow existing: Tavily + Ollama/cloud

    const audioReply = await synthesizeWithElevenLabs(answerText); // lihat bagian fallback di bawah
    await sendVoiceNote(chatId, audioReply);
  } catch (err) {
    await handleVoiceNoteError(err, chatId, answerTextFallback);
  }
}

function resetIdleTimer(chatId) {
  const session = listeningSessions.get(chatId);
  if (!session) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    listeningSessions.delete(chatId);
    sendMessage(chatId, "Sesi dengerin berakhir karena nggak ada aktivitas.");
  }, DENGERIN_CONFIG.IDLE_TIMEOUT_MS);
}
```

## Fallback: ElevenLabs Limit/Quota Habis

ElevenLabs API mengembalikan error dengan status code `401` atau `429` disertai
body berisi `detail.status` seperti `quota_exceeded` saat karakter/limit habis.
Tangkap error ini secara spesifik, jangan generic catch-all.

```js
async function synthesizeWithElevenLabs(text) {
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const status = errBody?.detail?.status;

      if (response.status === 401 || status === "quota_exceeded" || status === "limit_reached") {
        const err = new Error("ELEVENLABS_QUOTA_EXCEEDED");
        err.code = "QUOTA_EXCEEDED";
        throw err;
      }
      throw new Error(`ElevenLabs error: ${response.status}`);
    }

    return await response.arrayBuffer();
  } catch (err) {
    throw err;
  }
}

async function handleVoiceNoteError(err, chatId, answerTextFallback) {
  if (err.code === "QUOTA_EXCEEDED") {
    // Fallback natural: kirim pesan info + tetap kasih jawaban dalam bentuk teks
    await sendMessage(
      chatId,
      `Kuota suara lagi habis nih, jadi aku jawab pakai teks dulu ya:\n\n${answerTextFallback}`
    );
    return;
  }

  // Error lain (whisper gagal, assistant flow gagal, dsb) -> log + info umum
  console.error("[dengerin] error:", err);
  await sendMessage(chatId, "Waduh, ada masalah pas proses voice note-nya. Coba kirim ulang ya.");
}
```

**Catatan penting soal fallback:**
- `answerTextFallback` harus disimpan dari hasil `processAssistantFlow()` SEBELUM
  masuk ke tahap `synthesizeWithElevenLabs()`, supaya kalau TTS gagal karena quota,
  bot tetap bisa kasih jawaban (teks) — user nggak kehilangan jawaban sama sekali,
  cuma beda format.
- Pesan fallback dibuat terasa natural (bukan pesan error teknis kayak "Error 401:
  quota_exceeded"), supaya nggak awkward di grup keluarga.
- Sesi `!dengerin` TETAP AKTIF meskipun ElevenLabs gagal — jangan otomatis
  matiin sesi hanya karena TTS gagal sekali, karena kuota bisa balik lagi
  (reset bulanan) atau user mungkin ganti API key.
- Opsional: tambahkan cache sederhana (in-memory counter) buat cek sisa kuota
  sebelum call API, supaya nggak boros request kalau memang udah pasti habis
  (ElevenLabs punya endpoint `GET /v1/user/subscription` buat cek `character_count`
  vs `character_limit`).

## File yang Kemungkinan Perlu Disentuh
- `assistant.js` atau file command handler utama — tambah case `!dengerin` / `!sudahdengerin`
- Handler pesan masuk — tambah pengecekan `messageType === 'audioMessage'` sebelum trigger flow biasa
- File baru: `services/whisper.js` (transcribe), `services/elevenlabs.js` (TTS + fallback)
- `.env` — tambah `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`

## Yang Perlu Ditest
1. `!dengerin` lalu kirim VN dalam 2 menit → bot balas VN.
2. `!dengerin` lalu diam >2 menit → sesi auto-mati, dapat notif.
3. Sesi aktif, idle >10 menit setelah VN terakhir → sesi auto-mati.
4. User B kirim VN padahal fokus masih ke user A di chat sama → diabaikan.
5. User A `!dengerin` di grup lain → sesi baru terpisah, tidak konflik dengan grup pertama.
6. ElevenLabs quota habis (simulasi dengan API key invalid) → bot balas teks + pesan natural, sesi tetap aktif.
