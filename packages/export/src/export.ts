/* Inkslide export - annotated PDF
 *
 * Loads a copy of the original PDF with pdf-lib, inserts the blank pages
 * (with their paper) and appends one content stream per annotated page with
 * the strokes as vector paths. Existing content streams are only wrapped in
 * q/Q (pdf-lib does this so a dangling CTM cannot shift the ink), so the
 * page text stays selectable. The input bytes are never modified.
 *
 * The look follows the screen (render.ts and toolbar.css):
 *   pen          filled outlinePath(strokeOutline(points, size))
 *   highlighter  stroked centerlinePath, width = size, round caps / joins,
 *                opacity 0.35 and multiply blend, below the pen strokes
 *   paper        white page; lined / grid rules, PAPER_STYLE of render.ts
 * Notes are read through NotesDoc (io.loadNotes), so v1 Marp notes are scaled,
 * malformed pages and strokes are skipped with a warning and pages beyond the
 * PDF (kept by NotesDoc) are left out silently.
 */
import {
  LineCapStyle, LineJoinStyle, PDFDocument, PDFName, PDFNumber,
  concatTransformationMatrix, fill, popGraphicsState, pushGraphicsState, setFillingRgbColor,
  setGraphicsState, setLineCap, setLineJoin, setLineWidth, setStrokingRgbColor, stroke as strokeOp,
  type PDFOperator, type PDFPage, type PDFRef,
} from 'pdf-lib';
import {
  centerlinePath, getOutlineEngine, outlinePath, strokeOutline,
  type OutlineEngine, type Stroke,
} from '@inkslide/annotate/geometry';
import { NotesDoc, type NotesJSON, type Paper, type Size } from '@inkslide/annotate/model';
import { loadNotes } from '@inkslide/annotate/io';
import { PAPER_STYLE } from '@inkslide/annotate/render';
import { displayMatrix, displaySize, parseColor, rectOp, svgPathOperators, type Box, type Matrix } from './ops';

/** Highlighter opacity, as `.ann-stroke-hl` in toolbar.css. */
export const HIGHLIGHTER_OPACITY = 0.35;
/** Highlighter blend mode (PDF name), as `.ann-stroke-hl` in toolbar.css. */
export const HIGHLIGHTER_BLEND = 'Multiply';

/** Paper spacing, colors and rule widths: the screen's (render.ts). */
export { PAPER_STYLE };

/** Options of exportAnnotatedPdf and exportAnnotatedPdfWithReport. */
export interface ExportOptions {
  /** Outline of pen strokes; default: the engine the screen uses (geometry.getOutlineEngine()). */
  outline?: OutlineEngine;
  /**
   * Called for each skipped page or stroke. exportAnnotatedPdf defaults to
   * console.warn; exportAnnotatedPdfWithReport calls it only when given.
   */
  onWarning?: (message: string) => void;
}

/** Result of exportAnnotatedPdfWithReport. */
export interface ExportResult {
  bytes: Uint8Array;
  /**
   * Notes that could not be placed (malformed pages and strokes) and page count or size
   * mismatches. Title and checksum are not checked: the caller pairs the notes with the PDF.
   */
  warnings: string[];
  /** Pages in the exported PDF. */
  pageCount: number;
}

interface Frame {
  box: Box;
  rotation: number;
  /** /UserUnit: user space units per display unit (PDF.js scales the viewport by it). */
  unit: number;
  size: Size;
}

/** A box with its corners in either order (allowed by the PDF spec) as x, y, width, height >= 0. */
const normalizeBox = ({ x, y, width, height }: Box): Box => ({
  x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height),
});

/** PDF.js's MediaBox for a page without a usable one: US Letter. */
const LETTER_BOX: Box = { x: 0, y: 0, width: 612, height: 792 };

const hasArea = (b: Box): boolean => b.width > 0 && b.height > 0 && b.width < Infinity && b.height < Infinity;

/** A page box, or null when it is missing, malformed or without area (pdf-lib throws on some). */
function readBox(get: () => Box): Box | null {
  try {
    const b = normalizeBox(get());
    return hasArea(b) ? b : null;
  } catch {
    return null;
  }
}

/**
 * The box a viewer shows: CropBox clipped to the MediaBox (as PDF.js does).
 * A page without a usable MediaBox gets Letter, as in PDF.js, written onto
 * the page so other viewers show the same frame.
 */
function visibleBox(page: PDFPage): Box {
  let m = readBox(() => page.getMediaBox());
  if (!m) {
    m = LETTER_BOX;
    page.setMediaBox(m.x, m.y, m.width, m.height);
  }
  const c = readBox(() => page.getCropBox()) || m;
  const x = Math.max(m.x, c.x), y = Math.max(m.y, c.y);
  const x2 = Math.min(m.x + m.width, c.x + c.width), y2 = Math.min(m.y + m.height, c.y + c.height);
  return x2 > x && y2 > y ? { x, y, width: x2 - x, height: y2 - y } : m;
}

/** The page's /UserUnit as PDF.js reads it: a number > 0 in the page dict itself, else 1. */
function userUnit(page: PDFPage): number {
  const u = page.node.lookup(PDFName.of('UserUnit'));
  return u instanceof PDFNumber && u.asNumber() > 0 ? u.asNumber() : 1;
}

function frameOf(page: PDFPage): Frame {
  const box = visibleBox(page);
  const rotation = page.getRotation().angle;
  const unit = userUnit(page);
  const [w, h] = displaySize(box, rotation);
  return { box, rotation, unit, size: [w * unit, h * unit] };
}

/** Matrix from display coordinates (display units, so /UserUnit applied) to the page's user space. */
function frameMatrix({ box, rotation, unit }: Frame): Matrix {
  const [a, b, c, d, e, f] = displayMatrix(box, rotation);
  return [a / unit, b / unit, c / unit, d / unit, e, f];
}

/** Laser strokes are never stored, but drop them quietly if a file has any. */
function withoutLaser(notes: NotesJSON): NotesJSON {
  return {
    ...notes,
    pages: (notes.pages || []).map(p => (p && Array.isArray(p.strokes)
      ? { ...p, strokes: p.strokes.filter(s => !s || (s.tool as string) !== 'laser') } : p)),
  };
}

/** Why a PDF with encryption (usually an owner password against changes) can not be exported. */
export const ENCRYPTED_PDF_MESSAGE = 'This PDF is encrypted (its author protected it against changes), so Inkslide can not '
  + 'write a copy with notes. Save an unprotected copy first, for example with "qpdf --decrypt in.pdf out.pdf".';

/**
 * pdf-lib's load, with a plain message for encrypted PDFs: pdf-lib can not
 * decrypt them. (Its own EncryptedPDFError fails instanceof, an ES5 Error
 * subclass, so the document is loaded anyway and checked.)
 */
async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  if (pdf.isEncrypted) throw new Error(ENCRYPTED_PDF_MESSAGE);
  return pdf;
}

/**
 * Annotated copy of a PDF and the warnings for notes that were skipped.
 * Notes kept for pages beyond the PDF (NotesDoc.kept, after the PDF lost
 * pages) are expected and left out silently: they are no problem of the export.
 */
export async function exportAnnotatedPdfWithReport(
  pdfBytes: Uint8Array, notes: NotesJSON | null | undefined, opts: ExportOptions = {},
): Promise<ExportResult> {
  const pdf = await loadPdf(pdfBytes);
  const pages = pdf.getPages(); // once: every insertPage() makes pdf-lib walk the page tree again
  const frames = pages.map(frameOf);
  const deck = notes ? notes.deck : null;
  const doc = new NotesDoc({
    source: 'pdf', title: deck ? deck.title : '', slides: frames.length,
    pageSizes: frames.map(f => f.size), sha256: deck ? deck.sha256 : undefined,
  });
  // Kept pages are notices, not warnings: the export leaves them out silently.
  const warnings = notes ? loadNotes(doc, withoutLaser(notes)).warnings : [];
  if (opts.onWarning) warnings.forEach(opts.onWarning);
  const painter = new Painter(pdf, opts.outline || getOutlineEngine());

  let index = 0;
  for (const id of doc.sequence()) {
    const page = doc.getPage(id); // null: a slide page without notes (no load() when notes are null)
    if (!page || page.kind === 'slide') {
      index++;
      if (page && page.strokes.length) painter.paint(pages[page.slide - 1], frames[page.slide - 1], null, page.strokes);
    } else {
      const size = frames[page.after - 1].size;
      const target = pdf.insertPage(index++, [size[0], size[1]]);
      const frame: Frame = { box: { x: 0, y: 0, width: size[0], height: size[1] }, rotation: 0, unit: 1, size };
      painter.paint(target, frame, page.paper, page.strokes);
    }
  }

  const bytes = await pdf.save();
  return { bytes, warnings, pageCount: pdf.getPageCount() };
}

/**
 * Annotated copy of a PDF: blank pages inserted, strokes drawn as vectors.
 * Skipped notes are reported to opts.onWarning (default console.warn).
 */
export async function exportAnnotatedPdf(
  pdfBytes: Uint8Array, notes: NotesJSON | null | undefined, opts: ExportOptions = {},
): Promise<Uint8Array> {
  const onWarning = opts.onWarning || ((m: string) => { if (typeof console !== 'undefined') console.warn(`Inkslide export: ${m}`); });
  return (await exportAnnotatedPdfWithReport(pdfBytes, notes, { ...opts, onWarning })).bytes;
}

// ── Painting ───────────────────────────────────────────────────

class Painter {
  /** ExtGState dicts shared by all pages, keyed by "ca/CA/BM". */
  private states = new Map<string, PDFRef>();
  /** Resource name of each state per page dict. */
  private names = new WeakMap<object, Map<string, PDFName>>();

  constructor(private pdf: PDFDocument, private engine: OutlineEngine) {}

  paint(page: PDFPage, frame: Frame, paper: Paper | null, strokes: readonly Stroke[]): void {
    page.node.normalize(); // wraps the existing content in q/Q
    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...frameMatrix(frame))];
    if (paper) ops.push(...paperOperators(paper, frame.size));
    // The screen draws all highlighter strokes in a group below the pen group.
    for (const s of strokes) if (s.tool === 'highlighter') ops.push(...this.highlighter(page, s));
    for (const s of strokes) if (s.tool === 'pen') ops.push(...this.pen(page, s));
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }

  private pen(page: PDFPage, s: Stroke): PDFOperator[] {
    const path = svgPathOperators(outlinePath(strokeOutline(s.points, s.size, { engine: this.engine })));
    if (!path.length) return [];
    const c = parseColor(s.color);
    const ops = [pushGraphicsState()];
    if (c.a < 1) ops.push(setGraphicsState(this.state(page, c.a, 1, null)));
    ops.push(setFillingRgbColor(c.r, c.g, c.b), ...path, fill(), popGraphicsState());
    return ops;
  }

  private highlighter(page: PDFPage, s: Stroke): PDFOperator[] {
    const path = svgPathOperators(centerlinePath(s.points));
    if (!path.length) return [];
    const c = parseColor(s.color);
    return [
      pushGraphicsState(),
      setGraphicsState(this.state(page, 1, HIGHLIGHTER_OPACITY * c.a, HIGHLIGHTER_BLEND)),
      setStrokingRgbColor(c.r, c.g, c.b),
      setLineWidth(s.size), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round),
      ...path, strokeOp(), popGraphicsState(),
    ];
  }

  /** Resource name on `page` of an ExtGState with fill alpha ca, stroke alpha CA and blend mode. */
  private state(page: PDFPage, ca: number, CA: number, blend: string | null): PDFName {
    const key = `${ca}/${CA}/${blend}`;
    let ref = this.states.get(key);
    if (!ref) {
      const dict = this.pdf.context.obj({ Type: 'ExtGState' });
      if (ca < 1) dict.set(PDFName.of('ca'), PDFNumber.of(ca));
      if (CA < 1) dict.set(PDFName.of('CA'), PDFNumber.of(CA));
      if (blend) dict.set(PDFName.of('BM'), PDFName.of(blend));
      ref = this.pdf.context.register(dict);
      this.states.set(key, ref);
    }
    // Pages may share (inherited) resource dicts; key the names by the dict.
    const { Resources } = page.node.normalizedEntries();
    let names = this.names.get(Resources);
    if (!names) this.names.set(Resources, names = new Map());
    let name = names.get(key);
    if (!name) names.set(key, name = page.node.newExtGState('InkGS', ref));
    return name;
  }
}

// ── Paper ──────────────────────────────────────────────────────

/**
 * Paper of a blank page in display coordinates. The screen draws the rules
 * as SVG patterns clipped to their tiles, so only the inner part of each
 * rule shows: lined rules are 1.1 units ending at y = k·step (k ≥ 2), grid
 * lines 0.5 units ending at x, y = k·step (k ≥ 1). These are drawn as
 * rectangles of exactly that area. The lined margin is a full 1.2 line.
 */
export function paperOperators(paper: Paper, size: Size): PDFOperator[] {
  const [w, h] = size;
  // A page without area (broken MediaBox) gets no paper: the rule loops would never end.
  if (!(w > 0 && h > 0 && w < Infinity && h < Infinity)) return [];
  const step = w / PAPER_STYLE.steps;
  const ops: PDFOperator[] = [setFillingRgbColor(1, 1, 1), rectOp(0, 0, w, h), fill()];
  const fillRgb = (css: string): PDFOperator => {
    const c = parseColor(css);
    return setFillingRgbColor(c.r, c.g, c.b);
  };
  if (paper === 'lined') {
    const t = PAPER_STYLE.rule.width / 2 + 0.5; // rule centered 0.5 above the tile edge
    ops.push(fillRgb(PAPER_STYLE.rule.color));
    for (let k = 2; k * step - t < h; k++) ops.push(rectOp(0, k * step - t, w, Math.min(t, h - (k * step - t))));
    ops.push(fill());
    const m = PAPER_STYLE.margin.width;
    ops.push(fillRgb(PAPER_STYLE.margin.color), rectOp(step * PAPER_STYLE.marginSteps - m / 2, 0, m, h), fill());
  } else if (paper === 'grid') {
    const t = PAPER_STYLE.grid.width / 2;
    ops.push(fillRgb(PAPER_STYLE.grid.color));
    for (let k = 1; k * step - t < w; k++) ops.push(rectOp(k * step - t, 0, Math.min(t, w - (k * step - t)), h));
    for (let k = 1; k * step - t < h; k++) ops.push(rectOp(0, k * step - t, w, Math.min(t, h - (k * step - t))));
    ops.push(fill());
  }
  return ops;
}
