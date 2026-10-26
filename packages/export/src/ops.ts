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

/** Page rotation normalized to 0, 90, 180 or 270 (PDF allows any multiple of 90, also negative). */
export function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
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

/** RGB in 0..1 and alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', gray: '#808080', grey: '#808080',
};

/** Parse a CSS color as used by stroke colors (#rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), a few names). Unknown: black. */
export function parseColor(css: string): Rgba {
  let s = String(css || '').trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) s = '#' + [...m[1]].map(c => c + c).join('');
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    const v = parseInt(m[1], 16);
    return { r: (v >> 16 & 255) / 255, g: (v >> 8 & 255) / 255, b: (v & 255) / 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = parts.slice(0, 3).map(t => (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t) / 255));
    const alpha = parts[3] == null ? 1 : parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
    if (ch.length === 3 && ch.every(Number.isFinite)) {
      const clamp = (v: number): number => Math.min(1, Math.max(0, v));
      return { r: clamp(ch[0]), g: clamp(ch[1]), b: clamp(ch[2]), a: Number.isFinite(alpha) ? clamp(alpha) : 1 };
    }
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}
