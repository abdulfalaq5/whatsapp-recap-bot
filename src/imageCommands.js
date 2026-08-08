// Handler command gambar: !carigambar <kata kunci> dan !buatgambar <deskripsi>.
import fs from 'node:fs';
import { searchImage } from './services/imageSearch.js';
import { generateImage } from './services/imageGenerate.js';
import { deleteFile, shouldAutoDelete } from './utils/downloadImage.js';

export const IMAGE_HELP_TEXT = `• 🖼️ !carigambar <kata kunci> - cari gambar dari internet, contoh: !carigambar kucing lucu
• 🎨 !buatgambar <deskripsi> - buat gambar dengan AI, contoh: !buatgambar kucing astronot di luar angkasa`;

export async function handleSearchImage(sock, logger, config, { msg, groupId, arg }) {
  const query = String(arg || '').trim();
  if (!query) {
    await sock.sendMessage(groupId, { text: `Cara pakai: !carigambar <kata kunci>\nContoh: !carigambar kucing lucu`, quoted: msg });
    return;
  }

  let result;
  try {
    result = await searchImage(query, config.env, logger);
  } catch (err) {
    logger.error({ err, query }, 'Image search gagal (semua provider)');
    await sock.sendMessage(groupId, { text: 'Maaf, gambar tidak ditemukan dari semua sumber. Coba kata kunci lain ya.', quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(groupId, {
      image: fs.readFileSync(result.filePath),
      caption: `🖼️ Hasil pencarian: ${query}\n(Sumber: ${result.provider})`,
    }, { quoted: msg });
    logger.info({ provider: result.provider, file: result.filePath, query }, 'Image search terkirim ke WA');
  } catch (err) {
    logger.error({ err, query }, 'Gagal mengirim gambar hasil pencarian');
    await sock.sendMessage(groupId, { text: 'Gagal mengirim gambar hasil pencarian. Coba lagi ya.', quoted: msg });
  } finally {
    if (shouldAutoDelete(config.env)) deleteFile(result.filePath);
  }
}

export async function handleGenerateImage(sock, logger, config, { msg, groupId, arg }) {
  const prompt = String(arg || '').trim();
  if (!prompt) {
    await sock.sendMessage(groupId, { text: `Cara pakai: !buatgambar <deskripsi>\nContoh: !buatgambar kucing astronot di luar angkasa, gaya kartun`, quoted: msg });
    return;
  }

  await sock.sendMessage(groupId, { text: `🎨 Lagi buat gambar: "${prompt}"\nIni butuh beberapa detik ya...`, quoted: msg });

  let result;
  try {
    result = await generateImage(prompt, config.env, logger);
  } catch (err) {
    logger.error({ err, prompt }, 'Image generate gagal (semua provider)');
    await sock.sendMessage(groupId, { text: 'Maaf, gagal membuat gambar dari semua sumber. Coba lagi sebentar ya.', quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(groupId, {
      image: fs.readFileSync(result.filePath),
      caption: `🎨 Hasil generate: ${prompt}\n(Sumber: ${result.provider})`,
    }, { quoted: msg });
    logger.info({ provider: result.provider, file: result.filePath }, 'Image generate terkirim ke WA');
  } catch (err) {
    logger.error({ err, prompt }, 'Gagal mengirim gambar hasil generate');
    await sock.sendMessage(groupId, { text: 'Gagal mengirim gambar hasil generate. Coba lagi ya.', quoted: msg });
  } finally {
    if (shouldAutoDelete(config.env)) deleteFile(result.filePath);
  }
}
