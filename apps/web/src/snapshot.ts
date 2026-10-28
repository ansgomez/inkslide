/* Inkslide web - snapshots: an area of a page as an image
 *
 * The host side of the snapshot tool (AnnotatorOptions.captureArea): the
 * area is drawn into a canvas as the screen shows it - the PDF page (PDF.js
 * renders only that area) or the paper of a blank page, then the page's
 * images, highlighter strokes (35 % opacity, multiply) and pen strokes, as
 * render.ts and toolbar.css draw them - and encoded as PNG, or as JPEG when
 * the PNG would exceed the model's per-image limit (photos), smaller still
 * if needed. Also turns images pasted from other programs into images
 * within the same limits (importImage).
 */
import type { Capture, PageImage, Paper, RectLike, Size, Stroke } from '@inkslide/annotate';
import { centerlinePath, outlinePath, strokeOutline } from '@inkslide/annotate/geometry';
import { imagePixelSize, MAX_IMAGE_CHARS } from '@inkslide/annotate/model';
import { PAPER_STYLE } from '@inkslide/annotate/render';

/** Longest side of a snapshot, px: bounds memory and the notes file. */
export const SNAPSHOT_MAX_PX = 2048;
/** Least pixels per CSS px of the page on screen: sharp when pasted at the same size, also on a 1x screen. */
export const SNAPSHOT_MIN_DENSITY = 2;
/**
 * Most pixels of an image pasted from another program. Larger ones are not
 * decoded at all (a small file can hold a huge image); smaller ones are
 * scaled to SNAPSHOT_MAX_PX on the long side while decoding.
 */
export const MAX_IMPORT_PIXELS = 100_000_000;
/** Bytes read from a pasted image to find its size in pixels (see model.imagePixelSize). */
const IMPORT_HEADER_BYTES = 256 * 1024;
/** JPEG quality for snapshots whose PNG is too large. */
export const JPEG_QUALITY = 0.9;

/**
 * Pixels per page unit for a snapshot of `rect`: the page's render scale
 * (device px per page unit on screen), at least SNAPSHOT_MIN_DENSITY × its
 * CSS scale, and at most what keeps the long side within SNAPSHOT_MAX_PX.
 */
export function snapshotScale(rect: RectLike, renderScale: number, cssScale: number): number {
  const wanted = Math.max(renderScale, SNAPSHOT_MIN_DENSITY * cssScale);
  const cap = SNAPSHOT_MAX_PX / Math.max(rect.w, rect.h);
  const k = Math.min(wanted, cap);
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** Length of the base64 data URL of `bytes` bytes of `type`. */
export const dataUrlLength = (bytes: number, type: string): number =>
  `data:${type};base64,`.length + Math.ceil(bytes / 3) * 4;

/** What a snapshot shows of a page. */
export interface SnapshotPage {
  size: Size;
  strokes: readonly Stroke[];
  images: readonly PageImage[];
  /** The paper of a blank page; null for a PDF page (drawn by `background`). */
  paper: Paper | null;
  /** Draw the PDF page's area into the canvas (sized already) at `scale` px per page unit. */
  background?(canvas: HTMLCanvasElement, rect: RectLike, scale: number): Promise<void>;
}

/** Area `rect` of a page as an image (see the module comment). */
export async function captureArea(page: SnapshotPage, rect: RectLike, scale: number): Promise<Capture> {
  const canvas = document.createElement('canvas');
  try {
    canvas.width = Math.max(1, Math.round(rect.w * scale));
    canvas.height = Math.max(1, Math.round(rect.h * scale));
    if (page.background && !page.paper) await page.background(canvas, rect, scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);
    if (page.paper) drawPaper(ctx, page.paper, page.size);
    else if (!page.background) drawPaper(ctx, 'plain', page.size); // white
    await drawInk(ctx, page.strokes, page.images);
    return await encode(canvas);
  } finally {
    canvas.width = canvas.height = 0; // free the backing store at once (WebKit keeps it otherwise)
  }
}

/**
 * An image from another program (Ctrl/Cmd+V) within the snapshot limits, with its pixel size.
 * Its size is read from the file first: one that cannot be read or is over MAX_IMPORT_PIXELS
 * is refused before decoding.
 */
export async function importImage(blob: Blob): Promise<Capture | null> {
  const head = new Uint8Array(await blob.slice(0, IMPORT_HEADER_BYTES).arrayBuffer());
  const size = imagePixelSize(blob.type, head);
  if (!size || !size.width || !size.height) throw new Error('its size in pixels could not be read');
  if (size.width * size.height > MAX_IMPORT_PIXELS) throw new Error(`it is too large (${size.width}×${size.height} pixels)`);
  const fit = Math.min(1, SNAPSHOT_MAX_PX / Math.max(size.width, size.height));
  // One side only keeps the aspect ratio, also when EXIF turns the image (the canvas below caps it again).
  const bmp = await createImageBitmap(blob, fit < 1 ? { resizeWidth: Math.max(1, Math.round(size.width * fit)), resizeQuality: 'high' } : {});
  const canvas = document.createElement('canvas');
  try {
    const k = Math.min(1, SNAPSHOT_MAX_PX / Math.max(bmp.width, bmp.height));
    canvas.width = Math.max(1, Math.round(bmp.width * k));
    canvas.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff'; // transparent parts show white, as in a JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return { ...(await encode(canvas)), width: canvas.width, height: canvas.height };
  } finally {
    bmp.close();
    canvas.width = canvas.height = 0;
  }
}

/** Images, highlighter and pen strokes, bottom to top, in page units (the context's transform). */
async function drawInk(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], images: readonly PageImage[]): Promise<void> {
  for (const i of images) {
    const img = new Image();
    img.src = i.src;
    try { await img.decode(); } catch (_) { continue; } // a broken image is missing on screen too
    ctx.drawImage(img, i.x, i.y, i.w, i.h);
  }
  ctx.save();
  ctx.globalAlpha = 0.35; // .ann-stroke-hl in toolbar.css
  ctx.globalCompositeOperation = 'multiply';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (s.tool !== 'highlighter') continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    const p = s.points;
    ctx.stroke(new Path2D(p.length === 1 ? `M${p[0][0]} ${p[0][1]}l0.01 0` : centerlinePath(p)));
  }
  ctx.restore();
  for (const s of strokes) {
    if (s.tool !== 'pen') continue;
    ctx.fillStyle = s.color;
    ctx.fill(new Path2D(outlinePath(strokeOutline(s.points, s.size))));
  }
}

/** The paper of a blank page (render.createPaper's look, PAPER_STYLE). */
function drawPaper(ctx: CanvasRenderingContext2D, paper: Paper, [w, h]: Size): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const step = w / PAPER_STYLE.steps;
  const line = (style: { color: string; width: number }, path: string): void => {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.stroke(new Path2D(path));
  };
  if (paper === 'lined') {
    let d = '';
    for (let y = 2 * step - 0.5; y < h; y += step) d += `M0 ${y}H${w}`;
    line(PAPER_STYLE.rule, d);
    const mx = step * PAPER_STYLE.marginSteps;
    line(PAPER_STYLE.margin, `M${mx} 0V${h}`);
  } else if (paper === 'grid') {
    let d = '';
    for (let x = step; x < w; x += step) d += `M${x} 0V${h}`;
    for (let y = step; y < h; y += step) d += `M0 ${y}H${w}`;
    line(PAPER_STYLE.grid, d);
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the image could not be encoded'))), type, quality));

const dataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error || new Error('the image could not be read'));
  reader.readAsDataURL(blob);
});

/**
 * PNG data URL of the canvas; JPEG if the PNG exceeds MAX_IMAGE_CHARS; the
 * canvas scaled down by 0.7 at a time while even that does. `png` is the PNG
 * for the system clipboard (other programs take only PNG).
 */
export async function encode(canvas: HTMLCanvasElement): Promise<Capture> {
  let png = await toBlob(canvas, 'image/png');
  const first = png;
  for (let tries = 0; tries < 8; tries++) {
    if (dataUrlLength(png.size, 'image/png') <= MAX_IMAGE_CHARS) return { src: await dataUrl(png), png };
    const jpeg = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    if (dataUrlLength(jpeg.size, 'image/jpeg') <= MAX_IMAGE_CHARS) return { src: await dataUrl(jpeg), png: first };
    const smaller = document.createElement('canvas');
    smaller.width = Math.max(1, Math.round(canvas.width * 0.7));
    smaller.height = Math.max(1, Math.round(canvas.height * 0.7));
    smaller.getContext('2d')!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    if (tries) canvas.width = canvas.height = 0; // an earlier smaller copy; the caller frees its own
    canvas = smaller;
    png = await toBlob(canvas, 'image/png');
  }
  throw new Error('the image is too large');
}
