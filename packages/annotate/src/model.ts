/* Inkslide annotate - document model, commands and (de)serialization (pure, no DOM)
 *
 * Ported from Marp Notes model.js (© Andres Gomez, MIT).
 * Strokes are immutable: every edit replaces a page's stroke array (and any
 * changed stroke object), so a command only needs the before/after arrays.
 * Images (snapshots pasted onto a page) are kept the same way in a second
 * array, drawn below all ink; one command can change both arrays.
 *
 * "Slide" pages are the pages of the source document: Marp slides (ids s1…sN)
 * or PDF pages (ids p1…pN). Blank pages sit after a slide page.
 */
import { round, translatePoints, type Point, type Stroke, type StrokeTool } from './geometry';

/** `format` field of every notes file. */
export const FORMAT = 'marp-notes';
/**
 * Newest notes file version this model reads. Marp decks still write version 1, PDFs version 2;
 * a file with images is version 3, so older builds reject it instead of dropping the images on
 * their next save (see docs/NOTES-FORMAT.md).
 */
export const VERSION = 3;
/** Stroke tools a notes file may contain. */
export const TOOLS: readonly StrokeTool[] = ['pen', 'highlighter'];
/** Papers of blank pages. */
export const PAPERS = ['plain', 'lined', 'grid'] as const;

/** Paper of a blank page. */
export type Paper = typeof PAPERS[number];
/** [width, height] in page units. */
export type Size = [number, number];
/** 'marp': an HTML deck (slides s<n>); 'pdf': a PDF (pages p<n>). */
export type DeckSource = 'marp' | 'pdf';

/** The document the notes belong to. */
export interface Deck {
  /** 'marp' (HTML deck, page ids s<n>) or 'pdf' (page ids p<n>). */
  source: DeckSource;
  title: string;
  /** Number of source pages (slides or PDF pages). */
  slides: number;
  /** Size of the first page, in viewBox units (PDF: points). */
  size: Size;
  /** Per-page sizes (PDF), index n - 1; pages without an entry use `size`. */
  pageSizes?: Size[];
  /** Hex SHA-256 of the PDF file. */
  sha256?: string;
}

/** Deck for the NotesDoc constructor; missing fields get defaults. */
export type DeckInit = Partial<Deck> & { slides?: number };

/** A page of the source document (Marp slide or PDF page). */
export interface SlidePage {
  id: string;
  kind: 'slide';
  slide: number;
  strokes: readonly Stroke[];
  images: readonly PageImage[];
}

/** A page inserted by the user after a slide page. */
export interface BlankPage {
  id: string;
  kind: 'blank';
  /** Number of the slide page this blank page follows. */
  after: number;
  paper: Paper;
  strokes: readonly Stroke[];
  images: readonly PageImage[];
}

/** A page of the notes: a source page or a blank page. */
export type Page = SlidePage | BlankPage;

/** An undoable step; `pageId` names the page it changed (if any). */
export interface Command {
  label?: string;
  pageId?: string;
  do(): void;
  undo(): void;
}

/**
 * An image on a page: a PNG or JPEG data URL drawn into the rectangle x, y,
 * w, h (page units, origin top-left), below all ink. Like strokes, images
 * are immutable; a move replaces the object.
 */
export interface PageImage {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** "data:image/png;base64,…" or "data:image/jpeg;base64,…". */
  src: string;
}

/** Unchecked image data, as accepted by createImage. */
export interface ImageInput {
  id?: string | null;
  x: unknown;
  y: unknown;
  w: unknown;
  h: unknown;
  src: unknown;
}

/** Unchecked stroke data, as accepted by createStroke. */
export interface StrokeInput {
  id?: string | null;
  tool: string;
  color: unknown;
  size: unknown;
  points: unknown;
}

/** One page as stored in a notes file. */
export interface PageJSON {
  id: string;
  kind: 'slide' | 'blank';
  slide?: number;
  after?: number;
  paper?: Paper;
  strokes: StrokeJSON[];
  /** Version 3: images, bottom to top; left out when the page has none. */
  images?: ImageJSON[];
}

/** One stroke as stored in a notes file. */
export interface StrokeJSON {
  id: string;
  tool: StrokeTool;
  color: string;
  size: number;
  points: Point[];
}

/** One image as stored in a notes file (v3). */
export type ImageJSON = PageImage;

/** Deck information as stored in a notes file (v1: title, slides, size). */
export interface DeckJSON {
  source?: DeckSource;
  title: string;
  slides: number;
  size: Size;
  pageSizes?: Size[];
  sha256?: string;
}

/** A notes file (see docs/NOTES-FORMAT.md). */
export interface NotesJSON {
  format: typeof FORMAT;
  version: number;
  deck: DeckJSON;
  pages: PageJSON[];
}

/** kind: 'strokes' (a page's strokes or images changed), 'pages' (pages added/removed/restyled) or 'saved'. */
export type ChangeKind = 'strokes' | 'pages' | 'saved';
/** Listener of NotesDoc.onChange; pageId is null for document-wide changes (e.g. 'strokes' of every page after load()). */
export type ChangeListener = (pageId: string | null, kind: ChangeKind) => void;

let idCounter = 0;
// Unique per window, so two windows (presenter + audience) never mint the same id.
const idPrefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/** A new stroke id, unique per window. */
export const newId = (): string => `${idPrefix}-${(idCounter++).toString(36)}`;

/** Longest stroke or image id kept (presenter mode sends ids up to this length); longer ones get a new id. */
export const MAX_ID_LENGTH = 200;
/** Longest stroke color kept (a CSS color; presenter mode sends colors up to this length). */
export const MAX_COLOR_LENGTH = 100;
/** `id` if it is a usable id (a non-empty string of at most MAX_ID_LENGTH), else a new one. */
const itemId = (id: unknown): string => (typeof id === 'string' && id && id.length <= MAX_ID_LENGTH ? id : newId());

/**
 * Largest |x|, |y| and size a stroke may have, in page units. Pages are at most
 * 14400 pt; beyond this the numbers only come from broken files or edits, and
 * would overflow when rounded for saving (null in the file) or exported.
 */
export const MAX_COORD = 1e6;

/** Calls every listener; one that throws is logged and does not stop the others (or the edit that emitted). */
function notify<A extends unknown[]>(listeners: readonly ((...args: A) => void)[], ...args: A): void {
  for (const fn of listeners) {
    try {
      fn(...args);
    } catch (e) {
      if (typeof console !== 'undefined') console.error('Inkslide: a change listener failed', e);
    }
  }
}

/**
 * A checked stroke: known tool, positive finite number size, at least one point, finite points within
 * ±MAX_COORD (pressure defaults to 0.5, clamped to 0..1). Throws on bad input; a missing or non-string id gets newId().
 */
export function createStroke({ id, tool, color, size, points }: StrokeInput): Stroke {
  if (!TOOLS.includes(tool as StrokeTool)) throw new Error(`Unknown stroke tool: ${tool}`);
  if (!Array.isArray(points)) throw new Error('Stroke points must be an array');
  if (typeof size !== 'number' || !(size > 0)) throw new Error('Stroke size must be a positive number');
  if (!(size <= MAX_COORD)) throw new Error('Stroke size out of range');
  if (!points.length) throw new Error('Stroke has no points');
  if (String(color).length > MAX_COLOR_LENGTH) throw new Error('Stroke color too long');
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  return {
    id: itemId(id),
    tool: tool as StrokeTool,
    color: String(color),
    size,
    points: points.map((p: unknown): Point => {
      const q = p as number[] | null;
      const pressure = q && q[2] == null ? 0.5 : q && q[2];
      if (!q || !finite(q[0]) || !finite(q[1]) || !finite(pressure)) {
        throw new Error('Stroke points must be finite numbers');
      }
      if (Math.abs(q[0]) > MAX_COORD || Math.abs(q[1]) > MAX_COORD) throw new Error('Stroke points out of range');
      return [q[0], q[1], Math.min(1, Math.max(0, pressure))];
    }),
  };
}

// ── Images ─────────────────────────────────────────────────────

/**
 * Smallest width and height of an image, in page units: the rounding of a
 * saved file (2 decimals) keeps it positive, so a saved image always loads.
 */
export const MIN_IMAGE_SIZE = 0.01;
/** Image types a notes file may contain, with the start of their base64 data (the file signature). */
const IMAGE_MAGIC: Readonly<Record<string, string>> = { 'image/png': 'iVBORw0KGgo', 'image/jpeg': '/9j/' };
/** Longest data URL of one image, in characters (about 2.2 MB of image data). */
export const MAX_IMAGE_CHARS = 3_000_000;
/** Most images on one page. */
export const MAX_PAGE_IMAGES = 32;
/** Most images in one document. */
export const MAX_DOC_IMAGES = 256;
/** Most data URL characters of all images of one document (they are all in the notes file). */
export const MAX_DOC_IMAGE_CHARS = 24_000_000;

/**
 * Most pixels per side, and in all, of an image. A small file can hold a huge
 * image (a 41 KB PNG of 16000×16000 pixels); decoding one (the export, the
 * screen, a snapshot) would take seconds and gigabytes. Snapshots are at most
 * 2048 px on a side; images pasted from other programs are scaled down first.
 */
export const MAX_IMAGE_SIDE = 4096, MAX_IMAGE_PIXELS = 16_000_000;
/** Bytes of a JPEG searched for its frame header (SOFn); our own JPEGs have it in the first few hundred. */
const JPEG_HEADER_BYTES = 256 * 1024;

const DATA_URL = /^data:(image\/(?:png|jpeg));base64,[A-Za-z0-9+/]*={0,2}$/;

/** Image type and size in pixels. */
export interface ImageInfo {
  type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** The first `bytes` bytes of base64 `data` (fewer if it is shorter). */
function headBytes(data: string, bytes: number): Uint8Array {
  return bytesAt(data, 0, bytes);
}

/** `n` bytes from byte `offset` of base64 `data`, decoding only the base64 groups that hold them. */
function bytesAt(data: string, offset: number, n: number): Uint8Array {
  const first = Math.floor(offset / 3);
  const raw = atob(data.slice(first * 4, Math.ceil((offset + n) / 3) * 4));
  const skip = offset - first * 3;
  const out = new Uint8Array(Math.max(0, Math.min(n, raw.length - skip)));
  for (let i = 0; i < out.length; i++) out[i] = raw.charCodeAt(skip + i);
  return out;
}

/** Most chunks of a PNG walked; canvas PNGs have a handful plus one IDAT per 8–64 KB. */
const MAX_PNG_CHUNKS = 10_000;

/**
 * Why a PNG (base64 `data`) is refused for its chunks, or '': animated (an
 * acTL chunk: pdf-lib decodes every frame of an APNG before it rejects it,
 * so many large frames in a small file exhaust memory) or more than
 * MAX_PNG_CHUNKS chunks. Walks the chunk headers by their lengths, decoding
 * only the 8 bytes of each header, not the chunk data.
 */
function pngChunkProblem(data: string): string {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const size = (data.length / 4) * 3 - pad;
  let offset = 8; // after the signature
  for (let chunks = 0; offset + 8 <= size; chunks++) {
    if (chunks >= MAX_PNG_CHUNKS) return 'Image has too many PNG chunks';
    const h = bytesAt(data, offset, 8);
    const length = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (type === 'acTL') return 'Animated PNG images are not supported';
    if (type === 'IEND') break;
    offset += 12 + length; // length, type, data, CRC
  }
  return '';
}

/**
 * Width and height in pixels from the start of a PNG (the IHDR chunk) or
 * JPEG (the first SOFn frame header, found by walking the marker segments
 * within the bytes given); null if they are not there (truncated, no frame
 * header before the scan data, broken segments).
 */
export function imagePixelSize(type: string, b: Uint8Array): { width: number; height: number } | null {
  const u16 = (i: number): number => (b[i] << 8) | b[i + 1];
  const u32 = (i: number): number => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (type === 'image/png') {
    // Signature (8), chunk length (4), "IHDR" (4), width (4), height (4).
    if (b.length < 24 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null;
    return { width: u32(16), height: u32(20) };
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null; // not at a marker: broken
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // no length
    if (m === 0xd9 || m === 0xda) return null; // end, or the scan, before any frame header
    if (i + 3 >= b.length) return null;
    const len = u16(i + 2);
    if (len < 2) return null;
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC): precision (1), height (2), width (2).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 8 >= b.length) return null;
      return { width: u16(i + 7), height: u16(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Type and pixel size of an image data URL Inkslide accepts: PNG or JPEG,
 * base64, the signature checked, at most MAX_IMAGE_SIDE pixels on a side and
 * MAX_IMAGE_PIXELS in all; otherwise why not.
 */
function inspectImage(src: unknown): ImageInfo | string {
  const bad = 'Image must be a PNG or JPEG data URL';
  if (typeof src !== 'string') return bad;
  if (src.length > MAX_IMAGE_CHARS) return 'Image too large';
  const m = DATA_URL.exec(src);
  if (!m) return bad;
  const type = m[1] as ImageInfo['type'];
  const data = src.slice(src.indexOf(',') + 1);
  if (data.length % 4 !== 0 || !data.startsWith(IMAGE_MAGIC[type])) return bad;
  let size: { width: number; height: number } | null;
  try { size = imagePixelSize(type, headBytes(data, type === 'image/png' ? 24 : JPEG_HEADER_BYTES)); } catch (_) { size = null; }
  if (!size || !size.width || !size.height) return 'Image size in pixels could not be read';
  if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE || size.width * size.height > MAX_IMAGE_PIXELS) {
    return `Image too large (${size.width}×${size.height} pixels; at most ${MAX_IMAGE_SIDE} on a side)`;
  }
  const chunks = type === 'image/png' ? pngChunkProblem(data) : '';
  if (chunks) return chunks;
  return { type, ...size };
}

/** MIME type of an image data URL Inkslide accepts (see inspectImage); null otherwise. */
export function imageType(src: unknown): 'image/png' | 'image/jpeg' | null {
  const info = inspectImage(src);
  return typeof info === 'string' ? null : info.type;
}

/** Type and pixel size of an image data URL Inkslide accepts; null otherwise. */
export function imageInfo(src: unknown): ImageInfo | null {
  const info = inspectImage(src);
  return typeof info === 'string' ? null : info;
}

/**
 * A checked image: a PNG or JPEG data URL of at most MAX_IMAGE_CHARS and
 * MAX_IMAGE_SIDE × MAX_IMAGE_SIDE pixels (MAX_IMAGE_PIXELS in all), finite x
 * and y within ±MAX_COORD, w and h from MIN_IMAGE_SIZE to MAX_COORD. Throws on
 * bad input; a missing or unusable id (not a string, longer than
 * MAX_ID_LENGTH) gets newId().
 */
export function createImage(input: ImageInput): PageImage {
  const { id, x, y, w, h, src } = (input && typeof input === 'object' ? input : {}) as Partial<ImageInput>;
  const info = inspectImage(src);
  if (typeof info === 'string') throw new Error(info);
  const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
  if (!coord(x) || !coord(y)) throw new Error('Image position must be finite numbers in range');
  if (!coord(w) || !coord(h) || !(w >= MIN_IMAGE_SIZE) || !(h >= MIN_IMAGE_SIZE)) {
    throw new Error(`Image size must be numbers from ${MIN_IMAGE_SIZE} to ${MAX_COORD}`);
  }
  const image: PageImage = { id: itemId(id), x, y, w, h, src: src as string };
  pixelCache.set(image, info.width * info.height);
  return image;
}

/** Images and data URL characters in use (see NotesDoc.imageRoom). */
interface ImageBudget {
  count: number;
  chars: number;
  /** Decoded pixels of all images (see imagePixels). */
  pixels: number;
}

/**
 * Most decoded pixels of the images of one page, and of a document. Each
 * image is limited (MAX_IMAGE_PIXELS), but 32 large ones on a page decode to
 * about 2 GB (4 bytes a pixel) on screen, in a snapshot or in the export. A
 * snapshot is at most 2048×2048 (4.2 MP), usually much less: a page holds 15
 * of the largest, a document 61.
 */
export const MAX_PAGE_IMAGE_PIXELS = 64_000_000, MAX_DOC_IMAGE_PIXELS = 256_000_000;

/** Pixels of images by object (images are immutable), so the budgets do not read every image header again. */
const pixelCache = new WeakMap<object, number>();

/** Decoded pixels of an image (width × height from its data); 0 if its data is not a valid image. */
export function imagePixels(image: { src?: unknown }): number {
  let n = pixelCache.get(image);
  if (n === undefined) {
    const info = imageInfo(image && image.src);
    n = info ? info.width * info.height : 0;
    if (image && typeof image === 'object') pixelCache.set(image, n);
  }
  return n;
}

// ── History ────────────────────────────────────────────────────

/** Command stack; a command is { do(), undo(), label }. */
export class History {
  limit: number;
  undoStack: Command[] = [];
  redoStack: Command[] = [];
  private listeners: ((h: History) => void)[] = [];

  constructor(limit = 500) {
    this.limit = limit;
  }
  /** Run a command and push it on the undo stack (dropping the oldest past `limit`); clears redo. */
  execute<C extends Command>(cmd: C): C {
    cmd.do();
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit();
    return cmd;
  }
  /** Run cmd[method]; a command that fails is dropped (logged), never rethrown. */
  step(from: Command[], to: Command[], method: 'do' | 'undo'): Command | null {
    const cmd = from[from.length - 1];
    if (!cmd) return null;
    try {
      cmd[method]();
    } catch (e) {
      from.pop();
      if (typeof console !== 'undefined') console.warn(`Inkslide: dropped a failing ${cmd.label || 'command'}`, e);
      this.emit();
      return null;
    }
    from.pop();
    to.push(cmd);
    this.emit();
    return cmd;
  }
  undo(): Command | null { return this.step(this.undoStack, this.redoStack, 'undo'); }
  redo(): Command | null { return this.step(this.redoStack, this.undoStack, 'do'); }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  /** The command undo() would revert (the saved state is compared by it). */
  top(): Command | null { return this.undoStack[this.undoStack.length - 1] || null; }
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }
  /** Called after every execute, undo, redo and clear. Returns a function that removes the listener. */
  onChange(fn: (h: History) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }
  emit(): void { notify(this.listeners, this); }
}

// ── Document ───────────────────────────────────────────────────

const sameArray = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const DEFAULT_SIZE: Size = [1280, 720];

/** Page id prefix of the source pages: s<n> for Marp slides, p<n> for PDF pages. */
export const slidePrefix = (source: DeckSource): string => (source === 'pdf' ? 'p' : 's');

/** Whether n is the number of a source page of the deck (an integer in 1..slides). */
const inDeck = (n: number, deck: Deck): boolean => Number.isInteger(n) && n >= 1 && n <= deck.slides;

/** The notes of one document: pages, blank pages, undo history and change events. See the module comment. */
export class NotesDoc {
  deck: Deck;
  pages = new Map<string, Page>();
  blankOrder: string[] = [];   // blank page ids, in sequence order (sorted by .after)
  blankCounter = 0;
  blankPrefix = Math.random().toString(36).slice(2, 8); // per window
  history = new History();
  savedTop: Command | null = null;
  remoteDirty = false; // unsaved changes that arrived from another window
  /**
   * Notes for pages this deck does not have (the PDF got shorter): not shown,
   * written back unchanged so they come back if the pages do.
   */
  kept: PageJSON[] = [];
  private listeners: ChangeListener[] = [];
  private readonly prefix: string;
  private readonly slideRe: RegExp;

  constructor(deck: DeckInit) {
    const source: DeckSource = deck.source === 'pdf' ? 'pdf' : 'marp';
    const pageSizes = deck.pageSizes ? deck.pageSizes.map(s => [s[0], s[1]] as Size) : undefined;
    const size = deck.size ? [deck.size[0], deck.size[1]] as Size
      : pageSizes && pageSizes[0] ? [pageSizes[0][0], pageSizes[0][1]] as Size : DEFAULT_SIZE.slice() as Size;
    this.deck = { source, title: deck.title || '', slides: deck.slides || 0, size };
    if (pageSizes) this.deck.pageSizes = pageSizes;
    if (deck.sha256) this.deck.sha256 = deck.sha256;
    this.prefix = slidePrefix(source);
    this.slideRe = new RegExp(`^${this.prefix}(\\d+)$`);
  }

  // Pages

  /** Id of source page n (s<n> or p<n>); creates the page entry if needed. */
  slidePageId(n: number): string {
    const id = this.slideId(n);
    if (!this.pages.has(id)) this.pages.set(id, { id, kind: 'slide', slide: n, strokes: [], images: [] });
    return id;
  }
  getPage(id: string): Page | null { return this.pages.get(id) || null; }
  /** Whether strokes can be written to page `id` (a blank page deleted meanwhile cannot). */
  hasPage(id: string): boolean { return !!(this.pages.get(id) || this.pageOnDemand(id)); }
  private slideId(n: number): string { return `${this.prefix}${n}`; }

  /** Slide pages exist implicitly: create "s<n>" the first time it is written. */
  pageOnDemand(id: string | null | undefined): Page | null {
    const m = this.slideRe.exec(id || '');
    const n = m ? Number(m[1]) : 0;
    return inDeck(n, this.deck) ? this.pages.get(this.slidePageId(n))! : null;
  }

  /** Ids of the blank pages after source page n, in order. */
  blanksAfter(n: number): string[] {
    return this.blankOrder.filter(id => (this.pages.get(id) as BlankPage).after === n);
  }

  /** All pages in reading order: slide 1, its blank pages, slide 2, … */
  sequence(): string[] {
    const blanks = new Map<number, string[]>();
    for (const id of this.blankOrder) {
      const after = (this.pages.get(id) as BlankPage).after;
      const list = blanks.get(after);
      if (list) list.push(id); else blanks.set(after, [id]);
    }
    const out: string[] = [];
    for (let n = 1; n <= this.deck.slides; n++) out.push(this.slideId(n), ...(blanks.get(n) || []));
    return out;
  }

  /** Source page number of a page: its own for a slide page, the one it follows for a blank page. */
  ownerSlide(pageId: string): number | null {
    const page = this.pages.get(pageId);
    if (page) return page.kind === 'slide' ? page.slide : page.after;
    const m = this.slideRe.exec(pageId);
    return m ? Number(m[1]) : null;
  }

  /** { slide, index, count }: index within [slide, ...its blank pages], 1-based. */
  position(pageId: string): { slide: number | null; index: number; count: number } {
    const slide = this.ownerSlide(pageId);
    const group = [`${this.prefix}${slide}`, ...(slide == null ? [] : this.blanksAfter(slide))];
    return { slide, index: group.indexOf(pageId) + 1, count: group.length };
  }

  /** The page `dir` steps away in reading order; null at either end or for an unknown page. */
  neighbor(pageId: string, dir: number): string | null {
    const seq = this.sequence();
    const i = seq.indexOf(pageId);
    return i === -1 ? null : seq[i + dir] || null;
  }

  /** Size of a page in viewBox units; a blank page has the size of its slide page. */
  pageSize(pageId: string): Size {
    const n = this.ownerSlide(pageId);
    const s = n != null && this.deck.pageSizes && this.deck.pageSizes[n - 1];
    return s ? [s[0], s[1]] : [this.deck.size[0], this.deck.size[1]];
  }

  /** Insert a blank page directly after `afterId` (a slide or blank page). */
  insertBlankPage(afterId: string, paper: Paper = 'plain'): Command & { pageId: string } {
    checkPaper(paper);
    const after = this.ownerSlide(afterId);
    if (after == null || !inDeck(after, this.deck)) throw new Error(`No page ${afterId}`);
    let id: string;
    do { id = `b-${this.blankPrefix}-${++this.blankCounter}`; } while (this.pages.has(id) || this.kept.some(k => k.id === id));
    const page: BlankPage = { id, kind: 'blank', after, paper, strokes: [], images: [] };
    const anchor = this.pages.get(afterId);
    const idx = anchor && anchor.kind === 'blank'
      ? this.blankOrder.indexOf(afterId) + 1
      : this.blankOrder.filter(b => (this.pages.get(b) as BlankPage).after < after).length;
    return this.history.execute({
      label: 'insert-page', pageId: id,
      do: () => { this.pages.set(id, page); this.blankOrder.splice(idx, 0, id); this.emit(id, 'pages'); },
      undo: () => { this.removeBlank(id); this.emit(id, 'pages'); },
    });
  }

  /** Remove a blank page without a command (undo of an insert, a peer's delete). */
  removeBlank(id: string): void {
    this.pages.delete(id);
    const idx = this.blankOrder.indexOf(id);
    if (idx !== -1) this.blankOrder.splice(idx, 1); // may already be gone (removed by a peer)
  }

  /** Delete a blank page with its strokes and images; slide pages cannot be deleted. */
  deletePage(id: string): Command | null {
    const page = this.pages.get(id);
    if (!page || page.kind !== 'blank') return null;
    const idx = this.blankOrder.indexOf(id);
    return this.history.execute({
      label: 'delete-page', pageId: id,
      do: () => { this.removeBlank(id); this.emit(id, 'pages'); },
      undo: () => { this.pages.set(id, page); this.blankOrder.splice(idx, 0, id); this.emit(id, 'pages'); },
    });
  }

  /** Change the paper of a blank page (undoable); null if nothing changes. */
  setPaper(id: string, paper: Paper): Command | null {
    checkPaper(paper);
    const page = this.pages.get(id);
    if (!page || page.kind !== 'blank' || page.paper === paper) return null;
    const before = page.paper;
    const set = (v: Paper): void => { page.paper = v; this.emit(id, 'pages'); };
    return this.history.execute({ label: 'paper', pageId: id, do: () => set(paper), undo: () => set(before) });
  }
  /** A page's strokes, bottom to top; empty for an unknown page. */
  strokes(pageId: string): readonly Stroke[] {
    const page = this.pages.get(pageId);
    return page ? page.strokes : [];
  }
  /** A page's images, bottom to top (all below the strokes); empty for an unknown page. */
  images(pageId: string): readonly PageImage[] {
    const page = this.pages.get(pageId);
    return page ? page.images : [];
  }

  /**
   * Why `images` cannot be added to page `pageId` (too many on the page or in
   * the document, or too much image data in all); null if they can.
   */
  imageRoom(pageId: string, images: readonly PageImage[]): string | null {
    if (!images.length) return null;
    if (this.images(pageId).length + images.length > MAX_PAGE_IMAGES) return `A page can hold at most ${MAX_PAGE_IMAGES} images.`;
    const used = this.imageBudget();
    if (used.count + images.length > MAX_DOC_IMAGES) return `A document can hold at most ${MAX_DOC_IMAGES} images.`;
    const chars = images.reduce((n, i) => n + i.src.length, 0);
    if (used.chars + chars > MAX_DOC_IMAGE_CHARS) {
      return `The images of a document can take at most ${Math.round(MAX_DOC_IMAGE_CHARS / 1e6)} MB of the notes file.`;
    }
    const pixels = images.reduce((n, i) => n + imagePixels(i), 0);
    const pagePixels = this.images(pageId).reduce((n, i) => n + imagePixels(i), 0);
    if (pagePixels + pixels > MAX_PAGE_IMAGE_PIXELS) {
      return `The images of a page can have at most ${MAX_PAGE_IMAGE_PIXELS / 1e6} megapixels in all.`;
    }
    if (used.pixels + pixels > MAX_DOC_IMAGE_PIXELS) {
      return `The images of a document can have at most ${MAX_DOC_IMAGE_PIXELS / 1e6} megapixels in all.`;
    }
    return null;
  }

  /** Images and their data URL characters on all pages (kept pages too: they are saved back). */
  private imageBudget(): ImageBudget {
    const used: ImageBudget = { count: 0, chars: 0, pixels: 0 };
    const add = (list: readonly { src?: unknown }[]): void => {
      for (const i of list) {
        used.count++;
        used.chars += i && typeof i.src === 'string' ? i.src.length : 0;
        used.pixels += i ? imagePixels(i) : 0;
      }
    };
    for (const page of this.pages.values()) add(page.images);
    for (const k of this.kept) add(Array.isArray(k.images) ? k.images : []);
    return used;
  }

  // Changes

  /** Called on every change of strokes or pages and on markSaved (see ChangeKind). Returns a function that removes the listener. */
  onChange(fn: ChangeListener): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }
  emit(pageId: string | null, kind: ChangeKind = 'strokes'): void { notify(this.listeners, pageId, kind); }

  /** Apply fn to a page's stroke list; a page that is gone (deleted by a peer) is skipped. */
  mutate(pageId: string, fn: (list: Stroke[]) => Stroke[]): void {
    const page = this.pages.get(pageId) || this.pageOnDemand(pageId);
    if (!page) return;
    page.strokes = fn(page.strokes.slice());
    this.emit(pageId);
  }

  /** Apply fn to a page's image list; a page that is gone is skipped. */
  private mutateImages(pageId: string, fn: (list: PageImage[]) => PageImage[]): void {
    const page = this.pages.get(pageId) || this.pageOnDemand(pageId);
    if (!page) return;
    page.images = fn(page.images.slice());
    this.emit(pageId);
  }

  /**
   * Change a page from its current strokes to `after` in one undoable step
   * (null if nothing changes). The command stores only the delta - strokes
   * removed (with their z-index), added (with their index) and replaced
   * (same id) - so undo/redo leave strokes added meanwhile by another
   * window untouched.
   */
  replaceStrokes(pageId: string, after: readonly Stroke[], label = 'edit'): Command | null {
    return this.replaceContent(pageId, { strokes: after }, label);
  }

  /**
   * replaceStrokes for strokes and images: change the lists given in `after`
   * in one undoable step (null if nothing changes). New and changed images
   * are checked like loaded ones, and added ones must fit (see imageRoom).
   */
  replaceContent(pageId: string, after: { strokes?: readonly Stroke[]; images?: readonly PageImage[] }, label = 'edit'): Command | null {
    const page = this.pages.get(pageId) || this.pageOnDemand(pageId);
    if (!page) throw new Error(`No page ${pageId}`);
    const strokes = after.strokes ? listChange(page.strokes, after.strokes) : null;
    const images = after.images ? listChange(page.images, after.images) : null;
    if (!strokes && !images) return null;
    // New and changed items are checked like loaded ones: nothing non-finite is ever stored or saved.
    if (strokes) for (const s of strokes.checked) createStroke(s);
    if (images) {
      for (const i of images.checked) createImage(i);
      const full = this.imageRoom(pageId, images.added);
      if (full) throw new Error(full);
    }
    return this.history.execute({
      label, pageId,
      do: () => {
        if (strokes) this.mutate(pageId, strokes.redo);
        if (images) this.mutateImages(pageId, images.redo);
      },
      undo: () => {
        if (images) this.mutateImages(pageId, images.undo);
        if (strokes) this.mutate(pageId, strokes.undo);
      },
    });
  }

  addStroke(pageId: string, stroke: Stroke): Command | null {
    return this.replaceStrokes(pageId, [...this.strokes(pageId), stroke], 'draw');
  }

  /** Add strokes on top of a page in one command (a paste); their ids must be new. */
  addStrokes(pageId: string, strokes: readonly Stroke[], label = 'paste'): Command | null {
    return this.replaceStrokes(pageId, [...this.strokes(pageId), ...strokes], label);
  }

  /** Add strokes and images on top of a page in one command (a paste); their ids must be new. */
  addItems(pageId: string, strokes: readonly Stroke[], images: readonly PageImage[], label = 'paste'): Command | null {
    return this.replaceContent(pageId, {
      strokes: [...this.strokes(pageId), ...strokes], images: [...this.images(pageId), ...images],
    }, label);
  }

  removeStrokes(pageId: string, ids: readonly string[], label = 'delete'): Command | null {
    const gone = new Set(ids);
    return this.replaceStrokes(pageId, this.strokes(pageId).filter(s => !gone.has(s.id)), label);
  }

  /** Remove the strokes and images `ids` in one command. */
  removeItems(pageId: string, ids: readonly string[], label = 'delete'): Command | null {
    const gone = new Set(ids);
    return this.replaceContent(pageId, {
      strokes: this.strokes(pageId).filter(s => !gone.has(s.id)),
      images: this.images(pageId).filter(i => !gone.has(i.id)),
    }, label);
  }

  clearPage(pageId: string): Command | null {
    if (!this.pages.has(pageId)) return null;
    return this.replaceContent(pageId, { strokes: [], images: [] }, 'clear');
  }

  /** Replace the strokes `ids` by fn(stroke) in one command. */
  updateStrokes(pageId: string, ids: readonly string[], fn: (s: Stroke) => Stroke, label?: string): Command | null {
    const set = new Set(ids);
    return this.replaceStrokes(pageId,
      this.strokes(pageId).map(s => (set.has(s.id) ? fn(s) : s)), label);
  }

  moveStrokes(pageId: string, ids: readonly string[], dx: number, dy: number): Command | null {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return null;
    return this.updateStrokes(pageId, ids,
      s => ({ ...s, points: translatePoints(s.points, dx, dy) }), 'move');
  }

  /** Move the strokes and images `ids` by (dx, dy) in one command. */
  moveItems(pageId: string, ids: readonly string[], dx: number, dy: number): Command | null {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return null;
    const set = new Set(ids);
    return this.replaceContent(pageId, {
      strokes: this.strokes(pageId).map(s => (set.has(s.id) ? { ...s, points: translatePoints(s.points, dx, dy) } : s)),
      images: this.images(pageId).map(i => (set.has(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i)),
    }, 'move');
  }

  restyleStrokes(pageId: string, ids: readonly string[], style: StrokeStyle): Command | null {
    return this.updateStrokes(pageId, ids, s => {
      const next = { ...s };
      if (style.color != null) next.color = style.color;
      if (style.size != null) next.size = typeof style.size === 'function' ? style.size(s) : style.size;
      return next.color === s.color && next.size === s.size ? s : next;
    }, 'restyle');
  }

  undo(): Command | null { return this.history.undo(); }
  redo(): Command | null { return this.history.redo(); }

  /** Unsaved changes: local commands since markSaved(), or changes from another window. */
  isDirty(): boolean { return this.remoteDirty || this.history.top() !== this.savedTop; }
  /** The current state is saved (emits 'saved'). */
  markSaved(): void {
    this.savedTop = this.history.top();
    this.remoteDirty = false;
    this.emit(null, 'saved');
  }

  // Changes from another window (presenter view). They bypass the local
  // undo stack; each window undoes only its own commands.

  /** Id, owner and paper of every blank page, in order (for another window). */
  blankMeta(): { id: string; after: number; paper: Paper }[] {
    return this.blankOrder.map(id => {
      const p = this.pages.get(id) as BlankPage;
      return { id, after: p.after, paper: p.paper };
    });
  }

  /**
   * Returns false if the page is unknown here (e.g. its blank page has not arrived yet).
   * A stroke the page already has (the same object, or the same id and content) is
   * kept as it is, so the SVG keeps its node (render.syncLayer).
   */
  applyRemoteStrokes(pageId: string, strokes: readonly StrokeInput[]): boolean {
    const page = this.pages.get(pageId) || this.pageOnDemand(pageId);
    if (!page) return false;
    const had = new Map(page.strokes.map(s => [s.id, s]));
    page.strokes = strokes.map(input => {
      const old = input.id ? had.get(input.id) : undefined;
      if (old && (old === input || sameStroke(old, input))) return old;
      return createStroke(input);
    });
    this.remoteDirty = true;
    this.emit(pageId);
    return true;
  }

  /**
   * A peer's images of a page (presenter mode), bottom to top; false if the page is unknown here.
   * Invalid images and those beyond MAX_PAGE_IMAGES are left out; an image the page already has
   * (same id and content) is kept as it is, so the SVG keeps its node (render.syncImages).
   */
  applyRemoteImages(pageId: string, images: readonly ImageInput[]): boolean {
    const page = this.pages.get(pageId) || this.pageOnDemand(pageId);
    if (!page) return false;
    const had = new Map(page.images.map(i => [i.id, i]));
    const list: PageImage[] = [];
    let pixels = 0;
    for (const input of images) {
      if (list.length >= MAX_PAGE_IMAGES) break;
      const old = input && typeof input.id === 'string' ? had.get(input.id) : undefined;
      let image: PageImage;
      if (old && old.x === input.x && old.y === input.y && old.w === input.w && old.h === input.h && old.src === input.src) {
        image = old;
      } else {
        try { image = createImage(input); } catch (_) { continue; } // skipped
      }
      if (pixels + imagePixels(image) > MAX_PAGE_IMAGE_PIXELS) continue; // over the page's pixel budget
      pixels += imagePixels(image);
      list.push(image);
    }
    if (!list.length && !page.images.length) return true;
    page.images = list;
    this.remoteDirty = true;
    this.emit(pageId);
    return true;
  }

  /**
   * Upsert the peer's blank pages and delete those in `removed`. Local blank
   * pages the peer does not know yet are kept.
   */
  applyRemoteBlanks(list: readonly { id: string; after?: unknown; paper?: unknown }[], removed: readonly string[] = []): void {
    const listed: BlankPage[] = [];
    const seen = new Set<string>();
    for (const meta of list) {
      const after = Number(meta.after);
      if (!inDeck(after, this.deck) || seen.has(meta.id)) continue;
      seen.add(meta.id);
      let page = this.pages.get(meta.id);
      if (!page || page.kind !== 'blank') {
        page = { id: meta.id, kind: 'blank', after, paper: 'plain', strokes: [], images: [] };
        this.pages.set(meta.id, page);
      }
      page.after = after;
      page.paper = PAPERS.includes(meta.paper as Paper) ? meta.paper as Paper : 'plain';
      listed.push(page);
    }
    for (const id of removed) {
      const page = this.pages.get(id);
      if (page && page.kind === 'blank' && !seen.has(id)) this.pages.delete(id);
    }
    const localOnly = this.blankOrder.filter(id => !seen.has(id) && this.pages.has(id))
      .map(id => this.pages.get(id) as BlankPage);
    this.blankOrder = [...listed, ...localOnly].sort((a, b) => a.after - b.after).map(p => p.id); // stable
    this.remoteDirty = true;
    this.emit(null, 'pages');
  }

  /** Replace all content with a peer's full state (save-file format). */
  applyRemoteState(data: unknown, dirty = true): void {
    checkFormat(data);
    const pages = ((data as NotesJSON).pages || []).filter(p => p && typeof p.id === 'string');
    const blanks = pages.filter(p => p.kind === 'blank');
    const listed = new Set(blanks.map(p => p.id));
    this.applyRemoteBlanks(blanks, this.blankOrder.filter(id => !listed.has(id)));
    const filled = new Set<string>();
    for (const p of pages) {
      if (this.applyRemoteStrokes(p.id, p.strokes || [])) filled.add(p.id);
    }
    for (const [id, page] of this.pages) {
      if (!filled.has(id) && page.strokes.length) this.applyRemoteStrokes(id, []);
    }
    const remoteImages = new Map(pages.map(p => [p.id, Array.isArray(p.images) ? p.images : []]));
    for (const id of this.pages.keys()) this.applyRemoteImages(id, remoteImages.get(id) || []);
    // Local commands refer to content that was just replaced.
    this.history.clear();
    this.savedTop = null;
    this.remoteDirty = !!dirty;
  }

  // Serialization

  /**
   * Marp decks write version 1 (readable by the HTML decks), PDF decks version 2. A file with
   * images is version 3 (either deck), so builds without images reject it instead of losing them.
   */
  toJSON(): NotesJSON {
    const pages: PageJSON[] = [];
    let images = false;
    for (const id of this.sequence()) {
      const page = this.pages.get(id);
      if (!page || (page.kind === 'slide' && !page.strokes.length && !page.images.length)) continue;
      const out: PageJSON = { id: page.id, kind: page.kind, strokes: [] };
      if (page.kind === 'slide') out.slide = page.slide;
      else { out.after = page.after; out.paper = page.paper; }
      out.strokes = page.strokes.map(serializeStroke);
      if (page.images.length) {
        out.images = page.images.map(serializeImage);
        images = true;
      }
      pages.push(out);
    }
    for (const k of this.kept) {
      pages.push(structuredClone(k));
      if (Array.isArray(k.images) && k.images.length) images = true;
    }
    const d = this.deck;
    if (d.source !== 'pdf') {
      return { format: FORMAT, version: images ? 3 : 1, deck: { title: d.title, slides: d.slides, size: [d.size[0], d.size[1]] }, pages };
    }
    const deck: DeckJSON = { source: 'pdf', title: d.title, slides: d.slides, size: [d.size[0], d.size[1]] };
    if (d.sha256) deck.sha256 = d.sha256;
    if (d.pageSizes) deck.pageSizes = d.pageSizes.map(s => [s[0], s[1]]);
    return { format: FORMAT, version: images ? 3 : 2, deck, pages };
  }

  /** Any content a notes file would keep: strokes, images, blank pages, or pages kept beyond the deck. */
  hasNotes(): boolean {
    return this.blankOrder.length > 0 || this.kept.length > 0 ||
      [...this.pages.values()].some(p => p.strokes.length > 0 || p.images.length > 0);
  }

  /**
   * Replace all content with a parsed save file. `warnings` are problems
   * (skipped pages and strokes, another deck); `notices` tell about pages
   * beyond the deck, which are kept (see `kept`) and are no problem.
   */
  load(data: unknown): { warnings: string[]; notices: string[] } {
    checkFormat(data);
    const file = data as NotesJSON;
    const warnings = deckWarnings(file.deck, this.deck);
    const pages = new Map<string, Page>();
    for (let n = 1; n <= this.deck.slides; n++) {
      const id = this.slideId(n);
      pages.set(id, { id, kind: 'slide', slide: n, strokes: [], images: [] });
    }
    const blanks: BlankPage[] = [];
    const strokeIds = new Set<string>(); // stroke and image ids
    // Image limits over the whole file; kept pages count too (they are saved back).
    const budget: ImageBudget = { count: 0, chars: 0, pixels: 0 };
    const seenPages = new Set<string>();
    const kept: PageJSON[] = [];
    const notices: string[] = [];
    let rawPages = file.pages || [];
    if (!Array.isArray(rawPages)) { warnings.push('Skipped the pages: not a list'); rawPages = []; }
    // A blank page id that is not a usable id (as itemId; presenter mode sends ids up to
    // MAX_ID_LENGTH) gets a fresh one, unused in the file. Blank pages are referenced by
    // nothing else (`after` is a slide number), so the order stays as it is.
    const fileIds = new Set(rawPages.map(r => (r && typeof r.id === 'string' ? r.id : '')));
    let fresh = 0;
    const freshId = (): string => {
      let id: string;
      do { id = `b-${this.blankPrefix}-load${++fresh}`; } while (fileIds.has(id));
      return id;
    };
    for (let raw of rawPages) {
      if (raw && raw.kind === 'blank' && !(typeof raw.id === 'string' && raw.id && raw.id.length <= MAX_ID_LENGTH)) {
        raw = { ...raw, id: freshId() };
      }
      const page = parsePage(raw, this.deck, warnings, strokeIds, kept, notices, budget);
      if (!page) continue;
      if (seenPages.has(page.id)) { warnings.push(`Skipped duplicate page ${page.id}`); continue; }
      seenPages.add(page.id);
      if (page.kind === 'blank') {
        if (pages.has(page.id)) { warnings.push(`Skipped duplicate page ${page.id}`); continue; }
        blanks.push(page);
      }
      pages.set(page.id, page);
    }
    this.pages = pages;
    this.kept = kept;
    this.blankOrder = blanks.sort((a, b) => a.after - b.after).map(p => p.id); // stable sort
    this.blankCounter = 0;
    this.history.clear();
    this.savedTop = null;
    this.remoteDirty = false;
    // One event for all strokes, not one per page: each would cost the app a full refresh.
    this.emit(null, 'strokes');
    this.emit(null, 'pages');
    return { warnings, notices };
  }
}

/** style: { color?, size?: number | (stroke) => number } */
export interface StrokeStyle {
  color?: string | null;
  size?: number | ((s: Stroke) => number) | null;
}

/** The delta of one list (strokes or images) for a command; see listChange. */
interface ListChange<T> {
  /** Added and replaced items (checked before the command runs). */
  checked: T[];
  /** Added items. */
  added: T[];
  redo(list: T[]): T[];
  undo(list: T[]): T[];
}

/**
 * The change of a list from `before` to `after` as a delta - items removed
 * (with their z-index), added (with their index) and replaced (same id) -
 * applied to whatever the list holds then; null if nothing changes (also
 * for an order-only change). Computed outside the closures, so the undo
 * entry does not keep whole-page maps alive.
 */
function listChange<T extends { id: string }>(before: readonly T[], after: readonly T[]): ListChange<T> | null {
  if (sameArray(before, after)) return null;
  const beforeById = new Map(before.map(s => [s.id, s]));
  const afterIds = new Set(after.map(s => s.id));
  const removedIds = new Set(before.filter(s => !afterIds.has(s.id)).map(s => s.id));
  const added: { item: T; index: number }[] = [];
  const oldById = new Map<string, T>(), newById = new Map<string, T>();
  after.forEach((s, index) => {
    const old = beforeById.get(s.id);
    if (!old) added.push({ item: s, index });
    else if (old !== s) { oldById.set(s.id, old); newById.set(s.id, s); }
  });
  if (!removedIds.size && !added.length && !newById.size) return null;
  const addedIds = new Set(added.map(a => a.item.id));
  const insertAll = (list: T[], items: { item: T; index: number }[]): T[] => {
    const present = new Set(list.map(s => s.id));
    for (const { item, index } of items) {
      if (present.has(item.id)) continue;
      list.splice(Math.min(index, list.length), 0, item);
      present.add(item.id);
    }
    return list;
  };
  let removedAt: { item: T; index: number }[] = [];
  return {
    checked: [...added.map(a => a.item), ...newById.values()],
    added: added.map(a => a.item),
    redo: list => {
      removedAt = [];
      list.forEach((s, index) => { if (removedIds.has(s.id)) removedAt.push({ item: s, index }); });
      const kept = list.filter(s => !removedIds.has(s.id)).map(s => newById.get(s.id) || s);
      return insertAll(kept, added);
    },
    undo: list => {
      const kept = list.filter(s => !addedIds.has(s.id)).map(s => oldById.get(s.id) || s);
      return insertAll(kept, removedAt);
    },
  };
}

function checkPaper(paper: string): void {
  if (!PAPERS.includes(paper as Paper)) throw new Error(`Unknown paper: ${paper}`);
}

/** Whether unchecked stroke data has the same tool, color, size and points as `s` (missing pressure is 0.5). */
export function sameStroke(s: Stroke, input: StrokeInput): boolean {
  if (input.tool !== s.tool || input.color !== s.color || input.size !== s.size || !Array.isArray(input.points)) return false;
  const pts = input.points as unknown[];
  return pts.length === s.points.length && pts.every((p, i) => {
    const q = p as number[] | null, o = s.points[i];
    return !!q && q[0] === o[0] && q[1] === o[1] && (q[2] ?? 0.5) === o[2];
  });
}

/** A stroke as stored: x and y rounded to 2 decimals, pressure to 3. */
export function serializeStroke(s: Stroke): StrokeJSON {
  return {
    id: s.id, tool: s.tool, color: s.color, size: s.size,
    points: s.points.map(p => [round(p[0], 2), round(p[1], 2), round(p[2], 3)]),
  };
}

/** An image as stored: position and size rounded to 2 decimals. */
export function serializeImage(i: PageImage): ImageJSON {
  return { id: i.id, x: round(i.x, 2), y: round(i.y, 2), w: round(i.w, 2), h: round(i.h, 2), src: i.src };
}

/** Throw unless `data` is a notes file of a version this model reads. */
export function checkFormat(data: unknown): asserts data is NotesJSON {
  const d = data as Partial<NotesJSON> | null;
  if (!d || d.format !== FORMAT) throw new Error(`Not a ${FORMAT} file (format mismatch)`);
  if (!Number.isInteger(d.version) || (d.version as number) < 1 || (d.version as number) > VERSION) {
    throw new Error(`Unsupported notes version: ${d.version}`);
  }
}

/** Warnings when notes made for `fileDeck` are loaded into `deck` (title, checksum, page count, sizes). */
export function deckWarnings(fileDeck: Partial<DeckJSON> | undefined | null, deck: Deck): string[] {
  const w: string[] = [];
  if (!fileDeck) return ['File has no deck information'];
  const sameFile = !!fileDeck.sha256 && !!deck.sha256 && fileDeck.sha256 === deck.sha256;
  if (fileDeck.sha256 && deck.sha256 && !sameFile) w.push('Notes were made for a different version of this PDF (checksum differs)');
  // A renamed but identical PDF is the same document.
  if (!sameFile && fileDeck.title !== deck.title) w.push(`Notes were made for "${fileDeck.title}", not "${deck.title}"`);
  if (fileDeck.slides !== deck.slides) w.push(`Notes deck has ${fileDeck.slides} slides, this deck has ${deck.slides}`);
  const fs = Array.isArray(fileDeck.size) ? fileDeck.size : [], ds = deck.size;
  const what = deck.source === 'pdf' ? 'Page' : 'Slide';
  if (fs[0] !== ds[0] || fs[1] !== ds[1]) w.push(`${what} size differs (${fs.join('x')} vs ${ds.join('x')})`);
  if (Array.isArray(fileDeck.pageSizes) && deck.pageSizes) {
    const n = Math.min(fileDeck.pageSizes.length, deck.pageSizes.length);
    let differ = 0;
    for (let i = 1; i < n; i++) { // page 1 is checked above
      const a = Array.isArray(fileDeck.pageSizes[i]) ? fileDeck.pageSizes[i] : [], b = deck.pageSizes[i];
      if (a[0] !== b[0] || a[1] !== b[1]) differ++;
    }
    if (differ) w.push(`${differ} more page size${differ === 1 ? '' : 's'} differ`);
  }
  return w;
}

/** A page beyond the deck's last one (kept, not shown); null if it is within the deck or invalid. */
function beyondDeck(raw: PageJSON, deck: Deck): number | null {
  const n = Number(raw.kind === 'slide' ? raw.slide : raw.kind === 'blank' ? raw.after : NaN);
  return Number.isInteger(n) && n > deck.slides ? n : null;
}

function parsePage(
  raw: PageJSON | null, deck: Deck, warnings: string[], strokeIds: Set<string>, kept: PageJSON[], notices: string[],
  budget: ImageBudget,
): Page | null {
  if (!raw || typeof raw.id !== 'string') { warnings.push('Skipped a page without id'); return null; }
  const beyond = beyondDeck(raw, deck);
  if (beyond !== null) {
    kept.push(structuredClone(raw));
    for (const i of Array.isArray(raw.images) ? raw.images : []) {
      budget.count++;
      budget.chars += i && typeof i.src === 'string' ? i.src.length : 0;
      budget.pixels += i ? imagePixels(i) : 0;
    }
    const what = raw.kind === 'slide' ? `notes for slide ${beyond}` : `blank page ${raw.id} after slide ${beyond}`;
    notices.push(`Kept ${what} (deck has ${deck.slides}): saved with the notes, not shown`);
    return null;
  }
  let page: Page;
  if (raw.kind === 'slide') {
    const n = Number(raw.slide);
    if (!inDeck(n, deck)) {
      warnings.push(`Skipped notes for slide ${raw.slide} (deck has ${deck.slides})`);
      return null;
    }
    // The id follows this deck (s<n> or p<n>), so v1 Marp notes load onto PDF pages.
    page = { id: `${slidePrefix(deck.source)}${n}`, kind: 'slide', slide: n, strokes: [], images: [] };
  } else if (raw.kind === 'blank') {
    const after = Number(raw.after);
    if (!inDeck(after, deck)) {
      warnings.push(`Skipped blank page ${raw.id} after slide ${raw.after} (deck has ${deck.slides})`);
      return null;
    }
    const paper = PAPERS.includes(raw.paper as Paper) ? raw.paper as Paper : 'plain';
    page = { id: raw.id, kind: 'blank', after, paper, strokes: [], images: [] };
  } else {
    warnings.push(`Skipped page ${raw.id} of unknown kind ${(raw as { kind?: string }).kind}`);
    return null;
  }
  const strokes: Stroke[] = [];
  let rawStrokes = raw.strokes || [];
  if (!Array.isArray(rawStrokes)) { warnings.push(`Skipped the strokes of page ${raw.id}: not a list`); rawStrokes = []; }
  for (const s of rawStrokes) {
    try {
      const stroke = createStroke(strokeIds.has(s && s.id) ? { ...s, id: null } : s);
      strokeIds.add(stroke.id);
      strokes.push(stroke);
    } catch (e) {
      warnings.push(`Skipped a malformed stroke on page ${raw.id}: ${(e as Error).message}`);
    }
  }
  page.strokes = strokes;
  // Images: checked like strokes, within the limits per page and per file.
  const images: PageImage[] = [];
  let pagePixels = 0;
  let rawImages: unknown = raw.images || [];
  if (!Array.isArray(rawImages)) { warnings.push(`Skipped the images of page ${raw.id}: not a list`); rawImages = []; }
  for (const i of rawImages as ImageJSON[]) {
    try {
      const image = createImage(strokeIds.has(i && i.id) ? { ...i, id: null } : i);
      if (images.length >= MAX_PAGE_IMAGES) throw new Error(`more than ${MAX_PAGE_IMAGES} images on the page`);
      if (budget.count >= MAX_DOC_IMAGES) throw new Error(`more than ${MAX_DOC_IMAGES} images in the file`);
      if (budget.chars + image.src.length > MAX_DOC_IMAGE_CHARS) throw new Error('too much image data in the file');
      const pixels = imagePixels(image);
      if (pagePixels + pixels > MAX_PAGE_IMAGE_PIXELS) throw new Error(`more than ${MAX_PAGE_IMAGE_PIXELS / 1e6} megapixels of images on the page`);
      if (budget.pixels + pixels > MAX_DOC_IMAGE_PIXELS) throw new Error(`more than ${MAX_DOC_IMAGE_PIXELS / 1e6} megapixels of images in the file`);
      pagePixels += pixels;
      budget.pixels += pixels;
      budget.count++;
      budget.chars += image.src.length;
      strokeIds.add(image.id);
      images.push(image);
    } catch (e) {
      warnings.push(`Skipped an image on page ${raw.id}: ${(e as Error).message}`);
    }
  }
  page.images = images;
  return page;
}
