/* Inkslide web - the PDF viewer: one page at a time, notes on top
 *
 * Page area (inset by the toolbar's --ann-off-* offsets):
 *   .ink-stage
 *     .ink-page             fitted page box; pinch zoom = CSS transform
 *       canvas.ink-pdf      PDF.js render (ImageBitmap) of the page
 *       svg.ann-page        annotation surface of the page (render.createPageSurface)
 *       canvas.ink-live     live stroke (live-ink.ts), pointer-events: none
 *
 * Fit modes (W, toolbar): "page" shows the whole page; "width" fills the
 * stage width and scrolls a taller page vertically. The − and + next to the
 * page counter (Ctrl/Cmd+= and Ctrl/Cmd+−) zoom by ZOOM_STEPS around the
 * middle of the view. The scroll position is
 * the view's ty at zoom 1, so pinch zoom, pan and scroll are one transform
 * (clampPan keeps the page over the visible part, see fit.ts). Render scale,
 * bitmap cache and prefetch follow the fit of the current mode.
 *
 * One document session per opened PDF: a NotesDoc (deckFromPdf), an
 * Annotator (tools, input, toolbar, keys), surfaces created on demand per
 * page and kept, the overview, and the save target. Rendered pages are kept
 * as ImageBitmaps (LRU, at most 6 and 160 MB): the page shown plus the pages before and
 * after it, pre-rendered at their fit size, so a page turn only draws a
 * bitmap.
 *
 * Snapshots (the snapshot tool's capture) are drawn by snapshot.ts: the PDF
 * area rendered again by PDF.js at the page's render scale (at least 2 px
 * per CSS px, at most 2048 px on the long side), then paper, images and ink.
 */
import {
  createAnnotator, NotesDoc, type Annotator, type Capture, type NotesBackup, type Paper, type PdfFile, type RectLike,
  type Surface,
} from '@inkslide/annotate';
import { deckFromPdf, loadNotesText, serializeNotes, sha256Hex } from '@inkslide/annotate/io';
import { PAPERS, pagesGroup, type PagesController, type PagesHost } from '@inkslide/annotate/pages';
import * as render from '@inkslide/annotate/render';
import type { ToolRenderer } from '@inkslide/annotate/tools';
import { ICONS, isTyping, registerGroup, type ToolbarHost, type ToolbarItem } from '@inkslide/annotate/toolbar';
import { banner } from './banner';
import { pageCounter, pdfPageNumber, sourceStep } from './counter';
import { storedItem, storeItem } from './dom';
import { buildAnnotatedPdf } from './export';
import {
  clampPan, fitTo, pageScroll, panLimits, renderScale, visibleBox, zoomAround, zoomStep, type Box, type FitMode, type FitRect,
} from './fit';
import { attachGestures } from './gestures';
import { createLiveInk } from './live-ink';
import { createOverview, type Overview } from './overview';
import { bitmapKey, createPageBitmaps } from './page-bitmaps';
import { isCancelled, openPdfDoc, PRIORITY, type PdfDoc } from './pdf';
import { flushSave, holdSaves, pageTurned, saveState, scheduleSave, setSaveTarget } from './persist';
import type { AppAdapter } from './platform';
import type { ViewerMirror } from './presenter';
import { printPageImages } from './print';
import { captureArea, importImage, snapshotScale } from './snapshot';

/** Gap around the fitted page, CSS px. */
const PAGE_MARGIN = 6;
const CACHE_LIMIT = 6;
/** Bytes of rendered pages kept (a page at the render cap is 64 MB). */
const CACHE_BYTES = 160 * 2 ** 20;
const FIT_KEY = 'inkslide-fit-mode';
/** Paper for new blank pages (the paper button), remembered like the fit mode. */
const PAPER_KEY = 'inkslide-blank-paper';
/** Keys of navKey that scroll or turn the page. */
const PAGE_KEYS = new Set(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Home', 'End']);

ICONS.open = '<path d="M3 7V5a1 1 0 011-1h5l2 2h8a1 1 0 011 1v2"/><path d="M3 9h18l-2 10H5z"/>';
ICONS.zoomOut = '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/>';
ICONS.zoomIn = '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6M10.5 7.5v6"/>';
ICONS.revert = '<path d="M3.5 12a8.5 8.5 0 102.5-6"/><path d="M3 3.5V9h5.5"/><path d="M12 7.5V12l3 2"/>';
ICONS.fitWidth = '<path d="M7 3h10v18H7z"/><path d="M3 12h6M21 12h-6M5 10l-2 2 2 2M19 10l2 2-2 2"/>';

/** Wait before reading saved notes that could not be read or loaded once more (a sync client may hold them). */
export const NOTES_RETRY_MS = 1000;

/** Load notes text into `doc`; returns what to tell the user (Marp scaling, problems, notices). */
function loadNotesMessages(doc: NotesDoc, text: string): string[] {
  const { warnings, notices, scaled } = loadNotesText(doc, text);
  const scaling = scaled ? [`Notes from a Marp deck, scaled by ${scaled.toFixed(2)} to the PDF pages.`] : [];
  return [...scaling, ...warnings, ...notices];
}

/** An annotation surface with the paper of a blank page. */
export interface PageSurface extends Surface {
  paper: render.PaperHandle | null;
}

/** The viewer's PagesController, with a jump to a PDF page. */
type ViewerPages = PagesController & { jump(n: number): void };

/** One opened PDF. */
interface Session {
  file: PdfFile;
  sha256: string;
  pdf: PdfDoc;
  doc: NotesDoc;
  app: Annotator;
  overview: Overview;
  current: string;
  defaultPaper: Paper;
  /** The page controller (also app.pages). */
  pages: ViewerPages;
  /** The PDF has a notes backup (shows the Revert to Backup button). */
  hasBackup: boolean;
  /** Counts the changes of the notes (to see whether they changed during a wait). */
  revision: number;
  unbind: () => void;
}

/** The page shell's elements the viewer works in. */
export interface ViewerElements {
  stage: HTMLElement;
  page: HTMLElement;
  pdfCanvas: HTMLCanvasElement;
  liveCanvas: HTMLCanvasElement;
  empty: HTMLElement;
}

/** The PDF viewer: one open document at a time. */
export interface Viewer {
  /** The open document, null before the first. */
  readonly session: Session | null;
  /** Open `file`, saving the open PDF's notes first; a request during an open waits for it. */
  open(file: PdfFile): Promise<void>;
  /** Ask the adapter for a PDF (dialog, or `path` / URL) and open it. */
  openFrom(path?: string): Promise<void>;
  /** Open a dropped / picked File. */
  openFile(file: File): Promise<void>;
  /** Show a page ("p3", a blank page id). */
  show(pageId: string): void;
  /** Show PDF page n (clamped). */
  jump(n: number): void;
  /** Whole page or page width (W); remembered. */
  readonly fitMode: FitMode;
  setFitMode(mode: FitMode): void;
  /** Replace the notes with a notes file (picked, or `text`), asking first if there are notes. */
  importNotes(text?: { name: string; text: string } | null): Promise<void>;
  /** Export the PDF with the notes through the adapter. */
  exportPdf(): Promise<void>;
  /** Print the annotated PDF (the export): adapter.print (vector) or page images. */
  print(): Promise<void>;
  /** Save the notes now (Ctrl/Cmd+S); a failure shows a banner. */
  save(): Promise<void>;
  /**
   * Write the notes now (a stroke in progress is dropped); if that fails,
   * ask `question`. True: saved, or the user agreed to lose the changes.
   */
  saveOrAsk(question: string): Promise<boolean>;
  /**
   * Revert to Backup (desktop: File menu; browser: File group of the
   * toolbar): save, ask, swap the saved notes and the backup, and load the
   * notes again (no undo step).
   */
  revertToBackup(): Promise<void>;
}

/**
 * The viewer in `els`; also installs its keys, gestures and toolbar groups.
 * `mirror` hears of the opened PDF, the page shown, the stroke being written
 * and the laser (presenter mode, presenter.ts).
 */
export function createViewer(els: ViewerElements, adapter: AppAdapter, mirror: ViewerMirror | null = null): Viewer {
  const { stage, page: pageEl, pdfCanvas, liveCanvas } = els;
  const pdfCtx = pdfCanvas.getContext('2d', { alpha: false })!;
  const bitmaps = createPageBitmaps(CACHE_LIMIT, CACHE_BYTES);
  const liveInk = createLiveInk(liveCanvas, pageEl);
  let s: Session | null = null;
  let fit: FitRect | null = null;
  let view = { zoom: 1, tx: 0, ty: 0 };
  /** Remembered across sessions (a convenience: storage may be blocked). */
  let fitMode: FitMode = storedItem(FIT_KEY) === 'width' ? 'width' : 'page';
  let opening = false;
  /** A PDF asked for while another opens: opened after it (the latest request wins). */
  let queued: PdfFile | null = null;
  let printing = false;
  /** Bitmap key on the PDF canvas (to skip redundant draws). */
  let shownKey = '';

  /**
   * Revert to Backup is a toolbar button where the adapter has backups but no
   * menu for it (browser, PWA); the desktop has File → Revert to Backup….
   */
  const backupButton = adapter.platform !== 'electron' && !!adapter.revertToBackup;

  const dpr = (): number => window.devicePixelRatio || 1;
  const ask = (message: string): Promise<boolean> =>
    (adapter.confirm ? adapter.confirm(message) : Promise.resolve(window.confirm(message)));

  /** The PDF's notes backup; null if there is none or it cannot be read (then it is ignored). */
  async function readBackup(file: PdfFile, sha256: string): Promise<NotesBackup | null> {
    try {
      return adapter.readBackup ? await adapter.readBackup(file, sha256) : null;
    } catch (e) {
      console.error('Reading the notes backup failed', e);
      return null;
    }
  }

  /** The saved notes loaded into a new document; `problem` says why they could not be read or loaded. */
  async function loadSaved(file: PdfFile, sha256: string, newDoc: () => NotesDoc):
    Promise<{ doc: NotesDoc; warnings: string[]; problem: string; reason: string }> {
    const doc = newDoc();
    let text: string | null;
    try {
      text = await adapter.readNotes(file, sha256);
    } catch (e) {
      const reason = String((e as Error).message || e);
      return { doc, warnings: [], problem: `could not be read: ${reason}`, reason };
    }
    try {
      return { doc, warnings: text ? loadNotesMessages(doc, text) : [], problem: '', reason: '' };
    } catch (e) {
      const reason = String((e as Error).message || e);
      return { doc: newDoc(), warnings: [], problem: `could not be loaded: ${reason}`, reason };
    }
  }

  /** Find out whether the session's PDF has a backup now; the toolbar shows Revert to Backup if so. */
  async function checkBackup(ses: Session): Promise<void> {
    if (!backupButton) return;
    const has = !!(await readBackup(ses.file, ses.sha256));
    if (s !== ses || has === ses.hasBackup) return;
    ses.hasBackup = has;
    ses.app.refresh();
  }

  /** The backup loaded into a new document; null if there is none or it does not load. */
  async function loadBackup(file: PdfFile, sha256: string, newDoc: () => NotesDoc):
    Promise<{ doc: NotesDoc; warnings: string[]; when: string } | null> {
    const backup = await readBackup(file, sha256);
    if (!backup) return null;
    try {
      const doc = newDoc();
      return { doc, warnings: loadNotesMessages(doc, backup.text), when: new Date(backup.time).toLocaleString() };
    } catch (e) {
      console.error('The notes backup could not be loaded', e);
      return null;
    }
  }

  /**
   * Keep the unreadable notes file before it is replaced (desktop, browser). Resolves
   * with where the copy is ('' without one), or null if the copy failed and
   * the user does not want to go on (then nothing is opened).
   */
  async function keepUnreadable(file: PdfFile, sha256: string): Promise<string | null> {
    if (!adapter.keepUnreadableNotes) return '';
    try {
      return (await adapter.keepUnreadableNotes(file, sha256)) ?? '';
    } catch (e) {
      const ok = await ask(`A copy of the notes file that could not be read could not be kept (${(e as Error).message || e}).\n\n` +
        'Open the PDF anyway? Notes written now replace that file for good.');
      return ok ? '' : null;
    }
  }

  /** Put notes text into the open document in place of its notes (import, revert); no undo step. */
  function replaceNotes(ses: Session, text: string): string[] {
    const warnings = loadNotesMessages(ses.doc, text);
    ses.app.select(null);
    show(ses.doc.getPage(ses.current) || pdfPageNumber(ses.current) ? ses.current : 'p1');
    ses.app.refresh();
    return warnings;
  }

  /** Write the open PDF's notes now, dropping a stroke in progress; false if that failed. */
  async function saveNow(): Promise<boolean> {
    if (!s) return true;
    s.app.input.cancel();
    return flushSave();
  }

  // ── Rendering ────────────────────────────────────────────────

  function sizeOf(pageId: string): [number, number] {
    return s ? s.doc.pageSize(pageId) : [612, 792];
  }

  const stageBox = (): Box => ({ width: stage.clientWidth, height: stage.clientHeight });

  function fitFor(pageId: string): FitRect {
    return fitTo(fitMode, sizeOf(pageId), stageBox(), PAGE_MARGIN);
  }

  function drawBitmap(bmp: ImageBitmap, key: string): void {
    if (pdfCanvas.width !== bmp.width || pdfCanvas.height !== bmp.height) {
      pdfCanvas.width = bmp.width;
      pdfCanvas.height = bmp.height;
    }
    pdfCtx.drawImage(bmp, 0, 0);
    shownKey = key;
  }

  /** Paint the shown PDF page: cached bitmap at once (any scale as stand-in), exact one when ready. */
  function paint(): void {
    if (!s || !fit) return;
    const n = pdfPageNumber(s.current);
    if (n === null) return;
    const scale = renderScale(sizeOf(s.current), fit.scale, dpr(), view.zoom);
    const key = bitmapKey(n, scale);
    if (shownKey === key) return;
    const exact = bitmaps.cached(n, scale);
    if (exact) { drawBitmap(exact, key); return; }
    const stand = bitmaps.standIn(n);
    if (stand) drawBitmap(stand, `${n}@stand-in`);
    else if (!shownKey.startsWith(`${n}@`)) {
      pdfCanvas.width = 1;
      pdfCanvas.height = 1;
      pdfCtx.fillStyle = '#ffffff';
      pdfCtx.fillRect(0, 0, 1, 1);
      shownKey = '';
    }
    const id = s.current;
    bitmaps.get(n, scale, PRIORITY.current).then(bmp => {
      if (s && s.current === id && bitmaps.cached(n, scale) === bmp) drawBitmap(bmp, key);
    }, e => { if (!isCancelled(e)) console.error(`Rendering page ${n} failed`, e); });
  }

  /** Pre-render the PDF pages before and after the shown one at their fit size. */
  function prefetch(): void {
    if (!s) return;
    const own = s.doc.ownerSlide(s.current);
    if (own == null) return;
    const pages: [number, number][] = [];
    for (const n of [own + 1, own - 1]) {
      if (n < 1 || n > s.doc.deck.slides) continue;
      const id = `p${n}`;
      const f = fitFor(id);
      pages.push([n, renderScale(sizeOf(id), f.scale, dpr())]);
    }
    bitmaps.prefetch(pages);
  }

  // ── Layout and zoom ──────────────────────────────────────────

  function applyView(): void {
    pageEl.style.transform = view.zoom === 1 && !view.tx && !view.ty ? ''
      : `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`;
  }

  /** Part of the page box the stage shows (pan and scroll limits); set by layout(), not read per gesture event. */
  let vis: Box = { width: 1, height: 1 };

  /** Live ink backing store: device pixels of the zoomed page box, capped like the PDF render. */
  function resizeLiveInk(f: FitRect): void {
    liveInk.resize(f.width, f.height, renderScale([f.width, f.height], 1, dpr(), view.zoom));
  }

  function layout(): void {
    if (!s) return;
    fit = fitFor(s.current);
    Object.assign(pageEl.style, {
      left: `${fit.left}px`, top: `${fit.top}px`, width: `${fit.width}px`, height: `${fit.height}px`,
    });
    vis = visibleBox(fit, stageBox(), PAGE_MARGIN);
    [view.tx, view.ty] = clampPan(view.tx, view.ty, fit, view.zoom, vis);
    applyView();
    resizeLiveInk(fit);
  }

  /** Zoom the toolbar last showed (the − and + buttons' states and titles). */
  let barZoom = 1;

  function setView(zoom: number, tx: number, ty: number, done: boolean): void {
    if (!fit) return;
    const [cx, cy] = clampPan(tx, ty, fit, zoom, vis);
    view = { zoom, tx: cx, ty: cy };
    applyView();
    if (done) {
      resizeLiveInk(fit);
      paint();
      if (s && barZoom !== view.zoom) { // a pinch may have reached a zoom limit
        barZoom = view.zoom;
        s.app.refresh();
      }
    }
  }

  /** Back to the fit, unzoomed (page turn, W); the caller refreshes the toolbar. */
  function resetView(): void {
    view = { zoom: 1, tx: 0, ty: 0 };
    barZoom = 1;
  }

  /** − / + next to the page counter: the next zoom step, around the middle of the view. */
  function zoomBy(dir: -1 | 1): void {
    // The page must not move under a stroke, nor behind the open overview.
    if (!s || !fit || s.app.input.busy || s.overview.isOpen()) return;
    const zoom = zoomStep(view.zoom, dir);
    if (zoom === null) return;
    const [tx, ty] = zoomAround(view, zoom, vis.width / 2, vis.height / 2);
    setView(zoom, tx, ty, true);
  }

  /** The zoom for the − and + tooltips: "fit page", "150% of fit width". */
  function zoomText(): string {
    const fitName = fitMode === 'width' ? 'fit width' : 'fit page';
    return view.zoom <= 1.001 ? fitName : `${Math.round(view.zoom * 100)}% of ${fitName}`;
  }

  /** PgDn / PgUp in fit-width mode: scroll about a screen; false at the page's end (turn instead). */
  function scrollPage(dir: -1 | 1): boolean {
    if (fitMode !== 'width' || !fit) return false;
    const ty = pageScroll(view.ty, panLimits(fit, view.zoom, vis)[1], vis.height, dir);
    if (ty === null) return false;
    setView(view.zoom, view.tx, ty, true);
    return true;
  }

  /** The page before, shown from its bottom (the page turn of PgUp at a page's top). */
  function stepBackToBottom(): void {
    if (!s) return;
    const before = s.current;
    s.pages.step(-1);
    if (s.current !== before && fit) setView(view.zoom, view.tx, panLimits(fit, view.zoom, vis)[1], true);
  }

  /** PgDn / PgUp / Space: scroll first (fit width), else turn the page. */
  function pageKey(dir: -1 | 1): void {
    if (scrollPage(dir)) return;
    if (dir > 0) s?.pages.step(1);
    else stepBackToBottom();
  }

  /** The remembered paper for new blank pages; plain if none (or storage is blocked). */
  const storedPaper = (): Paper => {
    const p = storedItem(PAPER_KEY);
    return PAPERS.some(x => x.id === p) ? p as Paper : 'plain';
  };

  const toggleFitMode = (): void => setFitMode(fitMode === 'width' ? 'page' : 'width');

  function setFitMode(mode: FitMode): void {
    if (mode === fitMode) return;
    fitMode = mode;
    storeItem(FIT_KEY, mode);
    if (!s) return;
    resetView();
    layout();
    paint();
    prefetch();
    s.app.refresh();
  }

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  new ResizeObserver(() => {
    if (!s) return;
    layout(); // the bitmap stretches at once; re-render when the size settles
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; paint(); prefetch(); }, 120);
  }).observe(stage);

  attachGestures(stage, {
    touchDraws: () => !!s && s.app.enabled && !s.app.input.penSeen,
    // Only a finger's stroke: a pen stroke must not be dropped by a palm (penSeen may
    // also have turned true while the finger was drawing, by a hovering pen).
    discardStroke: () => { if (s && s.app.input.activePointerType === 'touch') s.app.input.discard(); },
    setView,
    view: () => view,
    scrolls: () => !!fit && vis.height < fit.height,
    drawing: () => !!s && s.app.input.busy,
    pageRect: () => {
      if (!fit) return null;
      const r = stage.getBoundingClientRect();
      return new DOMRect(r.left + fit.left, r.top + fit.top, fit.width, fit.height);
    },
    step: dir => s?.pages.step(dir),
  });

  // ── Surfaces and pages ───────────────────────────────────────

  function surfaceFor(pageId: string): PageSurface | null {
    if (!s) return null;
    const existing = s.app.surfaces.get(pageId) as PageSurface | undefined;
    if (existing) return existing;
    const page = s.doc.getPage(pageId);
    const blank = !!page && page.kind === 'blank';
    if (!blank && pdfPageNumber(pageId) === null) return null;
    const { svg, layer, paper } = render.createPageSurface(s.doc.pageSize(pageId), {
      paper: blank ? (page as { paper: Paper }).paper : undefined,
      className: blank ? 'ink-surface ink-blank' : 'ink-surface',
    });
    svg.dataset.pageId = pageId;
    const surface: PageSurface = { pageId, svg, layer, paper, n: s.doc.ownerSlide(pageId) ?? undefined, blank };
    render.syncLayer(layer, s.doc.strokes(pageId));
    render.syncImages(layer, s.doc.images(pageId));
    s.app.surfaces.set(pageId, surface);
    s.app.input.attach(surface);
    return surface;
  }

  function currentSurface(): PageSurface | null {
    return s ? (s.app.surfaces.get(s.current) as PageSurface | undefined) || null : null;
  }

  function show(pageId: string): void {
    if (!s) return;
    const prev = currentSurface();
    const surface = surfaceFor(pageId);
    if (!surface) return;
    const turned = prev !== surface;
    s.current = pageId;
    if (turned) resetView();
    layout();
    if (prev && turned) prev.svg.remove();
    if (!surface.svg.isConnected) pageEl.insertBefore(surface.svg, liveCanvas);
    pageEl.classList.toggle('is-blank', !!surface.blank);
    pageEl.dataset.pageId = pageId;
    paint();
    mirror?.shown(pageId);
    if (turned) {
      s.app.pageChanged(prev);
      pageTurned(); // save on page turn
    } else {
      s.app.refresh();
    }
    prefetch();
  }

  /** Model pages changed (insert / delete / paper / undo / load): update blank surfaces. */
  function pagesChanged(): void {
    if (!s) return;
    for (const [id, surf] of [...s.app.surfaces]) {
      const surface = surf as PageSurface;
      if (!surface.blank) continue;
      const page = s.doc.getPage(id);
      if (!page || page.kind !== 'blank') {
        surface.svg.remove();
        s.app.surfaces.delete(id);
        if (s.current === id) {
          s.current = '';
          show(`p${surface.n || 1}`);
        }
      } else {
        surface.n = page.after;
        if (surface.paper) surface.paper.set(page.paper);
        render.syncLayer(surface.layer, s.doc.strokes(id));
        render.syncImages(surface.layer, s.doc.images(id));
      }
    }
    if (s.current && !s.doc.getPage(s.current) && pdfPageNumber(s.current) === null) show('p1');
  }

  function pagesController(): ViewerPages {
    const ses = s!;
    const doc = ses.doc;
    const onBlank = (): boolean => !!(ses.app.surfaces.get(ses.current) as PageSurface | undefined)?.blank; // this session's, not s
    return {
      step(dir) {
        const target = doc.neighbor(ses.current, dir);
        if (target) show(target);
      },
      canStep: dir => doc.neighbor(ses.current, dir) !== null,
      label: () => pageCounter(doc, ses.current),
      insert(paper) {
        const cmd = doc.insertBlankPage(ses.current, paper || this.paper());
        show(cmd.pageId);
      },
      paper() {
        const page = doc.getPage(ses.current);
        return page && page.kind === 'blank' ? page.paper : ses.defaultPaper;
      },
      setPaper(paper) {
        const before = ses.defaultPaper;
        const remember = (p: Paper): void => { ses.defaultPaper = p; storeItem(PAPER_KEY, p); };
        remember(paper);
        const cmd = onBlank() ? doc.setPaper(ses.current, paper) : null;
        if (cmd) {
          // Undo and redo of the blank page's paper take the paper for new blank pages along.
          const { do: redo, undo } = cmd;
          cmd.undo = () => { remember(before); undo(); };
          cmd.do = () => { remember(paper); redo(); };
        }
        ses.app.refresh();
      },
      deleteCurrent() {
        if (!onBlank()) return;
        const id = ses.current;
        const prev = doc.neighbor(id, -1);
        doc.deletePage(id); // pagesChanged() moves to the owning PDF page
        if (prev) show(prev);
      },
      onBlank,
      jump(n) {
        if (!Number.isFinite(n)) return;
        show(`p${Math.max(1, Math.min(doc.deck.slides, Math.round(n)))}`);
      },
    };
  }

  // ── Keys ─────────────────────────────────────────────────────

  /** Page navigation, in annotate mode and out of it. */
  function navKey(e: KeyboardEvent): void {
    if (!s || typeof e.key !== 'string' || e.isComposing || isTyping(e.target) || e.ctrlKey || e.metaKey) return;
    if (s.app.input.busy && s.app.tool !== 'laser' && PAGE_KEYS.has(e.key)) {
      // The page must not move (scroll or turn) under a stroke being written, as with the wheel;
      // a presenter's clicker still turns the page while the laser is held.
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const { pages } = s;
    let handled = true;
    if (e.altKey) {
      const dir = e.key === 'PageDown' ? 1 : e.key === 'PageUp' ? -1 : 0;
      const target = dir ? sourceStep(s.doc, s.current, dir) : null;
      if (target) show(target);
      handled = dir !== 0;
    } else {
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': pages.step(1); break;
        case 'ArrowLeft': case 'ArrowUp': pages.step(-1); break;
        // In fit-width mode these scroll first; a page turn starts at the top, PgUp's at the bottom.
        case 'PageDown': pageKey(1); break;
        case 'PageUp': pageKey(-1); break;
        case ' ': pageKey(e.shiftKey ? -1 : 1); break;
        case 'Home': show('p1'); break;
        case 'End': {
          const seq = s.doc.sequence();
          show(seq[seq.length - 1]);
          break;
        }
        default:
          if (e.code === 'KeyW' && !e.shiftKey) {
            if (!e.repeat) toggleFitMode();
          } else handled = false;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // ── Snapshots ────────────────────────────────────────────────

  /** Area `rect` of page `pageId` of a session as an image (AnnotatorOptions.captureArea). */
  async function snapshotArea(ses: Session, pageId: string, rect: RectLike): Promise<Capture | null> {
    const page = ses.doc.getPage(pageId);
    const paper = page && page.kind === 'blank' ? page.paper : null;
    const n = paper ? null : pdfPageNumber(pageId);
    if (!paper && n === null) return null;
    const size = ses.doc.pageSize(pageId);
    const f = fitFor(pageId);
    const zoom = s === ses && ses.current === pageId ? view.zoom : 1;
    const scale = snapshotScale(rect, renderScale(size, f.scale, dpr(), zoom), f.scale);
    return captureArea({
      size, paper, strokes: ses.doc.strokes(pageId), images: ses.doc.images(pageId),
      background: n === null ? undefined : (canvas, area, k) => ses.pdf.renderArea(canvas, n, area, k),
    }, rect, scale);
  }

  // ── Open / close ─────────────────────────────────────────────

  function closeSession(): void {
    if (!s) return;
    const old = s;
    s = null;
    old.unbind();
    old.overview.destroy();
    old.app.input.destroy();
    if (old.app.toolbar) old.app.toolbar.destroy();
    old.app.surfaces.forEach(surf => surf.svg.remove());
    bitmaps.setDoc(null);
    shownKey = '';
    setSaveTarget(null);
    void old.pdf.destroy();
  }

  async function open(file: PdfFile): Promise<void> {
    if (opening) {
      queued = file;
      return;
    }
    opening = true;
    try {
      await load(file);
    } finally {
      opening = false;
    }
    const next = queued;
    queued = null;
    if (next) await open(next);
  }

  /** Open `file` in place of the open PDF (whose notes are saved first). */
  async function load(file: PdfFile): Promise<void> {
    let loseUnsaved = false;
    /** Write the open PDF's notes; false if that failed and the user keeps that PDF open (asked once). */
    const saveOpen = async (): Promise<boolean> => loseUnsaved || (await saveNow()) ||
      (loseUnsaved = await ask('The notes of the open PDF could not be saved. Open the other PDF anyway and lose the unsaved notes?'));
    let pdf: PdfDoc | null = null;
    try {
      if (!(await saveOpen())) return;
      pdf = await openPdfDoc(file.bytes);
      if (queued) return; // a newer request replaces this one
      const sha256 = await sha256Hex(file.bytes);
      const title = pdf.title || file.name.replace(/\.pdf$/i, '');
      const pageSizes = pdf.pageSizes;
      const newDoc = (): NotesDoc => new NotesDoc(deckFromPdf({ title, pageSizes, sha256 }));
      // Saved notes that cannot be read or loaded (broken file, newer version, a
      // sync client holding it) are read once more after a second. Then the
      // backup is offered (desktop, browser), else the user decides whether to open
      // anyway; either way the unreadable file is kept before it is replaced.
      let saved = await loadSaved(file, sha256, newDoc);
      if (saved.problem) {
        await new Promise(r => setTimeout(r, NOTES_RETRY_MS));
        if (queued) return; // a newer request replaces this one
        saved = await loadSaved(file, sha256, newDoc);
      }
      let { doc } = saved;
      if (saved.warnings.length) banner(saved.warnings.join('\n'), 'warn');
      let fromBackup: Awaited<ReturnType<typeof loadBackup>> = null;
      if (saved.problem) {
        const backup = await loadBackup(file, sha256, newDoc);
        if (backup && await ask(`The notes file could not be read (${saved.reason}). Open the backup from ${backup.when} instead?`)) {
          fromBackup = backup;
          doc = backup.doc;
        } else if (!(await ask(`The saved notes of ${file.name} ${saved.problem}.\n\nOpen the PDF anyway? Notes written now replace the saved ones.`))) {
          return;
        }
      }
      if (queued) return; // a newer request replaces this one
      const kept = saved.problem ? await keepUnreadable(file, sha256) : '';
      if (kept === null || queued) return;
      const keptMsg = kept ? `The notes file that could not be read was kept as ${kept}.` : '';
      // The open PDF again: its notes written below (or by autosave meanwhile) came after the read.
      const reread = !!s && s.sha256 === sha256 && s.file.path === file.path && !saved.problem;
      // Strokes made on the open PDF while this one loaded, or during a write:
      // write until nothing is unsaved, then close with no await in between.
      do {
        if (!(await saveOpen())) return;
      } while (!loseUnsaved && saveState() !== 'saved');
      if (queued) return; // a newer request replaces this one
      // The open notes, as just written: if reading them again fails, the notes read
      // before (without the strokes written since) must not take their place.
      const openText = reread && s ? serializeNotes(s.doc) : '';
      closeSession();
      if (reread) {
        const again = await loadSaved(file, sha256, newDoc);
        if (!again.problem) doc = again.doc;
        else {
          console.warn('Reading the notes again failed; the open notes are kept', again.reason);
          const open = newDoc();
          try {
            loadNotesMessages(open, openText);
            doc = open;
          } catch (e) {
            console.error('The open notes could not be loaded again', e); // the notes read before, the most there is
          }
        }
      }
      startSession(file, sha256, pdf, doc);
      if (fromBackup) banner([`Opened the backup from ${fromBackup.when}.`, keptMsg, ...fromBackup.warnings].filter(Boolean).join('\n'), 'warn');
      else if (kept) banner(keptMsg, 'warn');
      if (adapter.opened) void adapter.opened(file, { sha256, pages: pdf.numPages });
      pdf = null;
      document.title = `${title} – Inkslide`;
    } catch (e) {
      console.error(e);
      banner(`Could not open ${file.name}: ${(e as Error).message || e}`, 'error');
    } finally {
      if (pdf) void pdf.destroy(); // not opened after all
    }
  }

  /** The live ink renderer; with a mirror, the stroke being written is also mirrored. */
  const renderer: ToolRenderer = mirror
    ? {
      ...liveInk.renderer,
      liveStroke: (layer, tool) => mirror.liveStroke(layer.svg.dataset.pageId || '', tool, liveInk.renderer.liveStroke(layer, tool)),
    }
    : liveInk.renderer;

  function startSession(file: PdfFile, sha256: string, pdf: PdfDoc, doc: NotesDoc): void {
    const app = createAnnotator({
      doc, activeSurface: () => currentSurface(), renderer,
      captureArea: (pageId, rect) => snapshotArea(ses, pageId, rect),
      importImage,
      notify: (text, kind) => { banner(text, kind); },
    });
    app.sync = mirror;
    const ses: Session = {
      file, sha256, pdf, doc, app, current: 'p1', defaultPaper: storedPaper(), hasBackup: false, revision: 0,
      overview: null as unknown as Overview, pages: null as unknown as ViewerPages, unbind: () => {},
    };
    s = ses;
    doc.onChange((_pageId, kind) => { if (kind !== 'saved') ses.revision++; });
    bitmaps.setDoc(pdf);
    const pages = pagesController();
    app.pages = ses.pages = pages;
    ses.overview = createOverview({
      doc, pdf,
      currentNumber: () => doc.ownerSlide(ses.current) || 1,
      jump: n => pages.jump(n),
      refresh: () => app.refresh(),
      cancelInput: () => app.input.cancel(),
    });
    app.overview = ses.overview;
    app.onPagesChanged = () => pagesChanged();
    app.keymap.push({ test: e => e.code === 'KeyB' && !e.ctrlKey && !e.metaKey && !e.altKey, run: () => pages.insert() });
    app.onRefresh = () => {
      const save = app.toolbar && app.toolbar.el.querySelector<HTMLElement>('.ann-btn[data-id="save"]');
      const state = saveState();
      if (save) {
        save.classList.toggle('is-unsaved', state !== 'saved');
        save.classList.toggle('is-error', state === 'error');
      }
    };
    window.addEventListener('keydown', navKey, true); // after the overview's keys, before the toolbar's
    const unbindKeys = app.mount(document.body);
    ses.unbind = () => {
      unbindKeys();
      window.removeEventListener('keydown', navKey, true);
    };
    setSaveTarget({ doc, adapter, pdf: file, sha256 }, {
      onError: e => banner(`Saving the notes failed (retrying): ${(e as Error).message || e}`, 'error'),
      onState: state => {
        // A save may have made the first backup (until then, look after each one).
        if (state === 'saved' && !ses.hasBackup) void checkBackup(ses);
        app.refresh();
      },
    });
    void checkBackup(ses);
    els.empty.hidden = true;
    stage.hidden = false;
    document.body.classList.add('has-doc');
    app.toggle(true); // a PDF opens ready to write on; A switches to plain viewing
    mirror?.opened(file, doc);
    show('p1');
  }

  // ── Toolbar groups ───────────────────────────────────────────

  registerGroup('pages', (app: PagesHost) => {
    const group = pagesGroup(app);
    // Zoom out and in on both sides of the page counter; the zoom is in their tooltips (the
    // counter has no room for it when the bar is docked left or right).
    const label = group.items.findIndex(item => item.id === 'page-label');
    const zoomItem = (dir: -1 | 1): ToolbarItem => ({
      id: dir < 0 ? 'zoom-out' : 'zoom-in', icon: dir < 0 ? 'zoomOut' : 'zoomIn',
      title: () => `${dir < 0 ? 'Zoom out (Ctrl/Cmd+−)' : 'Zoom in (Ctrl/Cmd+=)'} · now ${zoomText()}`,
      onClick: () => zoomBy(dir),
      disabled: () => !s || zoomStep(view.zoom, dir) === null,
    });
    group.items.splice(label + 1, 0, zoomItem(1));
    group.items.splice(label, 0, zoomItem(-1));
    group.items.push({
      id: 'fit-width', icon: 'fitWidth',
      title: () => (fitMode === 'width' ? 'Fit width (W) · on: show the whole page again' : 'Fit width (W): fill the width, scroll the page'),
      onClick: toggleFitMode,
      active: () => fitMode === 'width',
    });
    return group;
  });
  registerGroup('file', (app: ToolbarHost) => ({
    id: 'file', label: 'File',
    items: [
      { id: 'open', title: 'Open PDF (Ctrl/Cmd+O)', icon: 'open', onClick: () => void viewer.openFrom() },
      {
        id: 'save', icon: 'save', onClick: () => void viewer.save(),
        title: () => ({
          saved: 'Notes saved (Ctrl/Cmd+S)',
          dirty: 'Save notes now (Ctrl/Cmd+S) · unsaved changes',
          saving: 'Saving notes…',
          error: 'Saving the notes failed, retrying · Ctrl/Cmd+S to try now',
        })[saveState()],
      },
      { id: 'load', title: 'Import notes from .json (or drop a file on the window)', icon: 'load',
        onClick: () => void viewer.importNotes(), disabled: () => !adapter.importNotes },
      { id: 'pdf', title: 'Export PDF with notes', icon: 'pdf', onClick: () => void viewer.exportPdf() },
      { id: 'print', title: 'Print with notes (Ctrl/Cmd+P)', icon: 'print', onClick: () => void viewer.print(),
        disabled: () => printing },
      { id: 'revert', title: 'Revert to backup: the notes as saved a few minutes ago (asks first)', icon: 'revert',
        onClick: () => void viewer.revertToBackup(), hidden: () => !backupButton || !s?.hasBackup },
    ],
  }));

  /** The export of a session's PDF with its notes, and the file name for it. */
  async function annotatedPdf(ses: Session): Promise<{ bytes: Uint8Array; warnings: string[]; name: string }> {
    ses.app.input.cancel();
    const { bytes, warnings } = await buildAnnotatedPdf(ses.file.bytes, ses.doc.toJSON());
    return { bytes, warnings, name: ses.file.name.replace(/\.pdf$/i, '') + '-notes.pdf' };
  }

  const viewer: Viewer = {
    get session() { return s; },
    open,

    async openFrom(path) {
      try {
        const file = await adapter.openPdf(path);
        if (file) await open(file);
      } catch (e) {
        banner(`Could not open the PDF: ${(e as Error).message || e}`, 'error');
      }
    },

    async openFile(file) {
      let pdf: PdfFile;
      try {
        const path = adapter.pathForFile ? adapter.pathForFile(file) : '';
        if (path) return await viewer.openFrom(path);
        // Reading can fail (the file was moved or changed since it was picked or dropped).
        pdf = adapter.fromFile ? await adapter.fromFile(file)
          : { path: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
      } catch (e) {
        banner(`Could not open ${file.name}: ${(e as Error).message || e}`, 'error');
        return;
      }
      await open(pdf);
    },

    show,
    get fitMode() { return fitMode; },
    setFitMode,
    jump: n => s?.pages.jump(n),

    async importNotes(picked) {
      if (!s) return;
      const ses = s;
      try {
        const file = picked || (adapter.importNotes ? await adapter.importNotes() : null);
        if (!file || s !== ses) return;
        if (ses.doc.hasNotes()) {
          if (!(await ask(`Replace the notes of this PDF with ${file.name}? (The current notes can not be restored.)`))) return;
          if (s !== ses) return; // another PDF opened while the question was open
        }
        const warnings = replaceNotes(ses, file.text);
        scheduleSave();
        banner(warnings.length ? `Imported ${file.name}:\n${warnings.join('\n')}` : `Imported ${file.name}`, warnings.length ? 'warn' : 'info');
      } catch (e) {
        banner(`Could not import the notes: ${(e as Error).message || e}`, 'error');
      }
    },

    async exportPdf() {
      if (!s) return;
      const ses = s;
      try {
        const { bytes, warnings, name } = await annotatedPdf(ses);
        if (!(await adapter.exportPdf(bytes, name))) return;
        if (warnings.length) banner(`Exported ${name}, with problems:\n${warnings.join('\n')}`, 'warn');
        else banner(`Exported ${name}`);
      } catch (e) {
        banner(`Export failed: ${(e as Error).message || e}`, 'error');
      }
    },

    async print() {
      if (!s || printing) return;
      const ses = s;
      printing = true;
      ses.app.refresh();
      try {
        const { bytes, warnings, name } = await annotatedPdf(ses);
        if (adapter.print) {
          if (!(await adapter.print(bytes, name))) return;
        } else {
          await printPageImages(bytes);
        }
        if (warnings.length) banner(`Printed ${name}, with problems:\n${warnings.join('\n')}`, 'warn');
      } catch (e) {
        banner(`Printing failed: ${(e as Error).message || e}`, 'error');
      } finally {
        printing = false;
        ses.app.refresh();
      }
    },

    async save() {
      if (!(await saveNow())) banner('Saving the notes failed. Retrying in the background.', 'error');
    },

    async revertToBackup() {
      if (!s || !adapter.revertToBackup) return;
      const ses = s;
      try {
        // Strokes not yet written would be lost: save first, then ask.
        if (!(await saveNow())) return void banner('The notes could not be saved, so they were not reverted.', 'error');
        const backup = await readBackup(ses.file, ses.sha256);
        if (s !== ses) return;
        if (!backup) {
          // Gone since the button showed (e.g. the PDF left the recent files): hide it.
          if (ses.hasBackup) {
            ses.hasBackup = false;
            ses.app.refresh();
          }
          return void banner('There is no backup of these notes.', 'warn');
        }
        const when = new Date(backup.time).toLocaleString();
        if (!(await ask(`Replace the current notes with the backup from ${when}?`)) || s !== ses) return;
        // No pen input until the backup is loaded: a stroke written meanwhile would be replaced by it.
        pageEl.inert = true;
        try {
          if (!(await saveNow())) return void banner('The notes could not be saved, so they were not reverted.', 'error');
          const revert = adapter.revertToBackup.bind(adapter, ses.file, ses.sha256);
          const revision = ses.revision;
          // No autosave write during the swap. Notes changed meanwhile (a key: undo, a new
          // page) are newer than the swap: it is swapped back (the backup stays) and they are kept.
          const text = await holdSaves(async () => {
            const reverted = await revert();
            if (ses.revision === revision) return reverted;
            await revert();
            return null;
          });
          if (s !== ses) return;
          if (text === null) return void banner('The notes changed during the revert, so they were kept. Revert to Backup again to load the backup.', 'warn');
          const warnings = replaceNotes(ses, text);
          // Write the reloaded notes (the same text) at once, so nothing shows as unsaved.
          await saveNow();
          banner(warnings.length ? `Reverted to the backup from ${when}:\n${warnings.join('\n')}` : `Reverted to the backup from ${when}.`,
            warnings.length ? 'warn' : 'info');
        } finally {
          pageEl.inert = false;
        }
      } catch (e) {
        banner(`Could not revert to the backup: ${(e as Error).message || e}`, 'error');
        void checkBackup(ses);
      }
    },

    saveOrAsk: async question => (await saveNow()) || ask(question),
  };

  // Back in the page: another tab may have added or removed the backup.
  document.addEventListener('visibilitychange', () => {
    if (s && document.visibilityState === 'visible') void checkBackup(s);
  });

  // Keys that work with or without a document.
  window.addEventListener('keydown', e => {
    if (typeof e.key !== 'string' || e.isComposing || isTyping(e.target)) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if (mod && e.code === 'KeyO') {
      e.preventDefault();
      void viewer.openFrom();
    } else if (mod && e.code === 'KeyS') {
      e.preventDefault();
      void viewer.save();
    } else if (mod && e.code === 'KeyP' && s) {
      e.preventDefault(); // the document, not the browser's print of the screen
      void viewer.print();
    }
  });
  // Ctrl/Cmd+= (or +, also with Shift) and Ctrl/Cmd+−: the page, not the browser's zoom of the
  // whole app. Capture phase: a focused toolbar button stops keys from bubbling up to window.
  window.addEventListener('keydown', e => {
    if (!s || typeof e.key !== 'string' || e.isComposing || isTyping(e.target)) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !/^(=|\+|-)$/.test(e.key)) return;
    e.preventDefault();
    zoomBy(e.key === '-' ? -1 : 1);
  }, true);

  return viewer;
}
