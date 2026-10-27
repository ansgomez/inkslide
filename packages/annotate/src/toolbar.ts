/* Inkslide annotate - fully expanded toolbar and keyboard shortcuts
 *
 * Ported from Marp Notes toolbar.js (© Andres Gomez, MIT). Styles: toolbar.css.
 * The bar is built from groups in GROUP_ORDER. Each group builder is
 * registered with registerGroup(id, builder) and returns { id, label, items }
 * where an item is { id, title, icon | swatch | dot | text, onClick, active(),
 * disabled(), hidden() }. The app registers its own builders for 'pages' (pages.ts
 * pagesGroup) and 'file'; otherwise the disabled placeholders below are used.
 */
import type { NotesDoc } from './model';
import type { Stroke } from './geometry';
import { COLORS, SIZE_LABELS, TOOLS, type ToolId } from './tools';

// ── Icons (24×24, stroked with currentColor) ───────────────────

/** Icon markup by name (the inside of a 24×24 <svg>). */
export const ICONS: Record<string, string> = {
  annotate: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  pen: '<path d="M3 21l3.5-1L19 7.5 16.5 5 4 17.5z"/><path d="M14.5 7l2.5 2.5"/>',
  highlighter: '<path d="M9 14l-3 3v3h3l3-3"/><path d="M9 14l7-9 4 4-9 7z"/><path d="M3 21h6" stroke-width="3"/>',
  selector: '<rect x="3" y="3" width="13" height="13" stroke-dasharray="3 2.5"/><path d="M12 12l9 3.5-4 1.5-1.5 4z" fill="currentColor"/>',
  laser: '<circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  // Stroke eraser: eraser over a whole squiggle that disappears (crossed out).
  eraser: '<path d="M6 11l6-6 5 5-6 6H8z"/><path d="M9 8l5 5"/><path d="M2.5 20c3-2.5 5-2.5 7 0s5 2.5 7 0 3.5-1.5 5-1"/>',
  // Partial eraser: eraser biting a gap out of a line.
  partial: '<path d="M9 13l5-5 4 4-5 5z" fill="currentColor"/><path d="M2 20h7M16 20h6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
  clear: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  pageInsert: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M12.5 10.5v7M9 14h7"/>',
  pagePlain: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/>',
  pageLined: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 14h7M9 17h7"/>',
  pageGrid: '<path d="M6 3h9l4 4v14H6z"/><path d="M10 9v12M14 9v12M6 13h13M6 17h13"/>',
  pageDelete: '<path d="M6 3h9l4 4v14H6z"/><path d="M9.5 12.5l5 5M14.5 12.5l-5 5"/>',
  save: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  load: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v3h16v-3"/>',
  dockTop: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18" stroke-width="3.2"/>',
  dockRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M16 4v16" stroke-width="3.2"/>',
  dockBottom: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15h18" stroke-width="3.2"/>',
  dockLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16" stroke-width="3.2"/>',
  overview: '<rect x="3" y="4" width="7.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="7.5" height="6.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="6.5" rx="1"/>',
  // Export: a page with an arrow out of it.
  pdf: '<path d="M13 3H6v18h12V8z"/><path d="M13 3v5h5"/><path d="M9 14h7M13.5 11.5L16 14l-2.5 2.5"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="1.5"/><path d="M7 14h10v7H7z"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="1.5"/><path d="M16 8V4.5A1.5 1.5 0 0014.5 3h-9A1.5 1.5 0 004 4.5v11A1.5 1.5 0 005.5 17H8"/>',
  cut: '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.2 15.8L19 3M15.8 15.8L5 3"/>',
  paste: '<path d="M9 4H6.5A1.5 1.5 0 005 5.5v14A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5v-14A1.5 1.5 0 0017.5 4H15"/><rect x="9" y="2.5" width="6" height="3.5" rx="1"/><path d="M9 12h6M9 16h4"/>',
};

/** Inline SVG markup of icon `name`. */
export const icon = (name: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" ` +
  `stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

// ── Types ──────────────────────────────────────────────────────

type Dyn<T> = T | (() => T);

/** A button or label of the toolbar. Functions are evaluated on every update(). */
export interface ToolbarItem {
  id: string;
  title?: Dyn<string>;
  icon?: Dyn<string>;
  caption?: string;
  /** Color swatch (CSS color). */
  swatch?: string;
  /** Size dot index 0..3. */
  dot?: number;
  /** Text item (label, or a button with a label's look if it has onClick). */
  text?: () => string;
  /** Put the button at one end of the bar (large prev/next). */
  edge?: 'start' | 'end';
  onClick?: () => void;
  active?: () => boolean;
  disabled?: () => boolean;
  /** Hide the button, keeping its place (a group whose buttons are all hidden is hidden too). */
  hidden?: () => boolean;
}

/** A group of toolbar items. */
export interface ToolbarGroup {
  id: string;
  label: string;
  placeholder?: boolean;
  items: ToolbarItem[];
}

/** What the default groups and shortcuts need from the app. */
export interface ToolbarHost {
  enabled: boolean;
  tool: ToolId;
  doc: NotesDoc;
  selection: unknown;
  overview?: { open(): void; isOpen?(): boolean } | null;
  toggle(on?: boolean): void;
  refresh(): void;
  setTool(id: ToolId): void;
  setColor(color: string): void;
  setSize(i: number): void;
  currentColor(): string | null;
  currentSize(): number | null;
  undo(): void;
  redo(): void;
  clearPage(): void;
  activeStrokes(): readonly Stroke[];
  deleteSelection(): void;
  select(sel: null): void;
  copySelection(): void;
  cutSelection(): void;
  paste(): unknown;
  duplicateSelection(): void;
  /** Whether this window has strokes to paste. */
  canPaste(): boolean;
  /** Ctrl/Cmd+C, X or V; false leaves the key to the browser (see Annotator.clipboardKey). */
  clipboardKey(kind: 'copy' | 'cut' | 'paste'): boolean;
}

/** Builds a group for an app; called once by createToolbar. */
export type GroupBuilder<A = ToolbarHost> = (app: A) => ToolbarGroup;

// ── Groups ─────────────────────────────────────────────────────

/** Toolbar groups, in bar order. */
export const GROUP_ORDER = ['mode', 'tools', 'colors', 'sizes', 'history', 'edit', 'pages', 'file'] as const;
const groups: Record<string, GroupBuilder<any>> = {};

/** Register (or replace) the builder of a toolbar group. */
export function registerGroup<A extends ToolbarHost>(id: string, builder: GroupBuilder<A>): void {
  groups[id] = builder;
}

/** Window edges the toolbar can dock to. */
export const DOCKS = ['top', 'right', 'bottom', 'left'] as const;
/** A window edge the toolbar docks to. */
export type Dock = typeof DOCKS[number];
const DOCK_KEY = 'marp-notes-dock-v1';
const cap = (w: string): string => w[0].toUpperCase() + w.slice(1);

function loadDock(): Dock {
  try {
    const d = localStorage.getItem(DOCK_KEY);
    return DOCKS.includes(d as Dock) ? d as Dock : 'top';
  } catch (_) { return 'top'; }
}

/** Dock the toolbar to an edge and remember it. */
export function setDock(dock: Dock): void {
  document.body.dataset.annDock = dock;
  try { localStorage.setItem(DOCK_KEY, dock); } catch (_) { /* convenience only */ }
}

const nextDock = (): Dock => DOCKS[(DOCKS.indexOf(document.body.dataset.annDock as Dock) + 1) % DOCKS.length];

registerGroup('mode', app => ({
  id: 'mode', label: 'Annotate', items: [{
    id: 'toggle', title: 'Annotate mode (A)',
    icon: () => (app.enabled ? 'close' : 'annotate'),
    onClick: () => app.toggle(),
    active: () => app.enabled,
  }, {
    id: 'dock', title: () => `Move toolbar (now ${document.body.dataset.annDock}; next ${nextDock()})`,
    icon: () => `dock${cap(document.body.dataset.annDock || 'top')}`,
    onClick: () => { setDock(nextDock()); app.refresh(); },
  },
  // Only shown while annotate mode is off (the page counter opens it when on).
  ...(app.overview ? [{
    id: 'overview', title: 'Slide overview', icon: 'overview', onClick: () => app.overview!.open(),
  }] : [])],
}));

registerGroup('tools', app => ({
  id: 'tools', label: 'Tools',
  items: TOOLS.map(t => ({
    id: t.id, title: `${t.label} (${t.key})`, icon: t.id, caption: t.caption,
    onClick: () => app.setTool(t.id),
    active: () => app.tool === t.id,
  })),
}));

registerGroup('colors', app => ({
  id: 'colors', label: 'Colors',
  items: COLORS.map(c => ({
    id: `color-${c.id}`, title: c.label, swatch: c.value,
    onClick: () => app.setColor(c.value),
    active: () => app.currentColor() === c.value,
  })),
}));

registerGroup('sizes', app => ({
  id: 'sizes', label: 'Sizes',
  items: SIZE_LABELS.map((label, i) => ({
    id: `size-${i}`, title: `Size ${label} (${i + 1})`, dot: i,
    onClick: () => app.setSize(i),
    active: () => app.currentSize() === i,
  })),
}));

registerGroup('history', app => ({
  id: 'history', label: 'History',
  items: [
    { id: 'undo', title: 'Undo (Ctrl/Cmd+Z)', icon: 'undo', onClick: () => app.undo(), disabled: () => !app.doc.history.canUndo() },
    { id: 'redo', title: 'Redo (Ctrl/Cmd+Shift+Z)', icon: 'redo', onClick: () => app.redo(), disabled: () => !app.doc.history.canRedo() },
    { id: 'clear', title: 'Clear page (undoable)', icon: 'clear', onClick: () => app.clearPage(), disabled: () => !app.activeStrokes().length },
  ],
}));

// Shown only when there is something to copy or paste, for writing with the pen alone.
registerGroup('edit', app => ({
  id: 'edit', label: 'Edit',
  items: [
    { id: 'copy', title: 'Copy (Ctrl/Cmd+C)', icon: 'copy', onClick: () => app.copySelection(), hidden: () => !app.selection },
    { id: 'cut', title: 'Cut (Ctrl/Cmd+X)', icon: 'cut', onClick: () => app.cutSelection(), hidden: () => !app.selection },
    { id: 'paste', title: 'Paste (Ctrl/Cmd+V)', icon: 'paste', onClick: () => void app.paste(), hidden: () => !app.canPaste() },
  ],
}));

// Placeholders: replaced when the pages / file groups are registered.
const soon = (id: string, title: string, iconName: string): ToolbarItem =>
  ({ id, title: `${title} (coming soon)`, icon: iconName, disabled: () => true });

registerGroup('pages', () => ({
  id: 'pages', label: 'Pages', placeholder: true,
  items: [
    soon('page-prev', 'Previous page', 'prev'),
    soon('page-next', 'Next page', 'next'),
    soon('blank-plain', 'Insert plain page (B)', 'pagePlain'),
    soon('blank-lined', 'Insert lined page', 'pageLined'),
    soon('blank-grid', 'Insert grid page', 'pageGrid'),
    soon('page-delete', 'Delete blank page', 'pageDelete'),
  ],
}));

registerGroup('file', () => ({
  id: 'file', label: 'File', placeholder: true,
  items: [
    soon('save', 'Save notes (Ctrl/Cmd+S)', 'save'),
    soon('load', 'Load notes', 'load'),
    soon('pdf', 'Export PDF', 'pdf'),
  ],
}));

// ── DOM ────────────────────────────────────────────────────────

function buildLabel(item: ToolbarItem): HTMLElement {
  if (item.onClick) return buildButton(item, 'ann-label');
  const span = document.createElement('span');
  span.className = 'ann-label';
  span.dataset.id = item.id;
  span.title = typeof item.title === 'function' ? item.title() : item.title || '';
  span.setAttribute('aria-live', 'polite');
  return span;
}

/** A text item with onClick becomes a button with the label's look (extraClass). */
function buildButton(item: ToolbarItem, extraClass?: string): HTMLElement {
  if (item.text && !extraClass) return buildLabel(item);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `ann-btn ${extraClass}` : 'ann-btn';
  btn.dataset.id = item.id;
  const title = (typeof item.title === 'function' ? item.title() : item.title) || '';
  btn.title = title;
  // A text button is named by its text; the title describes it.
  if (extraClass) btn.setAttribute('aria-live', 'polite');
  else btn.setAttribute('aria-label', title);
  if (item.caption) btn.classList.add('has-cap');
  if (item.swatch) {
    btn.classList.add('ann-swatch');
    btn.style.setProperty('--swatch', item.swatch);
    btn.innerHTML = '<span></span>';
  } else if (item.dot != null) {
    btn.classList.add('ann-size');
    btn.innerHTML = `<span style="--dot:${[4, 8, 13, 19][item.dot]}px"></span>`;
  }
  // Do not take focus: a focused button would swallow Space meant for page turns.
  btn.addEventListener('pointerdown', e => e.preventDefault());
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (item.onClick && !btn.disabled) item.onClick();
  });
  return btn;
}

/** A built toolbar; update() refreshes icons, states and labels. */
export interface Toolbar {
  el: HTMLDivElement;
  update(): void;
}

/** Build the toolbar from the registered groups (in GROUP_ORDER) and add it to `parent`. */
export function createToolbar<A extends ToolbarHost>(app: A, parent: HTMLElement = document.body): Toolbar {
  const bar = document.createElement('div');
  bar.className = 'ann-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Lecture notes');
  const entries: { item: ToolbarItem; btn: HTMLElement }[] = [];
  const hiding = new Set<HTMLElement>(); // groups with buttons that hide
  // Previous/next page sit large at the two ends of the bar, easy to hit
  // on a tablet; every other button stays in its group.
  const edge = {} as Record<'start' | 'end', HTMLDivElement>;
  for (const side of ['start', 'end'] as const) {
    edge[side] = document.createElement('div');
    edge[side].className = `ann-group ann-edge ann-edge-${side}`;
    edge[side].setAttribute('role', 'group');
    edge[side].setAttribute('aria-label', side === 'start' ? 'Previous page' : 'Next page');
  }
  bar.appendChild(edge.start);

  for (const gid of GROUP_ORDER) {
    if (!groups[gid]) continue;
    const def = groups[gid](app);
    const g = document.createElement('div');
    g.className = `ann-group ann-group-${gid}`;
    if (def.placeholder) g.classList.add('ann-placeholder');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', def.label);
    for (const item of def.items) {
      const btn = buildButton(item);
      (item.edge ? edge[item.edge] : g).appendChild(btn);
      entries.push({ item, btn });
      if (item.hidden && !item.edge) hiding.add(g);
    }
    bar.appendChild(g);
  }
  bar.appendChild(edge.end);
  for (const el of Object.values(edge)) if (!el.childElementCount) el.remove();
  // Keys on focused toolbar buttons must not reach the page navigation.
  bar.addEventListener('keydown', e => e.stopPropagation());
  parent.appendChild(bar);

  // Offset the page content by the real bar height (the bar may wrap).
  const setOffset = (): void => {
    const style = document.documentElement.style;
    style.setProperty('--ann-bar-h', `${bar.offsetHeight}px`);
    style.setProperty('--ann-bar-w', `${bar.offsetWidth}px`);
  };
  if (!document.body.dataset.annDock) document.body.dataset.annDock = loadDock();
  if ('ResizeObserver' in window) new ResizeObserver(setOffset).observe(bar);
  setOffset();

  function update(): void {
    for (const { item, btn } of entries) {
      if (item.text) {
        const t = item.text();
        if (btn.textContent !== t) btn.textContent = t;
        if (!item.onClick) continue;
      }
      if (typeof item.title === 'function') {
        btn.title = item.title();
        btn.setAttribute('aria-label', btn.title);
      }
      if (item.icon) {
        const name = typeof item.icon === 'function' ? item.icon() : item.icon;
        if (btn.dataset.icon !== name) {
          btn.innerHTML = icon(name) + (item.caption ? `<span class="ann-cap">${item.caption}</span>` : '');
          btn.dataset.icon = name;
        }
      }
      const on = item.active ? !!item.active() : false;
      btn.classList.toggle('is-active', on);
      if (item.active) btn.setAttribute('aria-pressed', String(on));
      (btn as HTMLButtonElement).disabled = item.disabled ? !!item.disabled() : false;
      if (item.hidden) btn.hidden = !!item.hidden(); // keeps its place (toolbar.css): the bar does not reflow
    }
    for (const g of hiding) g.hidden = [...g.children].every(b => (b as HTMLElement).hidden);
    setOffset();
  }
  update();
  return { el: bar, update };
}

// ── Keyboard ───────────────────────────────────────────────────

/** A key typed into a text field (input, textarea, select, contenteditable): shortcuts leave it alone. */
export const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));
};

/** Shortcut table entry; later modules push their own. run() returning false leaves the key alone. */
export interface Shortcut {
  test(e: KeyboardEvent): boolean;
  run(e: KeyboardEvent): unknown;
}

/**
 * Letter shortcuts match the physical key (e.code), so they work with any
 * keyboard layout; undo/redo follow the key label like the OS does, with
 * the physical key as fallback on non-Latin layouts.
 */
export const noMods = (e: KeyboardEvent): boolean => !e.ctrlKey && !e.metaKey && !e.altKey;
/** Whether `e` is the physical key of letter `k`. */
export const letter = (e: KeyboardEvent, k: string): boolean => e.code === `Key${k.toUpperCase()}`;
const labelOrCode = (e: KeyboardEvent, k: string): boolean =>
  e.key.toLowerCase() === k || (!/^[a-z]$/i.test(e.key) && letter(e, k));

/** Shortcuts of annotate mode: tools, sizes 1–4, undo/redo, copy/cut/paste/duplicate, delete or drop the selection. */
export function defaultKeymap(app: ToolbarHost): Shortcut[] {
  const mod = (e: KeyboardEvent): boolean => (e.ctrlKey || e.metaKey) && !e.altKey;
  // Copy, cut, paste and duplicate act on the shown page: not while the overview covers it.
  const edit = (e: KeyboardEvent, k: string): boolean => mod(e) && labelOrCode(e, k) && !e.shiftKey &&
    !(app.overview && app.overview.isOpen && app.overview.isOpen());
  const tool = (k: string, id: ToolId, shift = false): Shortcut => ({
    test: e => letter(e, k) && noMods(e) && e.shiftKey === shift,
    run: () => app.setTool(id),
  });
  return [
    { test: e => mod(e) && labelOrCode(e, 'z') && !e.shiftKey, run: () => app.undo() },
    { test: e => mod(e) && ((labelOrCode(e, 'z') && e.shiftKey) || labelOrCode(e, 'y')), run: () => app.redo() },
    { test: e => edit(e, 'c') && !!app.selection, run: () => app.clipboardKey('copy') },
    { test: e => edit(e, 'x') && !!app.selection, run: () => app.clipboardKey('cut') },
    { test: e => edit(e, 'v'), run: () => app.clipboardKey('paste') },
    { test: e => edit(e, 'd') && !!app.selection, run: () => app.duplicateSelection() },
    tool('p', 'pen'), tool('h', 'highlighter'), tool('s', 'selector'),
    tool('l', 'laser'), tool('e', 'eraser'), tool('e', 'partial', true),
    ...[0, 1, 2, 3].map((i): Shortcut => ({
      test: e => (e.code === `Digit${i + 1}` || e.code === `Numpad${i + 1}`) && noMods(e),
      run: () => app.setSize(i),
    })),
    { test: e => (e.key === 'Delete' || e.key === 'Backspace') && !!app.selection, run: () => app.deleteSelection() },
    { test: e => e.key === 'Escape' && !!app.selection, run: () => app.select(null) },
  ];
}

/** Returns a function that removes the listener. */
export function bindKeys(app: Pick<ToolbarHost, 'enabled' | 'toggle'>, keymap: Shortcut[]): () => void {
  // Capture on window so we run before other document listeners
  // (in Marp decks 'p' would open the presenter view, Space/arrows navigate).
  const onKey = (e: KeyboardEvent): void => {
    if (typeof e.key !== 'string' || isTyping(e.target) || e.isComposing) return;
    let handled = false;
    if (letter(e, 'a') && noMods(e) && !e.shiftKey) {
      if (!e.repeat) app.toggle(); // holding A must not flicker the mode
      handled = true;
    } else if (app.enabled) {
      // A shortcut whose run() returns false leaves the key to the page.
      const hit = keymap.find(k => k.test(e));
      if (hit) handled = hit.run(e) !== false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
