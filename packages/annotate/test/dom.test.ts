// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAPER_STYLE, createLayer, createPageSurface, setSelectionBox, syncLayer, viewBoxSize } from '../src/render';
import { createToolbar, defaultKeymap, isTyping, registerGroup } from '../src/toolbar';
import { formatLabel, pagesGroup, parseSlideNumber, type PagesController } from '../src/pages';
import { createAnnotator } from '../src/app';
import { NotesDoc, createStroke } from '../src/model';
import { getClip, makeClip, serializeClip, setClip } from '../src/clipboard';
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
      'ann-group ann-group-sizes', 'ann-group ann-group-history', 'ann-group ann-group-edit',
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
    app.setSize(3);
    expect(app.prefs.pen).toEqual({ color: '#1e64c8', size: 3 });
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
    expect(app.currentSize()).toBe(1);
    app.setSize(2);
    const [a, b] = doc.strokes('p1');
    expect(a.size).toBeCloseTo(7 * 0.75);
    expect(b.size).toBeCloseTo(32 * 0.75);
    expect(app.currentSize()).toBe(2);
    doc.restyleStrokes('p1', ['a'], { size: 5 }); // not one of the sizes
    expect(app.currentSize()).toBeNull();
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
    expect(app.prefs.partial.size).toBe(3);
    doc.addStroke('p1', stroke('a'));
    press({ code: 'KeyZ', key: 'z', ctrlKey: true });
    expect(doc.strokes('p1')).toEqual([]);
    press({ code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true });
    expect(doc.strokes('p1').length).toBe(1);
    expect(press({ code: 'KeyQ', key: 'q' })).toBe(false);
  });

  describe('copy and paste', () => {
    const tick = () => new Promise(r => setTimeout(r, 0));
    /** A system clipboard the paste button and the key fallback can read (or not). */
    const fakeSystemClipboard = (read: () => Promise<string>, write: (t: string) => Promise<void> = () => Promise.reject(new Error('denied'))) => {
      const spy = vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(
        { readText: read, writeText: write } as unknown as Clipboard);
      cleanup.push(() => spy.mockRestore());
    };
    beforeEach(() => {
      setClip(null);
      let text = ''; // an empty system clipboard per test
      fakeSystemClipboard(async () => text, async t => { text = t; });
    });
    const twoPages = () => {
      const t = setup();
      const { svg, layer } = createPageSurface(t.doc.pageSize('p2'));
      const p2 = { pageId: 'p2', svg, layer, n: 2 };
      t.app.surfaces.set('p2', p2);
      return { ...t, p2 };
    };

    it('copy, paste on the same page (offset), and the paste is the selection', async () => {
      const { app, doc } = setup();
      app.mount();
      app.toggle(true);
      doc.addStroke('p1', stroke('a'));
      app.setTool('selector');
      const bar = document.querySelector('.ann-bar')!;
      const btn = (id: string) => bar.querySelector(`[data-id="${id}"]`) as HTMLButtonElement;
      expect(btn('copy').hidden).toBe(true);
      expect((bar.querySelector('.ann-group-edit') as HTMLElement).hidden).toBe(true);
      app.select({ pageId: 'p1', ids: ['a'] });
      expect(btn('copy').hidden).toBe(false);
      expect(btn('paste').hidden).toBe(true);
      btn('copy').click();
      expect(getClip()!.strokes.map(s => s.id)).toEqual(['a']);
      expect(btn('paste').hidden).toBe(false);
      btn('paste').click();
      await tick();
      const [a, b] = doc.strokes('p1');
      expect(b.id).not.toBe('a');
      expect(b.points[0][0]).toBeGreaterThan(a.points[0][0]); // offset
      expect(app.selection!.ids).toEqual([b.id]);
      app.undo();
      expect(doc.strokes('p1').map(s => s.id)).toEqual(['a']);
      expect(app.selection).toBeNull();
    });

    it('paste switches to the select tool and pastes on the shown page; cut is one undo step', async () => {
      const { app, doc } = setup();
      doc.addStroke('p1', stroke('a'));
      doc.addStroke('p1', stroke('b'));
      app.setTool('selector');
      app.select({ pageId: 'p1', ids: ['a', 'b'] });
      app.cutSelection();
      expect(doc.strokes('p1')).toEqual([]);
      expect(doc.history.top()!.label).toBe('cut');
      app.setTool('pen');
      await app.paste();
      expect(app.tool).toBe('selector');
      expect(doc.strokes('p1').length).toBe(2);
      // The cut strokes are gone: no offset, only the clamp that keeps the ink (radius 2) on the page.
      expect(doc.strokes('p1')[0].points[0]).toEqual([2, 2, 0.5]);
      expect(app.selection!.ids).toEqual(doc.strokes('p1').map(s => s.id));
      app.undo();
      expect(doc.strokes('p1')).toEqual([]);
      app.undo();
      expect(doc.strokes('p1').map(s => s.id)).toEqual(['a', 'b']);
    });

    it('a clip from another page size is scaled', async () => {
      const { app, doc } = setup();
      setClip(makeClip([createStroke({ tool: 'pen', color: '#000', size: 8, points: [[100, 100], [200, 200]] })], [1920, 1080]));
      await app.paste();
      const [s] = doc.strokes('p1'); // 960×540: half
      expect(s.size).toBe(4);
      expect(s.points[0].slice(0, 2)).toEqual([50, 50]);
    });

    it('duplicate pastes in place, offset, and leaves the clip alone', () => {
      const { app, doc } = setup();
      doc.addStroke('p1', stroke('a'));
      app.setTool('selector');
      app.select({ pageId: 'p1', ids: ['a'] });
      const keymap = defaultKeymap(app);
      const e = new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', ctrlKey: true });
      keymap.find(k => k.test(e))!.run(e);
      keymap.find(k => k.test(e))!.run(e); // the duplicate is selected: duplicate it again
      const xs = doc.strokes('p1').map(s => s.points[0][0]);
      expect(xs.length).toBe(3);
      expect(xs[1]).toBeGreaterThan(xs[0]);
      expect(xs[2]).toBeGreaterThan(xs[1]);
      expect(getClip()).toBeNull();
      expect(doc.history.top()!.label).toBe('duplicate');
    });

    it('Ctrl+C and Ctrl+V go through the browser clipboard events when they come', () => {
      const { app, doc } = twoPages();
      app.mount();
      app.toggle(true);
      doc.addStroke('p1', stroke('a'));
      app.setTool('selector');
      app.select({ pageId: 'p1', ids: ['a'] });
      const copy = new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', ctrlKey: true, cancelable: true });
      window.dispatchEvent(copy);
      expect(copy.defaultPrevented).toBe(false); // left to the browser, which fires 'copy'
      const data = new Map<string, string>();
      const clipboardData = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) || '' };
      const fire = (type: string) => {
        const ev = new Event(type, { cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: clipboardData });
        document.body.dispatchEvent(ev);
        return ev;
      };
      expect(fire('copy').defaultPrevented).toBe(true);
      expect(JSON.parse(data.get('text/plain')!).strokes[0].id).toBe('a');
      // A clip copied in another window arrives with the paste event.
      data.set('text/plain', serializeClip(makeClip([stroke('far')], [960, 540])!));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', ctrlKey: true }));
      fire('paste');
      expect(doc.strokes('p1').length).toBe(2);
      expect(doc.strokes('p1')[1].id).not.toBe('far');
      // A copy or paste event not started by our keys is left alone.
      expect(fire('copy').defaultPrevented).toBe(false);
    });

    it('without a browser event the keys use the window clip', async () => {
      const { app, doc } = setup();
      app.mount();
      app.toggle(true);
      doc.addStroke('p1', stroke('a'));
      app.setTool('selector');
      app.select({ pageId: 'p1', ids: ['a'] });
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', metaKey: true }));
      await new Promise(r => setTimeout(r, 0));
      expect(doc.strokes('p1')).toEqual([]);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', metaKey: true }));
      await new Promise(r => setTimeout(r, 0));
      expect(doc.strokes('p1').length).toBe(1);
      expect(app.selection!.ids).toEqual([doc.strokes('p1')[0].id]);
    });

    it('a paste event with other text pastes nothing once the clip reached the system clipboard', () => {
      const { app, doc } = setup();
      app.mount();
      app.toggle(true);
      doc.addStroke('p1', stroke('a'));
      app.setTool('selector');
      app.select({ pageId: 'p1', ids: ['a'] });
      let text = '';
      const clipboardData = { setData: (_t: string, v: string) => { text = v; }, getData: () => text };
      const fire = (type: string) => {
        const ev = new Event(type, { cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: clipboardData });
        document.body.dispatchEvent(ev);
      };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', ctrlKey: true }));
      fire('copy');
      text = 'some text copied in another program';
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', ctrlKey: true }));
      fire('paste');
      expect(doc.strokes('p1').length).toBe(1);
      text = ''; // an empty clipboard: the window's clip
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', ctrlKey: true }));
      fire('paste');
      expect(doc.strokes('p1').length).toBe(2);
    });

    it('a clip copied with the button pastes even if the platform refused the system clipboard', async () => {
      fakeSystemClipboard(async () => 'older text');
      const { app, doc } = setup();
      doc.addStroke('p1', stroke('a'));
      app.setTool('selector');
      app.select({ pageId: 'p1', ids: ['a'] });
      app.copySelection(); // writeText is refused
      await tick();
      await app.paste();
      expect(doc.strokes('p1').length).toBe(2);
    });

    it('the paste button and the key fallback read a clip from another window', async () => {
      const other = serializeClip(makeClip([stroke('far')], [960, 540])!);
      fakeSystemClipboard(async () => other);
      const { app, doc } = setup();
      app.mount();
      app.toggle(true);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', metaKey: true })); // no paste event follows
      await tick();
      await tick();
      expect(doc.strokes('p1').length).toBe(1);
      expect(getClip()).not.toBeNull();
      (document.querySelector('[data-id="paste"]') as HTMLButtonElement).click();
      await tick();
      expect(doc.strokes('p1').length).toBe(2);
    });

    it('a denied clipboard read falls back to the window clip', async () => {
      fakeSystemClipboard(() => Promise.reject(new Error('denied')));
      const { app, doc } = setup();
      setClip(makeClip([stroke('a')], [960, 540]));
      await app.paste();
      expect(doc.strokes('p1').length).toBe(1);
    });

    it('a crafted clip that scales out of range pastes nothing and does not throw', async () => {
      const { app, doc } = setup();
      setClip(makeClip([stroke('a')], [1e-6, 1e-6]));
      await expect(app.paste()).resolves.toBeUndefined();
      expect(doc.strokes('p1')).toEqual([]);
    });

    it('copy, cut, paste and duplicate keys are off while the overview is open', () => {
      const { app, doc } = setup();
      let open = true;
      app.overview = { open: () => {}, isOpen: () => open };
      doc.addStroke('p1', stroke('a'));
      app.setTool('selector');
      app.select({ pageId: 'p1', ids: ['a'] });
      const keymap = defaultKeymap(app);
      const hit = (code: string, key: string) =>
        keymap.some(k => k.test(new KeyboardEvent('keydown', { code, key, ctrlKey: true })));
      expect(['C', 'X', 'V', 'D'].map(k => hit(`Key${k}`, k.toLowerCase()))).toEqual([false, false, false, false]);
      open = false;
      expect(['C', 'X', 'V', 'D'].map(k => hit(`Key${k}`, k.toLowerCase()))).toEqual([true, true, true, true]);
    });

    it('hidden edit buttons keep their place', () => {
      const style = document.createElement('style');
      style.textContent = readFileSync(resolve(process.cwd(), 'src/toolbar.css'), 'utf8');
      document.head.appendChild(style);
      cleanup.push(() => style.remove());
      const { app } = setup();
      app.mount();
      app.toggle(true);
      const group = document.querySelector('.ann-group-edit') as HTMLElement;
      expect(group.hidden).toBe(true);
      expect(getComputedStyle(group).visibility).toBe('hidden');
      expect(getComputedStyle(group).display).not.toBe('none');
    });

    it('keys typed into a text field are not taken', async () => {
      const { app, doc } = setup();
      app.mount();
      app.toggle(true);
      doc.addStroke('p1', stroke('a'));
      app.setTool('selector');
      app.select({ pageId: 'p1', ids: ['a'] });
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', ctrlKey: true, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 0));
      expect(doc.strokes('p1').length).toBe(1);
      expect(getClip()).toBeNull();
    });
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
