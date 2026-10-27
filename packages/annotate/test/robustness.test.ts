// @vitest-environment happy-dom
/* Non-finite and degenerate geometry never enters the model, the notes file
 * or the export; a failing tool or change listener never leaves the input
 * or the autosave stuck. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_COORD, NotesDoc, createStroke, type NotesJSON } from '../src/model';
import { deckFromPdf, loadNotesText, parseNotes, serializeNotes } from '../src/io';
import { attachInput, type InputHost } from '../src/input';
import { createTools, DEFAULT_PREFS, type Prefs, type Selection, type Surface, type ToolHost, type ToolRenderer } from '../src/tools';
import { createAutosave } from '../src/autosave';
import { pageUnit, type Layer } from '../src/render';
import type { Point, Stroke } from '../src/geometry';

const A4: [number, number] = [595.28, 841.89];
const pdfDoc = (pages = 3) => new NotesDoc(deckFromPdf({ title: 'a4.pdf', pageSizes: Array.from({ length: pages }, () => A4), sha256: 'x' }));
const pts: Point[] = [[10, 10, 0.5], [50, 60, 0.5]];
const stroke = (id: string, points: Point[] = pts): Stroke => createStroke({ id, tool: 'pen', color: '#000', size: 4, points });
const finiteDeep = (v: unknown): boolean =>
  typeof v === 'number' ? Number.isFinite(v) : Array.isArray(v) ? v.every(finiteDeep)
    : v && typeof v === 'object' ? Object.values(v).every(finiteDeep) : true;

afterEach(() => vi.restoreAllMocks());

describe('createStroke keeps degenerate geometry out', () => {
  it('rejects infinite and absurd sizes and coordinates, and empty strokes', () => {
    const base = { tool: 'pen', color: '#000' };
    expect(() => createStroke({ ...base, size: Infinity, points: pts })).toThrow(/size/);
    expect(() => createStroke({ ...base, size: 1e300, points: pts })).toThrow(/size/);
    expect(() => createStroke({ ...base, size: 4, points: [[1e306, 0, 0.5]] })).toThrow(/range/);
    expect(() => createStroke({ ...base, size: 4, points: [[0, -(MAX_COORD + 1), 0.5]] })).toThrow(/range/);
    expect(() => createStroke({ ...base, size: 4, points: [] })).toThrow(/no points/);
    expect(createStroke({ ...base, size: 4, points: [[MAX_COORD, -MAX_COORD, 0.5]] }).points).toHaveLength(1);
  });

  it('clamps pressure to 0..1', () => {
    const s = createStroke({ tool: 'pen', color: '#000', size: 4, points: [[0, 0, 7], [1, 1, -2], [2, 2, 0.3]] });
    expect(s.points.map(p => p[2])).toEqual([1, 0, 0.3]);
  });

  it('a notes file with an out-of-range point loads without it, and saves only finite numbers', () => {
    const doc = pdfDoc();
    const file: NotesJSON = {
      format: 'marp-notes', version: 2, deck: doc.toJSON().deck,
      pages: [{ id: 'p2', kind: 'slide', slide: 2, strokes: [
        { id: 'ok', tool: 'pen', color: '#000', size: 4, points: pts },
        { id: 'far', tool: 'pen', color: '#000', size: 4, points: [[1e306, 5, 0.5], [0, 0, 0.5]] },
        { id: 'fat', tool: 'highlighter', color: '#000', size: 1e300, points: pts },
      ] }],
    };
    const { warnings } = loadNotesText(doc, JSON.stringify(file));
    expect(doc.strokes('p2').map(s => s.id)).toEqual(['ok']);
    expect(warnings.filter(w => /malformed stroke/.test(w))).toHaveLength(2);
    const text = serializeNotes(doc);
    expect(text).not.toMatch(/null/);
    expect(finiteDeep(parseNotes(text))).toBe(true);
  });
});

describe('NotesDoc edits never store non-finite geometry', () => {
  it('moveStrokes with a non-finite offset changes nothing', () => {
    const doc = pdfDoc();
    doc.addStroke('p1', stroke('a'));
    const before = doc.strokes('p1');
    expect(doc.moveStrokes('p1', ['a'], NaN, 3)).toBeNull();
    expect(doc.moveStrokes('p1', ['a'], 0, Infinity)).toBeNull();
    expect(doc.strokes('p1')).toBe(before);
    expect(doc.history.undoStack).toHaveLength(1);
  });

  it('a stroke with NaN points or size is refused before the page changes', () => {
    const doc = pdfDoc();
    doc.addStroke('p1', stroke('a'));
    const bad = { ...stroke('b'), points: [[NaN, 1, 0.5]] as Point[] };
    expect(() => doc.addStroke('p1', bad)).toThrow(/finite/);
    expect(() => doc.restyleStrokes('p1', ['a'], { size: NaN })).toThrow(/size/);
    expect(() => doc.restyleStrokes('p1', ['a'], { size: () => 0 })).toThrow(/size/);
    expect(doc.strokes('p1').map(s => [s.id, s.size])).toEqual([['a', 4]]);
    expect(doc.history.undoStack).toHaveLength(1);
    expect(finiteDeep(doc.toJSON())).toBe(true);
  });
});

describe('change listeners', () => {
  it('a throwing listener does not stop the others, the undo step or the autosave', async () => {
    const doc = pdfDoc();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    doc.onChange(() => { throw new Error('render failed'); });
    const writes: string[] = [];
    const saver = createAutosave({ doc, serialize: () => serializeNotes(doc), write: async t => { writes.push(t); }, delayMs: 10_000 });
    doc.addStroke('p2', stroke('a'));
    expect(doc.history.undoStack).toHaveLength(1);
    expect(doc.isDirty()).toBe(true);
    expect(saver.state).toBe('dirty');
    await saver.flush();
    expect(JSON.parse(writes[0]).pages[0].strokes[0].id).toBe('a');
    expect(errors).toHaveBeenCalled();
    saver.dispose();
  });

  it('a throwing history listener does not lose the command', () => {
    const doc = pdfDoc();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    doc.history.onChange(() => { throw new Error('toolbar failed'); });
    doc.addStroke('p1', stroke('a'));
    expect(doc.strokes('p1')).toHaveLength(1);
    doc.undo();
    expect(doc.strokes('p1')).toHaveLength(0);
    expect(doc.history.redoStack).toHaveLength(1);
  });
});

describe('input survives a failing tool', () => {
  function setup(fail: 'down' | 'move' | 'up') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    document.body.appendChild(svg);
    (svg as unknown as { getScreenCTM(): DOMMatrix }).getScreenCTM = () => new DOMMatrix();
    const released: number[] = [];
    svg.setPointerCapture = () => {};
    svg.releasePointerCapture = id => { released.push(id); };
    const surface: Surface = { pageId: 'p1', svg, layer: {} as Layer };
    const boom = () => { throw new Error(`${fail} failed`); };
    const pen = {
      id: 'pen' as const, down: vi.fn(), move: vi.fn(), up: vi.fn(), cancel: vi.fn(), leave: vi.fn(), [fail]: vi.fn(boom),
    };
    const host: InputHost = { enabled: true, tools: { eraser: { id: 'eraser' } }, currentTool: () => pen };
    const input = attachInput(host, [surface]);
    const fire = (type: string, init: PointerEventInit = {}) =>
      svg.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 3, pointerType: 'pen', buttons: 1, clientX: 5, clientY: 5, ...init }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { input, fire, pen, released, errors };
  }

  it('a throwing down ends the gesture: not busy, tool cancelled, capture released', () => {
    const { input, fire, pen, released, errors } = setup('down');
    fire('pointerdown');
    expect(input.busy).toBe(false);
    expect(pen.cancel).toHaveBeenCalledTimes(1);
    expect(released).toEqual([3]);
    expect(errors).toHaveBeenCalledTimes(1);
    fire('pointermove');
    expect(pen.move).not.toHaveBeenCalled();
  });

  it('a throwing move ends the gesture instead of repeating the error for every point', () => {
    const { input, fire, pen, errors } = setup('move');
    fire('pointerdown');
    fire('pointermove', { clientX: 9 });
    fire('pointermove', { clientX: 12 });
    expect(input.busy).toBe(false);
    expect(pen.move).toHaveBeenCalledTimes(1);
    expect(pen.cancel).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('a throwing up resets the tool, and cancel() (page turn, undo, blur) never throws', () => {
    const { input, fire, pen } = setup('up');
    fire('pointerdown');
    expect(() => input.cancel()).not.toThrow();
    expect(input.busy).toBe(false);
    expect(pen.cancel).toHaveBeenCalledTimes(1);
    fire('pointerdown');
    expect(() => fire('pointerup')).not.toThrow();
    expect(input.busy).toBe(false);
    expect(pen.cancel).toHaveBeenCalledTimes(2);
  });
});

describe('tools with a real NotesDoc', () => {
  const noop: ToolRenderer = {
    liveStroke: () => ({ update() {}, remove() {} }), syncLayer() {}, setEraserCursor() {}, translateStrokes() {},
    setSelectionBox() {}, setMarquee() {}, laser: () => ({ add() {} }),
  };
  function host(doc: NotesDoc): ToolHost {
    const prefs: Prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));
    const h: ToolHost = {
      doc, prefs, selection: null as Selection | null,
      select(sel) { h.selection = sel ? { pageId: sel.pageId, ids: sel.ids.slice(), box: { minX: 0, minY: 0, maxX: 600, maxY: 850 } } : null; },
      surfaces: [], sync: null,
    };
    return h;
  }
  const surf = (pageId: string, unit: number): Surface => ({ pageId, svg: {} as SVGSVGElement, layer: { unit } as Layer });

  it('a page with a broken tool scale still draws strokes of a sane size', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const doc = pdfDoc();
    const tools = createTools(host(doc), noop);
    for (const [i, unit] of [NaN, 0, -1, Infinity].entries()) {
      const s = surf('p1', unit);
      tools.pen.down!(s, [10, 10 + i, 0.5]);
      tools.pen.move!(s, [40, 30 + i, 0.5]);
      tools.pen.up!(s, [60, 50 + i, 0.5]);
    }
    const sizes = doc.strokes('p1').map(s => s.size);
    expect(sizes).toHaveLength(4);
    expect(sizes.every(v => Number.isFinite(v) && v > 0)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('a stroke whose blank page was deleted mid-gesture is dropped without an error', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    for (const id of ['pen', 'eraser', 'partial'] as const) {
      const doc = pdfDoc();
      const t = createTools(host(doc), noop)[id];
      const blank = doc.insertBlankPage('p1').pageId;
      doc.addStroke(blank, stroke('a'));
      const s = surf(blank, pageUnit(A4));
      t.down!(s, [10, 10, 0.5]);
      t.move!(s, [40, 30, 0.5]);
      doc.deletePage(blank); // the delete button while the pen is down
      expect(() => t.up!(s, null)).not.toThrow();
      expect(doc.getPage(blank)).toBeNull();
      expect(doc.history.top()!.label).toBe('delete-page');
    }
    vi.unstubAllGlobals();
  });

  it('an eraser does not bring back strokes cleared or deleted mid-gesture', () => {
    for (const id of ['eraser', 'partial'] as const) {
      const doc = pdfDoc();
      const t = createTools(host(doc), noop)[id];
      doc.addStroke('p1', stroke('a'));
      doc.addStroke('p1', stroke('b', [[300, 300, 0.5], [350, 300, 0.5]]));
      const s = surf('p1', pageUnit(A4));
      t.down!(s, [30, 35, 0.5]); // erases a
      doc.clearPage('p1'); // Clear page while the pen is down
      t.up!(s, null);
      expect(doc.strokes('p1')).toEqual([]);
      expect(doc.history.top()!.label).toBe('clear');
    }
  });
});
