import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import { ENCRYPTED_PDF_MESSAGE, exportAnnotatedPdf, exportAnnotatedPdfWithReport, paperOperators } from '../src/export';
import { displayMatrix, displaySize, normalizeRotation, parseColor, svgPathOperators } from '../src/ops';
import { SIZE, crossStrokes, fixturePdf, hl, notesFile, openPdfJs, pageTexts, pen } from './helpers';

const contentsCount = (page: PDFPage): number => {
  const c = page.node.Contents();
  return c instanceof PDFArray ? c.size() : c ? 1 : 0;
};

/** Decoded text of a page's last content stream (the one the export appends). */
function lastStream(page: PDFPage): string {
  const c = page.node.Contents();
  const ref = c instanceof PDFArray ? c.get(c.size() - 1) : c;
  const stream = page.doc.context.lookup(ref) as PDFRawStream;
  return new TextDecoder().decode(decodePDFRawStream(stream).decode());
}

/** ExtGState dicts in a page's resources. */
function extGStates(page: PDFPage): PDFDict[] {
  const res = page.node.Resources();
  const gs = res && res.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  return gs ? gs.values().map(v => page.doc.context.lookup(v) as PDFDict) : [];
}

const apply = (m: number[], u: number, v: number): [number, number] =>
  [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

const fullNotes = () => notesFile([
  { id: 'p1', kind: 'slide', slide: 1, strokes: crossStrokes('p1') },
  { id: 'b-t-1', kind: 'blank', after: 1, paper: 'lined', strokes: [pen('b1', [[100, 100], [300, 150]])] },
  { id: 'p2', kind: 'slide', slide: 2, strokes: crossStrokes('p2') },
  { id: 'p3', kind: 'slide', slide: 3, strokes: crossStrokes('p3') },
  { id: 'b-t-2', kind: 'blank', after: 3, paper: 'grid', strokes: [] },
  { id: 'b-t-3', kind: 'blank', after: 3, paper: 'plain', strokes: [hl('b3', [[10, 10], [500, 300]])] },
]);

describe('page frames', () => {
  it('normalizes rotation', () => {
    expect([0, 90, 180, 270, 360, -90, 450].map(normalizeRotation)).toEqual([0, 90, 180, 270, 0, 270, 90]);
    expect(displaySize({ x: 0, y: 0, width: 400, height: 600 }, 90)).toEqual([600, 400]);
  });

  it('maps display points like PDF.js viewports do', async () => {
    const pdf = await PDFDocument.create();
    const boxes = [
      { media: [0, 0, 600, 400], rot: 0 }, { media: [0, 0, 400, 600], rot: 90 },
      { media: [0, 0, 600, 400], rot: 180 }, { media: [0, 0, 400, 600], rot: 270 },
      { media: [0, 0, 800, 600], crop: [100, 50, 600, 400], rot: 0 },
      { media: [0, 0, 800, 600], crop: [100, 50, 400, 500], rot: 90 },
      { media: [-50, -20, 600, 400], rot: 270 },
    ];
    for (const b of boxes) {
      const p = pdf.addPage();
      p.setMediaBox(b.media[0], b.media[1], b.media[2], b.media[3]);
      if (b.crop) p.setCropBox(b.crop[0], b.crop[1], b.crop[2], b.crop[3]);
      p.setRotation({ type: 'degrees', angle: b.rot } as never);
    }
    const bytes = await pdf.save();
    const loaded = await PDFDocument.load(bytes);
    const { doc: js, destroy } = await openPdfJs(bytes);
    for (let n = 1; n <= boxes.length; n++) {
      const page = loaded.getPage(n - 1);
      const c = page.getCropBox();
      const m = displayMatrix(c, page.getRotation().angle);
      const vp = (await js.getPage(n)).getViewport({ scale: 1 });
      expect(displaySize(c, page.getRotation().angle)).toEqual([vp.width, vp.height]);
      for (const [u, v] of [[0, 0], [37, 11], [vp.width, vp.height]]) {
        const [x, y] = vp.convertToPdfPoint(u, v);
        const got = apply(m, u, v);
        expect(got[0]).toBeCloseTo(x, 6);
        expect(got[1]).toBeCloseTo(y, 6);
      }
    }
    await destroy();
  });
});

describe('svgPathOperators and parseColor', () => {
  it('converts M/Q/L/Z and relative l', () => {
    const ops = svgPathOperators('M0 0 Q3 3 6 0 L6 6 Z').map(String);
    expect(ops).toEqual(['0 0 m', '2 2 4 2 6 0 c', '6 6 l', 'h']);
    expect(svgPathOperators('M10 10 l0.01 0').map(String)).toEqual(['10 10 m', '10.01 10 l']);
    expect(svgPathOperators('')).toEqual([]);
  });

  it('skips stray numbers after Z instead of looping forever', () => {
    expect(svgPathOperators('M0 0 L1 1 Z 5 5').map(String)).toEqual(['0 0 m', '1 1 l', 'h']);
  });

  it('parses hex, rgb() and names', () => {
    expect(parseColor('#ff0000')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('#0f0')).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(parseColor('#00000080').a).toBeCloseTo(0.502, 3);
    expect(parseColor('rgb(0, 0, 255)')).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(parseColor('rgba(255 255 255 / 50%)')).toEqual({ r: 1, g: 1, b: 1, a: 0.5 });
    expect(parseColor('white')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor('bogus')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });
});

describe('exportAnnotatedPdf', () => {
  it('refuses an encrypted PDF (owner password) with a plain message', async () => {
    // The fixture with a standard security handler entry in its trailer, as an
    // owner-password PDF has: pdf-lib can not decrypt it and refuses to load it.
    const doc = await PDFDocument.load(await fixturePdf());
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({
      Filter: 'Standard', V: 2, R: 3, Length: 128, P: -3904,
    }));
    const encrypted = await doc.save({ useObjectStreams: false });
    await expect(exportAnnotatedPdf(encrypted, null)).rejects.toThrow(ENCRYPTED_PDF_MESSAGE);
  });

  it('inserts blank pages in order with the size of the page they follow', async () => {
    const src = await fixturePdf();
    const { bytes, warnings, pageCount } = await exportAnnotatedPdfWithReport(src, fullNotes());
    expect(warnings).toEqual([]);
    expect(pageCount).toBe(6);
    const out = await PDFDocument.load(bytes);
    const shown = out.getPages().map(p => displaySize(p.getCropBox(), p.getRotation().angle));
    expect(shown).toEqual(Array(6).fill(SIZE));
    // Originals keep their boxes and rotation; blank pages are unrotated.
    expect(out.getPages().map(p => p.getRotation().angle)).toEqual([0, 0, 90, 0, 0, 0]);
    expect(out.getPage(3).getCropBox()).toEqual({ x: 100, y: 50, width: 600, height: 400 });
    expect(out.getPage(3).getMediaBox()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    // Text order proves page order: p1, blank, p2, p3, blank, blank.
    const texts = await pageTexts(bytes);
    expect(texts[0]).toContain('Hello page one');
    expect(texts[1]).toBe('');
    expect(texts[2]).toContain('Rotated page two');
    expect(texts[3]).toContain('Cropped page three');
    expect(texts.slice(4)).toEqual(['', '']);
  });

  it('keeps the original text, title and input bytes', async () => {
    const src = await fixturePdf();
    const before = src.slice();
    const bytes = await exportAnnotatedPdf(src, fullNotes());
    expect(src).toEqual(before);
    const orig = await pageTexts(src);
    const texts = await pageTexts(bytes);
    expect([texts[0], texts[2], texts[3]]).toEqual(orig);
    expect((await PDFDocument.load(bytes)).getTitle()).toBe('Fixture deck');
  });

  it('appends content streams with vector paths and a highlighter ExtGState', async () => {
    const src = await fixturePdf();
    const orig = await PDFDocument.load(src);
    const out = await PDFDocument.load(await exportAnnotatedPdf(src, fullNotes()));
    for (const [o, e] of [[0, 0], [1, 2], [2, 3]]) {
      const page = out.getPage(e);
      // Original stream wrapped in q/Q plus our stream.
      expect(contentsCount(page)).toBeGreaterThan(contentsCount(orig.getPage(o)));
      const text = lastStream(page);
      expect(text).toMatch(/^q\n/);
      expect(text).toMatch(/ cm\n/);
      expect(text).toMatch(/ c\n/);          // Bézier curves
      expect(text).toMatch(/\nf\n/);         // filled pen outline
      expect(text).toMatch(/\nS\n/);         // stroked highlighter
      expect(text).toMatch(/1 J\n1 j\n/);    // round caps and joins
      const hlState = extGStates(page).find(d => d.get(PDFName.of('BM')) === PDFName.of('Multiply'));
      expect(hlState).toBeDefined();
      expect((hlState!.get(PDFName.of('CA')) as PDFNumber).asNumber()).toBeCloseTo(0.35, 6);
    }
    // Highlighters are painted before (below) pen strokes.
    const first = lastStream(out.getPage(0));
    expect(first.indexOf('\nS\n')).toBeLessThan(first.indexOf('\nf\n', first.indexOf('re\nf\n') + 1));
    // The lined blank page has white paper and rules.
    const blank = lastStream(out.getPage(1));
    expect(blank).toMatch(/1 1 1 rg\n0 0 600 400 re\nf\n/);
    expect((blank.match(/ re\n/g) || []).length).toBeGreaterThan(20);
  });

  it('places strokes in display coordinates on rotated and cropped pages', async () => {
    const src = await fixturePdf();
    const point = (n: number) => notesFile([{ id: `p${n}`, kind: 'slide', slide: n, strokes: [pen('d', [[100, 50]], '#000', 10)] }]);
    const out = await PDFDocument.load(await exportAnnotatedPdf(src, point(2)));
    const cm = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/.exec(lastStream(out.getPage(1)));
    // Rotate 90: display (u, v) -> user (x0 + v, y0 + u).
    expect(cm!.slice(1).map(Number)).toEqual([0, 1, 1, 0, 0, 0]);
    const out3 = await PDFDocument.load(await exportAnnotatedPdf(src, point(3)));
    const cm3 = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/.exec(lastStream(out3.getPage(2)));
    expect(cm3!.slice(1).map(Number)).toEqual([1, 0, 0, -1, 100, 450]);
  });

  it('a blank page after a rotated page has its shown (rotated) size, unrotated', async () => {
    const src = await fixturePdf();
    const notes = notesFile([{ id: 'b-r', kind: 'blank', after: 2, paper: 'grid', strokes: [pen('g', [[10, 10], [590, 390]])] }]);
    const out = await PDFDocument.load(await exportAnnotatedPdf(src, notes));
    expect(out.getPageCount()).toBe(4);
    const blank = out.getPage(2);
    expect(blank.getRotation().angle).toBe(0);
    expect(blank.getSize()).toEqual({ width: 600, height: 400 }); // MediaBox 400×600 turned by /Rotate 90
    expect(lastStream(blank)).toMatch(/1 0 0 -1 0 400 cm/);
  });

  it('reads inverted page boxes as PDF.js does', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 400]);
    page.node.set(PDFName.of('MediaBox'), pdf.context.obj([600, 400, 0, 0]));
    const src = await pdf.save();
    const js = await openPdfJs(src);
    const vp = (await js.doc.getPage(1)).getViewport({ scale: 1 });
    await js.destroy();
    expect([vp.width, vp.height]).toEqual([600, 400]);
    const notes = notesFile([
      { id: 'p1', kind: 'slide', slide: 1, strokes: [pen('d', [[100, 50]], '#000', 10)] },
      { id: 'b-1', kind: 'blank', after: 1, paper: 'plain', strokes: [] },
    ], 1);
    const res = await exportAnnotatedPdfWithReport(src, notes);
    expect(res.warnings).toEqual([]);
    const out = await PDFDocument.load(res.bytes);
    expect(out.getPage(1).getSize()).toEqual({ width: 600, height: 400 });
    const cm = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/.exec(lastStream(out.getPage(0)));
    expect(cm!.slice(1).map(Number)).toEqual([1, 0, 0, -1, 0, 400]);
  });

  it('leaves pages without notes untouched and handles empty notes', async () => {
    const src = await fixturePdf();
    const orig = await PDFDocument.load(src);
    for (const notes of [null, notesFile([])]) {
      const res = await exportAnnotatedPdfWithReport(src, notes);
      expect(res.warnings).toEqual([]);
      const out = await PDFDocument.load(res.bytes);
      expect(out.getPageCount()).toBe(3);
      out.getPages().forEach((p, i) => expect(contentsCount(p)).toBe(contentsCount(orig.getPage(i))));
    }
    const one = await PDFDocument.load(await exportAnnotatedPdf(src, notesFile([
      { id: 'p2', kind: 'slide', slide: 2, strokes: crossStrokes('x') },
    ])));
    expect(contentsCount(one.getPage(0))).toBe(contentsCount(orig.getPage(0)));
    expect(contentsCount(one.getPage(2))).toBe(contentsCount(orig.getPage(2)));
    expect(contentsCount(one.getPage(1))).toBeGreaterThan(contentsCount(orig.getPage(1)));
  });

  it('leaves notes kept for pages beyond the PDF out silently and drops laser strokes', async () => {
    const src = await fixturePdf();
    const notes = notesFile([
      { id: 'p1', kind: 'slide', slide: 1, strokes: [
        pen('ok', [[10, 10], [50, 50]]),
        { id: 'laser', tool: 'laser' as never, color: '#f00', size: 8, points: [[1, 1, 0.5]] },
      ] },
      { id: 'p9', kind: 'slide', slide: 9, strokes: [pen('far', [[10, 10], [50, 50]])] },
      { id: 'b-x', kind: 'blank', after: 7, paper: 'grid', strokes: [] },
    ], 9);
    const seen: string[] = [];
    const bytes = await exportAnnotatedPdf(src, notes, { onWarning: m => seen.push(m) });
    // Kept pages are expected (the PDF lost pages), not export problems; the deck mismatch is one.
    expect(seen.some(w => /slide 9|b-x/.test(w))).toBe(false);
    expect(seen.some(w => /9 slides/.test(w))).toBe(true);
    const report = await exportAnnotatedPdfWithReport(src, notes, { onWarning: m => seen.push(`again: ${m}`) });
    expect(report.warnings).toEqual(seen.filter(w => !w.startsWith('again: ')));
    expect(seen.filter(w => w.startsWith('again: '))).toHaveLength(report.warnings.length);
    expect(seen.some(w => /laser/.test(w))).toBe(false);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(3);
    expect((lastStream(out.getPage(0)).match(/\nf\n/g) || []).length).toBe(1);
  });

  it('uses the freehand outline when asked', async () => {
    const src = await fixturePdf();
    const notes = notesFile([{ id: 'p1', kind: 'slide', slide: 1, strokes: [pen('a', [[40, 40], [200, 120], [560, 360]])] }]);
    const classic = lastStream((await PDFDocument.load(await exportAnnotatedPdf(src, notes))).getPage(0));
    const free = lastStream((await PDFDocument.load(await exportAnnotatedPdf(src, notes, { outline: 'freehand' }))).getPage(0));
    expect(free).not.toBe(classic);
    expect(free).toMatch(/\nf\n/);
  });

  it('never writes non-finite numbers: out-of-range strokes are skipped with a warning', async () => {
    const src = await fixturePdf();
    const notes = notesFile([
      { id: 'p1', kind: 'slide', slide: 1, strokes: [
        pen('ok', [[40, 40], [200, 120]]),
        pen('far', [[1e306, 40], [200, 120]]),
        hl('fat', [[40, 40], [200, 120]], '#ffd200', 1e300),
        pen('one', [[300, 300]]),
      ] },
      { id: 'b-t-1', kind: 'blank', after: 1, paper: 'grid', strokes: [pen('dot', [[10, 10], [10, 10]])] },
    ]);
    const { bytes, warnings } = await exportAnnotatedPdfWithReport(src, notes);
    expect(warnings.filter(w => /malformed stroke/.test(w))).toHaveLength(2);
    const out = await PDFDocument.load(bytes);
    for (const i of [0, 1]) expect(lastStream(out.getPage(i))).not.toMatch(/NaN|Infinity|e\+/);
    expect((lastStream(out.getPage(0)).match(/\nf\n/g) || []).length).toBe(2); // ok and the one-point dot
  });

  it('a blank page after a page without width or height gets no endless paper rules', () => {
    for (const paper of ['lined', 'grid'] as const) {
      for (const size of [[0, 792], [612, 0], [0, 0], [NaN, 792]] as [number, number][]) {
        const ops = paperOperators(paper, size);
        expect(ops.length).toBeLessThan(10);
        expect(ops.join(' ')).not.toMatch(/NaN|Infinity/);
      }
    }
  });
});

// A real lecture PDF of your own (INKSLIDE_FIXTURE_PDF); skipped without one.
const FIXTURE = process.env.INKSLIDE_FIXTURE_PDF || '';

describe.skipIf(!existsSync(FIXTURE))('real lecture PDF', () => {
  it('exports with notes and keeps the text', async () => {
    const src = new Uint8Array(readFileSync(FIXTURE));
    const orig = await PDFDocument.load(src);
    const n = orig.getPageCount();
    const [w, h] = displaySize(orig.getPage(0).getCropBox(), orig.getPage(0).getRotation().angle);
    const notes = notesFile([
      { id: 'p1', kind: 'slide', slide: 1, strokes: [pen('a', [[w * 0.1, h * 0.1], [w * 0.9, h * 0.9]]), hl('h', [[w * 0.1, h * 0.5], [w * 0.6, h * 0.5]])] },
      { id: 'b-r-1', kind: 'blank', after: 2, paper: 'lined', strokes: [pen('b', [[50, 50], [300, 200]])] },
      { id: `p${n}`, kind: 'slide', slide: n, strokes: [pen('z', [[w / 2, h / 2], [w / 2 + 50, h / 2]])] },
    ], n);
    const { bytes, pageCount } = await exportAnnotatedPdfWithReport(src, notes);
    expect(pageCount).toBe(n + 1);
    const before = await pageTexts(src);
    const after = await pageTexts(bytes);
    expect(after.length).toBe(n + 1);
    expect([after[0], after[1], ...after.slice(3)]).toEqual(before);
    expect(after[2]).toBe('');
  }, 60_000);
});
