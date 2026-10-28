// @vitest-environment happy-dom
/* Images in the clipboard and the annotator: the snapshot tool, pasting an
 * image on another page, selecting, moving and deleting it, and its layer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnnotator, type AnnotatorOptions, type Capture } from '../src/app';
import { getClip, makeClip, parseClip, placeItems, serializeClip, setClip } from '../src/clipboard';
import { NotesDoc, createImage, createStroke, type PageImage } from '../src/model';
import { createPageSurface, syncImages, translateStrokes } from '../src/render';
import { defaultKeymap } from '../src/toolbar';
import { deckFromPdf } from '../src/io';
import { rectBBox } from '../src/geometry';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAGUlEQVR4nGP8z8DAwMDAyPCfgYGBiQEJAAAqNwIDlBYW1QAAAABJRU5ErkJggg==';
const img = (id: string, x: number, y: number, w: number, h: number): PageImage => createImage({ id, x, y, w, h, src: PNG });
const tick = () => new Promise(r => setTimeout(r, 0));

describe('clipboard with images', () => {
  it('places an image like strokes: same place, offset over an equal image, clamped', () => {
    const clip = makeClip([], [960, 540], [img('i', 100, 100, 200, 100)])!;
    const first = placeItems(clip, { size: [960, 540], strokes: [], images: [], step: 12 });
    expect(first.strokes).toEqual([]);
    expect(first.images[0]).toMatchObject({ x: 100, y: 100, w: 200, h: 100, src: PNG });
    expect(first.images[0].id).not.toBe('i');
    const second = placeItems(clip, { size: [960, 540], strokes: [], images: [img('i', 100, 100, 200, 100)], step: 12 });
    expect(second.images[0]).toMatchObject({ x: 112, y: 112 });
    const edge = makeClip([], [960, 540], [img('e', 900, 500, 200, 100)])!;
    expect(placeItems(edge, { size: [960, 540], strokes: [], step: 12 }).images[0]).toMatchObject({ x: 760, y: 440 });
  });

  it('scales an image to a page of another size, keeping its relative place', () => {
    const clip = makeClip([], [960, 540], [img('i', 100, 100, 200, 100)])!;
    const big = placeItems(clip, { size: [1920, 1080], strokes: [], step: 12 }).images[0];
    expect(big).toMatchObject({ x: 200, y: 200, w: 400, h: 200 });
    const a4 = placeItems(clip, { size: [595, 842], strokes: [], step: 12 }).images[0];
    const s = 595 / 960;
    expect(a4.w).toBeCloseTo(200 * s);
    expect(a4.h).toBeCloseTo(100 * s);
    expect(a4.x + a4.w / 2).toBeCloseTo(200 / 960 * 595);
    expect(a4.y + a4.h / 2).toBeCloseTo(150 / 540 * 842);
  });

  it('moves strokes and images of one clip by the same shift', () => {
    const st = createStroke({ id: 's', tool: 'pen', color: '#000', size: 4, points: [[150, 150, 0.5], [160, 160, 0.5]] });
    const clip = makeClip([st], [960, 540], [img('i', 100, 100, 200, 100)])!;
    const out = placeItems(clip, { size: [960, 540], strokes: [st], images: [], step: 12 });
    expect(out.strokes[0].points[0].slice(0, 2)).toEqual([162, 162]);
    expect(out.images[0]).toMatchObject({ x: 112, y: 112 });
  });

  it('round-trips images through the clipboard text and skips bad ones', () => {
    const clip = makeClip([], [960, 540], [img('i', 1, 2, 3, 4)])!;
    const text = serializeClip(clip);
    expect(JSON.parse(text).images).toHaveLength(1);
    expect(parseClip(text)!.images![0]).toMatchObject({ x: 1, y: 2, w: 3, h: 4, src: PNG });
    const bad = JSON.parse(text);
    bad.images.push({ x: 0, y: 0, w: 1, h: 1, src: 'data:image/svg+xml;base64,PHN2Zz4=' });
    expect(parseClip(JSON.stringify(bad))!.images).toHaveLength(1);
    bad.images = Array.from({ length: 40 }, () => bad.images[0]);
    expect(parseClip(JSON.stringify(bad))).toBeNull();
    // A stroke clip has no images field (older readers see what they know).
    const strokes = makeClip([createStroke({ tool: 'pen', color: '#000', size: 2, points: [[1, 1]] })], [960, 540])!;
    expect(JSON.parse(serializeClip(strokes))).not.toHaveProperty('images');
  });
});

describe('render images', () => {
  it('syncImages draws <image> nodes below the ink, reuses and removes them', () => {
    const { layer } = createPageSurface([960, 540]);
    expect([...layer.root.children].map(n => n.getAttribute('class'))).toEqual(['ann-hit', 'ann-img', 'ann-hl', 'ann-pen', 'ann-ui']);
    const a = img('a', 1, 2, 3, 4), b = img('b', 5, 6, 7, 8);
    syncImages(layer, [a, b]);
    const nodes = [...layer.img.children] as SVGImageElement[];
    expect(nodes.map(n => n.dataset.id)).toEqual(['a', 'b']);
    expect(['x', 'y', 'width', 'height', 'preserveAspectRatio', 'href'].map(k => nodes[0].getAttribute(k)))
      .toEqual(['1', '2', '3', '4', 'none', PNG]);
    translateStrokes(layer, ['a'], 5, 5);
    expect(nodes[0].getAttribute('transform')).toBe('translate(5 5)');
    syncImages(layer, [b, { ...a, x: 10 }]);
    expect([...layer.img.children]).toEqual([nodes[1], nodes[0]]);
    expect(nodes[0].getAttribute('x')).toBe('10');
    expect(nodes[0].hasAttribute('transform')).toBe(false);
    syncImages(layer, []);
    expect(layer.img.children.length).toBe(0);
    expect(layer.imgs.size).toBe(0);
  });
});

describe('annotator snapshot', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });
  beforeEach(() => {
    document.body.innerHTML = '';
    setClip(null);
    // A system clipboard that refuses everything (as Electron does).
    const spy = vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      readText: () => Promise.reject(new Error('denied')), writeText: () => Promise.reject(new Error('denied')),
      write: () => Promise.reject(new Error('denied')),
    } as unknown as Clipboard);
    cleanup.push(() => spy.mockRestore());
  });

  function setup(opts: Partial<AnnotatorOptions> = {}) {
    // Page 2 is A4: pastes onto it are scaled.
    const doc = new NotesDoc(deckFromPdf({ title: 't.pdf', pageSizes: [[960, 540], [595, 842]] }));
    const surfaces = ['p1', 'p2'].map((pageId, i) => {
      const { svg, layer } = createPageSurface(doc.pageSize(pageId));
      document.body.appendChild(svg);
      return { pageId, svg, layer, n: i + 1 };
    });
    let current = surfaces[0];
    const messages: string[] = [];
    const captureArea = vi.fn(async (): Promise<Capture | null> => ({ src: PNG, png: null }));
    const app = createAnnotator({
      doc, activeSurface: () => current, storage: null, captureArea, notify: t => { messages.push(t); }, ...opts,
    });
    for (const s of surfaces) { app.surfaces.set(s.pageId, s); app.input.attach(s); }
    cleanup.push(() => app.input.destroy());
    return { doc, app, surfaces, messages, captureArea, show: (i: number) => { current = surfaces[i]; } };
  }

  it('captures the area as the clip, says so and goes back to the tool before', async () => {
    const { app, messages, captureArea } = setup();
    app.setTool('highlighter');
    app.setTool('snapshot');
    await app.snapshot('p1', { x: 100, y: 50, w: 200, h: 100 });
    expect(captureArea).toHaveBeenCalledWith('p1', { x: 100, y: 50, w: 200, h: 100 });
    expect(getClip()).toMatchObject({ size: [960, 540], strokes: [], images: [{ x: 100, y: 50, w: 200, h: 100, src: PNG }] });
    expect(messages[0]).toMatch(/Snapshot copied/);
    expect(app.tool).toBe('highlighter');
    expect(app.canPaste()).toBe(true);
  });

  it('pastes the snapshot on another page, scaled; select, move, delete and undo work on it', async () => {
    const { app, doc, show } = setup();
    app.setTool('snapshot');
    await app.snapshot('p1', { x: 0, y: 0, w: 480, h: 270 });
    show(1);
    await app.paste(); // the system clipboard refuses: the window's clip
    const [pasted] = doc.images('p2');
    expect(pasted.w).toBeCloseTo(480 * 595 / 960);
    expect(pasted.x).toBeGreaterThanOrEqual(0);
    expect(app.tool).toBe('selector');
    expect(app.selection!.ids).toEqual([pasted.id]);
    expect(app.selection!.box).toEqual(rectBBox(pasted));
    expect(doc.history.top()!.label).toBe('paste');
    doc.moveItems('p2', app.selection!.ids, 10, 0);
    expect(app.selection!.box!.minX).toBeCloseTo(pasted.x + 10);
    app.deleteSelection();
    expect(doc.images('p2')).toEqual([]);
    app.undo();
    expect(doc.images('p2')).toHaveLength(1);
    app.undo();
    expect(doc.images('p2')[0].x).toBeCloseTo(pasted.x);
    app.undo();
    expect(doc.images('p2')).toEqual([]);
  });

  it('copies, cuts and duplicates a selection with images and strokes', () => {
    const { app, doc } = setup();
    doc.addItems('p1', [createStroke({ id: 's', tool: 'pen', color: '#000', size: 4, points: [[10, 10], [20, 20]] })], [img('i', 0, 0, 50, 50)]);
    app.setTool('selector');
    app.select({ pageId: 'p1', ids: ['s', 'i'] });
    app.duplicateSelection();
    expect(doc.images('p1')).toHaveLength(2);
    expect(doc.strokes('p1')).toHaveLength(2);
    expect(doc.history.top()!.label).toBe('duplicate');
    app.select({ pageId: 'p1', ids: ['s', 'i'] });
    app.cutSelection();
    expect(getClip()!.images).toHaveLength(1);
    expect(getClip()!.strokes).toHaveLength(1);
    expect(doc.images('p1').map(i => i.id)).not.toContain('i');
    expect(doc.history.top()!.label).toBe('cut');
  });

  it('keeps the tool and reports a failed capture', async () => {
    const { app, messages } = setup({ captureArea: () => Promise.reject(new Error('page closed')) });
    app.setTool('snapshot');
    await app.snapshot('p1', { x: 0, y: 0, w: 10, h: 10 });
    expect(getClip()).toBeNull();
    expect(messages).toEqual(['The snapshot failed: page closed']);
    expect(app.tool).toBe('snapshot');
  });

  it('refuses a paste beyond the image limits with a message', async () => {
    const { app, doc, messages } = setup();
    doc.addItems('p1', [], Array.from({ length: 32 }, (_, i) => img(`i${i}`, i, 0, 10, 10)));
    setClip(makeClip([], [960, 540], [img('x', 500, 300, 10, 10)]));
    await app.paste();
    expect(doc.images('p1')).toHaveLength(32);
    expect(messages[0]).toMatch(/Not pasted: A page can hold at most 32 images/);
  });

  it('Clear page is enabled for a page with only images, and clears them', () => {
    const { app, doc } = setup();
    app.mount();
    const clear = document.querySelector('.ann-bar [data-id="clear"]') as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    doc.addItems('p1', [], [img('i', 0, 0, 10, 10)]);
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(doc.images('p1')).toEqual([]);
  });

  it('C selects the snapshot tool and Escape leaves it', () => {
    const { app } = setup();
    app.setTool('laser');
    const keymap = defaultKeymap(app);
    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', init);
      const hit = keymap.find(k => k.test(e));
      if (hit) hit.run(e);
      return !!hit;
    };
    press({ code: 'KeyC', key: 'c' });
    expect(app.tool).toBe('snapshot');
    press({ code: 'Escape', key: 'Escape' });
    expect(app.tool).toBe('laser');
    expect(press({ code: 'Escape', key: 'Escape' })).toBe(false);
  });

  it('pastes an image from another program, fitted into the page', async () => {
    const importImage = vi.fn(async (): Promise<Capture | null> => ({ src: PNG, width: 1920, height: 1080 }));
    const { app, doc } = setup({ importImage });
    app.mount();
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    const event = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => '', types: ['Files'], files: [file] },
    });
    app.clipboardKey('paste');
    window.dispatchEvent(event);
    await tick();
    await tick();
    expect(importImage).toHaveBeenCalledWith(file);
    const [pasted] = doc.images('p1');
    // At most 80 % of the 960×540 page, centered, aspect kept.
    expect(pasted.w).toBeCloseTo(768);
    expect(pasted.h).toBeCloseTo(432);
    expect(pasted.x).toBeCloseTo(96);
    expect(pasted.y).toBeCloseTo(54);
  });
});
