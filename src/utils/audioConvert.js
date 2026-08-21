// Convert buffer audio (mp3 dari ElevenLabs TTS) ke ogg/opus — format wajib WhatsApp
// supaya pesan tampil sebagai voice note (ptt) yang bisa diputar, bukan file audio biasa.
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('error', reject); // misal binary ffmpeg tidak ditemukan
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export async function convertToOggOpus(inputBuffer) {
  const id = crypto.randomBytes(6).toString('hex');
  const inPath = path.join(tmpdir(), `dengerin-in-${id}`);
  const outPath = path.join(tmpdir(), `dengerin-out-${id}.ogg`);
  await writeFile(inPath, inputBuffer);
  try {
    await runFfmpeg(['-y', '-i', inPath, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', outPath]);
    return await readFile(outPath);
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}
