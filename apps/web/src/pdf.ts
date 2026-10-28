/* Inkslide web - PDF.js loading and page rendering
 *
 * The worker and PDF.js's data files are bundled (see vite.config.ts), so
 * nothing is fetched from a CDN. Renders go through one queue: the page on
 * screen jumps ahead of pre-renders and thumbnails, and at most one page is
 * rendered at a time (PDF.js work happens in the worker; the queue keeps
 * prefetching from delaying the page the user waits for). A queued render
 * can be moved up (a pre-render becomes the page on screen) or cancelled
 * (queued: dropped; running: PDF.js's RenderTask is cancelled). destroy()
 * cancels every render queued or running, so none is left waiting.
 *
 * All pages are fetched up front, PAGE_FETCHES at a time: their sizes make
 * the notes document (deckFromPdf), and PDF.js keeps the page objects anyway.
 * A PDF of more than MAX_PAGES pages is not opened. What a render
 * leaves behind on a page (operator list, images) is freed with
 * page.cleanup() once the page is not among the last few rendered.
 *
 * The legacy build: the modern one uses Map.getOrInsertComputed, which
 * older iPad Safari versions lack (Electron 43 has it).
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { RectLike, Size } from '@inkslide/annotate';
import { MAX_PDF_PAGES } from '@inkslide/annotate/model';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Directory of the bundled PDF.js data files, relative to the page. */
const assetUrl = (dir: string): string => new URL(`./pdfjs/${dir}/`, document.baseURI).href;

/** Pages whose render resources are kept (the page shown, its neighbours, one more). */
const KEEP_RENDERED = 4;

/** Pages asked of PDF.js at a time while a PDF opens. */
const PAGE_FETCHES = 16;
/** Most pages a PDF may have (the notes file holds that many, with blank pages; the desktop's recent files accept them). */
export const MAX_PAGES = MAX_PDF_PAGES;

/** Every page of `pdf`, at most `parallel` asked for at a time (not one request per page at once). */
async function fetchPages(pdf: PDFDocumentProxy, parallel = PAGE_FETCHES): Promise<PDFPageProxy[]> {
  const pages: PDFPageProxy[] = new Array(pdf.numPages);
  let next = 0;
  const fetchNext = async (): Promise<void> => {
    while (next < pages.length) {
      const i = next++;
      pages[i] = await pdf.getPage(i + 1);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, pages.length) }, fetchNext));
  return pages;
}

/** Render queue priorities, lower first. */
export const PRIORITY = { current: 0, neighbor: 1, thumb: 2 } as const;

interface Job {
  priority: number;
  seq: number;
  run(): Promise<void>;
  /** Cancel it, queued or running (the document closes): its promise rejects (isCancelled). */
  drop(): void;
}

/** A queued render (renderBitmap). */
export interface RenderJob<T> {
  readonly promise: Promise<T>;
  /** Move it in the queue (no effect once it runs). */
  setPriority(priority: number): void;
  /** Drop it from the queue, or stop it if it runs: the promise rejects (isCancelled). */
  cancel(): void;
}

/** What a running render needs to be cancelled. */
interface RenderControl {
  cancelled: boolean;
  task: { cancel(): void } | null;
}

const cancelledError = (): Error => new DOMException('rendering cancelled', 'AbortError');

/** The render was cancelled (RenderJob.cancel), not failed. */
export const isCancelled = (e: unknown): boolean => (e as Error | null)?.name === 'AbortError';

/** An open PDF: page sizes and queued rendering. */
export interface PdfDoc {
  readonly numPages: number;
  readonly title: string;
  /** Page sizes in points (rotation applied), page 1 first. */
  readonly pageSizes: readonly Size[];
  /** Render page n (1-based) at `scale` device px per point into an ImageBitmap. */
  renderBitmap(n: number, scale: number, priority?: number): RenderJob<ImageBitmap>;
  /** Render page n into an existing canvas (thumbnails). */
  renderInto(canvas: HTMLCanvasElement, n: number, scale: number, priority?: number): Promise<void>;
  /**
   * Render only the area `rect` (points, as shown) of page n into `canvas`, whose size the caller
   * sets (rect × scale): a snapshot.
   */
  renderArea(canvas: HTMLCanvasElement, n: number, rect: RectLike, scale: number, priority?: number): Promise<void>;
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
    if (pdf.numPages > MAX_PAGES) {
      throw new Error(`it has ${pdf.numPages.toLocaleString('en')} pages; Inkslide opens PDFs of up to ${MAX_PAGES.toLocaleString('en')} pages`);
    }
    pages = await fetchPages(pdf);
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
  /** The job running, if any. */
  let current: Job | null = null;
  /** Pages rendered last, oldest first. */
  const rendered: number[] = [];

  /** Page n was rendered: free the render resources of the page that drops out of the last KEEP_RENDERED. */
  function renderedPage(n: number): void {
    const i = rendered.indexOf(n);
    if (i >= 0) rendered.splice(i, 1);
    rendered.push(n);
    if (rendered.length > KEEP_RENDERED && !destroyed) pages[rendered.shift()! - 1].cleanup();
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    while (queue.length && !destroyed) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const job = queue.shift()!;
      current = job;
      try { await job.run(); } catch (_) { /* reported through the job's promise */ }
      current = null;
    }
    running = false;
  }

  function enqueue<T>(priority: number, work: (ctl: RenderControl) => Promise<T>): RenderJob<T> {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    const ctl: RenderControl = { cancelled: false, task: null };
    const job: Job = {
      priority, seq: seq++,
      run: () => work(ctl).then(resolve, e => {
        reject(ctl.cancelled ? cancelledError() : e);
        throw e;
      }),
      drop() {
        ctl.cancelled = true;
        reject(cancelledError()); // no effect if it already settled
        if (ctl.task) ctl.task.cancel();
      },
    };
    queue.push(job);
    void pump();
    return {
      promise,
      setPriority(p) { job.priority = p; }, // pump() sorts before each job
      cancel() {
        if (ctl.cancelled) return;
        ctl.cancelled = true;
        const i = queue.indexOf(job);
        if (i >= 0) {
          queue.splice(i, 1);
          reject(cancelledError());
        } else if (ctl.task) ctl.task.cancel(); // running: its render rejects
      },
    };
  }

  async function draw(canvas: HTMLCanvasElement, n: number, scale: number, ctl?: RenderControl): Promise<void> {
    if (destroyed) throw new Error('document closed');
    const page = pages[n - 1];
    if (!page) throw new Error(`no page ${n}`);
    const vp = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const task = page.render({ canvas, viewport: vp, background: '#ffffff' });
    if (ctl) ctl.task = task;
    try {
      await task.promise;
    } finally {
      if (ctl) ctl.task = null;
      renderedPage(n);
    }
  }

  return {
    numPages: pdf.numPages,
    title,
    pageSizes,
    renderBitmap(n, scale, priority = PRIORITY.current) {
      return enqueue(priority, async ctl => {
        const canvas = document.createElement('canvas');
        try {
          await draw(canvas, n, scale, ctl);
          if (ctl.cancelled) throw cancelledError();
          return await createImageBitmap(canvas);
        } finally {
          canvas.width = canvas.height = 0; // free the backing store at once (WebKit keeps it otherwise)
        }
      });
    },
    renderInto(canvas, n, scale, priority = PRIORITY.thumb) {
      return enqueue(priority, ctl => draw(canvas, n, scale, ctl)).promise;
    },
    renderArea(canvas, n, rect, scale, priority = PRIORITY.current) {
      return enqueue(priority, async ctl => {
        if (destroyed) throw new Error('document closed');
        const page = pages[n - 1];
        if (!page) throw new Error(`no page ${n}`);
        // The offsets move the area's top-left corner to the canvas origin (after rotation).
        const vp = page.getViewport({ scale, offsetX: -rect.x * scale, offsetY: -rect.y * scale });
        const task = page.render({ canvas, viewport: vp, background: '#ffffff' });
        ctl.task = task;
        try {
          await task.promise;
        } finally {
          ctl.task = null;
          renderedPage(n);
        }
      }).promise;
    },
    async destroy() {
      destroyed = true;
      for (const job of queue.splice(0)) job.drop();
      current?.drop();
      await task.destroy();
    },
  };
}
