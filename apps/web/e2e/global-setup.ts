/* Writes the small PDF fixture used by the tests (3 pages, one portrait). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '.fixtures', 'small.pdf');

export default async function globalSetup(): Promise<void> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Inkslide e2e fixture');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sizes: [number, number][] = [[960, 540], [960, 540], [595, 842]];
  sizes.forEach(([w, h], i) => {
    const page = pdf.addPage([w, h]);
    page.drawRectangle({ x: 20, y: 20, width: w - 40, height: h - 40, borderColor: rgb(0.1, 0.4, 0.8), borderWidth: 4 });
    page.drawText(`Page ${i + 1}`, { x: 60, y: h - 120, size: 64, font, color: rgb(0.1, 0.1, 0.1) });
  });
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, await pdf.save());
}
