// Generate file .xlsx dari konten terstruktur { sheets: [{ sheetName, headers, rows }] }.
import ExcelJS from 'exceljs';
import { uniqueDocPath } from '../utils/docStorage.js';

// Kolom yang namanya mengandung kata-kata ini diformat sebagai angka Rupiah (ribuan).
const CURRENCY_HEADER_PATTERN = /rupiah|harga|jumlah|total|biaya|pengeluaran|nominal|pemasukan|saldo/i;

export async function generateXlsxFile(content, env) {
  const workbook = new ExcelJS.Workbook();

  for (const sheet of content.sheets) {
    const ws = workbook.addWorksheet(sheet.sheetName || 'Sheet1');

    if (sheet.headers.length) {
      ws.addRow(sheet.headers);
      ws.getRow(1).font = { bold: true };
    }
    for (const row of sheet.rows) {
      ws.addRow(row);
    }

    sheet.headers.forEach((header, idx) => {
      const col = ws.getColumn(idx + 1);
      if (CURRENCY_HEADER_PATTERN.test(String(header))) {
        col.numFmt = '#,##0';
      }
      let maxLen = String(header).length;
      col.eachCell?.({ includeEmpty: true }, (cell) => {
        const len = String(cell.value ?? '').length;
        if (len > maxLen) maxLen = len;
      });
      col.width = Math.min(maxLen + 2, 50);
    });
  }

  const filePath = uniqueDocPath(env, { prefix: 'doc', ext: 'xlsx' });
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}
