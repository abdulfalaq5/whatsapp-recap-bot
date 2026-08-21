// Generate file .pptx dari konten terstruktur { title, slides: [{ heading, bullets }] }.
// Layout template tunggal & konsisten (tidak ada desain custom per slide).
import PptxGenJS from 'pptxgenjs';
import { uniqueDocPath } from '../utils/docStorage.js';

export async function generatePptxFile(content, env) {
  const pptx = new PptxGenJS();

  const titleSlide = pptx.addSlide();
  titleSlide.addText(content.title, {
    x: 0.5, y: 2.2, w: '90%', h: 1.5, fontSize: 32, bold: true, align: 'center',
  });

  for (const slide of content.slides) {
    const s = pptx.addSlide();
    s.addText(slide.heading, {
      x: 0.5, y: 0.3, w: '90%', h: 0.8, fontSize: 24, bold: true, color: '1F3864',
    });
    if (slide.bullets.length) {
      s.addText(
        slide.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.3, w: '90%', h: 4, fontSize: 18 },
      );
    }
  }

  const filePath = uniqueDocPath(env, { prefix: 'doc', ext: 'pptx' });
  await pptx.writeFile({ fileName: filePath });
  return filePath;
}
