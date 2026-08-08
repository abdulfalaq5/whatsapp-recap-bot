// Helper penyimpanan & penghapusan file gambar hasil search/generate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function getDownloadDir(env) {
  return env.IMAGE_DOWNLOAD_DIR || './Download';
}

export function ensureDownloadDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Simpan buffer ke file unik di IMAGE_DOWNLOAD_DIR. Return path absolut file.
export function saveBuffer(buffer, { env, prefix = 'img', ext = 'jpg' } = {}) {
  const dir = getDownloadDir(env);
  ensureDownloadDir(dir);
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function deleteFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // file sudah tidak ada / gagal hapus → abaikan, tidak kritis
  }
}

// Konfigurasi AUTO_DELETE_DOWNLOAD=true/false (default false).
export function shouldAutoDelete(env) {
  return String(env.AUTO_DELETE_DOWNLOAD || 'false').toLowerCase() === 'true';
}
