/* Inkslide web - the audience window of presenter mode (entry of audience.html)
 *
 * The desktop app opens this page in a second window (View → Presenter Mode),
 * full screen on the other display when there is one; the browser build opens
 * it as a pop-up (F5), audience.html#<id> with the presenter tab's link id
 * (presenter-link.ts). It shows what the presenter's window shows: the page,
 * the ink (also the stroke being written, erased or moved) and the laser, with
 * no toolbar. It reads no files: the PDF and the notes come as presenter
 * messages (@inkslide/annotate/presenter) through the bridge or the browser's
 * channel, are checked again here, and are applied to a NotesDoc of its own,
 * which is never saved.
 *
 * Input: none in the desktop app (main handles its keys). In the browser a
 * click goes full screen (a page may only ask for it on a click or a key; a
 * hint says so), and Escape (out of full screen) or F5 closes the window,
 * ending presenter mode as in the desktop app.
 *
 *   .ink-stage (whole window)
 *     .ink-page             the page, fitted whole (no zoom, no scroll)
 *       canvas.ink-pdf      PDF.js render of the page
 *       svg.ann-page        annotation surface; the live stroke and the laser are drawn in it
 */
import '@inkslide/annotate/toolbar.css';
import './style.css';
import { createStroke, NotesDoc, type Paper, type Point, type Stroke } from '@inkslide/annotate';
import { deckFromPdf } from '@inkslide/annotate/io';
import { applyLivePoints, parsePresenterMessage, PRESENTER_LIMITS, type PresenterMessage } from '@inkslide/annotate/presenter';
import * as render from '@inkslide/annotate/render';
import type { StrokeTool } from '@inkslide/annotate/geometry';
import type { StrokeInput } from '@inkslide/annotate/model';
import { pdfPageNumber } from './counter';
import { fitTo, renderScale, type FitRect } from './fit';
import { bitmapKey, createPageBitmaps } from './page-bitmaps';
import { openPdfDoc, PRIORITY, type PdfDoc } from './pdf';
import { broadcastPort, channelName, createAudienceLink, idFromHash } from './presenter-link';

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
/**
 * An erase or move under way on the presenter's page (erasing / moving
 * messages), shown over the page's strokes until preview-end. `pieces`: the
 * cut pieces received so far in this gesture, by id.
 */
let preview: { page: string; kind: 'erase' | 'move'; ids: string[]; pieces: Map<string, Stroke> } | null = null;
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
  render.syncImages(layer, doc.images(pageId));
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

// ── Previews (erasing and moving while they happen) ────────────

/** The page of the preview shows its strokes and images again, as the document has them. */
function endPreview(): void {
  if (!preview) return;
  const surface = surfaces.get(preview.page);
  if (surface && doc) {
    render.syncLayer(surface.layer, doc.strokes(preview.page));
    render.syncImages(surface.layer, doc.images(preview.page));
    // Items not changed by the move (it was refused) still carry the offset.
    if (preview.kind === 'move') render.translateStrokes(surface.layer, preview.ids, 0, 0);
  }
  preview = null;
}

/** A preview of `kind` on `page`: the one under way, or a new one (ending any other). */
function previewOn(page: string, kind: 'erase' | 'move'): NonNullable<typeof preview> {
  if (preview && (preview.page !== page || preview.kind !== kind)) endPreview();
  preview ??= { page, kind, ids: [], pieces: new Map() };
  return preview;
}

/** The page as the eraser leaves it so far: strokes by id (the page's or pieces), images not erased. */
function erasing(m: Extract<PresenterMessage, { type: 'erasing' }>): void {
  if (!doc) return;
  const pv = previewOn(m.page, 'erase');
  for (const s of m.strokes) {
    try {
      pv.pieces.set(s.id, createStroke(s));
    } catch (e) {
      console.error('Presenter mode: a piece could not be shown', e);
    }
  }
  const surface = surfaces.get(m.page);
  if (!surface) return;
  const own = new Map(doc.strokes(m.page).map(s => [s.id, s]));
  render.syncLayer(surface.layer, m.order.flatMap(id => pv.pieces.get(id) ?? own.get(id) ?? []));
  const hidden = new Set(m.hidden);
  render.syncImages(surface.layer, doc.images(m.page).filter(i => !hidden.has(i.id)));
}

/** Strokes and images being dragged: shown moved by (dx, dy). */
function moving(m: Extract<PresenterMessage, { type: 'moving' }>): void {
  const pv = previewOn(m.page, 'move');
  const surface = surfaces.get(m.page);
  if (surface) {
    // Items no longer dragged (none, as a rule) go back.
    const now = new Set(m.ids);
    render.translateStrokes(surface.layer, pv.ids.filter(id => !now.has(id)), 0, 0);
    render.translateStrokes(surface.layer, m.ids, m.dx, m.dy);
  }
  pv.ids = m.ids;
}

function show(pageId: string): void {
  // Another page: the preview of the one left ends (also when the new one is not known yet).
  if (preview && preview.page !== pageId) endPreview();
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
  preview = null;
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
      for (const [id, s] of surfaces) {
        if (pageId !== null && pageId !== id) continue;
        render.syncLayer(s.layer, d.strokes(id));
        render.syncImages(s.layer, d.images(id));
      }
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
  applyLivePoints(live.points, m.from, m.points);
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
    case 'erasing':
      erasing(m);
      return;
    case 'moving':
      moving(m);
      return;
    case 'preview-end':
      endPreview();
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
  } else if (m.type === 'images') {
    // Images the audience has are named by id only: their data comes from here.
    const known = new Map(doc.images(m.page).map(i => [i.id, i.src]));
    doc.applyRemoteImages(m.page, m.images.flatMap(i => {
      const src = i.src ?? known.get(i.id);
      return src ? [{ ...i, src }] : [];
    }));
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

// No menu.
document.addEventListener('contextmenu', e => e.preventDefault());

/** How long the full-screen hint stays after the pointer last moved, ms. */
const HINT_MS = 4000;

/** Browser: the hint, a click for full screen, and the keys that end presenter mode. */
function browserInput(): void {
  const hint = $<HTMLElement>('.ink-fullscreen-hint');
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  // F11 is the browser's own full screen (no fullscreenElement), seen as display-mode.
  const full = (): boolean => !!document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches;
  const showHint = (): void => {
    const on = !full();
    hint.hidden = !on;
    document.body.classList.toggle('has-hint', on);
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = on ? setTimeout(() => { hint.hidden = true; document.body.classList.remove('has-hint'); }, HINT_MS) : null;
  };
  document.addEventListener('pointermove', showHint);
  document.addEventListener('fullscreenchange', showHint);
  document.addEventListener('click', () => {
    if (full() || !document.documentElement.requestFullscreen) return;
    document.documentElement.requestFullscreen().catch(e => console.warn('Full screen refused', e));
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'F5' || (e.key === 'Escape' && !full())) {
      e.preventDefault();
      window.close();
    }
  });
  showHint();
}

const bridge = window.inkslide;
const linkId = idFromHash(location.hash);
if (bridge && typeof bridge.onAudience === 'function') {
  setWaiting('Waiting for the presenter…');
  bridge.onAudience(receive);
} else if (!bridge && linkId && typeof BroadcastChannel === 'function') {
  setWaiting('Waiting for the presenter…');
  const link = createAudienceLink(broadcastPort(channelName(linkId)), {
    message: receive,
    connected: () => {},
    gone: () => {
      queue = queue.then(() => {
        closeDoc();
        setWaiting('The presenter’s tab was closed or is reloading. Waiting for it…');
      });
    },
    // F5 in the presenter tab, or no presenter back within GRACE_MS. A window not opened by a
    // script (the URL typed in) stays: it keeps its text and follows a presenter that comes.
    quit: () => window.close(),
  });
  window.addEventListener('pagehide', e => { if (!e.persisted) link.leave(); });
  window.addEventListener('pageshow', e => { if (e.persisted) link.hello(); });
  browserInput();
} else {
  setWaiting('This is the audience window of presenter mode: press F5 in Inkslide (desktop app: View → Presenter Mode).');
}
