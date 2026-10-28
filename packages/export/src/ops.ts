/* Inkslide export - PDF content stream helpers (pure, no pdf-lib document)
 *
 * Strokes are drawn from the SVG path data the screen uses (geometry's
 * outlinePath / centerlinePath), converted to PDF path operators. All
 * drawing happens in "display" coordinates: page units with the origin at
 * the top-left of the page as a viewer shows it (y down, after /Rotate and
 * the CropBox), the same frame the notes are stored in.
 */
import {
  appendBezierCurve, closePath, lineTo, moveTo, rectangle, type PDFOperator,
} from 'pdf-lib';
import { colorRgba, type Rgba } from '@inkslide/annotate/color';
import { round } from '@inkslide/annotate/geometry';

/** [a, b, c, d, e, f] of a PDF `cm` operator. */
export type Matrix = [number, number, number, number, number, number];

/** A PDF page box (MediaBox, CropBox) in default user space. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Page rotation normalized to 0, 90, 180 or 270 (PDF allows any multiple of 90, also negative).
 * Like PDF.js, a /Rotate that is no multiple of 90 counts as 0 (it is not rounded).
 */
export function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  if (!Number.isFinite(angle) || angle % 90 !== 0) return 0;
  return ((angle % 360 + 360) % 360) as 0 | 90 | 180 | 270;
}

/** Size of a page as a viewer shows it (the box, rotated). */
export function displaySize(box: Box, rotation: number): [number, number] {
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270 ? [box.height, box.width] : [box.width, box.height];
}

/**
 * Matrix from display coordinates (origin top-left of the shown page, y
 * down) to the page's default user space, for a page whose visible box is
 * `box` and which a viewer turns clockwise by `rotation` degrees.
 */
export function displayMatrix(box: Box, rotation: number): Matrix {
  const { x, y, width: w, height: h } = box;
  switch (normalizeRotation(rotation)) {
    case 90: return [0, 1, 1, 0, x, y];               // top-left shows the box's bottom-left
    case 180: return [-1, 0, 0, 1, x + w, y];         // bottom-right
    case 270: return [0, -1, -1, 0, x + w, y + h];    // top-right
    default: return [1, 0, 0, -1, x, y + h];          // top-left
  }
}

const num = (v: number): number => round(v, 3);

/**
 * PDF path operators for SVG path data. Handles the commands geometry emits
 * (M, L, Q, Z and the relative l of a one-point centerline) plus their
 * absolute / relative forms; quadratic curves become cubic Béziers.
 */
export function svgPathOperators(d: string): PDFOperator[] {
  const ops: PDFOperator[] = [];
  const tokens = d.match(/[MmLlQqZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
  let i = 0, cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const next = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        cx = ox + next(); cy = oy + next();
        sx = cx; sy = cy;
        ops.push(moveTo(num(cx), num(cy)));
        cmd = rel ? 'l' : 'L'; // further pairs after M are line-tos
        break;
      }
      case 'L': {
        cx = ox + next(); cy = oy + next();
        ops.push(lineTo(num(cx), num(cy)));
        break;
      }
      case 'Q': {
        const qx = ox + next(), qy = oy + next();
        const x = ox + next(), y = oy + next();
        ops.push(appendBezierCurve(
          num(cx + (2 / 3) * (qx - cx)), num(cy + (2 / 3) * (qy - cy)),
          num(x + (2 / 3) * (qx - x)), num(y + (2 / 3) * (qy - y)),
          num(x), num(y)));
        cx = x; cy = y;
        break;
      }
      case 'Z': {
        ops.push(closePath());
        cx = sx; cy = sy;
        cmd = ''; // Z takes no numbers: stray ones after it are skipped
        break;
      }
      default:
        i++; // stray number without a command
    }
  }
  return ops;
}

/** A filled rectangle path in display coordinates. */
export const rectOp = (x: number, y: number, w: number, h: number): PDFOperator =>
  rectangle(num(x), num(y), num(w), num(h));

// ── Colors ─────────────────────────────────────────────────────

export type { Rgba };

/**
 * Parse a stroke color (any color a stroke may have, see @inkslide/annotate/color:
 * hex, rgb(), hsl(), CSS names, transparent). Anything else: black.
 */
export function parseColor(css: string): Rgba {
  return colorRgba(css) || { r: 0, g: 0, b: 0, a: 1 };
}
