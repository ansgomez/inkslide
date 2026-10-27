/* Inkslide web - PDF.js loading and page rendering
 *
 * The worker and PDF.js's data files are bundled (see vite.config.ts), so
 * nothing is fetched from a CDN. Renders go through one queue: the page on
 * screen jumps ahead of pre-renders and thumbnails, and at most one page is
 * rendered at a time (PDF.js work happens in the worker; the queue keeps
 * prefetching from delaying the page the user waits for).
 *
 * The legacy build: the modern one uses Map.getOrInsertComputed, which
 * older iPad Safari versions lack (Electron 43 has it).
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { Size } from '@inkslide/annotate';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Directory of the bundled PDF.js data files, relative to the page. */
const assetUrl = (dir: string): string => new URL(`./pdfjs/${dir}/`, document.baseURI).href;

/** Render queue priorities, lower first. */
export const PRIORITY = { current: 0, neighbor: 1, thumb: 2 } as const;

interface Job {
  priority: number;
  seq: number;
  run(): Promise<void>;
}

/** An open PDF: page sizes and queued rendering. */
export interface PdfDoc {
  readonly numPages: number;
  readonly title: string;
  /** Page sizes in points (rotation applied), page 1 first. */
  readonly pageSizes: readonly Size[];
  /** Render page n (1-based) at `scale` device px per point into an ImageBitmap. */
  renderBitmap(n: number, scale: number, priority?: number): Promise<ImageBitmap>;
  /** Render page n into an existing canvas (thumbnails). */
  renderInto(canvas: HTMLCanvasElement, n: number, scale: number, priority?: number): Promise<void>;
  destroy(): Promise<void>;
}

/** Open a PDF from its bytes. The bytes are copied (PDF.js transfers its buffer to the worker). */
export async function openPdfDoc(bytes: Uint8Array): Promise<PdfDoc> {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  });
  let pdf: PDFDocumentProxy;
  let pages: PDFPageProxy[];
  try {
    pdf = await task.promise;
    pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
  } catch (e) {
    void task.destroy(); // each document has its own worker, which would stay otherwise
    throw e;
  }
  const pageSizes = pages.map(p => {
    const vp = p.getViewport({ scale: 1 });
    return [vp.width, vp.height] as Size;
  });
  let title = '';
  try {
    const meta = await pdf.getMetadata();
    const info = meta.info as { Title?: unknown } | undefined;
    title = typeof info?.Title === 'string' ? info.Title.trim() : '';
  } catch (_) { /* no metadata */ }

  const queue: Job[] = [];
  let seq = 0, running = false, destroyed = false;

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    while (queue.length && !destroyed) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const job = queue.shift()!;
      try { await job.run(); } catch (_) { /* reported through the job's promise */ }
    }
    running = false;
  }

  function enqueue<T>(priority: number, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ priority, seq: seq++, run: () => work().then(resolve, e => { reject(e); throw e; }) });
      void pump();
    });
  }

  async function draw(canvas: HTMLCanvasElement, n: number, scale: number): Promise<void> {
    if (destroyed) throw new Error('document closed');
    const page = pages[n - 1];
    if (!page) throw new Error(`no page ${n}`);
    const vp = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
  }

  return {
    numPages: pdf.numPages,
    title,
    pageSizes,
    renderBitmap(n, scale, priority = PRIORITY.current) {
      return enqueue(priority, async () => {
        const canvas = document.createElement('canvas');
        try {
          await draw(canvas, n, scale);
          return await createImageBitmap(canvas);
        } finally {
          canvas.width = canvas.height = 0; // free the backing store at once (WebKit keeps it otherwise)
        }
      });
    },
    renderInto(canvas, n, scale, priority = PRIORITY.thumb) {
      return enqueue(priority, () => draw(canvas, n, scale));
    },
    async destroy() {
      destroyed = true;
      queue.length = 0;
      await task.destroy();
    },
  };
}
