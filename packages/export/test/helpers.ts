/* Test helpers: fixture PDFs made with pdf-lib, notes files, PDF.js in Node. */
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { NotesJSON, PageJSON, StrokeJSON } from '@inkslide/annotate/model';

/**
 * Three pages that all show as 600×400 pt:
 *   1. plain 600×400
 *   2. MediaBox 400×600 with /Rotate 90
 *   3. MediaBox 800×600, CropBox (100, 50, 600, 400)
 * Each has a line of text and a small black square at its shown top-left
 * corner (display 10..30), so a render shows where (0, 0) is.
 */
export async function fixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Fixture deck');
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const p1 = pdf.addPage([600, 400]);
  p1.drawText('Hello page one', { x: 50, y: 200, size: 24, font });
  p1.drawRectangle({ x: 10, y: 370, width: 20, height: 20, color: rgb(0, 0, 0) });

  const p2 = pdf.addPage([400, 600]);
  p2.setRotation(degrees(90));
  // Shown top-left is the MediaBox's bottom-left; text runs up so it reads left to right.
  p2.drawText('Rotated page two', { x: 200, y: 50, size: 24, font, rotate: degrees(90) });
  p2.drawRectangle({ x: 10, y: 10, width: 20, height: 20, color: rgb(0, 0, 0) });

  const p3 = pdf.addPage([800, 600]);
  p3.setCropBox(100, 50, 600, 400);
  p3.drawText('Cropped page three', { x: 150, y: 250, size: 24, font });
  p3.drawRectangle({ x: 110, y: 420, width: 20, height: 20, color: rgb(0, 0, 0) });
  p3.drawText('outside the crop box', { x: 10, y: 10, size: 12, font });

  return pdf.save();
}

export const SIZE: [number, number] = [600, 400];

export const pen = (id: string, points: [number, number][], color = '#be1e3c', size = 4): StrokeJSON => ({
  id, tool: 'pen', color, size, points: points.map(([x, y]) => [x, y, 0.5]),
});

export const hl = (id: string, points: [number, number][], color = '#ffd200', size = 20): StrokeJSON => ({
  id, tool: 'highlighter', color, size, points: points.map(([x, y]) => [x, y, 0.5]),
});

/** A cross from the shown top-left area to the bottom-right, plus an underline highlight. */
export const crossStrokes = (tag: string): StrokeJSON[] => [
  hl(`${tag}-h`, [[50, 215], [300, 215]]),
  pen(`${tag}-a`, [[40, 40], [200, 120], [560, 360]]),
  pen(`${tag}-b`, [[560, 40], [40, 360]], '#1565c0', 6),
];

export function notesFile(pages: PageJSON[], slides = 3): NotesJSON {
  return {
    format: 'marp-notes', version: 2,
    deck: { source: 'pdf', title: 'fixture.pdf', slides, size: SIZE, pageSizes: Array.from({ length: slides }, () => SIZE) },
    pages,
  };
}

// ── PDF.js (legacy build, Node) ────────────────────────────────

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;

export function pdfjs(): Promise<PdfJs> {
  return pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
}

/** A PDF.js document; `destroy` closes it (and its worker). */
export async function openPdfJs(bytes: Uint8Array) {
  const lib = await pdfjs();
  // PDF.js takes ownership of the buffer; give it a copy.
  const task = lib.getDocument({ data: bytes.slice(), verbosity: 0 });
  return { doc: await task.promise, destroy: () => task.destroy() };
}

/** Text of every page, items joined by spaces. */
export async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const { doc, destroy } = await openPdfJs(bytes);
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    out.push(content.items.map(i => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, ' ').trim());
  }
  await destroy();
  return out;
}
