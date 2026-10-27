// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAPER_STYLE, createLayer, createPageSurface, setSelectionBox, syncLayer, viewBoxSize } from '../src/render';
import { createToolbar, defaultKeymap, isTyping, registerGroup } from '../src/toolbar';
import { formatLabel, pagesGroup, parseSlideNumber, type PagesController } from '../src/pages';
import { createAnnotator, loadPrefs, PREFS_KEY } from '../src/app';
import { NotesDoc, createStroke } from '../src/model';
import { deckFromPdf } from '../src/io';
import type { Stroke } from '../src/geometry';

const stroke = (id: string, tool: Stroke['tool'] = 'pen'): Stroke =>
  createStroke({ id, tool, color: '#000', size: 4, points: [[0, 0, 0.5], [10, 10, 0.5]] });

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  delete document.body.dataset.annDock;
});

describe('render', () => {
  it('a PDF page surface uses PDF points as viewBox', () => {
    const { svg, layer, paper } = createPageSurface([595, 842]);
    expect(svg.getAttribute('viewBox')).toBe('0 0 595 842');
    expect(svg.getAttribute('class')).toBe('ann-page');
    expect(paper).toBeNull();
    expect(layer.size).toEqual([595, 842]);
    expect(layer.hit.getAttribute('width')).toBe('595');
    expect(viewBoxSize(svg)).toEqual([595, 842]);
  });

  it('a blank page surface has paper under the layer', () => {
    const { svg, paper } = createPageSurface([960, 540], { paper: 'lined', uid: 't1' });
    expect(paper).not.toBeNull();
    expect(svg.dataset.paper).toBe('lined');
    expect(svg.querySelector('#ann-lined-t1')).not.toBeNull();
    // The look comes from PAPER_STYLE, which the PDF export uses too.
    const rule = svg.querySelector('.ann-paper-rule')!;
    expect([rule.getAttribute('stroke'), rule.getAttribute('stroke-width')]).toEqual([PAPER_STYLE.rule.color, '1.2']);
    expect(svg.querySelector('.ann-paper-margin')!.getAttribute('x1')).toBe(String(960 / 32 * 3));
    expect(svg.lastElementChild!.getAttribute('class')).toBe('ann-layer');
    paper!.set('grid');
    expect(svg.dataset.paper).toBe('grid');
  });

  it('syncLayer keeps order, groups and reuses nodes', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 50');
    const layer = createLayer(svg);
    const a = stroke('a'), b = stroke('b', 'highlighter'), c = stroke('c');
    syncLayer(layer, [a, b, c]);
    expect([...layer.pen.children].map(n => (n as SVGElement).dataset.id)).toEqual(['a', 'c']);
    expect([...layer.hl.children].map(n => (n as SVGElement).dataset.id)).toEqual(['b']);
    const nodeA = layer.els.get('a')!.node;
    expect(nodeA.getAttribute('fill')).toBe('#000');
    expect(layer.els.get('b')!.node.getAttribute('stroke-width')).toBe('4');
    syncLayer(layer, [c, a]);
    expect([...layer.pen.children].map(n => (n as SVGElement).dataset.id)).toEqual(['c', 'a']);
    expect(layer.els.get('a')!.node).toBe(nodeA);
    expect(layer.hl.children.length).toBe(0);
  });

  it('selection box shows and hides', () => {
    const { layer } = createPageSurface([100, 100]);
    setSelectionBox(layer, { minX: 10, minY: 10, maxX: 20, maxY: 30 });
    const rect = layer.ui.querySelector('.ann-selection')!;
    expect(rect.getAttribute('x')).toBe('4');
    expect(rect.getAttribute('height')).toBe('32');
    setSelectionBox(layer, null);
    expect(rect.getAttribute('display')).toBe('none');
  });
});

describe('isTyping', () => {
  it('is true for text fields and contenteditable, false for other targets', () => {
    for (const tag of ['input', 'textarea', 'select']) expect(isTyping(document.createElement(tag))).toBe(true);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.append(editable);
    expect(isTyping(editable)).toBe(true);
    expect(isTyping(document.createElement('button'))).toBe(false);
    expect(isTyping(document.body)).toBe(false);
    expect(isTyping(window)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('pages helpers', () => {
  it('formatLabel', () => {
    expect(formatLabel({ slide: 3, index: 1, count: 1 }, 37)).toBe('3 / 37');
    expect(formatLabel({ slide: 3, index: 1, count: 3 }, 37)).toBe('3 / 37 · +2 blank');
    expect(formatLabel({ slide: 3, index: 2, count: 3 }, 37)).toBe('3 / 37 · blank 1/2');
  });

  it('parseSlideNumber', () => {
    expect(parseSlideNumber('12', 37)).toBe(12);
    expect(parseSlideNumber('99', 37)).toBe(37);
    expect(parseSlideNumber('0', 37)).toBe(1);
    expect(parseSlideNumber('1a', 37)).toBeNull();
    expect(parseSlideNumber('', 37)).toBeNull();
  });
});

describe('annotator, toolbar and keys', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });

  function setup() {
    const doc = new NotesDoc(deckFromPdf({ title: 't.pdf', pageSizes: [[960, 540], [960, 540]] }));
    const { svg, layer } = createPageSurface(doc.pageSize('p1'));
    document.body.appendChild(svg);
    const surface = { pageId: 'p1', svg, layer, n: 1 };
    const app = createAnnotator({ doc, activeSurface: () => surface, storage: null });
    app.surfaces.set('p1', surface);
    app.input.attach(surface);
    const mount = app.mount.bind(app);
    app.mount = parent => { const unbind = mount(parent); cleanup.push(unbind); return unbind; };
    cleanup.push(() => app.input.destroy());
    return { doc, app, surface, layer };
  }

  it('builds the bar with the Marp groups and placeholders', () => {
    const { app } = setup();
    app.mount();
    const bar = document.querySelector('.ann-bar')!;
    const groups = [...bar.querySelectorAll('.ann-group')].map(g => g.className);
    expect(groups).toEqual([
      'ann-group ann-group-mode', 'ann-group ann-group-tools', 'ann-group ann-group-colors',
      'ann-group ann-group-sizes', 'ann-group ann-group-history',
      'ann-group ann-group-pages ann-placeholder', 'ann-group ann-group-file ann-placeholder',
    ]);
    expect(bar.querySelectorAll('.ann-swatch').length).toBe(8);
    expect(bar.querySelector('[data-id="pen"]')!.classList.contains('is-active')).toBe(true);
    expect((bar.querySelector('[data-id="undo"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.dataset.annDock).toBe('top');
  });

  it('keeps the doc, layer and toolbar in sync', () => {
    const { app, doc, layer } = setup();
    app.mount();
    app.toggle(true);
    expect(document.body.classList.contains('ann-on')).toBe(true);
    doc.addStroke('p1', stroke('a'));
    expect(layer.els.has('a')).toBe(true);
    expect((document.querySelector('[data-id="undo"]') as HTMLButtonElement).disabled).toBe(false);
    app.undo();
    expect(layer.els.has('a')).toBe(false);
  });

  it('loading notes redraws the shown pages with one refresh, not one per page', () => {
    const { app, doc, layer } = setup();
    app.mount();
    doc.addStroke('p1', stroke('old'));
    const file = doc.toJSON();
    file.pages = [{ id: 'p1', kind: 'slide', slide: 1, strokes: [{ ...file.pages[0].strokes[0], id: 'new' }] }];
    const refreshes = vi.fn();
    app.onRefresh = refreshes;
    doc.load(file);
    expect([...layer.els.keys()]).toEqual(['new']);
    expect(refreshes.mock.calls.length).toBeLessThanOrEqual(3); // strokes, pages, history
  });

  it('turning annotate mode off creates no laser on pages that never used it', () => {
    const { app, layer } = setup();
    app.toggle(true);
    app.toggle(false);
    expect(layer.laser).toBeNull();
    expect(layer.ui.querySelector('.ann-laser')).toBeNull();
  });

  it('prefs, colors, sizes and the selection', () => {
    const { app, doc } = setup();
    app.setColor('#1e64c8');
    app.setSize(7);
    expect(app.prefs.pen).toEqual({ color: '#1e64c8', size: 7 });
    app.setTool('eraser');
    expect(app.currentColor()).toBeNull();
    app.setColor('#be1e3c'); // a color switches back to the pen
    expect(app.tool).toBe('pen');
    doc.addStroke('p1', stroke('a'));
    app.setTool('selector');
    app.select({ pageId: 'p1', ids: ['a'] });
    expect(app.selection!.box).not.toBeNull();
    expect(app.currentColor()).toBe('#000');
    app.setColor('#2e8b3a');
    expect(doc.strokes('p1')[0].color).toBe('#2e8b3a');
    app.deleteSelection();
    expect(doc.strokes('p1')).toEqual([]);
  });

  it('restyling a selection uses the page-scaled sizes', () => {
    const { app, doc, layer } = setup();
    expect(layer.unit).toBeCloseTo(0.75); // 960×540 pt
    // Sizes the pen draws on this page: SIZES × 0.75.
    const pts = [[0, 0, 0.5], [10, 10, 0.5]];
    doc.addStroke('p1', createStroke({ id: 'a', tool: 'pen', color: '#000', size: 4 * layer.unit, points: pts }));
    doc.addStroke('p1', createStroke({ id: 'b', tool: 'highlighter', color: '#000', size: 20 * layer.unit, points: pts }));
    app.setTool('selector');
    app.select({ pageId: 'p1', ids: ['a', 'b'] });
    expect(app.currentSize()).toBe(3);
    app.setSize(5);
    const [a, b] = doc.strokes('p1');
    expect(a.size).toBeCloseTo(7 * 0.75);
    expect(b.size).toBeCloseTo(32 * 0.75);
    expect(app.currentSize()).toBe(5);
    // − and + restyle the selection one step.
    app.stepSize(1);
    expect(doc.strokes('p1').map(s => s.size / 0.75)).toEqual([9.5, 40].map(v => expect.closeTo(v)));
    expect(app.currentSize()).toBe(6);
    doc.restyleStrokes('p1', ['a'], { size: 5 }); // not one of the sizes
    expect(app.currentSize()).toBeNull();
    // Strokes of different sizes: each goes to its own next step.
    app.stepSize(-1);
    expect(doc.strokes('p1').map(s => s.size)).toEqual([5.5 * 0.75, 32 * 0.75].map(v => expect.closeTo(v)));
    app.undo();
    expect(doc.strokes('p1')[0].size).toBe(5);
  });

  it('− and + step the tool size and stop at the ends of the scale', () => {
    const { app } = setup();
    app.mount();
    app.toggle(true);
    const btn = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement;
    expect(app.prefs.pen.size).toBe(3); // M
    expect(btn('size').getAttribute('aria-label')).toBe('Size 4 of 9 (M, key 2)');
    expect(btn('size').style.getPropertyValue('--dot-color')).toBe('#000000');
    btn('size-up').click();
    expect(app.prefs.pen.size).toBe(4);
    expect(btn('size').title).toBe('Size 5 of 9');
    app.setSize(8);
    expect((btn('size-up') as HTMLButtonElement).disabled).toBe(true);
    expect((btn('size-down') as HTMLButtonElement).disabled).toBe(false);
    app.stepSize(1); // at the end: nothing
    expect(app.prefs.pen.size).toBe(8);
    app.setTool('highlighter'); // its own size
    expect(app.prefs.highlighter.size).toBe(3);
    app.setSize(0);
    expect((btn('size-down') as HTMLButtonElement).disabled).toBe(true);
    expect(app.prefs.pen.size).toBe(8);
    // A tool without a size steps the pen's, like the size buttons did.
    app.setTool('laser');
    expect(btn('size').classList.contains('is-none')).toBe(true);
    btn('size-down').click();
    expect(app.tool).toBe('pen');
    expect(app.prefs.pen.size).toBe(7);
    // The preview is a picture, not a button; − and + are buttons with names.
    expect(btn('size').tagName).toBe('SPAN');
    expect(btn('size').getAttribute('role')).toBe('img');
    expect(btn('size-up').getAttribute('aria-label')).toBe('Thicker (])');
  });

  it('saves the size step and the nearest preset; they load back', () => {
    const items = new Map<string, string>();
    const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
    const doc = new NotesDoc(deckFromPdf({ title: 't.pdf', pageSizes: [[960, 540]] }));
    const app = createAnnotator({ doc, activeSurface: () => null, storage: storage as unknown as Storage });
    app.setSize(4);
    const saved = JSON.parse(items.get(PREFS_KEY)!);
    expect(saved.prefs.pen).toEqual({ color: '#000000', size: 1, step: 4 }); // between M and L: the smaller
    expect(saved.prefs.selector).toEqual({});
    expect(loadPrefs(storage).prefs.pen.size).toBe(4);
    app.input.destroy();
  });

  it('default keymap: tools, sizes, undo', () => {
    const { app, doc } = setup();
    const keymap = defaultKeymap(app);
    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', init);
      const hit = keymap.find(k => k.test(e));
      if (hit) hit.run(e);
      return !!hit;
    };
    press({ code: 'KeyH', key: 'h' });
    expect(app.tool).toBe('highlighter');
    press({ code: 'KeyE', key: 'E', shiftKey: true });
    expect(app.tool).toBe('partial');
    press({ code: 'Digit4', key: '4' });
    expect(app.prefs.partial.size).toBe(7); // XL
    press({ code: 'BracketLeft', key: '[' });
    expect(app.prefs.partial.size).toBe(6);
    press({ code: 'BracketRight', key: ']' });
    press({ code: 'BracketRight', key: ']' });
    expect(app.prefs.partial.size).toBe(8);
    press({ code: 'Digit8', key: ']', ctrlKey: true, altKey: true }); // AltGr+9 on a German layout (Windows)
    expect(app.prefs.partial.size).toBe(8); // the end of the scale
    expect(press({ code: 'BracketLeft', key: '[', ctrlKey: true })).toBe(false);
    doc.addStroke('p1', stroke('a'));
    press({ code: 'KeyZ', key: 'z', ctrlKey: true });
    expect(doc.strokes('p1')).toEqual([]);
    press({ code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true });
    expect(doc.strokes('p1').length).toBe(1);
    expect(press({ code: 'KeyQ', key: 'q' })).toBe(false);
  });

  it('A toggles annotate mode through bindKeys', () => {
    const { app } = setup();
    const unbind = app.mount();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a' }));
    expect(app.enabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p' }));
    expect(app.tool).toBe('pen');
    unbind();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a' }));
    expect(app.enabled).toBe(true);
  });

  it('a registered pages group replaces the placeholder', () => {
    const { app } = setup();
    const pages: PagesController = {
      step: () => {}, canStep: dir => dir > 0, label: () => '1 / 2', insert: () => {},
      paper: () => 'grid', setPaper: () => {}, deleteCurrent: () => {}, onBlank: () => false,
    };
    app.pages = pages;
    registerGroup('pages', pagesGroup);
    try {
      const bar = createToolbar(app as typeof app & { pages: PagesController });
      expect(bar.el.querySelector('.ann-group-pages')!.classList.contains('ann-placeholder')).toBe(false);
      expect(bar.el.querySelector('[data-id="page-label"]')!.textContent).toBe('1 / 2');
      expect(bar.el.querySelector('.ann-edge-start [data-id="page-prev"]')).not.toBeNull();
      expect((bar.el.querySelector('[data-id="page-prev"]') as HTMLButtonElement).disabled).toBe(true);
      expect(bar.el.querySelector('[data-id="paper-grid"]')!.classList.contains('is-active')).toBe(true);
    } finally {
      registerGroup('pages', () => ({ id: 'pages', label: 'Pages', placeholder: true, items: [] }));
    }
  });
});
