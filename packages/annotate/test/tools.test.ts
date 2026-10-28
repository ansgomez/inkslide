import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTools, DEFAULT_PREFS, nextSize, SIZE_PRESETS, SIZES, TOOLS, type Prefs, type Selection, type Surface, type ToolHost, type ToolRenderer } from '../src/tools';
import type { NotesDoc, PageImage } from '../src/model';
import { pageUnit, type Layer } from '../src/render';
import { loadPrefs, nearestPreset } from '../src/app';
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
  imgs = new Map<string, PageImage[]>();
  images(pageId: string): PageImage[] { return this.imgs.get(pageId) || []; }
  replaceStrokes(pageId: string, after: Stroke[], label: string) {
    this.calls.push({ method: 'replaceStrokes', pageId, args: [after, label] });
    this.pages.set(pageId, after.slice());
    return {};
  }
  /** Recorded as [strokes, label, images]. */
  replaceContent(pageId: string, after: { strokes: Stroke[]; images?: PageImage[] }, label: string) {
    this.calls.push({ method: 'replaceContent', pageId, args: [after.strokes, label, after.images] });
    this.pages.set(pageId, after.strokes.slice());
    if (after.images) this.imgs.set(pageId, after.images.slice());
    return {};
  }
  moveItems(pageId: string, ids: string[], dx: number, dy: number) {
    this.calls.push({ method: 'moveItems', pageId, args: [ids, dx, dy] });
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
    expect(s).toMatchObject({ tool: 'pen', color: '#000000', size: 4 }); // M
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
    app.prefs.pen = { color: '#be1e3c', size: 7 }; // XL
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
    expect((doc.calls[0].args[0] as Stroke).size).toBeCloseTo(4 * 0.702, 3);
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
    app.prefs.partial.size = 1; // radius 8
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
    app.prefs.eraser.size = 1; // radius 8, 4 on this page
    const { eraser } = createTools(app, R.r);
    eraser.down!(small, [50, 8, 0.5]);
    eraser.up!(small, null);
    expect((doc.calls[0].args[0] as Stroke[]).map(s => s.id)).toEqual(['a']); // missed: 8 > 4 + half the pen width
    eraser.down!(surface, [50, 8, 0.5]);
    eraser.up!(surface, null);
    expect(doc.calls[1].args[0]).toEqual([]); // a slide page: radius 8 reaches it
  });

  it('commits only what it erased: page changes made mid-gesture stay', () => {
    const d = mk('d', [[0, 200, 0.5]]);
    doc.pages.set('p1', [hline('a', 0), hline('b', 50), hline('c', 100), d]);
    const { eraser } = createTools(app, R.r);
    eraser.down!(surface, [50, -30, 0.5]);
    eraser.move!(surface, [50, 60, 0.5]); // crosses a and b
    // meanwhile (Delete selection, restyle, a new stroke from another window): c deleted, b restyled, e added
    const [a] = doc.strokes('p1');
    const b2 = { ...hline('b', 50), color: '#f00' };
    doc.pages.set('p1', [a, b2, d, hline('e', 300)]);
    eraser.up!(surface, null);
    // a erased; b changed meanwhile, so kept as it is now; c stays deleted; d and e kept
    expect((doc.calls[0].args[0] as Stroke[]).map(s => s.id)).toEqual(['b', 'd', 'e']);
    expect((doc.calls[0].args[0] as Stroke[])[0].color).toBe('#f00');
  });

  it('partial eraser: pieces replace their stroke in the page as it is on release', () => {
    doc.pages.set('p1', [hline('a', 0), hline('b', 50)]);
    app.prefs.partial.size = 0; // radius 8
    const { partial } = createTools(app, R.r);
    partial.down!(surface, [30, 0, 0.5]);
    partial.move!(surface, [70, 0, 0.5]);
    doc.pages.set('p1', [hline('z', 9), ...doc.strokes('p1')]); // added meanwhile, below
    partial.up!(surface, null);
    const after = doc.calls[0].args[0] as Stroke[];
    expect(after.map(s => s.id).slice(0, 1)).toEqual(['z']);
    expect(after.at(-1)!.id).toBe('b');
    expect(after.length).toBe(4); // z, two pieces of a, b
    expect(after.slice(1, 3).every(s => s.id !== 'a' && s.points.every(p => p[0] < 30 || p[0] > 70))).toBe(true);
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

  it('redraws the marquee once per frame, lasso or rectangle by the running path length', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn));
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [0, 0, 0.5]);
    for (let i = 1; i <= 2000; i++) selector.move!(surface, [i % 2 ? 100 : 0, i / 100, 0.5]); // zigzag: a lasso
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(R.log.filter(l => l.startsWith('marquee:'))).toEqual(['marquee:2001']);
    selector.move!(surface, [0, 21, 0.5]);
    selector.cancel!(surface);
    frames.shift()!(0); // a frame after cancel draws nothing
    expect(R.log.filter(l => l.startsWith('marquee:'))).toEqual(['marquee:2001', 'marquee:off']);
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
    expect(doc.calls).toEqual([{ method: 'moveItems', pageId: 'p1', args: [['a'], 10, 20] }]);
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

describe('nextSize', () => {
  it('steps along the scale and stops at its ends', () => {
    expect(nextSize('pen', 4, 1)).toBe(5.5);
    expect(nextSize('pen', 4, -1)).toBe(3);
    expect(nextSize('pen', 16, 1)).toBe(16);
    expect(nextSize('pen', 1, -1)).toBe(1);
  });

  it('works on page-scaled sizes and goes from between two steps to the next one', () => {
    expect(nextSize('highlighter', 20 * 0.75, 1, 0.75)).toBeCloseTo(26 * 0.75);
    expect(nextSize('pen', 5, 1)).toBe(5.5);
    expect(nextSize('pen', 5, -1)).toBe(4);
    expect(nextSize('pen', 40, -1)).toBe(16);
  });
});

describe('loadPrefs', () => {
  const stored = (v: unknown) => ({ getItem: () => JSON.stringify(v) });

  it('merges stored prefs over the defaults', () => {
    const { prefs, tool } = loadPrefs(stored({ tool: 'highlighter', prefs: { pen: { color: '#be1e3c', size: 2, step: 6 } } }));
    expect(tool).toBe('highlighter');
    expect(prefs.pen).toEqual({ color: '#be1e3c', size: 6 });
    expect(prefs.eraser).toEqual(DEFAULT_PREFS.eraser);
  });

  it('takes a stored color only if strokes can have it, as stored in strokes', () => {
    const { prefs } = loadPrefs(stored({ prefs: { pen: { color: 'oklch(0.5 0.2 30)' }, highlighter: { color: 'hsl(60 100% 50%)' } } }));
    expect(prefs.pen.color).toBe(DEFAULT_PREFS.pen.color);
    expect(prefs.highlighter.color).toBe('#ffff00');
  });

  it('prefs of earlier versions (a preset 0..3, no step) load at their preset', () => {
    const { prefs } = loadPrefs(stored({ prefs: { pen: { size: 0 }, highlighter: { size: 3 }, eraser: { size: 2 } } }));
    expect(SIZES.pen[prefs.pen.size]).toBe(2);
    expect(SIZES.highlighter[prefs.highlighter.size]).toBe(48);
    expect(SIZES.eraser[prefs.eraser.size]).toBe(32);
  });

  it('the scale keeps the four sizes of earlier versions at the preset steps', () => {
    const old = { pen: [2, 4, 7, 12], highlighter: [12, 20, 32, 48], eraser: [8, 16, 32, 64], partial: [8, 16, 32, 64] };
    for (const [tool, sizes] of Object.entries(old)) {
      expect(SIZE_PRESETS.map(i => SIZES[tool as keyof typeof SIZES][i])).toEqual(sizes);
      expect(SIZES[tool as keyof typeof SIZES].length).toBe(SIZES.pen.length);
    }
  });

  it('nearestPreset maps a step to S, M, L or XL', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(nearestPreset)).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 3]);
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

describe('images', () => {
  const pic = (id: string, x = 200, y = 200, w = 100, h = 50): PageImage => ({ id, x, y, w, h, src: 'data:image/png;base64,iVBORw0KGgo=' });
  const withSync = () => {
    const images: string[] = [];
    R.r.syncImages = (_l, list) => { images.push(list.map(i => i.id).join(',')); };
    return images;
  };

  it('the stroke eraser removes an image it touches when the gesture erases no ink', () => {
    doc.imgs.set('p1', [pic('i'), pic('far', 600, 600)]);
    const shown = withSync();
    const { eraser } = createTools(app, R.r);
    eraser.down!(surface, [250, 210, 0.5]);
    eraser.move!(surface, [260, 220, 0.5]);
    expect(shown).toEqual(['far']);
    eraser.up!(surface, null);
    expect(doc.calls).toHaveLength(1);
    expect((doc.calls[0].args[2] as PageImage[]).map(i => i.id)).toEqual(['far']);
  });

  it('erasing ink written on an image leaves the image, in one command', () => {
    doc.pages.set('p1', [hline('a', 220, 200, 300)]); // ink on image i
    doc.imgs.set('p1', [pic('i')]);
    const shown = withSync();
    const { eraser } = createTools(app, R.r);
    eraser.down!(surface, [250, 220, 0.5]);
    eraser.move!(surface, [260, 240, 0.5]);
    expect(shown).toEqual([]);
    eraser.up!(surface, null);
    expect(doc.calls).toHaveLength(1);
    expect(doc.calls[0].args[0]).toEqual([]);
    expect(doc.calls[0].args[2]).toBeUndefined(); // images untouched
    expect(doc.images('p1').map(i => i.id)).toEqual(['i']);
  });

  it('an image erased before the gesture reaches ink comes back', () => {
    doc.pages.set('p1', [hline('a', 240, 200, 300)]);
    doc.imgs.set('p1', [pic('i')]);
    const shown = withSync();
    const { eraser } = createTools(app, R.r);
    eraser.down!(surface, [210, 205, 0.5]); // on the image, away from the ink
    expect(shown).toEqual(['']);
    eraser.move!(surface, [250, 240, 0.5]); // now through the stroke
    expect(shown).toEqual(['', 'i']);
    eraser.up!(surface, null);
    expect(doc.calls[0].args[0]).toEqual([]);
    expect(doc.images('p1').map(i => i.id)).toEqual(['i']);
  });

  it('removes only the images it erased from the page as it is on release', () => {
    doc.imgs.set('p1', [pic('i')]);
    const { eraser } = createTools(app, R.r);
    eraser.down!(surface, [250, 225, 0.5]);
    doc.imgs.set('p1', [pic('i'), pic('new', 600, 600)]); // pasted meanwhile (another window)
    eraser.up!(surface, null);
    expect((doc.calls[0].args[2] as PageImage[]).map(i => i.id)).toEqual(['new']);
  });

  it('the partial eraser leaves images alone', () => {
    doc.imgs.set('p1', [pic('i')]);
    const { partial } = createTools(app, R.r);
    partial.down!(surface, [250, 225, 0.5]);
    partial.up!(surface, null);
    expect(doc.calls.every(c => c.args[2] === undefined)).toBe(true); // images not touched
    expect(doc.images('p1')).toHaveLength(1);
  });

  it('cancelling the eraser shows the images again', () => {
    doc.imgs.set('p1', [pic('i')]);
    const shown = withSync();
    const { eraser } = createTools(app, R.r);
    eraser.down!(surface, [250, 225, 0.5]);
    eraser.cancel!(surface);
    expect(shown).toEqual(['', 'i']);
    expect(doc.calls).toEqual([]);
  });

  it('the selector taps strokes before the image under them, and boxes images', () => {
    doc.pages.set('p1', [hline('a', 220, 200, 300)]);
    doc.imgs.set('p1', [pic('i')]);
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [250, 220, 0.5]);
    selector.up!(surface, [250, 220, 0.5]);
    expect(app.selection!.ids).toEqual(['a']);
    app.select(null);
    selector.down!(surface, [250, 240, 0.5]); // on the image, off the stroke
    selector.up!(surface, [250, 240, 0.5]);
    expect(app.selection!.ids).toEqual(['i']);
    app.select(null);
    selector.down!(surface, [190, 190, 0.5]);
    selector.move!(surface, [320, 260, 0.5]);
    selector.up!(surface, [320, 260, 0.5]);
    expect(app.selection!.ids).toEqual(['i', 'a']);
  });

  it('dragging a selection with images moves them with the strokes', () => {
    doc.imgs.set('p1', [pic('i')]);
    app.selection = { pageId: 'p1', ids: ['i'], box: { minX: 200, minY: 200, maxX: 300, maxY: 250 } };
    const { selector } = createTools(app, R.r);
    selector.down!(surface, [250, 225, 0.5]);
    selector.move!(surface, [260, 235, 0.5]);
    selector.up!(surface, [260, 235, 0.5]);
    expect(R.log).toContain('translate:i:10,10');
    expect(doc.calls).toEqual([{ method: 'moveItems', pageId: 'p1', args: [['i'], 10, 10] }]);
  });
});

describe('snapshot', () => {
  const page: Surface = { pageId: 'p1', svg: {} as SVGSVGElement, layer: { unit: 1, size: [960, 540] } as Layer };
  let shots: { pageId: string; rect: unknown }[];
  beforeEach(() => {
    shots = [];
    app.snapshot = (pageId, rect) => { shots.push({ pageId, rect }); };
  });

  it('hands the dragged area, clamped to the page, to the host', () => {
    const { snapshot } = createTools(app, R.r);
    snapshot.down!(page, [900, 500, 0.5]);
    snapshot.move!(page, [800, 400, 0.5]);
    expect(R.log).toEqual(['marquee:4']);
    snapshot.up!(page, [1000, 300, 0.5]); // beyond the right edge
    expect(R.log).toEqual(['marquee:4', 'marquee:off']);
    expect(shots).toEqual([{ pageId: 'p1', rect: { x: 900, y: 300, w: 60, h: 200 } }]);
    expect(doc.calls).toEqual([]);
  });

  it('captures nothing for a tap, a thin area, a cancel or a gesture ended without a point', () => {
    const { snapshot } = createTools(app, R.r);
    snapshot.down!(page, [100, 100, 0.5]);
    snapshot.up!(page, [101, 102, 0.5]);
    snapshot.down!(page, [100, 100, 0.5]);
    snapshot.up!(page, [300, 103, 0.5]);
    snapshot.down!(page, [100, 100, 0.5]);
    snapshot.move!(page, [300, 300, 0.5]);
    snapshot.cancel!(page);
    snapshot.up!(page, [300, 300, 0.5]);
    snapshot.down!(page, [100, 100, 0.5]);
    snapshot.up!(page, null);
    expect(shots).toEqual([]);
    expect(R.log.filter(l => l === 'marquee:off')).toHaveLength(4);
  });

  it('is in the tool list with key C, and never the tool to start with', () => {
    expect(TOOLS.find(t => t.id === 'snapshot')).toMatchObject({ key: 'C', color: false, size: false });
    expect(loadPrefs({ getItem: () => JSON.stringify({ tool: 'snapshot' }) }).tool).toBe('pen');
  });
});
