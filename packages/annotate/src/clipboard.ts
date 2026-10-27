/* Inkslide annotate - copy and paste of strokes (pure, no DOM)
 *
 * A clip is a copy of some strokes with the size of the page they came
 * from. The app keeps one clip per window (shared by every document opened
 * in it) and also writes it to the system clipboard as JSON text with a
 * format marker, so another window can paste it.
 *
 * placeClip() turns a clip into new strokes for a target page: new ids,
 * scaled to the target page size, kept at the same place on the page,
 * offset while they would sit exactly on strokes already there (the
 * originals, or an earlier paste), and clamped to the page.
 */
import { pointsBBox, strokeBBox, unionBBox, type BBox, type Point, type Stroke } from './geometry';
import { createStroke, newId, serializeStroke, type Size, type StrokeJSON } from './model';

/** `format` field of a clip on the system clipboard. */
export const CLIP_FORMAT = 'inkslide-strokes';
/** Newest clip version this module reads. */
export const CLIP_VERSION = 1;
/** Paste offset step, in units of a 1280×720 slide (scaled by the page's tool unit). */
export const PASTE_OFFSET = 16;
/** Most offset steps tried before a paste gives up looking for a free place. */
const MAX_STEPS = 50;
/** Most strokes, and points in all, of a clip read from the system clipboard. */
export const MAX_CLIP_STROKES = 10000, MAX_CLIP_POINTS = 1000000;

/** Copied strokes and the size of the page they were copied from. */
export interface Clip {
  /** [width, height] of the source page, in its page units. */
  size: Size;
  strokes: readonly Stroke[];
}

/** A clip as stored on the system clipboard (JSON text). */
export interface ClipJSON {
  format: typeof CLIP_FORMAT;
  version: number;
  size: Size;
  strokes: StrokeJSON[];
}

/** A clip of `strokes` from a page of `size` (an empty list gives null). */
export function makeClip(strokes: readonly Stroke[], size: Size): Clip | null {
  return strokes.length ? { size: [size[0], size[1]], strokes: strokes.slice() } : null;
}

// The clip of this window: copy in one document, paste in another.
let current: Clip | null = null;
// The text this window put on the system clipboard for the current clip; null if it did not get there (see clipForPaste).
let syncedText: string | null = null;

/** The clip of this window; null before the first copy. */
export const getClip = (): Clip | null => current;
/** Replace the clip of this window (not yet on the system clipboard). */
export function setClip(clip: Clip | null): void {
  current = clip;
  syncedText = null;
}
/** The current clip is on the system clipboard too, as `text`. */
export function markClipSynced(text: string): void { syncedText = current ? text : null; }

/**
 * What to paste, given the text of the system clipboard (null: unreadable)
 * and whether it holds something other than text (an image, files). The text
 * this window wrote gives this window's clip (also one too large to read
 * back). Another clip there wins (it may come from another window) and
 * becomes this window's clip. Other text or other content means something
 * else was copied after the clip went to the system clipboard: nothing to
 * paste. Without readable content, or if the clip never reached the system
 * clipboard (the platform refused), this window's clip.
 */
export function clipForPaste(text: string | null | undefined, otherContent = false): Clip | null {
  if (syncedText !== null && text === syncedText) return current;
  const fromSystem = parseClip(text);
  if (fromSystem) {
    current = fromSystem;
    syncedText = text as string;
    return fromSystem;
  }
  const hasText = typeof text === 'string' && !!text.trim();
  if ((hasText || otherContent) && syncedText !== null) return null;
  return current;
}

/** JSON text of a clip for the system clipboard. */
export function serializeClip(clip: Clip): string {
  const data: ClipJSON = {
    format: CLIP_FORMAT, version: CLIP_VERSION,
    size: [clip.size[0], clip.size[1]], strokes: clip.strokes.map(serializeStroke),
  };
  return JSON.stringify(data);
}

/**
 * The clip in system clipboard text; null if the text is no clip (any other
 * text, a newer version, no valid strokes). Malformed strokes are skipped.
 */
export function parseClip(text: unknown): Clip | null {
  if (typeof text !== 'string' || !text.includes(CLIP_FORMAT)) return null;
  let data: Partial<ClipJSON> | null;
  try { data = JSON.parse(text); } catch (_) { return null; }
  if (!data || data.format !== CLIP_FORMAT || typeof data.version !== 'number' || data.version > CLIP_VERSION) return null;
  const size = data.size;
  const positive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!Array.isArray(size) || !positive(size[0]) || !positive(size[1]) || !Array.isArray(data.strokes)) return null;
  if (data.strokes.length > MAX_CLIP_STROKES) return null;
  let points = 0;
  for (const s of data.strokes) points += s && Array.isArray(s.points) ? s.points.length : 0;
  if (points > MAX_CLIP_POINTS) return null;
  const strokes: Stroke[] = [];
  for (const s of data.strokes) {
    try { strokes.push(createStroke({ ...s, id: null })); } catch (_) { /* skipped */ }
  }
  return makeClip(strokes, [size[0], size[1]]);
}

/** Where a clip is pasted: the target page's size and strokes, and its offset step in page units. */
export interface PasteTarget {
  size: Size;
  strokes: readonly Stroke[];
  /** Offset per repeated paste, in page units (PASTE_OFFSET × the page's tool unit). */
  step: number;
}

/**
 * The strokes of a paste onto a page (new ids; nothing is added to the
 * page). On a page of another size the clip is scaled by the smaller of the
 * width and height ratios, and its center keeps its relative place on the
 * page. It is kept on the page and, while its first stroke would sit exactly
 * on a stroke of the page, moved by `step` (see freeShift). Strokes the
 * scaling breaks (out of range, from a crafted clip) are dropped.
 */
export function placeClip(clip: Clip, target: PasteTarget): Stroke[] {
  const [w, h] = target.size;
  const sx = w / clip.size[0], sy = h / clip.size[1];
  const scale = Math.min(sx, sy);
  const same = Math.abs(scale - 1) < 1e-9 && Math.abs(sx - sy) < 1e-9;
  const center = clip.strokes.length ? boxCenter(pointsBBox(clip.strokes.flatMap(s => s.points))) : [0, 0];
  const base: Stroke[] = [];
  for (const s of clip.strokes) {
    const scaled = same ? s : {
      ...s,
      size: s.size * scale,
      points: s.points.map((p): Point => [
        (p[0] - center[0]) * scale + center[0] * sx,
        (p[1] - center[1]) * scale + center[1] * sy,
        p[2],
      ]),
    };
    try { base.push(createStroke(scaled)); } catch (_) { /* dropped */ }
  }
  if (!base.length) return [];
  const box = unionBBox(base.map(strokeBBox))!;
  const shift = freeShift(base[0], box, target);
  const out: Stroke[] = [];
  for (const s of base) {
    try {
      out.push(createStroke({
        id: newId(), tool: s.tool, color: s.color, size: s.size,
        points: s.points.map(p => [p[0] + shift[0], p[1] + shift[1], p[2]]),
      }));
    } catch (_) { /* dropped */ }
  }
  return out;
}

/**
 * The shift that keeps `box` on the page and puts `first` on no equal stroke
 * of the page: none if that is free, else k steps down and right, for
 * k = 1, 2, …; on an axis where the page ends, k steps up or left instead.
 * Only if that finds no free place within MAX_STEPS steps, the other
 * directions; if they find none either, the last place tried.
 */
function freeShift(first: Stroke, box: BBox, target: PasteTarget): [number, number] {
  const [w, h] = target.size;
  const taken = (d: readonly [number, number]): boolean => target.strokes.some(s => samePlace(s, first, d));
  const start = clampShift(box, 0, 0, w, h);
  const step = Number.isFinite(target.step) && target.step > 0 ? target.step : 0;
  if (!step || !taken(start)) return start;
  let last = start;
  // Signs of x and y: the main direction first, the others only if it has no free place.
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    for (let k = 1; k <= MAX_STEPS; k++) {
      const d = k * step;
      const fwd = clampShift(box, d, d, w, h);
      // An axis the page stops (clamped short of d) goes the other way.
      const dx = fwd[0] < d ? -d : d, dy = fwd[1] < d ? -d : d;
      last = clampShift(box, sx * dx, sy * dy, w, h);
      if (!taken(last)) return last;
    }
  }
  return last;
}

const boxCenter = (b: BBox): [number, number] => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];

/** (dx, dy) changed so that `box` moved by it lies on a w×h page (its top-left corner if it is larger). */
function clampShift(box: BBox, dx: number, dy: number, w: number, h: number): [number, number] {
  const fit = (min: number, max: number, d: number, size: number): number => {
    if (max - min >= size) return -min;
    return Math.min(Math.max(d, -min), size - max);
  };
  return [fit(box.minX, box.maxX, dx, w), fit(box.minY, box.maxY, dy, h)];
}

/** Whether `a` has the look and the points of `b` moved by `shift` (within the rounding of a saved file). */
function samePlace(a: Stroke, b: Stroke, shift: readonly [number, number]): boolean {
  if (a.tool !== b.tool || a.color !== b.color || Math.abs(a.size - b.size) > 0.01 || a.points.length !== b.points.length) return false;
  return a.points.every((p, i) =>
    Math.abs(p[0] - b.points[i][0] - shift[0]) < 0.01 && Math.abs(p[1] - b.points[i][1] - shift[1]) < 0.01);
}
