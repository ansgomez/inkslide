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
import { getClip, makeClip, parseClip, placeClip, serializeClip, setClip, PASTE_OFFSET, type Clip } from './clipboard';
import { strokeBBox, unionBBox, type Stroke } from './geometry';
import type { NotesDoc } from './model';
import { attachInput, type InputController } from './input';
import * as render from './render';
import { createTools, DEFAULT_PREFS, SIZES, sizeIndex, toolSize, TOOLS, type Prefs, type Selection, type SizedTool, type Surface, type Tool, type ToolId, type ToolRenderer, type Tools } from './tools';
import { bindKeys, createToolbar, defaultKeymap, type Shortcut, type Toolbar } from './toolbar';
import type { PagesController } from './pages';

/**
 * localStorage key of the tool prefs (the Marp Notes key, so decks and Inkslide share them in one
 * origin).
 */
export const PREFS_KEY = 'marp-notes-prefs-v1';

/** Prefs as stored: per-tool color and size, and the current tool. */
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
        if ('size' in into && Number.isInteger(from.size) && SIZES[k as SizedTool][from.size] !== undefined) into.size = from.size;
      }
    }
    return { prefs, tool: saved && TOOLS.some(t => t.id === saved.tool) ? saved.tool : 'pen' };
  } catch (_) {
    return { prefs, tool: 'pen' };
  }
}

function savePrefs(storage: Pick<Storage, 'setItem'> | null, app: StoredPrefs): void {
  try {
    if (storage) storage.setItem(PREFS_KEY, JSON.stringify({ tool: app.tool, prefs: app.prefs }));
  } catch (_) { /* storage blocked: prefs are a convenience only */ }
}

/** Put text on the system clipboard if the platform allows it; a refusal is ignored (the window's clip still works). */
function writeSystemClipboard(text: string): void {
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard && clipboard.writeText) clipboard.writeText(text).catch(() => { /* not allowed */ });
  } catch (_) { /* not allowed */ }
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
  setSize(i: number): void;
  selectedStrokes(): Stroke[];
  select(sel: { pageId: string; ids: readonly string[] } | null): void;
  refreshSelection(): void;
  /** Remove the selected strokes (one undo step, labelled `label`, default 'delete'). */
  deleteSelection(label?: string): void;
  /** Copy the selection to this window's clip (and, if allowed, the system clipboard). */
  copySelection(): void;
  /** Copy the selection, then remove it (one undo step). */
  cutSelection(): void;
  /**
   * Paste a clip (default: this window's) onto the shown page in one undo step; the pasted
   * strokes become the selection (with the select tool).
   */
  paste(clip?: Clip | null): void;
  /** Paste a copy of the selection onto its page, offset, without touching the clip. */
  duplicateSelection(): void;
  canPaste(): boolean;
  /**
   * Ctrl/Cmd+C, X or V. Returns false, so the browser goes on to fire its copy, cut or paste
   * event, which reads and writes the system clipboard without asking for permission; the event
   * does the work. Where no event comes (Electron on macOS has no Edit menu), the key does it
   * right after with this window's clip.
   */
  clipboardKey(kind: 'copy' | 'cut' | 'paste'): boolean;
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
  /** The selection as a clip; null without one. */
  const selectionClip = (): Clip | null =>
    app.selection && makeClip(app.selectedStrokes(), doc.pageSize(app.selection.pageId));
  /** Add the strokes of `clip` to page `pageId` and select them. */
  const pasteOnto = (pageId: string, clip: Clip, label: string): void => {
    if (!doc.hasPage(pageId)) return;
    const size = doc.pageSize(pageId);
    const step = PASTE_OFFSET * render.pageUnit(size);
    const strokes = placeClip(clip, { size, strokes: doc.strokes(pageId), step });
    if (!doc.addStrokes(pageId, strokes, label)) return;
    if (app.tool !== 'selector') app.setTool('selector');
    app.select({ pageId, ids: strokes.map(s => s.id) });
  };
  // The clipboard key waiting for the browser's copy, cut or paste event (see clipboardKey).
  let pendingKey: 'copy' | 'cut' | 'paste' | null = null;
  const onClipboardEvent = (e: ClipboardEvent): void => {
    if (e.type !== pendingKey) return;
    pendingKey = null;
    e.preventDefault();
    const data = e.clipboardData;
    if (e.type === 'paste') {
      const clip = parseClip(data && data.getData('text/plain'));
      if (clip) setClip(clip); // copied in another window
      app.paste();
      return;
    }
    const clip = selectionClip();
    if (!clip) return;
    setClip(clip);
    if (data) data.setData('text/plain', serializeClip(clip));
    if (e.type === 'cut') app.deleteSelection('cut');
    app.refresh();
  };

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
    deleteSelection(label) {
      const sel = app.selection;
      if (!sel) return;
      app.select(null);
      doc.removeStrokes(sel.pageId, sel.ids, label);
    },

    // Clipboard

    copySelection() {
      const clip = selectionClip();
      if (!clip) return;
      setClip(clip);
      writeSystemClipboard(serializeClip(clip));
      app.refresh();
    },
    cutSelection() {
      if (!app.selection) return;
      app.copySelection();
      app.deleteSelection('cut');
    },
    paste(clip = getClip()) {
      const s = app.activeSurface();
      if (!clip || !s) return;
      if (app.input.busy) app.input.cancel();
      pasteOnto(s.pageId, clip, 'paste');
    },
    duplicateSelection() {
      const sel = app.selection;
      const clip = selectionClip();
      if (sel && clip) pasteOnto(sel.pageId, clip, 'duplicate');
    },
    canPaste() { return !!getClip(); },
    clipboardKey(kind) {
      pendingKey = kind;
      setTimeout(() => {
        if (pendingKey !== kind) return; // the event came
        pendingKey = null;
        if (kind === 'copy') app.copySelection();
        else if (kind === 'cut') app.cutSelection();
        else app.paste();
      }, 0);
      return false;
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
      const events = ['copy', 'cut', 'paste'] as const;
      for (const type of events) window.addEventListener(type, onClipboardEvent, true);
      app.toolbar = createToolbar(app, parent);
      app.refresh();
      return () => {
        unbind();
        for (const type of events) window.removeEventListener(type, onClipboardEvent, true);
      };
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
