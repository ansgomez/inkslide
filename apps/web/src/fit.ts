/* Inkslide web - fit-to-window and render-size math (pure, no DOM) */
import type { Size } from '@inkslide/annotate';

/** A width and height in CSS px. */
export interface Box {
  width: number;
  height: number;
}

/** Where and how large a page is shown in the stage, CSS px. */
export interface FitRect {
  /** CSS px per page unit (PDF point). */
  scale: number;
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * How a page is fitted: "page" shows the whole page, "width" fills the box
 * width and scrolls vertically when the page is taller than the box.
 */
export type FitMode = 'page' | 'width';

/**
 * Fit a page into the box (minus margin on each side), centred.
 * "page": the largest scale that shows the whole page. "width": the scale
 * that fills the box width; a page taller than the box starts at its top
 * (scrolled by the view's ty).
 */
export function fitTo(mode: FitMode, page: Size, box: Box, margin = 0): FitRect {
  const bw = Math.max(1, box.width - 2 * margin), bh = Math.max(1, box.height - 2 * margin);
  const sx = bw / page[0], sy = bh / page[1];
  const scale = page[0] > 0 && page[1] > 0 ? (mode === 'width' ? sx : Math.min(sx, sy)) : 1;
  const width = Math.round(page[0] * scale), height = Math.round(page[1] * scale);
  return {
    scale, width, height,
    left: Math.round((box.width - width) / 2),
    top: height > bh ? margin : Math.round((box.height - height) / 2),
  };
}

/**
 * Part of the fitted page box that the box (minus margins) shows: the whole
 * page for the page fit, the top screenful of a tall page for the width fit. Panning
 * keeps the (zoomed) page covering this part, see clampPan.
 */
export function visibleBox(fit: FitRect, box: Box, margin = 0): Box {
  return {
    width: Math.min(fit.width, Math.max(1, box.width - 2 * margin)),
    height: Math.min(fit.height, Math.max(1, box.height - 2 * margin)),
  };
}

/** Upper bound for one rendered page (iOS limits canvases to 16 M pixels). */
export const MAX_RENDER_PIXELS = 16_000_000;

/**
 * PDF.js render scale (device pixels per point) for a page shown at `fit`
 * CSS px per point, zoomed by `zoom`, on a `dpr` screen; capped so the
 * bitmap stays under maxPixels.
 */
export function renderScale(page: Size, fit: number, dpr = 1, zoom = 1, maxPixels = MAX_RENDER_PIXELS): number {
  let s = fit * Math.max(1, dpr) * Math.max(1, zoom);
  const px = page[0] * s * page[1] * s;
  if (px > maxPixels) s *= Math.sqrt(maxPixels / px);
  return s;
}

/** Cache key part for a render scale: close scales (resize jitter) share a bitmap. */
export const scaleKey = (s: number): string => s.toFixed(2);

/**
 * Clamp a view translation so the page (box size × zoom) still covers the
 * `visible` part of its box (default: all of it): no gap opens at an edge.
 * tx, ty are in CSS px; in fit-width mode ty is also the vertical scroll.
 */
export function clampPan(tx: number, ty: number, box: Box, zoom: number, visible: Box = box): [number, number] {
  const [minX, minY] = panLimits(box, zoom, visible);
  return [Math.min(0, Math.max(minX, tx)), Math.min(0, Math.max(minY, ty))];
}

/** Smallest tx, ty clampPan allows (the largest is 0): the page's right / bottom end. */
export function panLimits(box: Box, zoom: number, visible: Box = box): [number, number] {
  return [Math.min(0, visible.width - box.width * zoom), Math.min(0, visible.height - box.height * zoom)];
}

/**
 * PgDn / PgUp in fit-width mode: the next ty, `screen` × (1 - overlap)
 * further in direction `dir`, within [minTy, 0]; null when the page is
 * already at that end (turn the page instead).
 */
export function pageScroll(ty: number, minTy: number, screen: number, dir: -1 | 1, overlap = 0.1): number | null {
  const atEnd = dir > 0 ? ty <= minTy + 0.5 : ty >= -0.5;
  if (atEnd) return null;
  return Math.min(0, Math.max(minTy, ty - dir * Math.max(1, screen * (1 - overlap))));
}
