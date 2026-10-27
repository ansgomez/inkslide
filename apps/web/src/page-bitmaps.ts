/* Inkslide web - rendered pages of the open PDF
 *
 * An LRU of ImageBitmaps (bitmap-cache.ts) keyed by page and render scale,
 * bounded by count and by bytes (width × height × 4); once the bitmap a page
 * was last asked for arrives, its other scales (stand-ins, the scale before
 * a zoom) are evicted. Plus the renders in flight, so callers asking for the same bitmap at once
 * share one render. Bitmaps of a document that was closed meanwhile are
 * closed, never cached.
 *
 * Renders no longer wanted do not pile up in the render queue (holding a
 * page key): there is one page on screen (PRIORITY.current) and the
 * pre-renders of its neighbours. A new page on screen cancels the render of
 * another scale of the same page and moves the one of another page down to
 * a pre-render; prefetch() cancels pre-renders it no longer asks for. A
 * pending pre-render asked for at a higher priority is moved up.
 */
import { BitmapCache } from './bitmap-cache';
import { scaleKey } from './fit';
import { PRIORITY, type PdfDoc, type RenderJob } from './pdf';

/** Key of page n's bitmap at a render scale: "3@1.50". */
export const bitmapKey = (n: number, scale: number): string => `${n}@${scaleKey(scale)}`;

/** Rendered pages of the open PDF. */
export interface PageBitmaps {
  /**
   * Page n at `scale` (device px per point): cached, or rendered at
   * `priority`. PRIORITY.current: the page on screen (see the module comment).
   */
  get(n: number, scale: number, priority: number): Promise<ImageBitmap>;
  /** Pre-render these pages ([n, scale]) at PRIORITY.neighbor; other pending pre-renders are cancelled. */
  prefetch(pages: readonly (readonly [number, number])[]): void;
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

/** Bytes of a bitmap's pixels. */
const bitmapBytes = (b: ImageBitmap): number => b.width * b.height * 4;

/** Page bitmaps, at most `limit` and `maxBytes` kept. */
export function createPageBitmaps(limit: number, maxBytes = Infinity): PageBitmaps {
  const cache = new BitmapCache<ImageBitmap>(limit, b => b.close(), bitmapBytes, maxBytes);
  /** Key of the bitmap last asked for, per page. */
  const latest = new Map<number, string>();
  const pending = new Map<string, { n: number; priority: number; job: RenderJob<ImageBitmap>; promise: Promise<ImageBitmap> }>();
  let doc: PdfDoc | null = null;

  function cancel(key: string): void {
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    p.job.cancel();
  }

  /** `key` of page n is the page on screen now (see the module comment). */
  function onScreen(key: string, n: number): void {
    for (const [k, p] of [...pending]) {
      if (k === key || p.priority !== PRIORITY.current) continue;
      if (p.n === n) cancel(k);
      else {
        p.priority = PRIORITY.neighbor;
        p.job.setPriority(PRIORITY.neighbor);
      }
    }
  }

  const api: PageBitmaps = {
    get(n, scale, priority) {
      const key = bitmapKey(n, scale);
      latest.set(n, key);
      if (priority === PRIORITY.current) onScreen(key, n);
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
      const running = pending.get(key);
      if (running) {
        if (priority < running.priority) {
          running.priority = priority;
          running.job.setPriority(priority);
        }
        return running.promise;
      }
      if (!doc) return Promise.reject(new Error('no document'));
      const pdf = doc;
      const done = (): void => { if (pending.get(key)?.promise === p) pending.delete(key); }; // not the next document's
      const job = pdf.renderBitmap(n, scale, priority);
      const entry = { n, priority, job, promise: null as unknown as Promise<ImageBitmap> };
      const p = job.promise.then(bmp => {
        done();
        if (doc === pdf) {
          cache.set(key, bmp);
          if (latest.get(n) === key) {
            for (const k of cache.keys()) if (k !== key && k.startsWith(`${n}@`)) cache.delete(k);
          }
          if (entry.priority !== PRIORITY.current) warm(bmp);
        } else bmp.close();
        return bmp;
      }, e => { done(); throw e; });
      entry.promise = p;
      pending.set(key, entry);
      return p;
    },
    prefetch(pages) {
      const wanted = new Set(pages.map(([n, scale]) => bitmapKey(n, scale)));
      for (const [k, p] of [...pending]) {
        if (p.priority >= PRIORITY.neighbor && !wanted.has(k)) cancel(k);
      }
      for (const [n, scale] of pages) api.get(n, scale, PRIORITY.neighbor).catch(() => { /* cancelled, closed */ });
    },
    cached: (n, scale) => cache.get(bitmapKey(n, scale)),
    standIn: n => cache.find(k => k.startsWith(`${n}@`)),
    setDoc(pdf) {
      if (pdf === doc) return;
      doc = pdf;
      cache.clear();
      pending.clear();
      latest.clear();
    },
  };
  return api;
}
