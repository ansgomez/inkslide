/* Images (snapshots) in the export: embedded once, placed like strokes on
 * rotated, cropped and blank pages (checked against PDF.js), below the ink. */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import type { ImageJSON, PageJSON } from '@inkslide/annotate/model';
import { exportAnnotatedPdfWithReport } from '../src/export';
import { fixturePdf, notesFile, openPdfJs, pdfjs, pen, hl } from './helpers';

/** A 4×2 PNG and an 8×8 JPEG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAGUlEQVR4nGP8z8DAwMDAyPCfgYGBiQEJAAAqNwIDlBYW1QAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDySiiiv5yP5MP/2Q==';

const image = (id: string, x: number, y: number, w: number, h: number, src = PNG): ImageJSON => ({ id, x, y, w, h, src });
const v3 = (pages: PageJSON[], slides = 3) => ({ ...notesFile(pages, slides), version: 3 });

type M = [number, number, number, number, number, number];
/** m applied first, then ctm (a PDF `cm`). */
const concat = (ctm: M, m: M): M => [
  m[0] * ctm[0] + m[1] * ctm[2], m[0] * ctm[1] + m[1] * ctm[3],
  m[2] * ctm[0] + m[3] * ctm[2], m[2] * ctm[1] + m[3] * ctm[3],
  m[4] * ctm[0] + m[5] * ctm[2] + ctm[4], m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
];
const apply = (m: M, u: number, v: number): [number, number] => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

/**
 * Where PDF.js paints each image of page n, as display rectangles [x, y, w, h]
 * (its viewport at scale 1): the unit square's top-left and bottom-right
 * corners through the CTM at the paint.
 */
async function paintedImages(bytes: Uint8Array, n: number): Promise<number[][]> {
  const lib = await pdfjs();
  const { doc, destroy } = await openPdfJs(bytes);
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const list = await page.getOperatorList();
  const out: number[][] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i], args = list.argsArray[i];
    if (fn === lib.OPS.save) stack.push(ctm);
    else if (fn === lib.OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === lib.OPS.transform) ctm = concat(ctm, args as M);
    else if (fn === lib.OPS.paintImageXObject || fn === lib.OPS.paintInlineImageXObject) {
      const [x0, y0] = vp.convertToViewportPoint(...apply(ctm, 0, 1));
      const [x1, y1] = vp.convertToViewportPoint(...apply(ctm, 1, 0));
      out.push([x0, y0, x1 - x0, y1 - y0].map(v => Math.round(v * 100) / 100));
    }
  }
  await destroy();
  return out;
}

/** Decoded text of a page's last content stream (the one the export appends). */
function lastStream(page: PDFPage): string {
  const c = page.node.Contents();
  const ref = c instanceof PDFArray ? c.get(c.size() - 1) : c;
  return new TextDecoder().decode(decodePDFRawStream(page.doc.context.lookup(ref) as PDFRawStream).decode());
}

/** Image XObject dicts of the whole file. */
function imageXObjects(pdf: PDFDocument): PDFDict[] {
  return pdf.context.enumerateIndirectObjects().map(([, o]) => (o as { dict?: PDFDict }).dict)
    .filter((d): d is PDFDict => !!d && d.get(PDFName.of('Subtype')) === PDFName.of('Image'));
}

describe('images in the export', () => {
  it('lands where the notes put them on plain, rotated, cropped and blank pages (as PDF.js shows it)', async () => {
    const src = await fixturePdf();
    const rect = [120, 60, 200, 100];
    const at = (id: string) => image(id, rect[0], rect[1], rect[2], rect[3]);
    const { bytes, warnings } = await exportAnnotatedPdfWithReport(src, v3([
      { id: 'p1', kind: 'slide', slide: 1, strokes: [], images: [at('a')] },
      { id: 'p2', kind: 'slide', slide: 2, strokes: [], images: [at('b')] },
      { id: 'p3', kind: 'slide', slide: 3, strokes: [], images: [at('c')] },
      { id: 'b-1', kind: 'blank', after: 3, paper: 'grid', strokes: [], images: [at('d')] },
    ]));
    expect(warnings).toEqual([]);
    for (const n of [1, 2, 3, 4]) expect(await paintedImages(bytes, n)).toEqual([rect]);
  });

  it('embeds each distinct image once, PNG and JPEG', async () => {
    const src = await fixturePdf();
    const { bytes } = await exportAnnotatedPdfWithReport(src, v3([
      { id: 'p1', kind: 'slide', slide: 1, strokes: [], images: [image('a', 0, 0, 40, 20), image('b', 300, 200, 80, 40)] },
      { id: 'p2', kind: 'slide', slide: 2, strokes: [], images: [image('c', 10, 10, 40, 20), image('j', 100, 100, 50, 50, JPEG)] },
    ]));
    const out = await PDFDocument.load(bytes);
    const xobjects = imageXObjects(out);
    expect(xobjects).toHaveLength(2);
    const filters = xobjects.map(d => String(d.get(PDFName.of('Filter')))).sort();
    expect(filters).toEqual(['/DCTDecode', '/FlateDecode']);
    expect(await paintedImages(bytes, 1)).toEqual([[0, 0, 40, 20], [300, 200, 80, 40]]);
    expect(await paintedImages(bytes, 2)).toEqual([[10, 10, 40, 20], [100, 100, 50, 50]]);
  });

  it('draws images below the ink', async () => {
    const src = await fixturePdf();
    const { bytes } = await exportAnnotatedPdfWithReport(src, v3([{
      id: 'p1', kind: 'slide', slide: 1,
      strokes: [pen('a', [[10, 10], [200, 200]]), hl('h', [[10, 300], [300, 300]])],
      images: [image('i', 0, 0, 300, 150)],
    }]));
    const text = lastStream((await PDFDocument.load(bytes)).getPage(0));
    const draw = text.indexOf(' Do\n');
    expect(draw).toBeGreaterThan(0);
    expect(draw).toBeLessThan(text.indexOf('\nS\n')); // highlighter
    expect(draw).toBeLessThan(text.indexOf('\nf\n')); // pen
  });

  it('skips an image whose data does not decode, with a warning, and exports the rest', async () => {
    const src = await fixturePdf();
    // A PNG signature followed by garbage passes the notes check but not the decoder.
    const broken = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(41);
    const warned: string[] = [];
    const { bytes, warnings } = await exportAnnotatedPdfWithReport(src, v3([{
      id: 'p1', kind: 'slide', slide: 1, strokes: [pen('a', [[10, 10], [200, 200]])],
      images: [image('x', 0, 0, 10, 10, broken), image('ok', 50, 50, 40, 20)],
    }]), { onWarning: m => warned.push(m) });
    expect(warnings).toEqual(['Skipped an image on page p1: the image data could not be read']);
    expect(warned).toEqual(warnings);
    expect(await paintedImages(bytes, 1)).toEqual([[50, 50, 40, 20]]);
  });
});
