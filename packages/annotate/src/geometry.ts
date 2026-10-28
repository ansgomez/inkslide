/* Inkslide annotate - geometry (pure, no DOM)
 *
 * Ported from Marp Notes geometry.js (© Andres Gomez, MIT).
 * Points are [x, y, pressure] arrays in page coordinates (viewBox units: Marp
 * slide units or PDF points). Strokes are { id, tool, color, size, points }.
 */
import { getStroke, type StrokeOptions } from 'perfect-freehand';

/** [x, y, pressure] in page units; pressure 0..1. */
export type Point = [number, number, number];
/** [x, y] in page units. */
export type Vec2 = [number, number];
/** Anything with x and y in the first two slots ([x, y] or [x, y, p]). */
export type XY = readonly [number, number, ...number[]];

/** Tools that leave strokes in the document. */
export type StrokeTool = 'pen' | 'highlighter';

/** An ink stroke. Immutable: edits replace the object. */
export interface Stroke {
  readonly id: string;
  readonly tool: StrokeTool;
  readonly color: string;
  readonly size: number;
  readonly points: readonly Point[];
}

/** The parts of a stroke the geometry needs. */
export type StrokeLike = Pick<Stroke, 'tool' | 'size' | 'points'>;

/** Axis-aligned bounding box in page units. */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** How much pressure changes the pen width. */
export const PEN_THINNING = 0.6;
/** Input smoothing (0 = raw, 1 = frozen). */
export const STREAMLINE = 0.5;
const CAP_STEPS = 8;               // segments per half circle (caps, joins)
const MIN_GAP = 0.5;               // drop input points closer than this

/** Distance between two points. */
export const dist = (a: XY, b: XY): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** `v` rounded to `d` decimals. */
export const round = (v: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const pt3 = (p: readonly number[]): Point => [p[0], p[1], p[2]];

// ── Smoothing ──────────────────────────────────────────────────

/** Exponential smoothing of raw input; keeps the first and last raw point. */
export function smoothPoints(raw: readonly Point[], streamline = STREAMLINE): Point[] {
  if (!raw.length) return [];
  const t = 1 - streamline;
  const out: Point[] = [pt3(raw[0])];
  for (let i = 1; i < raw.length; i++) {
    const prev = out[out.length - 1];
    const p = raw[i];
    if (dist(prev, p) < MIN_GAP) continue;
    out.push([lerp(prev[0], p[0], t), lerp(prev[1], p[1], t), lerp(prev[2], p[2], t)]);
  }
  const last = pt3(raw[raw.length - 1]);
  const tail = out[out.length - 1];
  if (out.length > 1 && dist(tail, last) < MIN_GAP) out[out.length - 1] = last;
  else if (dist(tail, last) > 0) out.push(last);
  return out;
}

// ── Width ──────────────────────────────────────────────────────

function penRadius(size: number, p: number): number {
  return Math.max(0.25, size * (0.5 - PEN_THINNING * (0.5 - p)));
}

/** Half the ink width of a stroke at pressure p. */
export function strokeRadius(stroke: StrokeLike, p: number): number {
  return stroke.tool === 'pen' ? penRadius(stroke.size, p) : stroke.size / 2;
}

// Strokes are immutable, so derived values can be cached per stroke object.
const radiusCache = new WeakMap<object, number>();
const bboxCache = new WeakMap<object, Readonly<BBox>>();

/** Largest half ink width of a stroke (cached per stroke object). */
export function maxStrokeRadius(stroke: StrokeLike): number {
  if (stroke.tool !== 'pen') return stroke.size / 2;
  let r = radiusCache.get(stroke);
  if (r === undefined) {
    let p = 0;
    for (const pt of stroke.points) if (pt[2] > p) p = pt[2];
    r = penRadius(stroke.size, p);
    radiusCache.set(stroke, r);
  }
  return r;
}

// ── Outline (perfect-freehand style) ───────────────────────────

function arc(out: Vec2[], c: XY, r: number, from: number, sweep: number): void {
  for (let k = 1; k <= CAP_STEPS; k++) {
    const a = from + (sweep * k) / CAP_STEPS;
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
}

function unit(a: XY, b: XY): Vec2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/**
 * The original Marp Notes outline: filled polygon around a centerline with
 * pressure-dependent width and round caps / joins. Returns [[x, y], ...].
 */
export function classicOutline(points: readonly (readonly number[])[], size: number): Vec2[] {
  const pts: (readonly number[])[] = [];
  for (const p of points) {
    if (!pts.length || dist(pts[pts.length - 1] as XY, p as XY) > 1e-6) pts.push(p);
  }
  if (!pts.length) return [];
  const r = pts.map(p => penRadius(size, p[2] == null ? 0.5 : p[2]));

  if (pts.length === 1) {
    const c = pts[0] as XY;
    const out: Vec2[] = [[c[0] + r[0], c[1]]];
    arc(out, c, r[0], 0, Math.PI);
    arc(out, c, r[0], Math.PI, Math.PI);
    out.pop();
    return out;
  }

  const left: Vec2[] = [], right: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i] as XY;
    const dIn = i > 0 ? unit(pts[i - 1] as XY, p) : null;
    const dOut = i < n - 1 ? unit(p, pts[i + 1] as XY) : null;
    if (dIn && dOut && dIn[0] * dOut[0] + dIn[1] * dOut[1] < 0) {
      // Sharp turn: round join on both sides (inner one folds inside the ink).
      const a1 = Math.atan2(dIn[0], -dIn[1]);   // angle of normal (-dy, dx)
      const a2 = Math.atan2(dOut[0], -dOut[1]);
      let sweep = a2 - a1;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      const l: Vec2[] = [[p[0] + Math.cos(a1) * r[i], p[1] + Math.sin(a1) * r[i]]];
      const rr: Vec2[] = [[p[0] - Math.cos(a1) * r[i], p[1] - Math.sin(a1) * r[i]]];
      arc(l, p, r[i], a1, sweep);
      arc(rr, p, r[i], a1 + Math.PI, sweep);
      left.push(...l);
      right.push(...rr);
      continue;
    }
    const d = dIn && dOut ? unit([0, 0], [dIn[0] + dOut[0], dIn[1] + dOut[1]]) : (dIn || dOut)!;
    const nx = -d[1] * r[i], ny = d[0] * r[i];
    left.push([p[0] + nx, p[1] + ny]);
    right.push([p[0] - nx, p[1] - ny]);
  }

  const out = left.slice();
  // End cap: from the left side around the tip to the right side.
  const dEnd = unit(pts[n - 2] as XY, pts[n - 1] as XY);
  arc(out, pts[n - 1] as XY, r[n - 1], Math.atan2(dEnd[0], -dEnd[1]), -Math.PI);
  out.pop();
  for (let i = right.length - 1; i >= 0; i--) out.push(right[i]);
  // Start cap: from the right side around the back to the left side.
  const dStart = unit(pts[0] as XY, pts[1] as XY);
  arc(out, pts[0] as XY, r[0], Math.atan2(dStart[0], -dStart[1]) + Math.PI, -Math.PI);
  out.pop();
  return out;
}

// ── Outline (perfect-freehand) ─────────────────────────────────

/**
 * perfect-freehand options tuned to look like the Marp pen. Its radius is
 * size * (0.5 - thinning * (0.5 - p)), the same law as penRadius. Stored
 * points are already smoothed by smoothPoints; tune streamline later.
 */
export const FREEHAND_OPTIONS: Readonly<StrokeOptions> = Object.freeze({
  thinning: PEN_THINNING,
  streamline: 0.5,
  smoothing: 0.5,
  simulatePressure: false,
  last: true,
});

/** Outline from perfect-freehand's getStroke. Returns [[x, y], ...]. */
export function freehandOutline(
  points: readonly (readonly number[])[], size: number, options: StrokeOptions = {},
): Vec2[] {
  if (!points.length) return [];
  const input = points.map(p => [p[0], p[1], p[2] == null ? 0.5 : p[2]]);
  return getStroke(input, { ...FREEHAND_OPTIONS, ...options, size }) as Vec2[];
}

/** Pen outline: the original Marp Notes polygon or perfect-freehand. */
export type OutlineEngine = 'classic' | 'freehand';

/** Outline used when strokeOutline gets no engine. Classic until the freehand look is approved. */
let defaultEngine: OutlineEngine = 'classic';

/** Set the outline engine pen strokes use by default (screen and export). */
export function setOutlineEngine(engine: OutlineEngine): void { defaultEngine = engine; }
/** The default outline engine. */
export function getOutlineEngine(): OutlineEngine { return defaultEngine; }

/** Options of strokeOutline. */
export interface OutlineOptions {
  /** 'classic' (Marp Notes) or 'freehand' (perfect-freehand); default from setOutlineEngine. */
  engine?: OutlineEngine;
  /** Extra perfect-freehand options (freehand engine only). */
  freehand?: StrokeOptions;
}

/**
 * Filled outline polygon around a centerline with pressure-dependent width
 * and round caps / joins. Returns [[x, y], ...].
 */
export function strokeOutline(
  points: readonly (readonly number[])[], size: number, options: OutlineOptions = {},
): Vec2[] {
  return (options.engine || defaultEngine) === 'freehand'
    ? freehandOutline(points, size, options.freehand)
    : classicOutline(points, size);
}

// ── SVG path strings ───────────────────────────────────────────

const fmt = (v: number): string => String(round(v, 2));

/** Closed path through midpoints with quadratic curves (smooth outline). */
export function outlinePath(poly: readonly XY[]): string {
  const n = poly.length;
  if (n < 3) return '';
  const mid = (i: number): Vec2 => {
    const a = poly[i % n], b = poly[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const m0 = mid(0);
  let d = `M${fmt(m0[0])} ${fmt(m0[1])}`;
  for (let i = 1; i <= n; i++) {
    const p = poly[i % n], m = mid(i);
    d += ` Q${fmt(p[0])} ${fmt(p[1])} ${fmt(m[0])} ${fmt(m[1])}`;
  }
  return d + ' Z';
}

/** Open smooth path along the centerline (for stroked rendering). */
export function centerlinePath(points: readonly XY[]): string {
  if (!points.length) return '';
  const p0 = points[0];
  let d = `M${fmt(p0[0])} ${fmt(p0[1])}`;
  if (points.length === 1) return d + ' l0.01 0';
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];
    d += ` Q${fmt(p[0])} ${fmt(p[1])} ${fmt((p[0] + q[0]) / 2)} ${fmt((p[1] + q[1]) / 2)}`;
  }
  const last = points[points.length - 1];
  return d + ` L${fmt(last[0])} ${fmt(last[1])}`;
}

// ── Bounding boxes ─────────────────────────────────────────────

/** Bounding box of points, grown by `pad` on every side. */
export function pointsBBox(points: readonly XY[], pad = 0): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** Bounding box of a stroke including its ink width (cached per stroke object). */
export function strokeBBox(stroke: StrokeLike): Readonly<BBox> {
  let box = bboxCache.get(stroke);
  if (!box) {
    box = Object.freeze(pointsBBox(stroke.points, maxStrokeRadius(stroke)));
    bboxCache.set(stroke, box);
  }
  return box;
}

/** Box around all `boxes`; null if there are none. */
export function unionBBox(boxes: readonly BBox[]): BBox | null {
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  }));
}

/** Whether two boxes overlap (touching counts). */
export const boxesOverlap = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

// ── Distances / hit tests ──────────────────────────────────────

/** Distance from point p to segment a–b. */
export function distPointSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const cross = (o: XY, a: XY, b: XY): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b);
  const d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Shortest distance between segments a–b and c–d. */
export function distSegments(a: XY, b: XY, c: XY, d: XY): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distPointSegment(a, c, d), distPointSegment(b, c, d),
    distPointSegment(c, a, b), distPointSegment(d, a, b),
  );
}

/** Does an eraser of `radius` moving from a to b touch the stroke's ink? */
export function strokeHitsSegment(stroke: StrokeLike, a: XY, b: XY, radius: number): boolean {
  const pts = stroke.points;
  if (!pts.length) return false;
  const eb = pointsBBox([a, b], radius);
  if (!boxesOverlap(eb, strokeBBox(stroke))) return false;
  if (pts.length === 1) {
    return distPointSegment(pts[0], a, b) <= radius + strokeRadius(stroke, pts[0][2]);
  }
  for (let i = 1; i < pts.length; i++) {
    const r = Math.max(strokeRadius(stroke, pts[i - 1][2]), strokeRadius(stroke, pts[i][2]));
    if (distSegments(pts[i - 1], pts[i], a, b) <= radius + r) return true;
  }
  return false;
}

/** Insert interpolated points so that consecutive points are <= step apart. */
export function resample(points: readonly Point[], step: number): Point[] {
  if (points.length < 2) return points.map(pt3);
  const out: Point[] = [pt3(points[0])];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step - 1e-9));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
    }
  }
  return out;
}

/** Most samples splitByEraser takes along one segment. */
const MAX_ERASE_SAMPLES = 4096;

/** The part of segment p→q inside `box`, as [t0, t1] along it (Liang–Barsky); null if it misses. */
function clipSegment(p: XY, q: XY, box: BBox): [number, number] | null {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  let t0 = 0, t1 = 1;
  const edges: [number, number][] = [
    [-dx, p[0] - box.minX], [dx, box.maxX - p[0]], [-dy, p[1] - box.minY], [dy, box.maxY - p[1]],
  ];
  for (const [d, e] of edges) {
    if (d === 0) {
      if (e < 0) return null;
    } else {
      const t = e / d;
      if (d < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return [t0, t1];
}

/**
 * Partial erase. Returns null if the eraser (radius, moving a→b) removes no
 * ink; otherwise the remaining pieces as point arrays ([] when nothing is
 * left). The stroke is sampled densely near the eraser to find the cut, but
 * each piece keeps only the original points plus its two cut ends.
 */
export function splitByEraser(stroke: StrokeLike, a: XY, b: XY, radius: number): Point[][] | null {
  if (!strokeHitsSegment(stroke, a, b, radius)) return null;
  const step = Math.max(0.5, Math.min(radius, maxStrokeRadius(stroke)) / 2);
  const src = stroke.points;
  const pieces: Point[][] = [];
  let run: { p: Point; orig: boolean }[] | null = null, removed = false;

  // A run of one sample is still ink the eraser missed: it stays as a dot.
  const flush = (): void => {
    if (run && run.length) {
      const r = run;
      const keep = r.filter((s, i) => s.orig || i === 0 || i === r.length - 1);
      pieces.push(keep.map(s => s.p));
    }
    run = null;
  };
  const visit = (p: Point, orig: boolean): void => {
    if (distPointSegment(p, a, b) <= radius + strokeRadius(stroke, p[2])) {
      removed = true;
      flush();
    } else {
      (run = run || []).push({ p, orig });
    }
  };

  // Only ink within this box can be erased. Samples elsewhere never become a
  // cut end (one beside an erased sample is kept below), so a segment is
  // sampled only where it crosses the box.
  const box = pointsBBox([a, b], radius + maxStrokeRadius(stroke) + step);
  visit(pt3(src[0]), true);
  for (let i = 1; i < src.length; i++) {
    const p = src[i - 1], q = src[i];
    const span = clipSegment(p, q, box);
    if (span) {
      let n = Math.max(1, Math.ceil(dist(p, q) / step - 1e-9));
      // A huge segment through the eraser: coarser cuts, not millions of samples.
      if ((span[1] - span[0]) * n > MAX_ERASE_SAMPLES) n = Math.max(1, Math.ceil(MAX_ERASE_SAMPLES / (span[1] - span[0])));
      const k0 = Math.max(1, Math.floor(span[0] * n) - 1), k1 = Math.min(n - 1, Math.ceil(span[1] * n) + 1);
      for (let k = k0; k <= k1; k++) {
        const t = k / n;
        visit([lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t)], false);
      }
    }
    visit(pt3(q), true);
  }
  flush();
  return removed ? pieces : null;
}

// ── Selection ──────────────────────────────────────────────────

/** Whether p lies inside the polygon (even-odd rule). */
export function pointInPolygon(p: XY, poly: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** Rectangle with corners `a` and `b` as a polygon. */
export function rectPolygon(a: XY, b: XY): Vec2[] {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** Ids of strokes with at least `threshold` of their points inside poly. */
export function strokesInPolygon(
  strokes: readonly Stroke[], poly: readonly XY[], threshold = 0.75,
): string[] {
  if (poly.length < 3) return [];
  const box = pointsBBox(poly);
  const ids: string[] = [];
  for (const s of strokes) {
    if (!s.points.length || !boxesOverlap(box, strokeBBox(s))) continue; // cached; padding only widens the prefilter
    let inside = 0;
    for (const p of s.points) if (pointInPolygon(p, poly)) inside++;
    if (inside / s.points.length >= threshold) ids.push(s.id);
  }
  return ids;
}

// ── Rectangles (images) ────────────────────────────────────────

/** An axis-aligned rectangle in page units: an image on a page. */
export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box of a rectangle. */
export const rectBBox = (r: RectLike): BBox => ({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h });

/** Whether the segment a–b, grown by `radius`, touches the rectangle (an eraser over an image). */
export function rectHitsSegment(r: RectLike, a: XY, b: XY, radius: number): boolean {
  const inside = (p: XY): boolean => p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
  if (inside(a) || inside(b)) return true;
  const c: XY[] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  return c.some((p, i) => distSegments(a, b, p, c[(i + 1) % 4]) <= radius);
}

/**
 * Ids of the rectangles at least `threshold` inside a polygon, measured on a
 * 5×5 grid of points over each (the share of points, as strokesInPolygon).
 */
export function rectsInPolygon(rects: readonly (RectLike & { id: string })[], poly: readonly XY[], threshold = 0.75): string[] {
  if (poly.length < 3) return [];
  const box = pointsBBox(poly);
  const ids: string[] = [];
  for (const r of rects) {
    if (!boxesOverlap(box, rectBBox(r))) continue;
    let inside = 0;
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) if (pointInPolygon([r.x + r.w * i / 4, r.y + r.h * j / 4], poly)) inside++;
    }
    if (inside / 25 >= threshold) ids.push(r.id);
  }
  return ids;
}

/** Length of a polyline. */
export function pathLength(points: readonly XY[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

/**
 * A drag that travels much farther than its chord is a lasso, not a rectangle.
 * `len` is pathLength(path), if the caller keeps it (one step per move, not the whole path).
 */
export function isLasso(path: readonly XY[], len = pathLength(path)): boolean {
  if (path.length < 3) return false;
  return len > 40 && len > 1.8 * dist(path[0], path[path.length - 1]);
}

/** Points moved by (dx, dy), pressure kept. */
export function translatePoints(points: readonly Point[], dx: number, dy: number): Point[] {
  return points.map(p => [p[0] + dx, p[1] + dy, p[2]]);
}

/**
 * Laser trail: the newest part of [[x, y], ...] (oldest first) no longer
 * than maxLen, as [x, y, p] with p rising from 0 at the tail to 1 at the
 * head, so strokeOutline draws it tapered.
 */
export function laserTrail(points: readonly XY[], maxLen: number): Point[] {
  const out: Point[] = [];
  let len = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (out.length) {
      const step = dist(out[out.length - 1], p);
      if (len + step > maxLen) {
        const t = (maxLen - len) / step; // cut the last segment at exactly maxLen
        const q = out[out.length - 1];
        if (t > 0) out.push([lerp(q[0], p[0], t), lerp(q[1], p[1], t), 0]);
        len = maxLen;
        break;
      }
      len += step;
    }
    out.push([p[0], p[1], 0]);
  }
  out.reverse();
  // pressure by distance from the tail
  let acc = 0;
  for (let i = 0; i < out.length; i++) {
    if (i) acc += dist(out[i - 1], out[i]);
    out[i][2] = len ? acc / len : 1;
  }
  return out;
}
