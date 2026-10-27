/* Inkslide annotate - tool behaviours
 *
 * Ported from Marp Notes tools.js (© Andres Gomez, MIT).
 * A tool is { id, down, move, up, cancel, hover, leave, deactivate }; every
 * handler gets (surface, pt, event) with pt = [x, y, pressure] in page units.
 * Tools edit the document only through NotesDoc commands, so every finished
 * gesture is one undo step. The laser never touches the document.
 */
import {
  isLasso, pathLength, rectPolygon, splitByEraser, smoothPoints, strokeHitsSegment, strokesInPolygon,
  type BBox, type Point, type Stroke, type StrokeTool, type XY,
} from './geometry';
import { createStroke, type NotesDoc } from './model';
import * as render from './render';
import type { Layer } from './render';

/** The eight colors of the toolbar. */
export const COLORS = [
  { id: 'black', value: '#000000', label: 'Black' },
  { id: 'white', value: '#ffffff', label: 'White' },
  { id: 'red', value: '#be1e3c', label: 'TU Braunschweig red' },
  { id: 'blue', value: '#1e64c8', label: 'Blue' },
  { id: 'green', value: '#2e8b3a', label: 'Green' },
  { id: 'orange', value: '#f08c00', label: 'Orange' },
  { id: 'yellow', value: '#ffd200', label: 'Yellow' },
  { id: 'purple', value: '#7a3c96', label: 'Purple' },
] as const;

/** Labels of the four sizes. */
export const SIZE_LABELS = ['S', 'M', 'L', 'XL'] as const;
/** The four sizes per tool, in units of a 1280×720 slide (scaled by layer.unit). */
export const SIZES = {
  pen: [2, 4, 7, 12],           // stroke width
  highlighter: [12, 20, 32, 48],
  eraser: [8, 16, 32, 64],      // eraser radius
  partial: [8, 16, 32, 64],
} as const;

/** Every tool. */
export type ToolId = 'pen' | 'highlighter' | 'selector' | 'laser' | 'eraser' | 'partial';
/** Tools with a size setting. */
export type SizedTool = keyof typeof SIZES;
/** Index into SIZES[tool] (0..3). */
export type SizeIndex = number;

/** Per-tool settings (color, size index). */
export interface Prefs {
  pen: { color: string; size: SizeIndex };
  highlighter: { color: string; size: SizeIndex };
  eraser: { size: SizeIndex };
  partial: { size: SizeIndex };
  selector: Record<string, never>;
  laser: Record<string, never>;
}

/** Prefs before the user changes anything. */
export const DEFAULT_PREFS: Readonly<Prefs> = {
  pen: { color: '#000000', size: 1 },
  highlighter: { color: '#ffd200', size: 1 },
  eraser: { size: 1 },
  partial: { size: 1 },
  selector: {},
  laser: {},
};

/** A drawable page on screen: a PDF page, a blank page or a Marp slide. */
export interface Surface {
  pageId: string;
  svg: SVGSVGElement;
  layer: Layer;
  /** Owning slide/page number (1-based). */
  n?: number;
  blank?: boolean;
}

/** Selected strokes on one page; box is their bounding box. */
export interface Selection {
  pageId: string;
  ids: string[];
  box: BBox | null;
}

/** What the tools need from the app. */
export interface ToolHost {
  doc: NotesDoc;
  prefs: Prefs;
  selection: Selection | null;
  select(sel: { pageId: string; ids: readonly string[] } | null): void;
  /** Every surface with a layer (Map or array). */
  surfaces: { forEach(fn: (s: Surface) => void): void };
  /** Mirror of the laser to another window (presenter view, later). */
  sync?: { laser(pageId: string, pt: Point): void } | null;
}

/** The event part tools look at (Shift draws straight lines). */
export type ToolEvent = { shiftKey?: boolean } | null | undefined;

/** A tool: handlers for one pointer gesture on a surface (all optional). */
export interface Tool {
  id: ToolId;
  down?(surface: Surface, pt: Point, e?: ToolEvent): void;
  move?(surface: Surface, pt: Point, e?: ToolEvent): void;
  /** Commits the gesture; pt and e are null when ended by cancel/blur/etc. */
  up?(surface: Surface, pt: Point | null, e?: ToolEvent): void;
  cancel?(surface: Surface, pt?: Point | null, e?: ToolEvent): void;
  hover?(surface: Surface, pt: Point, e?: ToolEvent): void;
  leave?(surface: Surface, pt?: Point | null, e?: ToolEvent): void;
  deactivate?(): void;
}

/** All tools by id. */
export type Tools = Record<ToolId, Tool>;

/** The render functions the tools use; injectable for tests. */
export interface ToolRenderer {
  liveStroke(layer: Layer, tool: StrokeTool): { update(stroke: Stroke): void; remove(): void };
  syncLayer(layer: Layer, strokes: readonly Stroke[]): void;
  setEraserCursor(layer: Layer, pt: XY | null, r?: number): void;
  translateStrokes(layer: Layer, ids: readonly string[], dx: number, dy: number): void;
  setSelectionBox(layer: Layer, box: BBox | null, dx?: number, dy?: number): void;
  setMarquee(layer: Layer, poly: readonly XY[] | null): void;
  laser(layer: Layer): { add(pt: XY): void };
}

/** Size i of a tool on a page with tool size scale `unit` (render.pageUnit), in page units. */
export const toolSize = (tool: SizedTool, i: SizeIndex, unit = 1): number => SIZES[tool][i] * unit;

/** Index of a stroke size among a tool's sizes on a page with scale `unit`; -1 if it is none of them. */
export function sizeIndex(tool: SizedTool, size: number, unit = 1): SizeIndex {
  return SIZES[tool].findIndex(v => Math.abs(v * unit - size) <= 1e-3 * v * unit);
}

/** Size of a tool on a surface's page, in its page units (unscaled if the page has no usable scale). */
function sizeOf(app: ToolHost, tool: SizedTool, surface: Surface): number {
  const unit = surface.layer.unit;
  return toolSize(tool, app.prefs[tool].size, Number.isFinite(unit) && unit > 0 ? unit : 1);
}

// ── Pen / highlighter ──────────────────────────────────────────

function inkTool(app: ToolHost, id: StrokeTool, R: ToolRenderer): Tool {
  let raw: Point[] | null = null, live: ReturnType<ToolRenderer['liveStroke']> | null = null;
  let frame = 0, straight = false, size = 0;

  const current = () => {
    const r = raw!;
    const pts = straight ? [r[0], r[r.length - 1]] : smoothPoints(r);
    return { tool: id, color: app.prefs[id].color, size, points: pts };
  };
  // Redraw the live stroke at most once per frame (moves only collect points).
  const draw = (): void => {
    frame = 0;
    if (raw) live!.update({ id: 'live', ...current() });
  };
  const stopFrame = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  return {
    id,
    down(surface, pt, e) {
      raw = [pt];
      size = sizeOf(app, id, surface);
      straight = !!(e && e.shiftKey);
      live = R.liveStroke(surface.layer, id);
      draw();
    },
    move(_surface, pt, e) {
      if (!raw) return;
      raw.push(pt);
      straight = !!(e && e.shiftKey);
      if (!frame) frame = requestAnimationFrame(draw);
    },
    up(surface, pt, e) {
      if (!raw) return;
      stopFrame();
      // Pens report pressure 0 on release: keep the last real pressure.
      if (pt) raw.push([pt[0], pt[1], raw[raw.length - 1][2]]);
      if (e) straight = !!e.shiftKey;
      const data = current();
      live!.remove();
      raw = live = null;
      // The page may be gone (a blank page deleted while drawing): the stroke goes with it.
      if (app.doc.hasPage(surface.pageId)) app.doc.addStroke(surface.pageId, createStroke(data));
    },
    cancel() {
      stopFrame();
      if (live) live.remove();
      raw = live = null;
    },
  };
}

// ── Erasers ────────────────────────────────────────────────────

/** Same tool, color, size and points (the id is compared by the caller). */
function sameStroke(a: Stroke, b: Stroke): boolean {
  if (a === b) return true;
  if (a.tool !== b.tool || a.color !== b.color || a.size !== b.size || a.points.length !== b.points.length) return false;
  return a.points.every((p, i) => p[0] === b.points[i][0] && p[1] === b.points[i][1] && p[2] === b.points[i][2]);
}

/**
 * Works on a private copy of the page; one command on release, which applies
 * only what was erased to the page as it is then (edits made meanwhile stay).
 */
function eraserTool(app: ToolHost, id: 'eraser' | 'partial', R: ToolRenderer): Tool {
  const partial = id === 'partial';
  let working: Stroke[] | null = null, last: Point | null = null;
  let base: Map<string, Stroke> | null = null; // the page's strokes at down
  let origin: Map<string, string> | null = null; // piece id -> id of the stroke it was cut from

  /** The page's current strokes with this gesture's erasing applied. */
  function erased(current: readonly Stroke[]): Stroke[] {
    const left = new Map<string, Stroke[]>(); // erased stroke id -> its remaining pieces
    for (const s of base!.values()) left.set(s.id, []);
    for (const s of working!) {
      if (base!.get(s.id) === s) left.delete(s.id); // untouched
      else left.get(origin!.get(s.id)!)!.push(s);
    }
    // A stroke changed meanwhile (moved, restyled) is kept as it is now. Compared by
    // content: another window's push or undo rebuilds equal strokes as new objects.
    return current.flatMap(s => (left.has(s.id) && sameStroke(base!.get(s.id)!, s) ? left.get(s.id)! : [s]));
  }

  const radius = (surface: Surface): number => sizeOf(app, id, surface);

  function eraseAlong(surface: Surface, a: Point, b: Point): void {
    const r = radius(surface);
    let changed = false;
    const next: Stroke[] = [];
    for (const s of working!) {
      if (!partial) {
        if (strokeHitsSegment(s, a, b, r)) changed = true;
        else next.push(s);
        continue;
      }
      const pieces = splitByEraser(s, a, b, r);
      if (pieces === null) { next.push(s); continue; }
      changed = true;
      for (const points of pieces) {
        const piece = createStroke({ ...s, id: null, points });
        origin!.set(piece.id, origin!.get(s.id) || s.id);
        next.push(piece);
      }
    }
    if (changed) {
      working = next;
      R.syncLayer(surface.layer, working);
    }
  }

  return {
    id,
    down(surface, pt) {
      working = app.doc.strokes(surface.pageId).slice();
      base = new Map(working.map(s => [s.id, s]));
      origin = new Map();
      last = pt;
      R.setEraserCursor(surface.layer, pt, radius(surface));
      eraseAlong(surface, pt, pt);
    },
    move(surface, pt) {
      if (!working) return;
      R.setEraserCursor(surface.layer, pt, radius(surface));
      eraseAlong(surface, last!, pt);
      last = pt;
    },
    up(surface) {
      if (!working) return;
      const result = app.doc.hasPage(surface.pageId) ? erased(app.doc.strokes(surface.pageId)) : null;
      working = last = base = origin = null;
      if (result) app.doc.replaceStrokes(surface.pageId, result, partial ? 'partial-erase' : 'erase');
    },
    cancel(surface) {
      working = last = base = origin = null;
      R.syncLayer(surface.layer, app.doc.strokes(surface.pageId));
      R.setEraserCursor(surface.layer, null);
    },
    hover(surface, pt) { R.setEraserCursor(surface.layer, pt, radius(surface)); },
    leave(surface) { R.setEraserCursor(surface.layer, null); },
    deactivate() { app.surfaces.forEach(s => R.setEraserCursor(s.layer, null)); },
  };
}

// ── Selector ───────────────────────────────────────────────────

function selectorTool(app: ToolHost, R: ToolRenderer): Tool {
  let mode: 'move' | 'select' | null = null, path: Point[] | null = null;
  let start: Point | null = null, offset: [number, number] = [0, 0];
  let moving: Selection | null = null; // the selection being dragged
  let len = 0, frame = 0; // length of the select path so far; pending marquee redraw

  // Redraw the marquee at most once per frame (moves only collect points).
  const drawMarquee = (surface: Surface): void => {
    frame = 0;
    if (mode === 'select' && path) R.setMarquee(surface.layer, isLasso(path, len) ? path : rectPolygon(path[0], path[path.length - 1]));
  };
  const stopMarquee = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const sel = (): Selection | null => app.selection;
  const insideSelection = (surface: Surface, pt: Point): boolean => {
    const s = sel();
    if (!s || s.pageId !== surface.pageId || !s.box) return false;
    const pad = 10;
    return pt[0] >= s.box.minX - pad && pt[0] <= s.box.maxX + pad &&
           pt[1] >= s.box.minY - pad && pt[1] <= s.box.maxY + pad;
  };

  /** The selection was replaced or dropped mid-drag (Escape, Delete, a peer's edit): end the move, no command. */
  const dropped = (surface: Surface): boolean => {
    if (sel() === moving) return false;
    R.translateStrokes(surface.layer, moving!.ids, 0, 0);
    mode = null;
    moving = null;
    return true;
  };

  return {
    id: 'selector',
    down(surface, pt) {
      if (insideSelection(surface, pt)) {
        mode = 'move';
        moving = sel();
        start = pt;
        offset = [0, 0];
        return;
      }
      app.select(null);
      mode = 'select';
      path = [pt];
      len = 0;
    },
    move(surface, pt) {
      if (mode === 'move') {
        if (dropped(surface)) return;
        offset = [pt[0] - start![0], pt[1] - start![1]];
        R.translateStrokes(surface.layer, moving!.ids, offset[0], offset[1]);
        R.setSelectionBox(surface.layer, moving!.box, offset[0], offset[1]);
      } else if (mode === 'select') {
        len += pathLength([path![path!.length - 1], pt]);
        path!.push(pt);
        if (!frame) frame = requestAnimationFrame(() => drawMarquee(surface));
      }
    },
    up(surface, pt) {
      if (mode === 'move') {
        if (dropped(surface)) return;
        const s = moving!;
        mode = null;
        moving = null;
        if (!app.doc.hasPage(surface.pageId)) return;
        if (!app.doc.moveStrokes(surface.pageId, s.ids, offset[0], offset[1])) {
          R.translateStrokes(surface.layer, s.ids, 0, 0);
          R.setSelectionBox(surface.layer, s.box);
        }
        return;
      }
      if (mode !== 'select') return;
      mode = null;
      const p = path!;
      if (pt) p.push(pt);
      stopMarquee();
      R.setMarquee(surface.layer, null);
      const strokes = app.doc.strokes(surface.pageId);
      let ids: string[];
      if (pathLength(p) < 4) {
        // A tap selects the topmost stroke under the pointer.
        const hit = strokes.slice().reverse().find(s => strokeHitsSegment(s, p[0], p[0], 4));
        ids = hit ? [hit.id] : [];
      } else {
        const poly = isLasso(p) ? p : rectPolygon(p[0], p[p.length - 1]);
        ids = strokesInPolygon(strokes, poly);
      }
      path = null;
      app.select(ids.length ? { pageId: surface.pageId, ids } : null);
    },
    cancel(surface) {
      if (mode === 'move' && !dropped(surface)) {
        R.translateStrokes(surface.layer, moving!.ids, 0, 0);
        R.setSelectionBox(surface.layer, moving!.box);
      }
      stopMarquee();
      R.setMarquee(surface.layer, null);
      mode = null;
      moving = null;
      path = null;
    },
    deactivate() { app.select(null); },
  };
}

// ── Laser ──────────────────────────────────────────────────────

function laserTool(app: ToolHost, R: ToolRenderer): Tool {
  const trace = (surface: Surface, pt: Point): void => {
    R.laser(surface.layer).add(pt);
    if (app.sync) app.sync.laser(surface.pageId, pt); // mirror to the presenter/audience window
  };
  return { id: 'laser', down: trace, move: trace, hover: trace };
}

// ── Registry ───────────────────────────────────────────────────

/** Toolbar entry of a tool (see TOOLS). */
export interface ToolInfo {
  id: ToolId;
  label: string;
  key: string;
  caption?: string;
  color: boolean;
  size: boolean;
}

/** Toolbar entries of the tools, in bar order, with their shortcut keys. */
export const TOOLS: readonly ToolInfo[] = [
  { id: 'pen', label: 'Pen', key: 'P', color: true, size: true },
  { id: 'highlighter', label: 'Highlighter', key: 'H', color: true, size: true },
  { id: 'selector', label: 'Select (drag: box, circle: lasso)', key: 'S', color: false, size: false },
  { id: 'laser', label: 'Laser pointer', key: 'L', color: false, size: false },
  { id: 'eraser', label: 'Stroke eraser: removes whole strokes', key: 'E', caption: 'stroke', color: false, size: true },
  { id: 'partial', label: 'Partial eraser: erases only what it touches', key: 'Shift+E', caption: 'part', color: false, size: true },
];

/** Create every tool for an app. */
export function createTools(app: ToolHost, renderer: ToolRenderer = render): Tools {
  return {
    pen: inkTool(app, 'pen', renderer),
    highlighter: inkTool(app, 'highlighter', renderer),
    selector: selectorTool(app, renderer),
    laser: laserTool(app, renderer),
    eraser: eraserTool(app, 'eraser', renderer),
    partial: eraserTool(app, 'partial', renderer),
  };
}
