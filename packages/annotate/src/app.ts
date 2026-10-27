/* Inkslide annotate - app state: current tool, prefs, selection, commands
 *
 * The page-independent part of Marp Notes main.js (© Andres Gomez, MIT).
 * The Marp bootstrap (finding slide SVGs, watching bespoke's slide classes)
 * is left out: the viewer creates the surfaces, tells the app which one is
 * active and calls pageChanged() on a page turn.
 *
 * Boot sequence (as in main.js):
 *   const app = createAnnotator({ doc, activeSurface: () => current });
 *   app.surfaces.set(id, surface); app.input.attach(surface);   // per page
 *   app.pages = myPages; registerGroup('pages', pagesGroup);       // optional
 *   app.keymap.push(...);                                          // optional
 *   app.mount();                                                   // keys + toolbar
 */
import { strokeBBox, unionBBox, type Stroke } from './geometry';
import type { NotesDoc } from './model';
import { attachInput, type InputController } from './input';
import * as render from './render';
import { createTools, DEFAULT_PREFS, nextSize, SIZE_PRESETS, SIZES, sizeIndex, toolSize, TOOLS, type Prefs, type Selection, type SizedTool, type Surface, type Tool, type ToolId, type ToolRenderer, type Tools } from './tools';
import { bindKeys, createToolbar, defaultKeymap, type Shortcut, type Toolbar } from './toolbar';
import type { PagesController } from './pages';

/**
 * localStorage key of the tool prefs (the Marp Notes key, so decks and Inkslide share them in one
 * origin).
 */
export const PREFS_KEY = 'marp-notes-prefs-v1';

/**
 * Prefs as stored: per-tool color and size, and the current tool. A tool's size is stored twice:
 * `step` is the step of the size scale (SIZES), `size` the nearest preset S, M, L, XL (0..3), the
 * value earlier versions and the Marp decks read. Prefs without a `step` load their preset.
 */
export interface StoredPrefs {
  prefs: Prefs;
  tool: ToolId;
}

/** Stored prefs merged over the defaults; the defaults if there are none or they are broken. */
export function loadPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): StoredPrefs {
  const prefs: Prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));
  try {
    const saved = JSON.parse((storage && storage.getItem(PREFS_KEY)) || 'null');
    if (saved && saved.prefs) {
      // Take only valid values: the key is shared with the Marp decks, and a bad size would break every stroke.
      for (const k in prefs) {
        const into = prefs[k as keyof Prefs] as { color?: string; size?: number };
        const from = saved.prefs[k] || {};
        if ('color' in into && typeof from.color === 'string') into.color = from.color;
        if (!('size' in into)) continue;
        if (Number.isInteger(from.step) && SIZES[k as SizedTool][from.step] !== undefined) into.size = from.step;
        else if (Number.isInteger(from.size) && SIZE_PRESETS[from.size as number] !== undefined) into.size = SIZE_PRESETS[from.size as number];
      }
    }
    return { prefs, tool: saved && TOOLS.some(t => t.id === saved.tool) ? saved.tool : 'pen' };
  } catch (_) {
    return { prefs, tool: 'pen' };
  }
}

/** The preset (0..3) nearest to a size step; the smaller one when two are as near. */
export function nearestPreset(step: number): number {
  let best = 0;
  SIZE_PRESETS.forEach((p, i) => { if (Math.abs(p - step) < Math.abs(SIZE_PRESETS[best] - step)) best = i; });
  return best;
}

function savePrefs(storage: Pick<Storage, 'setItem'> | null, app: StoredPrefs): void {
  const prefs: Record<string, object> = {};
  for (const [k, v] of Object.entries(app.prefs)) {
    prefs[k] = 'size' in v ? { ...v, size: nearestPreset(v.size), step: v.size } : v;
  }
  try {
    if (storage) storage.setItem(PREFS_KEY, JSON.stringify({ tool: app.tool, prefs }));
  } catch (_) { /* storage blocked: prefs are a convenience only */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
}

/** Options of createAnnotator. */
export interface AnnotatorOptions {
  doc: NotesDoc;
  /** The surface being written on (the shown page or blank page). */
  activeSurface(): Surface | null;
  /** Prefs storage; default localStorage, null for none. */
  storage?: Storage | null;
  /** Element that gets the ann-on class and data-ann-tool; default document.body. */
  body?: HTMLElement;
  /** Render functions for the tools; default render.ts (e.g. a canvas live stroke instead). */
  renderer?: ToolRenderer;
}

/** App state and commands shared by the toolbar, the keys and the viewer (see createAnnotator). */
export interface Annotator {
  doc: NotesDoc;
  /** Every drawable surface by page id. */
  surfaces: Map<string, Surface>;
  prefs: Prefs;
  tool: ToolId;
  enabled: boolean;
  selection: Selection | null;
  tools: Tools;
  input: InputController;
  toolbar: Toolbar | null;
  keymap: Shortcut[];
  pages: PagesController | null;
  overview: { open(): void; prompt?(): string | null; refresh?(): void } | null;
  /** Called after model page changes (insert/delete/paper/undo/load). */
  onPagesChanged: ((pageId: string | null) => void) | null;
  /** Called on every refresh (after the toolbar update). */
  onRefresh: (() => void) | null;
  sync: { laser(pageId: string, pt: [number, number, number]): void } | null;

  currentTool(): Tool;
  activeSurface(): Surface | null;
  activeStrokes(): readonly Stroke[];
  toggle(on?: boolean): void;
  setTool(id: ToolId): void;
  currentColor(): string | null;
  currentSize(): number | null;
  setColor(color: string): void;
  /** Set size step i of the current tool, or restyle the selection to it. */
  setSize(i: number): void;
  /** One size step smaller (-1) or larger (1): the current tool's size, or each selected stroke's. */
  stepSize(dir: -1 | 1): void;
  /** Whether stepSize(dir) changes something (false at the end of the scale). */
  canStepSize(dir: -1 | 1): boolean;
  selectedStrokes(): Stroke[];
  select(sel: { pageId: string; ids: readonly string[] } | null): void;
  refreshSelection(): void;
  deleteSelection(): void;
  undo(): void;
  redo(): void;
  clearPage(): void;
  refresh(): void;
  /** The shown page changed: drop transient state of the page left behind. */
  pageChanged(previous: Surface | null): void;
  /** Bind the shortcuts and build the toolbar. Returns a function that unbinds the keys. */
  mount(parent?: HTMLElement): () => void;
}

/**
 * The annotation app for one document: tools, input routing, prefs, selection and commands. Call
 * mount() to bind the keys and build the toolbar.
 */
export function createAnnotator(opts: AnnotatorOptions): Annotator {
  const { doc } = opts;
  const storage = opts.storage === undefined ? safeStorage() : opts.storage;
  const body = opts.body || document.body;
  const surfaces = new Map<string, Surface>();
  const toolInfo = (id: ToolId) => TOOLS.find(t => t.id === id)!;
  /** Tool size scale of the selection's page (sizes are stored scaled, see tools.toolSize). */
  const selectionUnit = (): number => {
    const surface = app.selection && surfaces.get(app.selection.pageId);
    return surface ? surface.layer.unit ?? 1 : 1;
  };
  const { prefs, tool } = loadPrefs(storage);
  /** The tool a size command changes: the current one if it has a size, else the pen. */
  const sizedTool = (): SizedTool => (toolInfo(app.tool).size ? app.tool as SizedTool : 'pen');

  const app = {
    doc, surfaces, prefs, tool,
    enabled: false,
    selection: null, // { pageId, ids, box }
    tools: null as unknown as Tools,
    input: null as unknown as InputController,
    toolbar: null,
    keymap: [],
    pages: null,
    overview: null,
    onPagesChanged: null,
    onRefresh: null,
    sync: null,

    currentTool() { return app.tools[app.tool]; },
    activeSurface() { return opts.activeSurface(); },
    activeStrokes() {
      const s = app.activeSurface();
      return s ? doc.strokes(s.pageId) : [];
    },

    toggle(on = !app.enabled) {
      if (on === app.enabled) return;
      if (app.input) app.input.cancel();
      app.enabled = on;
      if (!on) {
        app.select(null);
        surfaces.forEach(s => { if (s.layer.laser) s.layer.laser.clear(); }); // no laser nodes where none was used
        const t = app.currentTool();
        if (t.deactivate) t.deactivate();
      }
      body.classList.toggle('ann-on', on);
      app.refresh();
    },

    setTool(id) {
      if (!app.tools[id]) return;
      if (id !== app.tool) {
        app.input.cancel();
        const old = app.currentTool();
        if (old.deactivate) old.deactivate();
        app.tool = id;
        savePrefs(storage, app);
      }
      body.dataset.annTool = id;
      app.refresh();
    },

    /** Color of the current tool, or of the selection; null if neither has one. */
    currentColor() {
      if (app.tool === 'selector' && app.selection) {
        const colors = new Set(app.selectedStrokes().map(s => s.color));
        return colors.size === 1 ? [...colors][0] : null;
      }
      return toolInfo(app.tool).color ? (app.prefs[app.tool] as { color: string }).color : null;
    },
    currentSize() {
      if (app.tool === 'selector' && app.selection) {
        const unit = selectionUnit();
        const idx = new Set(app.selectedStrokes().map(s => sizeIndex(s.tool, s.size, unit)));
        return idx.size === 1 && !idx.has(-1) ? [...idx][0] : null;
      }
      return toolInfo(app.tool).size ? app.prefs[app.tool as SizedTool].size : null;
    },

    setColor(color) {
      if (app.tool === 'selector' && app.selection) {
        doc.restyleStrokes(app.selection.pageId, app.selection.ids, { color });
        return;
      }
      if (!toolInfo(app.tool).color) app.setTool('pen');
      (app.prefs[app.tool] as { color: string }).color = color;
      savePrefs(storage, app);
      app.refresh();
    },

    setSize(i) {
      if (app.tool === 'selector' && app.selection) {
        const unit = selectionUnit();
        doc.restyleStrokes(app.selection.pageId, app.selection.ids, { size: s => toolSize(s.tool, i, unit) });
        return;
      }
      if (!toolInfo(app.tool).size) app.setTool('pen');
      app.prefs[app.tool as SizedTool].size = i;
      savePrefs(storage, app);
      app.refresh();
    },

    stepSize(dir) {
      if (app.tool === 'selector' && app.selection) {
        const unit = selectionUnit();
        doc.restyleStrokes(app.selection.pageId, app.selection.ids, { size: s => nextSize(s.tool, s.size, dir, unit) });
        return;
      }
      // A tool without a size steps the pen's (as the size buttons did).
      const i = app.prefs[sizedTool()].size + dir;
      if (SIZES[sizedTool()][i] !== undefined) app.setSize(i);
    },
    canStepSize(dir) {
      if (app.tool === 'selector' && app.selection) {
        const unit = selectionUnit();
        return app.selectedStrokes().some(s => nextSize(s.tool, s.size, dir, unit) !== s.size);
      }
      return SIZES[sizedTool()][app.prefs[sizedTool()].size + dir] !== undefined;
    },

    // Selection

    selectedStrokes() {
      if (!app.selection) return [];
      const ids = new Set(app.selection.ids);
      return doc.strokes(app.selection.pageId).filter(s => ids.has(s.id));
    },
    select(sel) {
      const prev = app.selection;
      if (prev && surfaces.has(prev.pageId)) render.setSelectionBox(surfaces.get(prev.pageId)!.layer, null);
      app.selection = sel ? { pageId: sel.pageId, ids: sel.ids.slice(), box: null } : null;
      app.refreshSelection();
      app.refresh();
    },
    refreshSelection() {
      const sel = app.selection;
      if (!sel) return;
      const strokes = app.selectedStrokes();
      const surface = surfaces.get(sel.pageId);
      if (!strokes.length || !surface) {
        app.selection = null;
        if (surface) render.setSelectionBox(surface.layer, null);
        return;
      }
      sel.ids = strokes.map(s => s.id);
      sel.box = unionBBox(strokes.map(strokeBBox));
      render.setSelectionBox(surface.layer, sel.box);
    },
    deleteSelection() {
      const sel = app.selection;
      if (!sel) return;
      app.select(null);
      doc.removeStrokes(sel.pageId, sel.ids);
    },

    // Commands

    // Mid-gesture, Ctrl+Z only finishes the stroke being drawn.
    undo() { if (app.input.busy) app.input.cancel(); else doc.undo(); },
    redo() { if (app.input.busy) app.input.cancel(); else doc.redo(); },
    clearPage() {
      const s = app.activeSurface();
      app.select(null);
      if (s) doc.clearPage(s.pageId);
    },

    refresh() {
      if (app.toolbar) app.toolbar.update();
      if (app.overview && app.overview.refresh) app.overview.refresh();
      if (app.onRefresh) app.onRefresh();
    },

    pageChanged(previous) {
      app.input.cancel();
      if (previous) {
        if (previous.layer.laser) previous.layer.laser.clear();
        render.setEraserCursor(previous.layer, null);
      }
      app.select(null);
      app.refresh();
    },

    mount(parent) {
      const unbind = bindKeys(app, app.keymap);
      app.toolbar = createToolbar(app, parent);
      app.refresh();
      return unbind;
    },
  } as Annotator;

  app.tools = createTools(app, opts.renderer);
  app.input = attachInput(app);
  body.dataset.annTool = app.tool;
  app.keymap = defaultKeymap(app);

  doc.onChange((pageId, kind) => {
    if (kind === 'pages') {
      if (app.onPagesChanged) app.onPagesChanged(pageId);
    } else if (pageId) {
      const surface = surfaces.get(pageId);
      if (surface) render.syncLayer(surface.layer, doc.strokes(pageId));
    } else if (kind === 'strokes') {
      surfaces.forEach(s => render.syncLayer(s.layer, doc.strokes(s.pageId))); // every page (load)
    }
    if (app.selection && (pageId === null || app.selection.pageId === pageId)) app.refreshSelection();
    app.refresh();
  });
  doc.history.onChange(() => app.refresh());

  return app;
}
