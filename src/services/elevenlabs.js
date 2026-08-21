// ElevenLabs: Speech-to-Text (Scribe) untuk transkrip voice note, dan Text-to-Speech
// untuk balas jawaban asisten sebagai suara. Dipakai oleh mode "!dengerin" (src/dengerin.js).

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const TTS_URL = (voiceId) => `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

async function readErrorBody(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// ElevenLabs balas 401 atau 429 dengan detail.status seperti "quota_exceeded"/"limit_reached"
// saat karakter/limit habis. Dideteksi khusus supaya bisa fallback natural, bukan error generik.
function isQuotaError(status, body) {
  const detailStatus = body?.detail?.status || body?.status;
  return status === 401 || status === 429 || detailStatus === 'quota_exceeded' || detailStatus === 'limit_reached';
}

// Transkrip voice note. WhatsApp voice note formatnya ogg/opus dan ElevenLabs terima
// langsung tanpa perlu convert dulu.
export async function transcribeAudio(buffer, mimeType, env) {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    const err = new Error('ELEVENLABS_API_KEY is not set');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const form = new FormData();
  form.append('model_id', env.ELEVENLABS_STT_MODEL || 'scribe_v1');
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), 'voice-note.ogg');

  const res = await fetch(STT_URL, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    if (isQuotaError(res.status, body)) {
      const err = new Error('ElevenLabs STT quota/limit exceeded');
      err.code = 'STT_QUOTA_EXCEEDED';
      throw err;
    }
    throw new Error(`ElevenLabs STT error ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }

  const data = await res.json();
  return String(data.text || '').trim();
}

// Text-to-speech: balas jawaban asisten jadi audio (mp3). Konversi ke ogg/opus untuk
// dikirim sebagai voice note WhatsApp dilakukan terpisah (lihat utils/audioConvert.js).
export async function synthesizeSpeech(text, env) {
  const apiKey = env.ELEVENLABS_API_KEY;
  const voiceId = env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    const err = new Error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID belum di-set');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const res = await fetch(TTS_URL(voiceId), {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
    }),
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    if (isQuotaError(res.status, body)) {
      const err = new Error('ElevenLabs TTS quota/limit exceeded');
      err.code = 'TTS_QUOTA_EXCEEDED';
      throw err;
    }
    throw new Error(`ElevenLabs TTS error ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
