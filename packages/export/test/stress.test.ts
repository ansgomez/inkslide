/* Stress: an A4 PDF written on with every tool across many pages (page
 * turns, then page 2 again), saved, loaded and exported. Nothing may throw,
 * no number may be non-finite, and the notes must round-trip. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { NotesDoc } from '@inkslide/annotate/model';
import { deckFromPdf, loadNotesText, parseNotes, serializeNotes } from '@inkslide/annotate/io';
import { createTools, DEFAULT_PREFS, type Prefs, type Selection, type Surface, type ToolHost, type ToolRenderer } from '@inkslide/annotate/tools';
import { pageUnit, type Layer } from '@inkslide/annotate/render';
import type { Point } from '@inkslide/annotate/geometry';
import { exportAnnotatedPdfWithReport } from '../src/export';

const A4: [number, number] = [595.28, 841.89];
const PAGES = 6;

const finiteDeep = (v: unknown): boolean =>
  typeof v === 'number' ? Number.isFinite(v) : Array.isArray(v) ? v.every(finiteDeep)
    : v && typeof v === 'object' ? Object.values(v).every(finiteDeep) : true;

const noop: ToolRenderer = {
  liveStroke: () => ({ update() {}, remove() {} }), syncLayer() {}, setEraserCursor() {}, translateStrokes() {},
  setSelectionBox() {}, setMarquee() {}, laser: () => ({ add() {} }),
};

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterAll(() => vi.unstubAllGlobals());

describe('stress: A4 PDF, many strokes on many pages', () => {
  it('draws, erases, moves and turns pages without errors; notes round-trip and export cleanly', async () => {
    const src = await PDFDocument.create();
    for (let i = 0; i < PAGES; i++) src.addPage(A4);
    const pdfBytes = await src.save();

    const doc = new NotesDoc(deckFromPdf({ title: 'a4.pdf', pageSizes: Array.from({ length: PAGES }, () => A4), sha256: 'a4' }));
    const prefs: Prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));
    const app: ToolHost = {
      doc, prefs, selection: null as Selection | null,
      select(sel) { app.selection = sel ? { pageId: sel.pageId, ids: sel.ids.slice(), box: { minX: 0, minY: 0, maxX: A4[0], maxY: A4[1] } } : null; },
      surfaces: [], sync: null,
    };
    const tools = createTools(app, noop);
    const surfaces = new Map<string, Surface>();
    const surface = (pageId: string): Surface => {
      let s = surfaces.get(pageId);
      if (!s) surfaces.set(pageId, s = { pageId, svg: {} as SVGSVGElement, layer: { unit: pageUnit(doc.pageSize(pageId)) } as Layer });
      return s;
    };
    let seed = 7;
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const gesture = (tool: keyof typeof tools, pageId: string, n: number, opts: { up?: boolean; dup?: boolean } = {}): void => {
      const s = surface(pageId), t = tools[tool];
      let x = rnd() * A4[0], y = rnd() * A4[1];
      t.down?.(s, [x, y, rnd()]);
      for (let i = 0; i < n; i++) {
        if (!opts.dup || rnd() > 0.5) { x += (rnd() - 0.5) * 40; y += (rnd() - 0.5) * 40; } // repeats: zero-length segments
        t.move?.(s, [x, y, [0, 1, rnd()][i % 3]] as Point);
      }
      // up with a point, or ended by a page turn / blur (pt null)
      t.up?.(s, opts.up === false ? null : [x, y, 0]);
    };

    // Several annotations on every page, turning pages in between.
    for (let round = 0; round < 3; round++) {
      for (let n = 1; n <= PAGES; n++) {
        const id = `p${n}`;
        for (let k = 0; k < 8; k++) gesture(k % 3 ? 'pen' : 'highlighter', id, k === 0 ? 0 : 5 + k * 4, { dup: k % 2 === 0, up: k !== 3 });
        gesture('laser', id, 10);
        if (round > 0) gesture('partial', id, 6);
        if (round > 1) gesture('eraser', id, 2);
      }
    }
    // Back to page 2: draw, select everything and move it, draw more.
    const blank = doc.insertBlankPage('p2', 'lined').pageId;
    for (const id of ['p2', blank, 'p2']) {
      for (let k = 0; k < 10; k++) gesture('pen', id, 20 + k);
      const s = surface(id);
      tools.selector.down!(s, [1, 1, 0.5]);
      tools.selector.move!(s, [A4[0] - 1, A4[1] - 1, 0.5]);
      tools.selector.up!(s, [A4[0] - 1, A4[1] - 1, 0.5]);
      tools.selector.down!(s, [A4[0] / 2, A4[1] / 2, 0.5]);
      tools.selector.move!(s, [A4[0] / 2 + 13, A4[1] / 2 - 7, 0.5]);
      tools.selector.up!(s, [A4[0] / 2 + 13, A4[1] / 2 - 7, 0.5]);
      gesture('partial', id, 8);
    }
    for (let i = 0; i < 20; i++) doc.undo();
    for (let i = 0; i < 10; i++) doc.redo();

    const total = doc.sequence().reduce((sum, id) => sum + doc.strokes(id).length, 0);
    expect(total).toBeGreaterThan(PAGES * 10);
    expect(doc.strokes('p2').length).toBeGreaterThan(10);

    // Save, load, save again: identical, and only finite numbers.
    const text = serializeNotes(doc);
    expect(finiteDeep(parseNotes(text))).toBe(true);
    const again = new NotesDoc(deckFromPdf({ title: 'a4.pdf', pageSizes: Array.from({ length: PAGES }, () => A4), sha256: 'a4' }));
    const { warnings } = loadNotesText(again, text);
    expect(warnings).toEqual([]);
    expect(serializeNotes(again)).toBe(text);

    // Export: one page more (the blank one), no non-finite operator anywhere.
    const { bytes, warnings: exportWarnings, pageCount } = await exportAnnotatedPdfWithReport(pdfBytes, parseNotes(text));
    expect(exportWarnings).toEqual([]);
    expect(pageCount).toBe(PAGES + 1);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(PAGES + 1);
    let streams = 0;
    for (const [, obj] of out.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const content = new TextDecoder('latin1').decode(decodePDFRawStream(obj).decode());
      if (/ m\n/.test(content)) streams++;
      expect(content).not.toMatch(/NaN|Infinity/);
    }
    expect(streams).toBeGreaterThanOrEqual(PAGES);
  });
});
