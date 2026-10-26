/* Inkslide web - page overview and jump-to-page
 *
 * Ported from the ideas of Marp Notes overview.js (© Andres Gomez, MIT):
 * a full-screen grid of page thumbnails, opened from the page counter, the
 * collapsed bar's grid button, or G + Enter. Clicking one jumps there; Esc
 * closes it; arrows move between thumbnails. Instead of cloning slide SVGs,
 * each tile is a small PDF.js render (made once, lazily, the first time it
 * scrolls into view, then kept) with the page's notes as an SVG on top.
 *
 * Keyboard: G, a page number, Enter jumps; G, Enter opens the overview.
 */
import type { NotesDoc } from '@inkslide/annotate';
import { parseSlideNumber } from '@inkslide/annotate/pages';
import * as render from '@inkslide/annotate/render';
import { icon, isTyping, noMods } from '@inkslide/annotate/toolbar';
import { PRIORITY, type PdfDoc } from './pdf';

const GOTO_TIMEOUT = 5000;
/** Thumbnail width in CSS px (rendered at devicePixelRatio). */
const THUMB_WIDTH = 260;

/** What the overview needs from the viewer. */
export interface OverviewHost {
  doc: NotesDoc;
  pdf: PdfDoc;
  /** PDF page number of the page shown (its owner for a blank page). */
  currentNumber(): number;
  jump(n: number): void;
  refresh(): void;
  cancelInput(): void;
}

/** The overview of one document (also handles G + number). */
export interface Overview {
  isOpen(): boolean;
  /** Counter text while typing G + number, else null. */
  prompt(): string | null;
  open(): void;
  close(): void;
  toggle(): void;
  refresh(): void;
  destroy(): void;
}

interface Item {
  n: number;
  btn: HTMLButtonElement;
  tile: HTMLDivElement;
  badges: HTMLSpanElement;
  canvas: HTMLCanvasElement | null;
  layer: render.Layer | null;
  badgeKey: string;
  notesKey: unknown;
}

/** The overview of `host.doc`; its keys are bound until destroy(). */
export function createOverview(host: OverviewHost): Overview {
  const { doc, pdf } = host;
  const total = doc.deck.slides;
  let ui: { root: HTMLDivElement; grid: HTMLDivElement; items: Item[] } | null = null;
  let observer: IntersectionObserver | null = null;
  let open = false;
  let goto: { digits: string; timer: ReturnType<typeof setTimeout> | 0 } | null = null;

  function build(): NonNullable<typeof ui> {
    const root = document.createElement('div');
    root.id = 'ann-ov';
    root.className = 'ann-ov';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Page overview');
    const first = doc.deck.pageSizes && doc.deck.pageSizes[0] || doc.deck.size;
    root.style.setProperty('--ann-ov-ratio', `${first[0]} / ${first[1]}`);

    const head = document.createElement('div');
    head.className = 'ann-ov-head';
    head.innerHTML = `<span class="ann-ov-title">Pages <span class="ann-ov-count">${total}</span></span>` +
      '<span class="ann-ov-hint">Tap a page to go there · Esc closes</span>';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ann-ov-close';
    close.title = 'Close overview (Esc)';
    close.setAttribute('aria-label', 'Close overview');
    close.innerHTML = icon('close');
    close.addEventListener('click', () => api.close());
    head.appendChild(close);

    const grid = document.createElement('div');
    grid.className = 'ann-ov-grid';
    const items: Item[] = [];
    for (let n = 1; n <= total; n++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ann-ov-item';
      btn.dataset.n = String(n);
      const size = doc.pageSize(`p${n}`);
      btn.style.setProperty('--ann-ov-ratio', `${size[0]} / ${size[1]}`);
      const tile = document.createElement('div');
      tile.className = 'ann-ov-tile';
      tile.inert = true;
      const num = document.createElement('span');
      num.className = 'ann-ov-num';
      num.textContent = String(n);
      const badges = document.createElement('span');
      badges.className = 'ann-ov-badges';
      btn.append(tile, num, badges);
      btn.addEventListener('click', () => { api.close(); host.jump(n); });
      grid.appendChild(btn);
      items.push({ n, btn, tile, badges, canvas: null, layer: null, badgeKey: '', notesKey: null });
    }
    root.append(head, grid);
    for (const type of ['pointerdown', 'click', 'wheel', 'touchstart', 'touchmove', 'touchend'] as const) {
      root.addEventListener(type, e => e.stopPropagation(), { passive: true });
    }
    document.body.appendChild(root);

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const item = items[Number((en.target as HTMLElement).dataset.n) - 1];
          observer!.unobserve(en.target);
          fill(item);
        }
      }, { root: grid, rootMargin: '400px 0px' });
      items.forEach(it => observer!.observe(it.btn));
    } else {
      items.forEach(fill);
    }
    return { root, grid, items };
  }

  /** Render the thumbnail once and add the notes layer. */
  function fill(item: Item): void {
    if (item.canvas) return;
    const size = doc.pageSize(`p${item.n}`);
    const canvas = document.createElement('canvas');
    canvas.className = 'ink-ov-pdf';
    item.canvas = canvas;
    const scale = (THUMB_WIDTH * Math.min(2, window.devicePixelRatio || 1)) / size[0];
    const { svg, layer } = render.createPageSurface(size, { className: 'ink-ov-notes' });
    item.layer = layer;
    item.tile.append(canvas, svg);
    syncNotes(item);
    pdf.renderInto(canvas, item.n, scale, PRIORITY.thumb).catch(() => { /* closed meanwhile */ });
  }

  function syncNotes(item: Item): void {
    if (!item.layer) return;
    const strokes = doc.strokes(`p${item.n}`);
    if (strokes === item.notesKey) return;
    item.notesKey = strokes;
    render.syncLayer(item.layer, strokes);
  }

  const hasNotes = (n: number): boolean => doc.strokes(`p${n}`).length > 0 ||
    doc.blanksAfter(n).some(id => doc.strokes(id).length > 0);

  function update(): void {
    if (!ui) return;
    const cur = host.currentNumber();
    for (const item of ui.items) {
      const current = item.n === cur;
      item.btn.classList.toggle('is-current', current);
      if (current) item.btn.setAttribute('aria-current', 'page'); else item.btn.removeAttribute('aria-current');
      const notes = hasNotes(item.n);
      const blanks = doc.blanksAfter(item.n).length;
      const key = `${notes}|${blanks}|${current}`;
      if (key !== item.badgeKey) {
        item.badgeKey = key;
        item.badges.innerHTML =
          (notes ? `<span class="ann-ov-badge" title="Has notes">${icon('pen')}</span>` : '') +
          (blanks ? `<span class="ann-ov-badge" title="${blanks} blank page${blanks > 1 ? 's' : ''}">${icon('pagePlain')}${blanks}</span>` : '');
        item.btn.setAttribute('aria-label', [`Page ${item.n}`, current && 'current',
          notes && 'has notes', blanks && `${blanks} blank page${blanks > 1 ? 's' : ''}`].filter(Boolean).join(', '));
      }
      syncNotes(item);
    }
  }

  function columns(): number {
    const items = ui!.items;
    const top = items[0].btn.offsetTop;
    let c = 0;
    while (c < items.length && items[c].btn.offsetTop === top) c++;
    return Math.max(1, c);
  }

  function focusItem(i: number): void {
    const items = ui!.items;
    const item = items[Math.max(0, Math.min(items.length - 1, i))];
    item.btn.focus({ preventScroll: true });
    const { grid } = ui!;
    const top = item.btn.offsetTop, bottom = top + item.btn.offsetHeight;
    if (top < grid.scrollTop) grid.scrollTop = top - 18;
    else if (bottom > grid.scrollTop + grid.clientHeight) grid.scrollTop = bottom - grid.clientHeight + 18;
  }

  // ── G + number ──

  function endGoto(): void {
    if (!goto) return;
    if (goto.timer) clearTimeout(goto.timer);
    goto = null;
    host.refresh();
  }
  function touchGoto(): void {
    if (goto!.timer) clearTimeout(goto!.timer);
    goto!.timer = setTimeout(endGoto, GOTO_TIMEOUT);
    host.refresh();
  }

  function gotoKey(e: KeyboardEvent): boolean {
    const g = goto!;
    const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code || '') || /^(\d)$/.exec(e.key);
    if (m && noMods(e)) {
      if (g.digits.length < 5) g.digits += m[1];
      touchGoto();
      return true;
    }
    if (e.key === 'Backspace') { g.digits = g.digits.slice(0, -1); touchGoto(); return true; }
    if (e.key === 'Enter') {
      const n = parseSlideNumber(g.digits, total);
      endGoto();
      if (n === null) api.open(); else host.jump(n);
      return true;
    }
    if (e.key === 'Escape' || (e.code === 'KeyG' && noMods(e))) { endGoto(); return true; }
    if (/^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return true; // e.g. Shift for digits on AZERTY
    endGoto();
    return false; // any other key cancels and does its usual thing
  }

  function openKey(e: KeyboardEvent): boolean {
    const items = ui!.items;
    const i = items.findIndex(it => it.btn === document.activeElement);
    const at = i === -1 ? host.currentNumber() - 1 : i;
    switch (e.key) {
      case 'Escape': api.close(); return true;
      case 'ArrowRight': focusItem(at + (i === -1 ? 0 : 1)); return true;
      case 'ArrowLeft': focusItem(at - (i === -1 ? 0 : 1)); return true;
      case 'ArrowDown': focusItem(at + columns()); return true;
      case 'ArrowUp': focusItem(at - columns()); return true;
      case 'Home': focusItem(0); return true;
      case 'End': focusItem(items.length - 1); return true;
      default: return false;
    }
  }

  // Window capture, installed before the viewer's keys and toolbar.bindKeys.
  const onKey = (e: KeyboardEvent): void => {
    if (typeof e.key !== 'string' || e.isComposing) return;
    if (open) {
      if (e.ctrlKey || e.metaKey) return; // Ctrl/Cmd+S etc. keep working
      if (openKey(e)) e.preventDefault();
      e.stopImmediatePropagation(); // Enter/Space/Tab keep their default on the focused thumbnail
      return;
    }
    if (isTyping(e.target)) return;
    let handled = false;
    if (goto) handled = gotoKey(e);
    else if (e.code === 'KeyG' && noMods(e) && !e.shiftKey && !e.repeat) {
      goto = { digits: '', timer: 0 };
      touchGoto();
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('keydown', onKey, true);

  const api: Overview = {
    isOpen: () => open,
    prompt: () => (goto ? `Go to ${goto.digits}_` : null),

    open() {
      endGoto();
      if (!ui) ui = build();
      host.cancelInput();
      open = true;
      ui.root.hidden = false;
      document.body.classList.add('ann-ov-open');
      update();
      const cur = ui.items[host.currentNumber() - 1];
      if (cur) {
        ui.grid.scrollTop = cur.btn.offsetTop - (ui.grid.clientHeight - cur.btn.offsetHeight) / 2;
        cur.btn.focus({ preventScroll: true });
      }
    },

    close() {
      if (!open || !ui) return;
      open = false;
      if (ui.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      ui.root.hidden = true;
      document.body.classList.remove('ann-ov-open');
    },

    toggle() { if (open) api.close(); else api.open(); },

    refresh() { if (open) update(); },

    destroy() {
      api.close();
      endGoto();
      window.removeEventListener('keydown', onKey, true);
      if (observer) observer.disconnect();
      if (ui) ui.root.remove();
      ui = null;
    },
  };
  return api;
}
