import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTools, DEFAULT_PREFS, SIZES, TOOLS, type Prefs, type Selection, type Surface, type ToolHost, type ToolRenderer } from '../src/tools';
import type { NotesDoc } from '../src/model';
import { pageUnit, type Layer } from '../src/render';
import { loadPrefs } from '../src/app';
import type { Point, Stroke } from '../src/geometry';

/** A NotesDoc stand-in that records the commands the tools issue. */
class FakeDoc {
  pages = new Map<string, Stroke[]>();
  calls: { method: string; pageId: string; args: unknown[] }[] = [];
  strokes(pageId: string): Stroke[] { return this.pages.get(pageId) || []; }
  hasPage(_pageId: string): boolean { return true; }
  addStroke(pageId: string, s: Stroke) {
    this.calls.push({ method: 'addStroke', pageId, args: [s] });
    this.pages.set(pageId, [...this.strokes(pageId), s]);
    return {};
  }
  replaceStrokes(pageId: string, after: Stroke[], label: string) {
    this.calls.push({ method: 'replaceStrokes', pageId, args: [after, label] });
    this.pages.set(pageId, after.slice());
    return {};
  }
  moveStrokes(pageId: string, ids: string[], dx: number, dy: number) {
    this.calls.push({ method: 'moveStrokes', pageId, args: [ids, dx, dy] });
    return dx || dy ? {} : null;
  }
}

function fakeRenderer() {
  const log: string[] = [];
  const live = { update: vi.fn(), remove: vi.fn() };
  const laserAdd = vi.fn();
  const r: ToolRenderer = {
    liveStroke: (_l, tool) => { log.push(`live:${tool}`); return live; },
    syncLayer: (_l, strokes) => { log.push(`sync:${strokes.map(s => s.id).join(',')}`); },
    setEraserCursor: (_l, pt) => { log.push(pt ? 'cursor' : 'cursor:off'); },
    translateStrokes: (_l, ids, dx, dy) => { log.push(`translate:${ids.join(',')}:${dx},${dy}`); },
    setSelectionBox: (_l, box) => { log.push(box ? 'box' : 'box:off'); },
    setMarquee: (_l, poly) => { log.push(poly ? `marquee:${poly.length}` : 'marquee:off'); },
    laser: () => ({ add: laserAdd }),
  };
  return { r, log, live, laserAdd };
}

const mk = (id: string, points: Point[], tool: Stroke['tool'] = 'pen', size = 4): Stroke =>
  ({ id, tool, color: '#000', size, points });
const hline = (id: string, y: number, x0 = 0, x1 = 100): Stroke =>
  mk(id, Array.from({ length: (x1 - x0) / 10 + 1 }, (_, i) => [x0 + i * 10, y, 0.5] as Point));

let doc: FakeDoc;
let app: ToolHost & { selected: unknown[] };
let R: ReturnType<typeof fakeRenderer>;
const surface: Surface = { pageId: 'p1', svg: {} as SVGSVGElement, layer: { unit: 1 } as Layer };

beforeEach(() => {
  doc = new FakeDoc();
  R = fakeRenderer();
  const prefs: Prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));
  app = {
    doc: doc as unknown as NotesDoc,
    prefs,
    selection: null as Selection | null,
    selected: [],
    select(sel) {
      this.selected.push(sel);
      this.selection = sel ? { pageId: sel.pageId, ids: sel.ids.slice(), box: { minX: 0, minY: 0, maxX: 100, maxY: 10 } } : null;
    },
    surfaces: [surface],
    sync: null,
  };
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

describe('registry', () => {
  it('has a tool for every TOOLS entry', () => {
    const tools = createTools(app, R.r);
    for (const t of TOOLS) expect(tools[t.id].id).toBe(t.id);
  });
});

describe('pen and highlighter', () => {
  it('draw a smoothed stroke as one addStroke on release', () => {
    const { pen } = createTools(app, R.r);
    pen.down!(surface, [0, 0, 0.4]);
    pen.move!(surface, [10, 0, 0.6]);
    pen.move!(surface, [20, 0, 0.8]);
    expect(R.live.update).toHaveBeenCalled();
    expect(doc.calls).toEqual([]);
    pen.up!(surface, [30, 0, 0]);
    expect(R.live.remove).toHaveBeenCalled();
    expect(doc.calls.length).toBe(1);
    const s = doc.calls[0].args[0] as Stroke;
    expect(s).toMatchObject({ tool: 'pen', color: '#000000', size: SIZES.pen[1] });
    expect(s.points[0]).toEqual([0, 0, 0.4]);
    // release pressure 0 is replaced by the last real pressure
    expect(s.points[s.points.length - 1]).toEqual([30, 0, 0.8]);
  });

  it('Shift draws a straight line', () => {
    const { highlighter } = createTools(app, R.r);
    highlighter.down!(surface, [0, 0, 0.5], { shiftKey: true });
    highlighter.move!(surface, [10, 30, 0.5], { shiftKey: true });
    highlighter.up!(surface, [50, 50, 0.5], { shiftKey: true });
    const s = doc.calls[0].args[0] as Stroke;
    expect(s.tool).toBe('highlighter');
    expect(s.color).toBe('#ffd200');
    expect(s.points).toEqual([[0, 0, 0.5], [50, 50, 0.5]]);
  });

  it('uses the current prefs', () => {
    app.prefs.pen = { color: '#be1e3c', size: 3 };
    const { pen } = createTools(app, R.r);
    pen.down!(surface, [0, 0, 0.5]);
    pen.up!(surface, null);
    expect(doc.calls[0].args[0]).toMatchObject({ color: '#be1e3c', size: 12 });
  });

  it('scales the size to the page (A4: 0.70 of a slide)', () => {
    const a4: Surface = { pageId: 'p2', svg: {} as SVGSVGElement, layer: { unit: pageUnit([595, 842]) } as Layer };
    const { pen } = createTools(app, R.r);
    pen.down!(a4, [0, 0, 0.5]);
    pen.up!(a4, null);
    expect((doc.calls[0].args[0] as Stroke).size).toBeCloseTo(SIZES.pen[1] * 0.702, 3);
  });

  it('cancel drops the stroke', () => {
    const { pen } = createTools(app, R.r);
    pen.down!(surface, [0, 0, 0.5]);
    pen.cancel!(surface);
    pen.up!(surface, [1, 1, 0.5]);
    expect(doc.calls).toEqual([]);
    expect(R.live.remove).toHaveBeenCalledTimes(1);
  });
});

describe('erasers', () => {
  it('stroke eraser removes whole strokes in one command', () => {
    doc.pages.set('p1', [hline('a', 0), hline('b', 50), hline('c', 100)]);
    const { eraser } = createTools(app, R.r);
    eraser.down!(surface, [50, -30, 0.5]);
    eraser.move!(surface, [50, 60, 0.5]); // crosses a and b
    expect(R.log).toContain('sync:c');
    expect(doc.calls).toEqual([]);
    eraser.up!(surface, null);
    expect(doc.calls.length).toBe(1);
    expect(doc.calls[0].args[1]).toBe('erase');
    expect((doc.calls[0].args[0] as Stroke[]).map(s => s.id)).toEqual(['c']);
  });

  it('partial eraser splits a stroke into new strokes', () => {
    doc.pages.set('p1', [hline('a', 0)]);
    app.prefs.partial.size = 0; // radius 8
    const { partial } = createTools(app, R.r);
    partial.down!(surface, [50, 0, 0.5]);
    partial.up!(surface, null);
    const [after, label] = doc.calls[0].args as [Stroke[], string];
    expect(label).toBe('partial-erase');
    expect(after.length).toBe(2);
    expect(after.every(s => s.id !== 'a' && s.tool === 'pen' && s.color === '#000')).toBe(true);
  });

  it('the radius scales with the page', () => {
    doc.pages.set('p1', [hline('a', 0)]);
    const small: Surface = { ...surface, layer: { unit: 0.5 } as Layer };
    app.prefs.eraser.size = 0; // radius 8, 4 on this page
    const { eraser } = createTools(app, R.r);
    eraser.down!(small, [50, 8, 0.5]);
    eraser.up!(small, null);
    expect((doc.calls[0].args[0] as Stroke[]).map(s => s.id)).toEqual(['a']); // missed: 8 > 4 + half the pen width
    eraser.down!(surface, [50, 8, 0.5]);
    eraser.up!(surface, null);
    expect(doc.calls[1].args[0]).toEqual([]); // a slide page: radius 8 reaches it
  });

  it('cancel restores the page and commits nothing', () => {
    doc.pages.set('p1', [hline('a', 0)]);
    const { eraser } = createTools(app, R.r);
    eraser.down!(surface, [50, 500, 0.5]);
    eraser.cancel!(surface);
    eraser.up!(surface, null);
    expect(doc.calls).toEqual([]);
    expect(R.log).toEqual(['cursor', 'sync:a', 'cursor:off']);
  });

  it('shows and hides the cursor on hover, leave and deactivate', () => {
    const { eraser } = createTools(app, R.r);
    eraser.hover!(surface, [1, 1, 0.5]);
    eraser.leave!(surface);
    eraser.deactivate!();
    expect(R.log).toEqual(['cursor', 'cursor:off', 'cursor:off']);
  });
});

describe('selector', () => {
  it('a tap selects the topmost stroke under the pointer', () => {
    doc.pages.set('p1', [hline('a', 0), hline('b', 2)]);
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [50, 1, 0.5]);
    selector.up!(surface, [50, 1, 0.5]);
    expect(app.selection).toMatchObject({ pageId: 'p1', ids: ['b'] });
  });

  it('a drag selects with a rectangle', () => {
    doc.pages.set('p1', [hline('a', 0, 0, 40), hline('b', 50, 0, 40), hline('c', 200)]);
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [-10, -10, 0.5]);
    selector.move!(surface, [60, 70, 0.5]);
    expect(R.log).toContain('marquee:4');
    selector.up!(surface, [60, 70, 0.5]);
    expect(R.log).toContain('marquee:off');
    expect(app.selection!.ids).toEqual(['a', 'b']);
  });

  it('a circle selects with a lasso', () => {
    doc.pages.set('p1', [hline('a', 0, 0, 20), hline('far', 0, 300, 320)]);
    const { selector } = createTools(app, R.r);
    const circle: Point[] = [];
    for (let k = 0; k <= 20; k++) {
      const a = (k / 20) * 2 * Math.PI;
      circle.push([10 + 40 * Math.cos(a), 40 * Math.sin(a), 0.5]);
    }
    selector.down!(surface, circle[0]);
    for (const p of circle.slice(1)) selector.move!(surface, p);
    selector.up!(surface, null);
    expect(app.selection!.ids).toEqual(['a']);
  });

  it('empty selection clears it', () => {
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [5, 5, 0.5]);
    selector.up!(surface, [5, 5, 0.5]);
    expect(app.selection).toBeNull();
  });

  it('dragging inside the selection moves its strokes in one command', () => {
    doc.pages.set('p1', [hline('a', 0)]);
    app.select({ pageId: 'p1', ids: ['a'] });
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [50, 5, 0.5]);
    selector.move!(surface, [60, 25, 0.5]);
    expect(R.log).toContain('translate:a:10,20');
    selector.up!(surface, [60, 25, 0.5]);
    expect(doc.calls).toEqual([{ method: 'moveStrokes', pageId: 'p1', args: [['a'], 10, 20] }]);
  });

  it('a move without offset resets the preview; cancel undoes the preview', () => {
    doc.pages.set('p1', [hline('a', 0)]);
    app.select({ pageId: 'p1', ids: ['a'] });
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [50, 5, 0.5]);
    selector.up!(surface, [50, 5, 0.5]);
    expect(R.log).toContain('translate:a:0,0');
    R.log.length = 0;
    selector.down!(surface, [50, 5, 0.5]);
    selector.move!(surface, [70, 5, 0.5]);
    selector.cancel!(surface);
    expect(R.log.slice(-3)).toEqual(['translate:a:0,0', 'box', 'marquee:off']);
  });

  it('a selection dropped mid-drag (Escape, Delete) ends the move without a command', () => {
    doc.pages.set('p1', [hline('a', 0)]);
    app.select({ pageId: 'p1', ids: ['a'] });
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [50, 5, 0.5]);
    selector.move!(surface, [60, 25, 0.5]);
    app.select(null);
    R.log.length = 0;
    expect(() => selector.move!(surface, [70, 30, 0.5])).not.toThrow();
    expect(R.log).toEqual(['translate:a:0,0']);
    expect(() => selector.up!(surface, [70, 30, 0.5])).not.toThrow();
    expect(doc.calls).toEqual([]);
  });

  it('deactivate clears the selection', () => {
    app.select({ pageId: 'p1', ids: ['a'] });
    createTools(app, R.r).selector.deactivate!();
    expect(app.selection).toBeNull();
  });
});

describe('laser', () => {
  it('traces without touching the document and mirrors to sync', () => {
    const sync = { laser: vi.fn() };
    app.sync = sync;
    const { laser } = createTools(app, R.r);
    laser.hover!(surface, [1, 2, 0.5]);
    laser.down!(surface, [3, 4, 0.5]);
    laser.move!(surface, [5, 6, 0.5]);
    expect(R.laserAdd).toHaveBeenCalledTimes(3);
    expect(sync.laser).toHaveBeenLastCalledWith('p1', [5, 6, 0.5]);
    expect(doc.calls).toEqual([]);
  });
});

describe('loadPrefs', () => {
  const stored = (v: unknown) => ({ getItem: () => JSON.stringify(v) });

  it('merges stored prefs over the defaults', () => {
    const { prefs, tool } = loadPrefs(stored({ tool: 'highlighter', prefs: { pen: { color: '#be1e3c', size: 3 } } }));
    expect(tool).toBe('highlighter');
    expect(prefs.pen).toEqual({ color: '#be1e3c', size: 3 });
    expect(prefs.eraser).toEqual(DEFAULT_PREFS.eraser);
  });

  it('ignores sizes and colors that are not valid (shared key, other writers)', () => {
    const { prefs, tool } = loadPrefs(stored({ tool: 'bogus', prefs: { pen: { size: 5, color: 3 }, eraser: { size: '2' }, partial: { size: 1.5 } } }));
    expect(tool).toBe('pen');
    expect(prefs.pen).toEqual(DEFAULT_PREFS.pen);
    expect(prefs.eraser).toEqual(DEFAULT_PREFS.eraser);
    expect(prefs.partial).toEqual(DEFAULT_PREFS.partial);
    expect(loadPrefs({ getItem: () => '{broken' }).prefs).toEqual(DEFAULT_PREFS);
  });
});
