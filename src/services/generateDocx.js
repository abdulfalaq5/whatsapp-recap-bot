// Generate file .docx dari konten terstruktur { title, sections: [{ heading, paragraphs, bulletList }] }.
import fs from 'node:fs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { uniqueDocPath } from '../utils/docStorage.js';

export async function generateDocxFile(content, env) {
  const children = [new Paragraph({ text: content.title, heading: HeadingLevel.TITLE })];

  for (const section of content.sections) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const paragraph of section.paragraphs) {
      children.push(new Paragraph({ children: [new TextRun(paragraph)] }));
    }
    for (const bullet of section.bulletList) {
      children.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const filePath = uniqueDocPath(env, { prefix: 'doc', ext: 'docx' });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
