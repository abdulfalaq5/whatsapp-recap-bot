// Voice note handling.
// Transkripsi (Whisper/OpenAI) di-skip untuk sekarang karena tidak ada API key.
// Pesan audio tetap dibalas dengan fallback yang jelas, tidak diam saja.
export async function handleVoiceNote(sock, logger, config, msg) {
  const groupId = msg.key.remoteJid;
  logger.info({ groupId, type: msg.message?.audioMessage ? 'audio' : 'ptt' }, 'Voice note received (transcribe disabled)');
  try {
    await sock.sendMessage(groupId, {
      text: '🎙️ Aku belum bisa dengar voice note untuk sekarang (fitur transkripsi belum aktif). Kirim pesan teks saja ya!',
      quoted: msg,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to reply to voice note');
  }
}
