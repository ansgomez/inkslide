/* Inkslide annotate - pointer input: coordinate mapping and palm rejection
 *
 * Ported from Marp Notes input.js (© Andres Gomez, MIT).
 * Routes pointer events on a page's annotation surface to the active tool as
 * down / move / up / cancel / hover / leave calls with page coordinates.
 */
import type { Point } from './geometry';
import type { Surface, Tool } from './tools';

/** Pressure only for real pens; mouse and touch draw at constant width. */
export function pressureOf(e: Pick<PointerEvent, 'pointerType' | 'pressure'>): number {
  if (e.pointerType !== 'pen') return 0.5;
  return e.pressure > 0 ? e.pressure : 0.5;
}

/** Client (screen) coordinates -> page viewBox coordinates. */
export function toSlidePoint(svg: SVGGraphicsElement, e: PointerEvent): Point | null {
  const toPage = screenToPage(svg);
  return toPage && toPage(e);
}

/**
 * Mapper from pointer events to page coordinates for the SVG's current
 * screen position; null if the SVG is not rendered. Reuse it for the
 * coalesced events of one pointermove (one layout read instead of one each).
 */
export function screenToPage(svg: SVGGraphicsElement): ((e: PointerEvent) => Point | null) | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const inv = ctm.inverse();
  return e => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv);
    return Number.isFinite(p.x) && Number.isFinite(p.y) ? [p.x, p.y, pressureOf(e)] : null;
  };
}

/** Button mask of the pen's eraser end (or barrel eraser button). */
export const ERASER_BUTTON = 32;
/** Pen side (barrel) button: mask 4 in Chromium/CEF, mask 2 in Electron. Both count. */
export const SIDE_BUTTONS = 2 | 4;

/** Pen button held during a gesture (see penButton). */
export type PenButton = 'eraser' | 'side' | null;

/** Which pen button is held: the eraser end wins over the side button. */
export function penButton(e: Pick<PointerEvent, 'pointerType' | 'buttons'>): PenButton {
  if (e.pointerType !== 'pen') return null;
  if (e.buttons & ERASER_BUTTON) return 'eraser';
  if (e.buttons & SIDE_BUTTONS) return 'side';
  return null;
}

const midpoint = (t: TouchList): { x: number; y: number } =>
  ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

/**
 * Page step for a two-finger swipe moving (dx, dy) screen px in ms: 1 (to
 * the left: next), -1 (to the right: previous) or 0 when it is too short,
 * too slow or not clearly horizontal.
 */
export function swipeDirection(dx: number, dy: number, ms: number): -1 | 0 | 1 {
  if (Math.abs(dx) < 80 || Math.abs(dx) < 2 * Math.abs(dy) || ms > 700) return 0;
  return dx < 0 ? 1 : -1;
}

/** What the input router needs from the app. */
export interface InputHost {
  /** Annotate mode on; when off, events pass through. */
  enabled: boolean;
  tools: { eraser: Tool };
  currentTool(): Tool;
  /** Tool while the pen's side button is held; default: the stroke eraser. null: no change. */
  sideButtonTool?(): Tool | null;
  /** Two-finger swipe target. */
  pages?: { step(dir: -1 | 1): void } | null;
}

/** Pointer routing for the surfaces of one app (see attachInput). */
export interface InputController {
  /** Route events of one more surface. */
  attach(surface: Surface): void;
  /** Commit the running gesture (if any). */
  cancel(): void;
  /** Drop the running gesture (if any). */
  discard(): void;
  /** Remove the window listeners (surfaces keep theirs until removed). */
  destroy(): void;
  readonly busy: boolean;
  /** Pointer type ("pen", "touch", "mouse") of the running gesture; null if none. */
  readonly activePointerType: string | null;
  readonly penSeen: boolean;
}

type Method = 'down' | 'move' | 'up' | 'cancel' | 'hover' | 'leave';

/**
 * Tools implement any of down/move/up/cancel/hover/leave(surface, pt, e).
 */
export function attachInput(app: InputHost, surfaces: Iterable<Surface> = []): InputController {
  let penSeen = false;
  let active: { pointerId: number; pointerType: string; tool: Tool; slide: Surface } | null = null;

  /**
   * Call a tool handler. A handler that throws is logged, never rethrown: a
   * failing down, move or up drops the gesture and cancels the tool, so
   * neither the input nor the tool stays stuck in it, and callers of
   * cancel() (page turn, undo, blur) are not interrupted.
   */
  function call(tool: Tool | null | undefined, method: Method, slide: Surface, pt: Point | null, e: Event | null): void {
    const fn = tool && tool[method] as ((s: Surface, p: Point | null, e: Event | null) => void) | undefined;
    if (typeof fn !== 'function') return;
    try {
      fn.call(tool, slide, pt, e);
    } catch (err) {
      console.error(`Inkslide: the ${tool!.id} tool failed (${method})`, err);
      if (method === 'hover' || method === 'leave' || method === 'cancel') return;
      if (active && active.tool === tool) {
        const { pointerId } = active;
        active = null;
        try { slide.svg.releasePointerCapture(pointerId); } catch (_) { /* gone */ }
      }
      call(tool, 'cancel', slide, null, null);
    }
  }

  /**
   * End the running gesture. By default it is committed (as if the pointer
   * went up), so nothing written is lost on page changes, undo, blur or a
   * cancelled pointer; discard=true drops it (a palm replaced by the pen).
   */
  function finish(discard = false): void {
    if (!active) return;
    const { tool, slide, pointerId } = active;
    active = null;
    try { slide.svg.releasePointerCapture(pointerId); } catch (_) { /* gone */ }
    end(tool, discard ? 'cancel' : 'up', slide, null, null);
  }

  /** End a gesture; a pen-button tool (not the current one) also gets leave, as hovers go elsewhere now. */
  function end(tool: Tool, method: 'up' | 'cancel', slide: Surface, pt: Point | null, e: Event | null): void {
    call(tool, method, slide, pt, e);
    if (tool !== app.currentTool()) call(tool, 'leave', slide, null, e);
  }

  /** Tool for a new gesture: pen eraser end, pen side button, else the current tool. */
  function toolFor(e: PointerEvent): Tool {
    const button = penButton(e);
    if (button === 'eraser') return app.tools.eraser;
    if (button === 'side') {
      const t = app.sideButtonTool ? app.sideButtonTool() : app.tools.eraser;
      if (t) return t;
    }
    return app.currentTool();
  }

  function onDown(slide: Surface, e: PointerEvent): void {
    if (!app.enabled) return;
    e.stopPropagation();
    if (e.pointerType === 'pen') penSeen = true;
    // Palm rejection: once a pen has been used, touch never draws.
    if (penSeen && e.pointerType === 'touch') { e.preventDefault(); return; }
    if (active) {
      if (e.pointerType === 'pen' && active.pointerType !== 'pen') finish(true); // palm replaced by pen
      else if (e.pointerType === active.pointerType) finish(); // stale gesture (lost its pointerup)
      else return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const pt = toSlidePoint(slide.svg, e);
    if (!pt) return;
    const tool = toolFor(e);
    active = { pointerId: e.pointerId, pointerType: e.pointerType, tool, slide };
    try { slide.svg.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
    call(tool, 'down', slide, pt, e);
  }

  // Move and up go to the surface the gesture started on, also if pointer capture failed.
  function onMove(slide: Surface, e: PointerEvent): void {
    if (e.pointerType === 'pen') penSeen = true; // a hovering pen counts: the palm may land first
    if (!app.enabled) return;
    if (active && active.pointerId === e.pointerId) {
      e.stopPropagation();
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const toPage = screenToPage(active.slide.svg);
      for (const ev of toPage ? (list.length ? list : [e]) : []) {
        const pt = toPage!(ev);
        if (pt) call(active.tool, 'move', active.slide, pt, e);
      }
    } else if (!active && e.pointerType !== 'touch') {
      const pt = toSlidePoint(slide.svg, e);
      if (pt) call(app.currentTool(), 'hover', slide, pt, e);
    }
  }

  function onUp(e: PointerEvent, cancelled: boolean): void {
    if (!active || active.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const { tool, slide } = active;
    active = null;
    // pointercancel still commits what was drawn so far.
    end(tool, 'up', slide, cancelled ? null : toSlidePoint(slide.svg, e), e);
  }

  const onBlur = (): void => finish();
  window.addEventListener('blur', onBlur);

  // Two-finger swipe changes the page, but only once a pen has been seen:
  // touch never draws then, and one finger (or a resting palm) never pages.
  let swipeStart: { mid: { x: number; y: number }; time: number; last?: { x: number; y: number } } | null = null;
  function swipe(e: TouchEvent): void {
    const t = e.touches;
    if (e.type === 'touchstart') {
      swipeStart = penSeen && t.length === 2 ? { mid: midpoint(t), time: e.timeStamp } : null;
    } else if (e.type === 'touchmove') {
      if (swipeStart && t.length === 2) swipeStart.last = midpoint(t);
      else if (t.length > 2) swipeStart = null;
    } else if (swipeStart && t.length === 0) {
      const { mid, last, time } = swipeStart;
      swipeStart = null;
      if (!last || e.type === 'touchcancel') return;
      const dir = swipeDirection(last.x - mid.x, last.y - mid.y, e.timeStamp - time);
      if (dir && app.pages) app.pages.step(dir);
    }
  }

  /** Route events of one surface (PDF page, blank page or slide) to the tools. */
  function attach(slide: Surface): void {
    const svg = slide.svg;
    svg.addEventListener('pointerdown', e => onDown(slide, e));
    svg.addEventListener('pointermove', e => onMove(slide, e));
    svg.addEventListener('pointerup', e => onUp(e, false));
    svg.addEventListener('pointercancel', e => onUp(e, true));
    svg.addEventListener('lostpointercapture', e => {
      if (active && active.pointerId === e.pointerId) finish();
    });
    svg.addEventListener('pointerover', e => { if (e.pointerType === 'pen') penSeen = true; });
    svg.addEventListener('pointerleave', e => {
      if (app.enabled && !active) call(app.currentTool(), 'leave', slide, null, e);
    });
    // Keep page-level touch navigation and context menus away while drawing.
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      svg.addEventListener(type, e => {
        if (!app.enabled) return;
        e.stopPropagation();
        swipe(e);
      });
    }
    svg.addEventListener('contextmenu', e => { if (app.enabled) e.preventDefault(); });
  }
  for (const s of surfaces) attach(s);

  return {
    attach,
    cancel: () => finish(),
    discard: () => finish(true),
    destroy: () => window.removeEventListener('blur', onBlur),
    get busy() { return !!active; },
    get activePointerType() { return active ? active.pointerType : null; },
    get penSeen() { return penSeen; },
  };
}
