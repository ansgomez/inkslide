/* Inkslide web - the audience window of presenter mode (entry of audience.html)
 *
 * The desktop app opens this page in a second window (View → Presenter Mode),
 * full screen on the other display when there is one. It shows what the
 * presenter's window shows: the page, the ink (also the stroke being written)
 * and the laser, with no toolbar and no input. It reads no files: the PDF and
 * the notes come as presenter messages (@inkslide/annotate/presenter) through
 * the bridge, are checked again here, and are applied to a NotesDoc of its
 * own, which is never saved.
 *
 *   .ink-stage (whole window)
 *     .ink-page             the page, fitted whole (no zoom, no scroll)
 *       canvas.ink-pdf      PDF.js render of the page
 *       svg.ann-page        annotation surface; the live stroke and the laser are drawn in it
 */
import '@inkslide/annotate/toolbar.css';
import './style.css';
import { NotesDoc, type Paper, type Point } from '@inkslide/annotate';
import { deckFromPdf } from '@inkslide/annotate/io';
import { parsePresenterMessage, PRESENTER_LIMITS, type PresenterMessage } from '@inkslide/annotate/presenter';
import * as render from '@inkslide/annotate/render';
import type { StrokeTool } from '@inkslide/annotate/geometry';
import type { StrokeInput } from '@inkslide/annotate/model';
import { pdfPageNumber } from './counter';
import { fitTo, renderScale, type FitRect } from './fit';
import { bitmapKey, createPageBitmaps } from './page-bitmaps';
import { openPdfDoc, PRIORITY, type PdfDoc } from './pdf';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

interface AudienceSurface {
  svg: SVGSVGElement;
  layer: render.Layer;
  paper: render.PaperHandle | null;
  blank: boolean;
}

/** The stroke being written on the presenter's page. */
interface Live {
  page: string;
  stroke: render.LiveStroke;
  tool: StrokeTool;
  points: Point[];
}

const stage = $<HTMLElement>('.ink-stage');
const pageEl = $<HTMLElement>('.ink-page');
const pdfCanvas = $<HTMLCanvasElement>('canvas.ink-pdf');
const waiting = $<HTMLElement>('.ink-waiting');
const pdfCtx = pdfCanvas.getContext('2d', { alpha: false })!;
const bitmaps = createPageBitmaps(4);

let pdf: PdfDoc | null = null;
let doc: NotesDoc | null = null;
let current = '';
/** A page asked for before it was known (a blank page whose list has not come yet). */
let wanted = '';
let fit: FitRect | null = null;
let shownKey = '';
let live: Live | null = null;
const surfaces = new Map<string, AudienceSurface>();

const dpr = (): number => window.devicePixelRatio || 1;

function setWaiting(text: string): void {
  waiting.textContent = text;
  waiting.hidden = false;
  stage.hidden = true;
}

// ── Rendering ──────────────────────────────────────────────────

/** Whether the document has page `pageId` (a PDF page, or a blank page that has arrived). */
function known(pageId: string): boolean {
  if (!doc) return false;
  const page = doc.getPage(pageId);
  if (page && page.kind === 'blank') return true;
  const n = pdfPageNumber(pageId);
  return n !== null && n >= 1 && n <= doc.deck.slides;
}

function surfaceFor(pageId: string): AudienceSurface | null {
  if (!doc || !known(pageId)) return null;
  const existing = surfaces.get(pageId);
  if (existing) return existing;
  const page = doc.getPage(pageId);
  const blank = !!page && page.kind === 'blank';
  const { svg, layer, paper } = render.createPageSurface(doc.pageSize(pageId), {
    paper: blank ? (page as { paper: Paper }).paper : undefined,
    className: blank ? 'ink-surface ink-blank' : 'ink-surface',
  });
  const surface: AudienceSurface = { svg, layer, paper, blank };
  render.syncLayer(layer, doc.strokes(pageId));
  surfaces.set(pageId, surface);
  return surface;
}

function layout(): void {
  if (!doc || !current) return;
  fit = fitTo('page', doc.pageSize(current), { width: stage.clientWidth, height: stage.clientHeight });
  Object.assign(pageEl.style, {
    left: `${fit.left}px`, top: `${fit.top}px`, width: `${fit.width}px`, height: `${fit.height}px`,
  });
}

function drawBitmap(bmp: ImageBitmap, key: string): void {
  if (pdfCanvas.width !== bmp.width || pdfCanvas.height !== bmp.height) {
    pdfCanvas.width = bmp.width;
    pdfCanvas.height = bmp.height;
  }
  pdfCtx.drawImage(bmp, 0, 0);
  shownKey = key;
}

/** Paint the PDF page: a cached bitmap at once (any scale as a stand-in), the exact one when ready. */
function paint(): void {
  if (!doc || !fit) return;
  const n = pdfPageNumber(current);
  if (n === null) return;
  const scale = renderScale(doc.pageSize(current), fit.scale, dpr());
  const key = bitmapKey(n, scale);
  if (shownKey === key) return;
  const exact = bitmaps.cached(n, scale);
  if (exact) return drawBitmap(exact, key);
  const stand = bitmaps.standIn(n);
  if (stand) drawBitmap(stand, `${n}@stand-in`);
  else if (!shownKey.startsWith(`${n}@`)) {
    pdfCanvas.width = pdfCanvas.height = 1;
    pdfCtx.fillStyle = '#ffffff';
    pdfCtx.fillRect(0, 0, 1, 1);
    shownKey = '';
  }
  const id = current;
  bitmaps.get(n, scale, PRIORITY.current).then(bmp => {
    if (current === id && bitmaps.cached(n, scale) === bmp) drawBitmap(bmp, key);
  }, e => console.error(`Rendering page ${n} failed`, e));
}

function endLive(): void {
  if (live) live.stroke.remove();
  live = null;
}

function show(pageId: string): void {
  const surface = surfaceFor(pageId);
  if (!surface) {
    wanted = pageId; // shown once its blank page arrives
    return;
  }
  wanted = '';
  const prev = current ? surfaces.get(current) : undefined;
  current = pageId;
  if (prev && prev !== surface) {
    endLive();
    prev.layer.laser?.clear();
    prev.svg.remove();
  }
  if (!surface.svg.isConnected) pageEl.appendChild(surface.svg);
  pageEl.classList.toggle('is-blank', surface.blank);
  layout();
  paint();
  // The next pages are likely next.
  const own = doc!.ownerSlide(pageId);
  if (own != null && own < doc!.deck.slides && fit) {
    const next = own + 1;
    const f = fitTo('page', doc!.pageSize(`p${next}`), { width: stage.clientWidth, height: stage.clientHeight });
    bitmaps.get(next, renderScale(doc!.pageSize(`p${next}`), f.scale, dpr()), PRIORITY.neighbor).catch(() => { /* closed */ });
  }
}

/** Blank pages changed (inserted, deleted, paper): update their surfaces. */
function pagesChanged(): void {
  if (!doc) return;
  for (const [id, surface] of [...surfaces]) {
    if (!surface.blank) continue;
    const page = doc.getPage(id);
    if (!page || page.kind !== 'blank') {
      surface.svg.remove();
      surfaces.delete(id);
      if (current === id) current = '';
    } else if (surface.paper) surface.paper.set(page.paper);
  }
  if (wanted && known(wanted)) show(wanted);
  // The presenter moves on from a deleted page with its own page message.
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
new ResizeObserver(() => {
  layout();
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { resizeTimer = null; paint(); }, 120);
}).observe(stage);

// ── Messages ───────────────────────────────────────────────────

function closeDoc(): void {
  endLive();
  surfaces.forEach(s => s.svg.remove());
  surfaces.clear();
  bitmaps.setDoc(null);
  if (pdf) void pdf.destroy();
  pdf = null;
  doc = null;
  current = wanted = shownKey = '';
  fit = null;
}

async function open(bytes: Uint8Array, title: string): Promise<void> {
  closeDoc();
  const opened = await openPdfDoc(bytes);
  pdf = opened;
  const d = new NotesDoc(deckFromPdf({ title, pageSizes: opened.pageSizes }));
  d.onChange((pageId, kind) => {
    if (d !== doc) return;
    if (kind === 'pages') pagesChanged();
    else if (kind === 'strokes') {
      for (const [id, s] of surfaces) if (pageId === null || pageId === id) render.syncLayer(s.layer, d.strokes(id));
    }
  });
  doc = d;
  bitmaps.setDoc(opened);
  document.title = `${title} – Inkslide audience`;
  waiting.hidden = true;
  stage.hidden = false;
}

/** The stroke being written: points from `from` on replace the ones it had. */
function liveStroke(m: Extract<PresenterMessage, { type: 'live' }>): void {
  if (m.page !== current) return;
  const surface = surfaces.get(current);
  if (!surface) return;
  if (!live || m.from === 0 || live.page !== m.page || live.tool !== m.tool) {
    endLive();
    live = { page: m.page, tool: m.tool, stroke: render.liveStroke(surface.layer, m.tool), points: [] };
  }
  live.points.length = Math.min(live.points.length, m.from);
  live.points.push(...m.points);
  if (live.points.length) live.stroke.update({ id: 'live', tool: m.tool, color: m.color, size: m.size, points: live.points });
}

async function handle(m: PresenterMessage): Promise<void> {
  switch (m.type) {
    case 'open':
      await open(m.pdf, m.title);
      return;
    case 'close':
      closeDoc();
      setWaiting(m.reason === 'too-large' ? `Could not mirror this PDF: it is larger than ${PRESENTER_LIMITS.pdfBytes / 2 ** 20} MB.`
        : m.reason === 'failed' ? 'Could not mirror this PDF.' : 'No PDF is open.');
      return;
    case 'page':
      show(m.page);
      return;
    case 'live':
      liveStroke(m);
      return;
    case 'live-end':
      endLive();
      return;
    case 'laser': {
      const surface = m.page === current ? surfaces.get(current) : undefined;
      if (surface) for (const pt of m.points) render.laser(surface.layer).add(pt);
      return;
    }
  }
  if (!doc) return;
  if (m.type === 'notes') {
    doc.load(JSON.parse(m.notes));
  } else if (m.type === 'strokes') {
    doc.applyRemoteStrokes(m.page, m.strokes);
  } else if (m.type === 'delta') {
    // Known strokes go back as the same objects: their SVG nodes stay (applyRemoteStrokes).
    const known = new Map<string, StrokeInput>(doc.strokes(m.page).map(s => [s.id, s]));
    for (const s of m.strokes) known.set(s.id, s);
    doc.applyRemoteStrokes(m.page, m.order.flatMap(id => known.get(id) ?? []));
  } else if (m.type === 'blanks') {
    const listed = new Set(m.blanks.map(b => b.id));
    doc.applyRemoteBlanks(m.blanks, doc.blankOrder.filter(id => !listed.has(id)));
  }
}

// One message at a time, in order (opening the PDF takes a while).
let queue = Promise.resolve();
function receive(value: unknown): void {
  let m: PresenterMessage;
  try {
    m = parsePresenterMessage(value);
  } catch (e) {
    console.error(e);
    return;
  }
  queue = queue.then(() => handle(m)).catch(e => {
    console.error('Presenter mode: a message could not be shown', e);
    if (m.type === 'open') {
      closeDoc();
      setWaiting('Could not mirror this PDF.');
    }
  });
}

// No input: nothing here takes a click, a key or a menu.
document.addEventListener('contextmenu', e => e.preventDefault());

const bridge = window.inkslide;
if (bridge && typeof bridge.onAudience === 'function') {
  setWaiting('Waiting for the presenter…');
  bridge.onAudience(receive);
} else {
  setWaiting('This is the audience window of the desktop app’s presenter mode (View → Presenter Mode).');
}
