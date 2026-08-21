// Helper penyimpanan & penghapusan file dokumen (docx/xlsx/pptx) hasil generate AI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function getDocDir(env) {
  return env.DOC_GENERATE_DIR || './temp/docs';
}

export function ensureDocDir(env) {
  const dir = getDocDir(env);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Path unik untuk file dokumen baru di DOC_GENERATE_DIR. Return path absolut/relatif file.
export function uniqueDocPath(env, { prefix = 'doc', ext = 'docx' } = {}) {
  const dir = ensureDocDir(env);
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  return path.join(dir, name);
}

export function deleteDocFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // file sudah tidak ada / gagal hapus → abaikan, tidak kritis
  }
}
