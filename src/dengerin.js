// Mode "dengerin": user trigger dengan !dengerin, lalu tiap voice note yang dia kirim di
// chat yang sama otomatis ditranskrip (ElevenLabs Speech-to-Text) → dijawab lewat flow
// asisten yang sudah ada (getAssistantReply: memory + web search + Ollama/cloud) → jawaban
// diubah jadi voice note balasan (ElevenLabs Text-to-Speech). Sesi berakhir manual
// (!sudahdengerin), auto-expire kalau nggak ada VN dalam grace period awal, atau auto-expire
// kalau idle terlalu lama setelah sesi aktif.
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { getAssistantReply } from './assistant.js';
import { aiErrorHint } from './ai.js';
import { transcribeAudio, synthesizeSpeech } from './services/elevenlabs.js';
import { convertToOggOpus } from './utils/audioConvert.js';

// key: groupId (bukan userId) — supaya beberapa grup bisa jalan sesi dengerin masing-masing
// bersamaan tanpa saling ganggu.
const listeningSessions = new Map();

function dengerinConfig(env) {
  return {
    gracePeriodMs: Number(env.DENGERIN_GRACE_PERIOD_MS || 2 * 60 * 1000),
    idleTimeoutMs: Number(env.DENGERIN_IDLE_TIMEOUT_MS || 10 * 60 * 1000),
  };
}

function clearSessionTimers(session) {
  clearTimeout(session.graceTimer);
  clearTimeout(session.idleTimer);
}

export function hasActiveSession(groupId) {
  return listeningSessions.has(groupId);
}

export async function handleDengerinStart(sock, logger, config, { msg, groupId, senderNumber, senderName }) {
  if (!config.env.ELEVENLABS_API_KEY || !config.env.ELEVENLABS_VOICE_ID) {
    await sock.sendMessage(groupId, {
      text: 'Fitur dengerin belum aktif — ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID belum di-set di .env.',
      quoted: msg,
    });
    return;
  }

  const { gracePeriodMs } = dengerinConfig(config.env);

  const existing = listeningSessions.get(groupId);
  if (existing) {
    clearSessionTimers(existing);
    if (existing.userId !== senderNumber) {
      await sock.sendMessage(groupId, { text: `Fokus dengerin dipindah dari ${existing.senderName} ke ${senderName || 'kamu'}.` });
    }
  }

  const graceTimer = setTimeout(() => {
    const session = listeningSessions.get(groupId);
    if (session && !session.confirmed) {
      listeningSessions.delete(groupId);
      sock.sendMessage(groupId, { text: 'Sesi dengerin dimatikan karena nggak ada voice note masuk.' })
        .catch((err) => logger.error({ err, groupId }, 'Dengerin: gagal kirim notif grace timeout'));
    }
  }, gracePeriodMs);

  listeningSessions.set(groupId, {
    userId: senderNumber,
    senderName: senderName || 'kamu',
    confirmed: false,
    lastActivity: Date.now(),
    graceTimer,
    idleTimer: null,
  });

  logger.info({ groupId, senderNumber }, 'Dengerin session started');
  const minutes = Math.round(gracePeriodMs / 60000);
  await sock.sendMessage(groupId, {
    text: `🎧 Baik, saya dengarkan ${senderName || 'kamu'}. Kirim voice note dalam ${minutes} menit ya.`,
    quoted: msg,
  });
}

export async function handleDengerinStop(sock, logger, { msg, groupId, senderNumber }) {
  const session = listeningSessions.get(groupId);
  if (!session || session.userId !== senderNumber) {
    await sock.sendMessage(groupId, { text: 'Nggak ada sesi dengerin aktif buat kamu di sini.', quoted: msg });
    return;
  }
  clearSessionTimers(session);
  listeningSessions.delete(groupId);
  logger.info({ groupId, senderNumber }, 'Dengerin session stopped');
  await sock.sendMessage(groupId, { text: 'Oke, saya berhenti dengarkan.', quoted: msg });
}

function resetIdleTimer(sock, logger, config, groupId) {
  const session = listeningSessions.get(groupId);
  if (!session) return;
  clearTimeout(session.idleTimer);
  const { idleTimeoutMs } = dengerinConfig(config.env);
  session.idleTimer = setTimeout(() => {
    listeningSessions.delete(groupId);
    sock.sendMessage(groupId, { text: 'Sesi dengerin berakhir karena nggak ada aktivitas.' })
      .catch((err) => logger.error({ err, groupId }, 'Dengerin: gagal kirim notif idle timeout'));
  }, idleTimeoutMs);
}

function getAudioMessage(msg) {
  return msg.message?.audioMessage || msg.message?.pttMessage || null;
}

export async function handleIncomingVoiceNote(sock, logger, config, msg, { groupId, senderNumber }) {
  const session = listeningSessions.get(groupId);
  // Bukan sesi aktif, atau bukan dari user yang sedang difokuskan -> abaikan total
  if (!session || session.userId !== senderNumber) return;

  // VN pertama -> confirm sesi, clear grace timer, mulai idle timer
  if (!session.confirmed) {
    clearTimeout(session.graceTimer);
    session.confirmed = true;
  }
  session.lastActivity = Date.now();
  resetIdleTimer(sock, logger, config, groupId);

  let transcript = '';
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const mimeType = getAudioMessage(msg)?.mimetype || 'audio/ogg';
    transcript = await transcribeAudio(buffer, mimeType, config.env);
  } catch (err) {
    if (err.code === 'STT_QUOTA_EXCEEDED') {
      await sock.sendMessage(groupId, { text: 'Kuota transkripsi suara lagi habis nih, coba lagi nanti ya.', quoted: msg });
      return;
    }
    logger.error({ err, groupId }, 'Dengerin: transcribe gagal');
    await sock.sendMessage(groupId, { text: 'Waduh, ada masalah pas dengerin voice note-nya. Coba kirim ulang ya.', quoted: msg });
    return;
  }

  if (!transcript) {
    await sock.sendMessage(groupId, { text: 'Nggak nangkep suaranya, coba ulang ya.', quoted: msg });
    return;
  }

  let answerText;
  try {
    answerText = await getAssistantReply(logger, config, {
      groupId,
      question: transcript,
      senderName: session.senderName,
      senderNumber: session.userId,
    });
  } catch (err) {
    logger.error({ err, groupId }, 'Dengerin: assistant flow gagal');
    await sock.sendMessage(groupId, { text: aiErrorHint(err), quoted: msg });
    return;
  }

  // TTS gagal (termasuk quota habis) TIDAK mematikan sesi — kuota bisa reset bulanan,
  // dan user tetap dapat jawabannya (teks) supaya nggak kehilangan jawaban sama sekali.
  try {
    const mp3 = await synthesizeSpeech(answerText, config.env);
    const oggOpus = await convertToOggOpus(mp3);
    await sock.sendMessage(groupId, { audio: oggOpus, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
    logger.info({ groupId }, 'Dengerin: voice reply sent');
  } catch (err) {
    logger.warn({ err, groupId }, 'Dengerin: TTS/convert gagal, fallback teks');
    const reason = err.code === 'TTS_QUOTA_EXCEEDED' ? 'Kuota suara lagi habis nih' : 'Suaranya lagi gagal dibikin nih';
    await sock.sendMessage(groupId, { text: `${reason}, jadi aku jawab pakai teks dulu ya:\n\n${answerText}`, quoted: msg });
  }
}
