/* Inkslide web - touch gestures on the page: pinch zoom, pan, two-finger swipe
 *
 * Runs in the capture phase on the stage, before input.ts sees the events
 * on the page SVG:
 *   - One finger draws (input.ts) until a pen has been seen and annotate
 *     mode is on; otherwise it does nothing here. It never pans or scrolls:
 *     a hand brushing the screen moved the page too often.
 *   - A second finger ends a finger stroke (discarded) and starts a
 *     pinch: pan or scroll with the fingers' midpoint, and zoom around it
 *     once their spread has changed by PINCH_SLOP (two fingers scrolling
 *     do not zoom by accident).
 *   - Two fingers that move quickly sideways without zooming turn the
 *     page (swipeDirection from input.ts). The touch events never reach
 *     the SVG, so input.ts's own swipe does not step a second time.
 *   - While the pen touches or hovers (and PEN_GRACE_MS after), touch is
 *     ignored: a palm resting on the screen neither zooms, pans nor turns
 *     the page. Touches that start then stay ignored until lifted, and a
 *     pinch or pan running when the pen comes is ended. The pen's up is
 *     also seen outside the stage (lifted over the toolbar), and a window
 *     blur ends it, so touch is not ignored for good.
 *   - Ctrl + wheel (also a touchpad pinch in Chromium) zooms at the pointer;
 *     a plain wheel (touchpad two-finger scroll) pans or scrolls the page;
 *     neither while the pen is down or a stroke is being drawn.
 */
import { swipeDirection } from '@inkslide/annotate/input';

/** What the gestures read from and do to the viewer. */
export interface GestureHost {
  /** Drop a stroke a finger started (a pinch is starting). */
  discardStroke(): void;
  /** The view transform changed (zoom, tx, ty in CSS px). */
  setView(zoom: number, tx: number, ty: number, done: boolean): void;
  view(): { zoom: number; tx: number; ty: number };
  /** The unzoomed page can move (fit width, page taller than the stage): the wheel scrolls it. */
  scrolls(): boolean;
  /** A stroke (or other tool gesture) is running: the page must not move under it. */
  drawing(): boolean;
  /** Page box in client coordinates (untransformed). */
  pageRect(): DOMRect | null;
  step(dir: -1 | 1): void;
}

/** Largest pinch / Ctrl + wheel zoom. */
export const MAX_ZOOM = 6;
const ZOOMED = 1.02; // above this the page counts as zoomed (the wheel pans, swipes pan)
/** Change of the two fingers' spread (ratio) before a pinch zooms. */
export const PINCH_SLOP = 0.08;
/** Touch stays ignored this long after the pen's last event (lifting the hand). */
export const PEN_GRACE_MS = 500;

interface Pt { x: number; y: number }

/** Install the gestures on `stage`; returns a function that removes them. */
export function attachGestures(stage: HTMLElement, host: GestureHost): () => void {
  const touches = new Map<number, Pt>();
  let pinch: {
    d0: number; m0: Pt; zoom0: number; tx0: number; ty0: number; t0: number;
    zoomed: boolean; last: Pt; maxScale: number;
    /** Spread the zoom is measured from; null until the spread passed PINCH_SLOP. */
    dz: number | null;
  } | null = null;
  const pensDown = new Set<number>();
  let penLast = -Infinity; // timeStamp of the pen's last event
  const ignored = new Set<number>(); // touches that started while the pen was busy

  const penBusy = (t: number): boolean => pensDown.size > 0 || t - penLast < PEN_GRACE_MS;

  /** The pen arrived: end a running pinch or pan where it is. */
  function stopGestures(): void {
    if (!pinch) return;
    pinch = null;
    touches.forEach((_p, id) => ignored.add(id));
    touches.clear();
    const v = host.view();
    host.setView(v.zoom, v.tx, v.ty, true);
  }

  function onPen(e: PointerEvent): void {
    penLast = e.timeStamp;
    if (e.type === 'pointerdown') pensDown.add(e.pointerId);
    else if (e.type === 'pointerup' || e.type === 'pointercancel') pensDown.delete(e.pointerId);
    stopGestures();
  }

  /** A pen lifted anywhere (window, capture): the stage may not see that up. */
  function onWindowPenUp(e: PointerEvent): void {
    if (e.pointerType === 'pen' && pensDown.has(e.pointerId)) onPen(e);
  }
  /** Window lost focus: an up may never come. The grace time starts now. */
  function onBlur(e: Event): void {
    if (!pensDown.size) return;
    pensDown.clear();
    penLast = e.timeStamp;
  }

  const mid = (): Pt => {
    const [a, b] = [...touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const spread = (): number => {
    const [a, b] = [...touches.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  };

  function startPinch(t: number): void {
    const v = host.view();
    pinch = { d0: spread(), m0: mid(), zoom0: v.zoom, tx0: v.tx, ty0: v.ty, t0: t, zoomed: v.zoom > ZOOMED, last: mid(), maxScale: 1, dz: null };
  }

  function onDown(e: PointerEvent): void {
    if (e.pointerType === 'pen') return onPen(e);
    if (e.pointerType !== 'touch') return;
    if (ignored.has(e.pointerId) || penBusy(e.timeStamp)) {
      ignored.add(e.pointerId);
      e.stopPropagation();
      return;
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      host.discardStroke();
      e.stopPropagation(); // the second finger never starts a stroke
      startPinch(e.timeStamp);
    } else if (touches.size > 2) {
      e.stopPropagation();
      pinch = null;
    }
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerType === 'pen') return onPen(e);
    if (ignored.has(e.pointerId)) return e.stopPropagation();
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = host.pageRect();
    if (pinch && touches.size === 2 && rect) {
      const m = mid();
      pinch.last = m;
      const d = spread(), raw = d / pinch.d0;
      pinch.maxScale = Math.max(pinch.maxScale, raw, 1 / raw);
      // Zoom from where the spread passed the slop: no jump when it starts.
      if (pinch.dz === null && Math.abs(Math.log(raw)) > Math.log(1 + PINCH_SLOP)) pinch.dz = d;
      const scale = pinch.dz === null ? 1 : d / pinch.dz;
      const zoom = Math.min(MAX_ZOOM, Math.max(1, pinch.zoom0 * scale));
      // Keep the page point under the starting midpoint under the fingers.
      const px = (pinch.m0.x - rect.left - pinch.tx0) / pinch.zoom0;
      const py = (pinch.m0.y - rect.top - pinch.ty0) / pinch.zoom0;
      host.setView(zoom, m.x - rect.left - px * zoom, m.y - rect.top - py * zoom, false);
    }
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerType === 'pen') return onPen(e);
    if (ignored.delete(e.pointerId)) return e.stopPropagation();
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    if (pinch && touches.size < 2) {
      const p = pinch;
      pinch = null;
      const v = host.view();
      // A swipe: fast, sideways, no zoom involved (neither before nor during).
      const dir = e.type === 'pointercancel' || p.zoomed || p.maxScale > 1.15 ? 0
        : swipeDirection(p.last.x - p.m0.x, p.last.y - p.m0.y, e.timeStamp - p.t0);
      if (dir) host.step(dir);
      else host.setView(v.zoom, v.tx, v.ty, true);
    }
  }

  // Touch events: keep them from input.ts's swipe on the SVG (see above).
  const swallow = (e: TouchEvent): void => { e.stopPropagation(); };

  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  function onWheel(e: WheelEvent): void {
    const v = host.view();
    if (!e.ctrlKey && v.zoom <= ZOOMED && !host.scrolls()) return; // nothing to move: leave the wheel alone
    const rect = e.ctrlKey ? host.pageRect() : null; // only zoom needs it (a layout read)
    if (e.ctrlKey && !rect) return;
    e.preventDefault(); // Ctrl + wheel: never the browser's page zoom
    if (pensDown.size || host.drawing()) return; // the page must not move under a stroke being written
    if (!rect) {
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stage.clientHeight : 1;
      host.setView(v.zoom, v.tx - e.deltaX * unit, v.ty - e.deltaY * unit, false);
    } else {
      const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom * Math.exp(-e.deltaY / 200)));
      const px = (e.clientX - rect.left - v.tx) / v.zoom, py = (e.clientY - rect.top - v.ty) / v.zoom;
      host.setView(zoom, e.clientX - rect.left - px * zoom, e.clientY - rect.top - py * zoom, false);
    }
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      const w = host.view();
      host.setView(w.zoom, w.tx, w.ty, true);
    }, 200);
  }

  const opts = { capture: true } as const;
  stage.addEventListener('pointerdown', onDown, opts);
  stage.addEventListener('pointermove', onMove, opts);
  stage.addEventListener('pointerup', onUp, opts);
  stage.addEventListener('pointercancel', onUp, opts);
  for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) stage.addEventListener(t, swallow, opts);
  stage.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('pointerup', onWindowPenUp, opts);
  window.addEventListener('pointercancel', onWindowPenUp, opts);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('pointerup', onWindowPenUp, opts);
    window.removeEventListener('pointercancel', onWindowPenUp, opts);
    window.removeEventListener('blur', onBlur);
    stage.removeEventListener('pointerdown', onDown, opts);
    stage.removeEventListener('pointermove', onMove, opts);
    stage.removeEventListener('pointerup', onUp, opts);
    stage.removeEventListener('pointercancel', onUp, opts);
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) stage.removeEventListener(t, swallow, opts);
    stage.removeEventListener('wheel', onWheel);
  };
}
