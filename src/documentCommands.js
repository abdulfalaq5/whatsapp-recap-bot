// Handler command generate dokumen kantoran: !buatdoc <permintaan>
// (juga dipicu natural language "@kacan buatkan ... dalam word/excel/ppt").
import fs from 'node:fs';
import path from 'node:path';
import { generateDocumentContent } from './ai.js';
import { detectDocType } from './commands.js';
import { generateDocxFile } from './services/generateDocx.js';
import { generateXlsxFile } from './services/generateXlsx.js';
import { generatePptxFile } from './services/generatePptx.js';
import { deleteDocFile } from './utils/docStorage.js';

const MIME_TYPE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const DOC_LABEL = { docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint' };

const GENERATOR = {
  docx: generateDocxFile,
  xlsx: generateXlsxFile,
  pptx: generatePptxFile,
};

function documentTitle(docType, content) {
  if (docType === 'xlsx') return content.sheets?.[0]?.sheetName || 'Dokumen';
  return content.title || 'Dokumen';
}

export async function handleGenerateDocument(sock, logger, config, { msg, groupId, senderNumber, arg }) {
  const request = String(arg || '').trim();
  if (!request) {
    await sock.sendMessage(groupId, {
      text: `Cara pakai: !buatdoc <permintaan>\nContoh: !buatdoc buatkan draft surat izin dalam word`,
      quoted: msg,
    });
    return;
  }

  const docType = detectDocType(request);
  if (!docType) {
    await sock.sendMessage(groupId, {
      text: 'Mau dibuatkan dalam format apa? Sebutkan salah satu: *word*, *excel*, atau *ppt*.\nContoh: "@kacan buatkan laporan pengeluaran bulan ini dalam excel"',
      quoted: msg,
    });
    return;
  }

  await sock.sendMessage(groupId, {
    text: `📄 Lagi nyusun dokumen ${DOC_LABEL[docType]}: "${request}"\nTunggu sebentar ya...`,
    quoted: msg,
  });

  let content;
  try {
    content = await generateDocumentContent(docType, request);
  } catch (err) {
    logger.error({ err, docType, request }, 'Gagal generate konten dokumen dari AI');
    await sock.sendMessage(groupId, {
      text: 'Maaf, gagal menyusun isi dokumennya. Coba ulangi permintaannya dengan lebih spesifik ya.',
      quoted: msg,
    });
    return;
  }

  let filePath;
  try {
    filePath = await GENERATOR[docType](content, config.env);
  } catch (err) {
    logger.error({ err, docType }, 'Gagal generate file dokumen');
    await sock.sendMessage(groupId, { text: 'Maaf, gagal membuat file dokumennya. Coba lagi ya.', quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(groupId, {
      document: fs.readFileSync(filePath),
      fileName: path.basename(filePath),
      mimetype: MIME_TYPE[docType],
      caption: `📄 ${DOC_LABEL[docType]}: ${documentTitle(docType, content)}`,
    }, { quoted: msg });
    logger.info({ docType, filePath, senderNumber }, 'Dokumen hasil generate terkirim ke WA');
  } catch (err) {
    logger.error({ err, docType, filePath }, 'Gagal mengirim dokumen ke WA');
    await sock.sendMessage(groupId, { text: 'Dokumen sudah dibuat tapi gagal dikirim. Coba lagi ya.', quoted: msg });
  } finally {
    deleteDocFile(filePath);
  }
}
