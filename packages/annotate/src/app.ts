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
import { clipForPaste, getClip, makeClip, markClipSynced, placeItems, serializeClip, setClip, CLIP_FORMAT, PASTE_OFFSET, type Clip } from './clipboard';
import { normalizeColor } from './color';
import { rectBBox, strokeBBox, unionBBox, type RectLike, type Stroke } from './geometry';
import { createImage, type NotesDoc, type PageImage } from './model';
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
    if (saved && saved.tool === 'snapshot') saved.tool = 'pen'; // a one-off tool: never the tool to start with
    if (saved && saved.prefs) {
      // Take only valid values: the key is shared with the Marp decks, and a bad size would break every stroke.
      for (const k in prefs) {
        const into = prefs[k as keyof Prefs] as { color?: string; size?: number };
        const from = saved.prefs[k] || {};
        const color = normalizeColor(from.color); // the strokes drawn with it must be able to take it
        if ('color' in into && color !== null) into.color = color;
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

/**
 * The latest snapshot started in this window (all documents): a capture that
 * finishes after a later one has started is dropped, so the clip is always
 * the last area chosen.
 */
let snapshotGeneration = 0;

const systemClipboard = (): Clipboard | undefined => {
  try { return typeof navigator !== 'undefined' ? navigator.clipboard : undefined; } catch (_) { return undefined; }
};

/**
 * Put text on the system clipboard if the platform allows it, with `png` as
 * an image for other programs where ClipboardItem exists; resolves to
 * whether the text got there.
 */
async function writeSystemClipboard(text: string, png?: Blob | null): Promise<boolean> {
  try {
    const clipboard = systemClipboard();
    if (png && clipboard && clipboard.write && typeof ClipboardItem !== 'undefined') {
      try {
        await clipboard.write([new ClipboardItem({ 'image/png': png, 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        return true;
      } catch (_) { /* refused (Electron grants no clipboard permission) or no image support: text only */ }
    }
    if (!clipboard || !clipboard.writeText) return false;
    await clipboard.writeText(text);
    return true;
  } catch (_) { return false; } // not allowed: the window's clip still works
}

/** Text of the system clipboard; null where the platform does not allow reading it (or the user declined). */
async function readSystemClipboard(): Promise<string | null> {
  try {
    const clipboard = systemClipboard();
    return clipboard && clipboard.readText ? await clipboard.readText() : null;
  } catch (_) { return null; }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
}

/** An image made by the host (AnnotatorOptions.captureArea and importImage). */
export interface Capture {
  /** The image as a PNG or JPEG data URL within the model's limits (model.createImage); it is stored in the notes. */
  src: string;
  /** A PNG of it for the system clipboard, so other programs can paste it; optional. */
  png?: Blob | null;
  /** Size in pixels (importImage only: an image from another program has no place on the page yet). */
  width?: number;
  height?: number;
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
  /**
   * The snapshot tool's capture: area `rect` (page units) of page `pageId` as it shows (PDF page
   * or paper, images and ink) as an image; null if there is nothing to capture. Without it the
   * snapshot tool captures nothing. The host owns the PDF rendering, so the core stays DOM-light.
   */
  captureArea?(pageId: string, rect: RectLike): Promise<Capture | null>;
  /**
   * An image pasted from another program (Ctrl/Cmd+V with an image on the system clipboard) as a
   * capture within the model's limits, with its pixel size; null to ignore it. Optional.
   */
  importImage?(image: Blob): Promise<Capture | null>;
  /** Show a short message (a snapshot copied, a paste refused). Optional. */
  notify?(text: string, kind?: 'info' | 'warn' | 'error'): void;
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
  overview: { open(): void; isOpen?(): boolean; prompt?(): string | null; refresh?(): void } | null;
  /** Called after model page changes (insert/delete/paper/undo/load). */
  onPagesChanged: ((pageId: string | null) => void) | null;
  /** Called on every refresh (after the toolbar update). */
  onRefresh: (() => void) | null;
  sync: { laser(pageId: string, pt: [number, number, number]): void } | null;

  currentTool(): Tool;
  activeSurface(): Surface | null;
  activeStrokes(): readonly Stroke[];
  activeImages(): readonly PageImage[];
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
  selectedImages(): PageImage[];
  select(sel: { pageId: string; ids: readonly string[] } | null): void;
  refreshSelection(): void;
  /** Remove the selected strokes and images (one undo step, labelled `label`, default 'delete'). */
  deleteSelection(label?: string): void;
  /** Copy the selection to this window's clip (and, if allowed, the system clipboard). */
  copySelection(): void;
  /** Copy the selection, then remove it (one undo step). */
  cutSelection(): void;
  /**
   * Paste onto the shown page: a clip on the system clipboard if it can be read (it may come
   * from another window), else this window's clip (see clipboard.clipForPaste).
   */
  paste(): Promise<void>;
  /** Paste `clip` onto the shown page in one undo step; the pasted items become the selection (with the select tool). */
  pasteClip(clip: Clip): void;
  /**
   * The snapshot tool's release: capture `rect` of page `pageId` (options.captureArea), make it
   * this window's clip (and, if allowed, the system clipboard's, also as a PNG), say so, and go
   * back to the tool used before the snapshot tool.
   */
  snapshot(pageId: string, rect: RectLike): Promise<void>;
  /** Leave the snapshot tool for the tool used before it (Escape). */
  leaveSnapshot(): void;
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
  const notify = (text: string, kind: 'info' | 'warn' | 'error' = 'info'): void => { if (opts.notify) opts.notify(text, kind); };
  /** The tool to go back to after a snapshot. */
  let beforeSnapshot: ToolId = tool;
  /** mount()'s unbind ran: the document is closed, a snapshot still running is dropped. */
  let unmounted = false;
  /** The tool a size command changes: the current one if it has a size, else the pen. */
  const sizedTool = (): SizedTool => (toolInfo(app.tool).size ? app.tool as SizedTool : 'pen');
  /** The selection as a clip; null without one. */
  const selectionClip = (): Clip | null =>
    app.selection && makeClip(app.selectedStrokes(), doc.pageSize(app.selection.pageId), app.selectedImages());
  /** Add the strokes and images of `clip` to page `pageId` and select them. */
  const pasteOnto = (pageId: string, clip: Clip, label: string): void => {
    if (!doc.hasPage(pageId)) return;
    const size = doc.pageSize(pageId);
    const step = PASTE_OFFSET * render.pageUnit(size);
    const { strokes, images } = placeItems(clip, { size, strokes: doc.strokes(pageId), images: doc.images(pageId), step });
    const full = doc.imageRoom(pageId, images) || doc.inkRoom(pageId, strokes, images.length);
    if (full) return notify(`Not pasted: ${full}`, 'warn');
    if (!doc.addItems(pageId, strokes, images, label)) return;
    if (app.tool !== 'selector') app.setTool('selector');
    app.select({ pageId, ids: [...images.map(i => i.id), ...strokes.map(s => s.id)] });
  };
  /** Paste an image from another program onto the shown page, fitted into it (see AnnotatorOptions.importImage). */
  const pasteImage = async (blob: Blob): Promise<void> => {
    const s = app.activeSurface();
    if (!s || !opts.importImage) return;
    let cap: Capture | null;
    try { cap = await opts.importImage(blob); } catch (e) { return notify(`The image could not be pasted: ${(e as Error).message || e}`, 'warn'); }
    const now = app.activeSurface();
    if (!cap || !now || now.pageId !== s.pageId || !doc.hasPage(s.pageId)) return;
    const [w, h] = doc.pageSize(s.pageId);
    const pw = cap.width || 1, ph = cap.height || 1;
    // At most one page unit per pixel, and at most 80 % of the page, centered.
    const k = Math.min(1, (0.8 * w) / pw, (0.8 * h) / ph);
    let image: PageImage;
    try {
      image = createImage({ x: (w - pw * k) / 2, y: (h - ph * k) / 2, w: pw * k, h: ph * k, src: cap.src });
    } catch (e) { return notify(`The image could not be pasted: ${(e as Error).message}`, 'warn'); }
    pasteOnto(s.pageId, makeClip([], [w, h], [image])!, 'paste');
  };
  // The clipboard key waiting for the browser's copy, cut or paste event (see clipboardKey).
  let pendingKey: 'copy' | 'cut' | 'paste' | null = null;
  const onClipboardEvent = (e: ClipboardEvent): void => {
    if (e.type !== pendingKey) return;
    pendingKey = null;
    e.preventDefault();
    const data = e.clipboardData;
    if (e.type === 'paste') {
      // An image or files on the clipboard have types but no text.
      const text = data ? data.getData('text/plain') : null;
      const file = data && data.files ? [...data.files].find(f => f.type === 'image/png' || f.type === 'image/jpeg') : null;
      // An image with no clip text of Inkslide's next to it was copied in another program: it wins
      // over this window's clip, also one that never reached the system clipboard (Electron).
      const foreignImage = !!file && !!opts.importImage && !(typeof text === 'string' && text.includes(CLIP_FORMAT));
      const clip = foreignImage ? null : clipForPaste(text, !!(data && data.types && data.types.length));
      if (clip) app.pasteClip(clip);
      else if (file) void pasteImage(file);
      return;
    }
    const clip = selectionClip();
    if (!clip) return;
    setClip(clip);
    if (data) {
      const text = serializeClip(clip);
      data.setData('text/plain', text);
      markClipSynced(text);
    }
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
    notify,

    currentTool() { return app.tools[app.tool]; },
    activeSurface() { return opts.activeSurface(); },
    activeStrokes() {
      const s = app.activeSurface();
      return s ? doc.strokes(s.pageId) : [];
    },
    activeImages() {
      const s = app.activeSurface();
      return s ? doc.images(s.pageId) : [];
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
        if (id === 'snapshot') beforeSnapshot = app.tool;
        app.tool = id;
        if (id !== 'snapshot') savePrefs(storage, app); // a one-off tool: the saved tool stays the one before
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
    selectedImages() {
      if (!app.selection) return [];
      const ids = new Set(app.selection.ids);
      return doc.images(app.selection.pageId).filter(i => ids.has(i.id));
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
      const images = app.selectedImages();
      const surface = surfaces.get(sel.pageId);
      if ((!strokes.length && !images.length) || !surface) {
        app.selection = null;
        if (surface) render.setSelectionBox(surface.layer, null);
        return;
      }
      sel.ids = [...images.map(i => i.id), ...strokes.map(s => s.id)];
      sel.box = unionBBox([...images.map(rectBBox), ...strokes.map(strokeBBox)]);
      render.setSelectionBox(surface.layer, sel.box);
    },
    deleteSelection(label) {
      const sel = app.selection;
      if (!sel) return;
      app.select(null);
      doc.removeItems(sel.pageId, sel.ids, label);
    },

    // Clipboard

    copySelection() {
      const clip = selectionClip();
      if (!clip) return;
      setClip(clip);
      const text = serializeClip(clip);
      void writeSystemClipboard(text).then(ok => { if (ok && getClip() === clip) markClipSynced(text); });
      app.refresh();
    },
    cutSelection() {
      if (!app.selection) return;
      app.copySelection();
      app.deleteSelection('cut');
    },
    async paste() {
      // Reading may wait for a browser prompt: a paste after a page turn or a new stroke started meanwhile is dropped.
      const s = app.activeSurface();
      const busy = app.input.busy;
      const text = await readSystemClipboard();
      const now = app.activeSurface();
      if (!s || !now || now.pageId !== s.pageId || (app.input.busy && !busy)) return;
      const clip = clipForPaste(text);
      if (clip) app.pasteClip(clip);
    },
    pasteClip(clip) {
      const s = app.activeSurface();
      if (!s) return;
      if (app.input.busy) app.input.cancel();
      pasteOnto(s.pageId, clip, 'paste');
    },
    duplicateSelection() {
      const sel = app.selection;
      const clip = selectionClip();
      if (sel && clip) pasteOnto(sel.pageId, clip, 'duplicate');
    },
    async snapshot(pageId, rect) {
      if (!opts.captureArea) return;
      const generation = ++snapshotGeneration;
      // A later snapshot started meanwhile, or this document was closed (unmounted): drop this one.
      const stale = (): boolean => generation !== snapshotGeneration || unmounted;
      let image: PageImage;
      let png: Blob | null | undefined;
      try {
        const cap = await opts.captureArea(pageId, rect);
        if (!cap || stale()) return;
        image = createImage({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, src: cap.src });
        png = cap.png;
      } catch (e) {
        if (stale()) return;
        return notify(`The snapshot failed: ${(e as Error).message || e}`, 'error');
      }
      // The image sits where the area was: pasted on a page of the same size, it covers the area exactly.
      const clip = makeClip([], doc.pageSize(pageId), [image])!;
      setClip(clip);
      const text = serializeClip(clip);
      void writeSystemClipboard(text, png).then(ok => { if (ok && getClip() === clip) markClipSynced(text); });
      notify('Snapshot copied. Paste it with Ctrl/Cmd+V or the paste button, on any page.');
      app.leaveSnapshot();
      app.refresh();
    },
    leaveSnapshot() {
      if (app.tool === 'snapshot') app.setTool(beforeSnapshot !== 'snapshot' ? beforeSnapshot : 'pen');
    },
    canPaste() { return !!getClip(); },
    clipboardKey(kind) {
      pendingKey = kind;
      setTimeout(() => {
        if (pendingKey !== kind) return; // the event came
        pendingKey = null;
        if (kind === 'copy') app.copySelection();
        else if (kind === 'cut') app.cutSelection();
        else void app.paste();
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
      unmounted = false;
      return () => {
        unmounted = true;
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
      if (surface) {
        render.syncLayer(surface.layer, doc.strokes(pageId));
        render.syncImages(surface.layer, doc.images(pageId));
      }
    } else if (kind === 'strokes') {
      surfaces.forEach(s => { // every page (load)
        render.syncLayer(s.layer, doc.strokes(s.pageId));
        render.syncImages(s.layer, doc.images(s.pageId));
      });
    }
    // A save changes no strokes: redrawing the box would undo a running drag's offset.
    if (kind !== 'saved' && app.selection && (pageId === null || app.selection.pageId === pageId)) app.refreshSelection();
    app.refresh();
  });
  doc.history.onChange(() => app.refresh());

  return app;
}
