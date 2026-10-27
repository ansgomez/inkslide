/* Inkslide annotate - SVG rendering of annotation layers
 *
 * Ported from Marp Notes render.js (© Andres Gomez, MIT).
 * Each page surface is an <svg> whose viewBox is the page size (a Marp slide
 * SVG, or an SVG laid over a PDF page with its viewBox in PDF points). It gets
 * one <g class="ann-layer">, so annotations share the page's coordinates.
 *   g.ann-layer
 *     rect.ann-hit    transparent input surface (only active in annotate mode)
 *     g.ann-img       images (snapshots), below all ink
 *     g.ann-hl        highlighter strokes (below pen)
 *     g.ann-pen       pen strokes
 *     g.ann-ui        selection box, marquee, eraser cursor, laser (never printed)
 */
import {
  centerlinePath, laserTrail, outlinePath, round, smoothPoints, strokeOutline,
  type BBox, type Stroke, type StrokeTool, type XY,
} from './geometry';
import type { PageImage, Paper, Size } from './model';

/** SVG namespace. */
export const SVGNS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number>;

/** Create an SVG element with attributes, appended to `parent` if given. */
export function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs, parent?: Element | null): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVGNS, tag);
  for (const k in attrs) node.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(node);
  return node;
}

/** Laser trail of one layer (see laser()). */
export interface Laser {
  add(pt: XY): void;
  clear(): void;
  readonly length: number;
}

/** The annotation layer of one page surface: groups, stroke nodes and UI overlays. */
export interface Layer {
  svg: SVGSVGElement;
  root: SVGGElement;
  size: Size;
  hit: SVGRectElement;
  img: SVGGElement;
  hl: SVGGElement;
  pen: SVGGElement;
  ui: SVGGElement;
  els: Map<string, { stroke: Stroke; node: SVGPathElement }>; // stroke id -> { stroke, node }
  imgs: Map<string, { image: PageImage; node: SVGImageElement }>; // image id -> { image, node }
  laser: Laser | null;
  /** Tool size scale of this page (pageUnit); tool sizes are for a 1280×720 slide. */
  unit: number;
  uiNodes?: Record<string, SVGElement>;
}

/** Page size from the viewBox (Marp decks may be 16:9 or 4:3, PDF pages anything). */
export function viewBoxSize(svg: SVGSVGElement): Size {
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (vb && vb.width && vb.height) return [vb.width, vb.height];
  const parts = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts[2] > 0 ? [parts[2], parts[3]] : [1280, 720];
}

/**
 * Tool size scale of a page: its diagonal over a 1280×720 slide's. Pen,
 * eraser and laser sizes are given for the slide, so they look the same
 * relative to the content on an A4 page (0.70) or a 960×540 PDF (0.75).
 */
export function pageUnit([w, h]: Size): number {
  return Math.hypot(w, h) / Math.hypot(1280, 720);
}

/** Add an annotation layer (g.ann-layer) to a page SVG, sized from its viewBox. */
export function createLayer(svg: SVGSVGElement): Layer {
  const [w, h] = viewBoxSize(svg);
  const root = el('g', { class: 'ann-layer' });
  const layer: Layer = {
    svg, root, size: [w, h],
    hit: el('rect', { class: 'ann-hit', x: 0, y: 0, width: w, height: h, fill: 'transparent' }, root),
    img: el('g', { class: 'ann-img' }, root),
    hl: el('g', { class: 'ann-hl' }, root),
    pen: el('g', { class: 'ann-pen' }, root),
    ui: el('g', { class: 'ann-ui' }, root),
    els: new Map(),
    imgs: new Map(),
    laser: null,
    unit: pageUnit([w, h]),
  };
  svg.appendChild(root);
  return layer;
}

// ── Strokes ────────────────────────────────────────────────────

/** Draw a stroke into a path node: pen as filled outline, highlighter as stroked centerline. */
export function paintStroke(node: SVGPathElement, stroke: Stroke): void {
  node.removeAttribute('transform');
  if (stroke.tool === 'pen') {
    node.setAttribute('class', 'ann-stroke ann-stroke-pen');
    node.setAttribute('d', outlinePath(strokeOutline(stroke.points, stroke.size)));
    node.setAttribute('fill', stroke.color);
  } else {
    node.setAttribute('class', 'ann-stroke ann-stroke-hl');
    node.setAttribute('d', centerlinePath(stroke.points));
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', stroke.color);
    node.setAttribute('stroke-width', String(stroke.size));
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
  }
  node.dataset.id = stroke.id;
}

const groupFor = (layer: Layer, stroke: Stroke): SVGGElement => (stroke.tool === 'pen' ? layer.pen : layer.hl);

/** Make the layer show exactly `strokes`, in order, reusing unchanged nodes. */
export function syncLayer(layer: Layer, strokes: readonly Stroke[]): void {
  const keep = new Set<string>();
  const cursors = new Map<SVGGElement, ChildNode | null>([[layer.hl, layer.hl.firstChild], [layer.pen, layer.pen.firstChild]]);
  for (const stroke of strokes) {
    keep.add(stroke.id);
    const group = groupFor(layer, stroke);
    let entry = layer.els.get(stroke.id);
    if (entry && entry.node.parentNode !== group) {
      entry.node.remove();
      entry = undefined;
    }
    if (!entry) {
      entry = { stroke, node: el('path', {}) };
      paintStroke(entry.node, stroke);
      layer.els.set(stroke.id, entry);
    } else if (entry.stroke !== stroke) {
      paintStroke(entry.node, stroke);
      entry.stroke = stroke;
    }
    const cursor = cursors.get(group)!;
    if (entry.node === cursor) cursors.set(group, cursor.nextSibling);
    else group.insertBefore(entry.node, cursor);
  }
  for (const [id, entry] of layer.els) {
    if (!keep.has(id)) {
      entry.node.remove();
      layer.els.delete(id);
    }
  }
}

// ── Images ─────────────────────────────────────────────────────

/** Draw an image into an <image> node, stretched to its rectangle. */
export function paintImage(node: SVGImageElement, image: PageImage): void {
  node.removeAttribute('transform');
  node.setAttribute('class', 'ann-image');
  node.setAttribute('x', String(image.x));
  node.setAttribute('y', String(image.y));
  node.setAttribute('width', String(image.w));
  node.setAttribute('height', String(image.h));
  node.setAttribute('preserveAspectRatio', 'none');
  if (node.getAttribute('href') !== image.src) node.setAttribute('href', image.src); // a move does not decode it again
  node.dataset.id = image.id;
}

/** Make the layer show exactly `images`, in order, reusing unchanged nodes. */
export function syncImages(layer: Layer, images: readonly PageImage[]): void {
  const keep = new Set<string>();
  let cursor: ChildNode | null = layer.img.firstChild;
  for (const image of images) {
    keep.add(image.id);
    let entry = layer.imgs.get(image.id);
    if (!entry) {
      entry = { image, node: el('image', {}) };
      paintImage(entry.node, image);
      layer.imgs.set(image.id, entry);
    } else if (entry.image !== image) {
      paintImage(entry.node, image);
      entry.image = image;
    }
    if (entry.node === cursor) cursor = cursor.nextSibling;
    else layer.img.insertBefore(entry.node, cursor);
  }
  for (const [id, entry] of layer.imgs) {
    if (!keep.has(id)) {
      entry.node.remove();
      layer.imgs.delete(id);
    }
  }
}

/** A stroke being drawn (see liveStroke). */
export interface LiveStroke {
  update(stroke: Stroke): void;
  remove(): void;
}

/** A stroke being drawn; rendered in its final group so it looks identical. */
export function liveStroke(layer: Layer, tool: StrokeTool): LiveStroke {
  const node = el('path', {});
  (tool === 'pen' ? layer.pen : layer.hl).appendChild(node);
  return {
    update(stroke) { paintStroke(node, stroke); node.classList.add('ann-live'); },
    remove() { node.remove(); },
  };
}

/** Show strokes and images moved by (dx, dy) while they are dragged; (0, 0) resets. */
export function translateStrokes(layer: Layer, ids: readonly string[], dx: number, dy: number): void {
  for (const id of ids) {
    const entry = layer.els.get(id) || (layer.imgs && layer.imgs.get(id));
    if (entry) entry.node.setAttribute('transform', `translate(${dx} ${dy})`);
  }
}

// ── UI overlays ────────────────────────────────────────────────

function uiNode<K extends keyof SVGElementTagNameMap>(layer: Layer, key: string, tag: K, attrs: Attrs): SVGElementTagNameMap[K] {
  layer.uiNodes = layer.uiNodes || {};
  let node = layer.uiNodes[key] as SVGElementTagNameMap[K] | undefined;
  if (!node) node = (layer.uiNodes[key] = el(tag, attrs, layer.ui)) as SVGElementTagNameMap[K];
  return node;
}

function hideUi(layer: Layer, key: string): void {
  if (layer.uiNodes && layer.uiNodes[key]) layer.uiNodes[key].setAttribute('display', 'none');
}

/** Dashed selection rectangle; null hides it. */
export function setSelectionBox(layer: Layer, box: BBox | null, dx = 0, dy = 0): void {
  if (!box) return hideUi(layer, 'sel');
  const pad = 6;
  const node = uiNode(layer, 'sel', 'rect', { class: 'ann-selection' });
  node.removeAttribute('display');
  node.setAttribute('x', String(box.minX - pad + dx));
  node.setAttribute('y', String(box.minY - pad + dy));
  node.setAttribute('width', String(box.maxX - box.minX + 2 * pad));
  node.setAttribute('height', String(box.maxY - box.minY + 2 * pad));
}

/** Rectangle or lasso outline while selecting; null hides it. */
export function setMarquee(layer: Layer, poly: readonly XY[] | null): void {
  if (!poly) return hideUi(layer, 'marquee');
  const node = uiNode(layer, 'marquee', 'polygon', { class: 'ann-marquee' });
  node.removeAttribute('display');
  node.setAttribute('points', poly.map(p => `${round(p[0], 1)},${round(p[1], 1)}`).join(' '));
}

/** Eraser outline following the pointer; null hides it. */
export function setEraserCursor(layer: Layer, pt: XY | null, r?: number): void {
  if (!pt) return hideUi(layer, 'eraser');
  const node = uiNode(layer, 'eraser', 'circle', { class: 'ann-eraser-cursor' });
  node.removeAttribute('display');
  node.setAttribute('cx', String(pt[0]));
  node.setAttribute('cy', String(pt[1]));
  node.setAttribute('r', String(r));
}

// ── Paper (blank pages) ────────────────────────────────────────

/** Look of the paper of blank pages; the PDF export draws the same (@inkslide/export paperOperators). */
export const PAPER_STYLE = Object.freeze({
  /** Rule and grid spacing is the page width / steps (40 units on a 1280-wide slide). */
  steps: 32,
  /** The lined margin is this many steps from the left edge. */
  marginSteps: 3,
  rule: { color: '#a9c8e8', width: 1.2 },
  grid: { color: '#d5dbe3', width: 1 },
  margin: { color: '#e9a3ad', width: 1.2 },
});

/** The paper of a blank page surface (see createPaper). */
export interface PaperHandle {
  base: SVGRectElement;
  set(paper: Paper): void;
}

/**
 * White page with optional ruled lines or grid, drawn as SVG patterns whose
 * spacing scales with the page width (see PAPER_STYLE).
 * Returns { set(paper) }. Must be created before the annotation layer.
 */
export function createPaper(svg: SVGSVGElement, size: Size, uid: string): PaperHandle {
  const [w, h] = size;
  const step = w / PAPER_STYLE.steps;
  const line = (s: { color: string; width: number }): Attrs => ({ stroke: s.color, 'stroke-width': s.width });
  const defs = el('defs', {}, svg);
  const lined = el('pattern', {
    id: `ann-lined-${uid}`, patternUnits: 'userSpaceOnUse', width: w, height: step,
  }, defs);
  el('line', { x1: 0, y1: step - 0.5, x2: w, y2: step - 0.5, class: 'ann-paper-rule', ...line(PAPER_STYLE.rule) }, lined);
  const grid = el('pattern', {
    id: `ann-grid-${uid}`, patternUnits: 'userSpaceOnUse', width: step, height: step,
  }, defs);
  el('path', { d: `M${step} 0V${step}H0`, class: 'ann-paper-grid', fill: 'none', ...line(PAPER_STYLE.grid) }, grid);

  const base = el('rect', { class: 'ann-paper', x: 0, y: 0, width: w, height: h, fill: '#ffffff' }, svg);
  const pattern = el('rect', { x: 0, y: step, width: w, height: h - step, fill: 'none' }, svg);
  const mx = step * PAPER_STYLE.marginSteps;
  const margin = el('line', { class: 'ann-paper-margin', x1: mx, y1: 0, x2: mx, y2: h, ...line(PAPER_STYLE.margin) }, svg);

  return {
    base,
    set(paper) {
      svg.dataset.paper = paper;
      margin.setAttribute('display', paper === 'lined' ? 'inline' : 'none');
      if (paper === 'lined') {
        pattern.setAttribute('y', String(step));
        pattern.setAttribute('height', String(h - step));
        pattern.setAttribute('fill', `url(#ann-lined-${uid})`);
      } else if (paper === 'grid') {
        pattern.setAttribute('y', '0');
        pattern.setAttribute('height', String(h));
        pattern.setAttribute('fill', `url(#ann-grid-${uid})`);
      } else {
        pattern.setAttribute('fill', 'none');
      }
    },
  };
}

// ── Page surface (PDF page or blank page) ──────────────────────

/** Options of createPageSurface. */
export interface PageSurfaceOptions {
  /** Paper for a blank page; omit for a PDF page (the PDF canvas shows through). */
  paper?: Paper;
  /** Unique id for the paper patterns (url(#…) must not depend on page ids). */
  uid?: string;
  /** Extra classes on the <svg>. */
  className?: string;
}

/** Result of createPageSurface. */
export interface PageSurfaceSvg {
  svg: SVGSVGElement;
  layer: Layer;
  paper: PaperHandle | null;
}

let surfaceUid = 0;

/**
 * An <svg class="ann-page"> with viewBox = page size (e.g. PDF points from
 * page.getViewport({ scale: 1 })) and its annotation layer. Blank pages get
 * paper under the layer. Sizing and stacking over the PDF canvas is up to
 * the caller's CSS.
 */
export function createPageSurface(size: Size, opts: PageSurfaceOptions = {}): PageSurfaceSvg {
  const [w, h] = size;
  const svg = el('svg', {
    class: opts.className ? `ann-page ${opts.className}` : 'ann-page',
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'xMidYMid meet',
  });
  let paper: PaperHandle | null = null;
  if (opts.paper) {
    paper = createPaper(svg, [w, h], opts.uid || `s${++surfaceUid}`);
    paper.set(opts.paper);
  }
  return { svg, layer: createLayer(svg), paper };
}

// ── Laser ──────────────────────────────────────────────────────

/** A laser point fades out after this many ms. */
export const LASER_MS = 350;
/** Longest laser trail, in slide units (times layer.unit). */
export const LASER_LEN = 140;
/** Laser width at the head (tapers to the tail), in slide units. */
export const LASER_SIZE = 8;

/** Fading red trail. Points live only here: never stored, never undoable. */
export function laser(layer: Layer): Laser {
  if (layer.laser) return layer.laser;
  const g = el('g', { class: 'ann-laser' }, layer.ui);
  // one smooth tapered shape instead of separate segments (no beads, no gaps)
  const trail = el('path', { class: 'ann-laser-trail' }, g);
  const unit = layer.unit ?? 1;
  const dot = el('circle', { class: 'ann-laser-dot', r: 7 * unit, display: 'none' }, g);
  let pts: { x: number; y: number; t: number }[] = [];
  let frame = 0;

  function draw(): void {
    const now = performance.now();
    pts = pts.filter(p => now - p.t < LASER_MS);
    const head = pts[pts.length - 1];
    if (!head) {
      trail.removeAttribute('d');
      dot.setAttribute('display', 'none');
      frame = 0;
      return;
    }
    const line = laserTrail(pts.map(p => [p.x, p.y]), LASER_LEN * unit);
    // Always the classic outline: the laser's look does not follow the pen engine.
    trail.setAttribute('d', line.length > 1
      ? outlinePath(strokeOutline(smoothPoints(line), LASER_SIZE * unit, { engine: 'classic' })) : '');
    const fade = Math.max(0, 1 - (now - head.t) / LASER_MS).toFixed(3);
    trail.setAttribute('opacity', fade);
    dot.removeAttribute('display');
    dot.setAttribute('cx', String(head.x));
    dot.setAttribute('cy', String(head.y));
    dot.setAttribute('opacity', fade);
    frame = requestAnimationFrame(draw);
  }

  layer.laser = {
    add(pt) {
      pts.push({ x: pt[0], y: pt[1], t: performance.now() });
      if (!frame) frame = requestAnimationFrame(draw);
    },
    clear() {
      pts = [];
      trail.removeAttribute('d');
      dot.setAttribute('display', 'none');
    },
    get length() { return pts.length; },
  };
  return layer.laser;
}
