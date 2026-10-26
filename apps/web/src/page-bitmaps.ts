/* Inkslide web - rendered pages of the open PDF
 *
 * An LRU of ImageBitmaps (bitmap-cache.ts) keyed by page and render scale,
 * plus the renders in flight, so callers asking for the same bitmap at once
 * share one render. Bitmaps of a document that was closed meanwhile are
 * closed, never cached.
 */
import { BitmapCache } from './bitmap-cache';
import { scaleKey } from './fit';
import { PRIORITY, type PdfDoc } from './pdf';

/** Key of page n's bitmap at a render scale: "3@1.50". */
export const bitmapKey = (n: number, scale: number): string => `${n}@${scaleKey(scale)}`;

/** Rendered pages of the open PDF. */
export interface PageBitmaps {
  /** Page n at `scale` (device px per point): cached, or rendered at `priority`. */
  get(n: number, scale: number, priority: number): Promise<ImageBitmap>;
  /** The cached bitmap (marked as recently used), else undefined. */
  cached(n: number, scale: number): ImageBitmap | undefined;
  /** The latest used bitmap of page n at any scale: a stand-in while the exact one renders. */
  standIn(n: number): ImageBitmap | undefined;
  /** Render from `pdf` from now on (null: none); drops the bitmaps of the one before. */
  setDoc(pdf: PdfDoc | null): void;
}

/**
 * WebKit uploads an ImageBitmap on its first draw (~200 ms for a 2000 px
 * page in software rendering). Pre-rendered pages pay that now, with a
 * 1×1 draw, instead of on the page turn.
 */
let warmCtx: CanvasRenderingContext2D | null = null;
function warm(bmp: ImageBitmap): void {
  try {
    warmCtx ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
    warmCtx?.drawImage(bmp, 0, 0, 1, 1);
  } catch (_) { /* closed */ }
}

/** Page bitmaps, at most `limit` kept. */
export function createPageBitmaps(limit: number): PageBitmaps {
  const cache = new BitmapCache<ImageBitmap>(limit, b => b.close());
  const pending = new Map<string, Promise<ImageBitmap>>();
  let doc: PdfDoc | null = null;

  return {
    get(n, scale, priority) {
      const key = bitmapKey(n, scale);
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
      const running = pending.get(key);
      if (running) return running;
      if (!doc) return Promise.reject(new Error('no document'));
      const pdf = doc;
      const done = (): void => { if (pending.get(key) === p) pending.delete(key); }; // not the next document's
      const p = pdf.renderBitmap(n, scale, priority).then(bmp => {
        done();
        if (doc === pdf) {
          cache.set(key, bmp);
          if (priority !== PRIORITY.current) warm(bmp);
        } else bmp.close();
        return bmp;
      }, e => { done(); throw e; });
      pending.set(key, p);
      return p;
    },
    cached: (n, scale) => cache.get(bitmapKey(n, scale)),
    standIn: n => cache.find(k => k.startsWith(`${n}@`)),
    setDoc(pdf) {
      if (pdf === doc) return;
      doc = pdf;
      cache.clear();
      pending.clear();
    },
  };
}
