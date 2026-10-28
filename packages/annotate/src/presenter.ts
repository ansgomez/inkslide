/* Inkslide annotate - presenter mode messages (pure, no DOM)
 *
 * In presenter mode a second window (the audience window, for a projector)
 * mirrors the page, the ink and the laser of the window the teacher writes
 * in. The presenter sends the messages below; the audience only renders them.
 * Every message is checked with parsePresenterMessage on the way (the
 * desktop app's main process, which relays them, and the audience page), so
 * only known fields of the right type and size get through. Strokes are
 * checked once more by createStroke when the audience applies them.
 *
 *   open      the PDF (its bytes) and its title; a new document
 *   notes     all notes, as a notes file (after open, import, revert)
 *   close     no document any more (`reason`: the PDF is too large to mirror, or failed)
 *   page      the page shown (p<n> or a blank page id)
 *   strokes   all strokes of one page (its first change after open, notes or a reload)
 *   delta     a page's later changes: the ids of all its strokes in order, and only
 *             the strokes that are new or changed (the others are known by id)
 *   images    all images of one page, in order; `src` only for images the audience
 *             does not have yet (a moved image keeps its id and data)
 *   blanks    every blank page: id, the page it follows, its paper
 *   live      the stroke being written: points from index `from` on
 *   live-end  the stroke being written is gone (finished or dropped)
 *   laser     laser points on a page
 */
import type { Point, StrokeTool, Vec2 } from './geometry';
import { imageType, MAX_COLOR_LENGTH, MAX_DOC_IMAGE_CHARS, MAX_ID_LENGTH, MAX_PAGE_IMAGES, type Paper, type StrokeJSON } from './model';

/** One blank page as sent to the audience. */
export interface BlankMeta {
  id: string;
  after: number;
  paper: Paper;
}

/** An image of an `images` message; `src` is left out when the audience has the image (by id). */
export interface RemoteImage {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  src?: string;
}

/** A message from the presenter window to the audience window (see the module comment). */
export type PresenterMessage =
  | { type: 'open'; pdf: Uint8Array; title: string }
  | { type: 'notes'; notes: string }
  | { type: 'close'; reason?: 'too-large' | 'failed' }
  | { type: 'page'; page: string }
  | { type: 'strokes'; page: string; strokes: StrokeJSON[] }
  | { type: 'delta'; page: string; order: string[]; strokes: StrokeJSON[] }
  | { type: 'images'; page: string; images: RemoteImage[] }
  | { type: 'blanks'; blanks: BlankMeta[] }
  | { type: 'live'; page: string; tool: StrokeTool; color: string; size: number; from: number; points: Point[] }
  | { type: 'live-end' }
  | { type: 'laser'; page: string; points: Vec2[] };

/** Size limits of the messages. */
export const PRESENTER_LIMITS = Object.freeze({
  /**
   * Largest PDF mirrored. The bytes cross IPC twice (app window → main →
   * audience) each time presenter mode starts or a window reloads; larger
   * PDFs are not mirrored (`close` with reason 'too-large').
   */
  pdfBytes: 256 * 2 ** 20,
  /** Characters of the notes text (as the desktop app's notes files). */
  notesChars: 256 * 2 ** 20,
  title: 1000,
  /** Ids (as the model keeps them, MAX_ID_LENGTH) and page ids. */
  id: MAX_ID_LENGTH,
  color: MAX_COLOR_LENGTH,
  /** Strokes on one page, and points in one message (all strokes together). */
  strokes: 100_000,
  points: 10_000_000,
  blanks: 10_000,
  laserPoints: 1000,
  /** Images of one page, and characters of image data in one message (the notes file's limits). */
  images: MAX_PAGE_IMAGES,
  imageChars: MAX_DOC_IMAGE_CHARS,
});

const PAPER_IDS: readonly string[] = ['plain', 'lined', 'grid'];
const STROKE_TOOLS: readonly string[] = ['pen', 'highlighter'];

const fail = (what: string): never => { throw new Error(`invalid presenter message: ${what}`); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function text(v: unknown, max: number, what: string, empty = false): string {
  if (typeof v !== 'string' || v.length > max || (!empty && !v)) fail(what);
  return v as string;
}

function list(v: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(what);
  return v as unknown[];
}

/** Points as [x, y, pressure] (pressure 0.5 when missing); counts them against `budget`. */
function points(v: unknown, budget: { left: number }): Point[] {
  const raw = list(v, budget.left, 'points');
  budget.left -= raw.length;
  return raw.map(p => {
    if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) fail('point');
    const q = p as unknown[];
    const pressure = q[2] === undefined ? 0.5 : q[2];
    if (!finite(pressure)) fail('point');
    return [q[0] as number, q[1] as number, pressure as number];
  });
}

function stroke(v: unknown, budget: { left: number }): StrokeJSON {
  if (!isObject(v) || !STROKE_TOOLS.includes(v.tool as string)) fail('stroke');
  const s = v as Record<string, unknown>;
  if (!finite(s.size) || s.size <= 0) fail('stroke size');
  return {
    id: text(s.id, PRESENTER_LIMITS.id, 'stroke id'),
    tool: s.tool as StrokeTool,
    color: text(s.color, PRESENTER_LIMITS.color, 'stroke color', true),
    size: s.size as number,
    points: points(s.points, budget),
  };
}

/** An image of an `images` message; its data (when sent) is counted against `budget`. */
function image(v: unknown, budget: { left: number }): RemoteImage {
  if (!isObject(v)) return fail('image');
  if (!finite(v.x) || !finite(v.y) || !finite(v.w) || !finite(v.h) || v.w <= 0 || v.h <= 0) fail('image geometry');
  const out: RemoteImage = { id: text(v.id, PRESENTER_LIMITS.id, 'image id'), x: v.x as number, y: v.y as number, w: v.w as number, h: v.h as number };
  if (v.src !== undefined) {
    if (!imageType(v.src) || (v.src as string).length > budget.left) fail('image data');
    budget.left -= (v.src as string).length;
    out.src = v.src as string;
  }
  return out;
}

/**
 * A presenter message rebuilt from `value` with only its known fields;
 * throws if it is not one (unknown type, wrong field types, too large).
 */
export function parsePresenterMessage(value: unknown): PresenterMessage {
  if (!isObject(value)) return fail('not an object');
  const v = value;
  const page = (): string => text(v.page, PRESENTER_LIMITS.id, 'page');
  switch (v.type) {
    case 'open':
      if (!(v.pdf instanceof Uint8Array) || v.pdf.byteLength > PRESENTER_LIMITS.pdfBytes) fail('pdf');
      return { type: 'open', pdf: v.pdf as Uint8Array, title: text(v.title, PRESENTER_LIMITS.title, 'title', true) };
    case 'notes':
      return { type: 'notes', notes: text(v.notes, PRESENTER_LIMITS.notesChars, 'notes') };
    case 'close':
      if (v.reason !== undefined && v.reason !== 'too-large' && v.reason !== 'failed') fail('close reason');
      return v.reason === undefined ? { type: 'close' } : { type: 'close', reason: v.reason as 'too-large' | 'failed' };
    case 'live-end':
      return { type: v.type };
    case 'page':
      return { type: 'page', page: page() };
    case 'strokes': {
      const budget = { left: PRESENTER_LIMITS.points };
      return { type: 'strokes', page: page(), strokes: list(v.strokes, PRESENTER_LIMITS.strokes, 'strokes').map(s => stroke(s, budget)) };
    }
    case 'delta': {
      const budget = { left: PRESENTER_LIMITS.points };
      return {
        type: 'delta', page: page(),
        order: list(v.order, PRESENTER_LIMITS.strokes, 'order').map(id => text(id, PRESENTER_LIMITS.id, 'stroke id')),
        strokes: list(v.strokes, PRESENTER_LIMITS.strokes, 'strokes').map(s => stroke(s, budget)),
      };
    }
    case 'images': {
      const budget = { left: PRESENTER_LIMITS.imageChars };
      return { type: 'images', page: page(), images: list(v.images, PRESENTER_LIMITS.images, 'images').map(i => image(i, budget)) };
    }
    case 'blanks':
      return {
        type: 'blanks',
        blanks: list(v.blanks, PRESENTER_LIMITS.blanks, 'blanks').map(b => {
          if (!isObject(b) || !Number.isInteger(b.after) || !PAPER_IDS.includes(b.paper as string)) fail('blank page');
          const m = b as Record<string, unknown>;
          return { id: text(m.id, PRESENTER_LIMITS.id, 'blank page id'), after: m.after as number, paper: m.paper as Paper };
        }),
      };
    case 'live': {
      if (!STROKE_TOOLS.includes(v.tool as string)) fail('live tool');
      if (!finite(v.size) || v.size <= 0) fail('live size');
      if (!Number.isInteger(v.from) || (v.from as number) < 0 || (v.from as number) > PRESENTER_LIMITS.points) fail('live from');
      return {
        type: 'live', page: page(), tool: v.tool as StrokeTool,
        color: text(v.color, PRESENTER_LIMITS.color, 'live color', true),
        size: v.size as number, from: v.from as number,
        points: points(v.points, { left: PRESENTER_LIMITS.points }),
      };
    }
    case 'laser':
      return {
        type: 'laser', page: page(),
        points: list(v.points, PRESENTER_LIMITS.laserPoints, 'laser points').map((p): Vec2 => {
          if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) fail('laser point');
          const q = p as number[];
          return [q[0], q[1]];
        }),
      };
    default:
      return fail('unknown type');
  }
}

/** Number of leading points `a` and `b` share (same x, y and pressure). */
export function commonPrefix(a: readonly Point[], b: readonly Point[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && (a[i] === b[i] || (a[i][0] === b[i][0] && a[i][1] === b[i][1] && a[i][2] === b[i][2]))) i++;
  return i;
}
