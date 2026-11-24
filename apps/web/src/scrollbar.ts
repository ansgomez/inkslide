/* Inkslide web - the page scrollbar: a slim handle at the stage's right edge
 *
 *   .ink-stage
 *     .ink-scroll            track, full stage height; takes no input itself
 *       .ink-scroll-thumb    the handle (a wider, invisible hit area around a slim bar)
 *
 * Shown only while the page is taller than the stage (fit width, or zoomed
 * in). Dragging the handle with one finger, the mouse or the pen scrolls the
 * page; a tap on the track elsewhere does nothing (the page under it can be
 * written on). gestures.ts leaves touches on the scrollbar alone, but its
 * palm rejection still applies: a touch while the pen is down or hovering
 * never reaches the handle. The handle does not move while a stroke runs.
 */

/** Smallest handle length, CSS px (a finger must be able to hold it). */
export const MIN_THUMB = 44;

/** Handle size and position on a track, CSS px. */
export interface ThumbBox {
  /** Handle length. */
  size: number;
  /** Handle start from the track's top. */
  offset: number;
  /** Track px the handle can travel (track - size). */
  travel: number;
}

/**
 * The handle for a scroll position: `ty` in [minTy, 0] (the view's
 * translate, 0 at the page's top), `visible` the stage height the page
 * shows, `content` the zoomed page height. null when nothing scrolls.
 */
export function thumbBox(ty: number, minTy: number, visible: number, content: number, track: number,
  minThumb = MIN_THUMB): ThumbBox | null {
  if (minTy > -0.5 || content <= visible || track <= 0) return null;
  const size = Math.min(track, Math.max(minThumb, track * visible / content));
  const travel = Math.max(0, track - size);
  const f = Math.min(1, Math.max(0, ty / minTy));
  return { size, offset: f * travel, travel };
}

/** ty after dragging the handle `dy` px from where it was at `ty0` (clamped to [minTy, 0]). */
export function dragScroll(ty0: number, dy: number, minTy: number, travel: number): number {
  if (travel <= 0) return ty0;
  return Math.min(0, Math.max(minTy, ty0 + dy * minTy / travel));
}

/** What the scrollbar reads from and does to the viewer. */
export interface ScrollbarHost {
  /** Current ty and its lower limit (0 at the top, minTy at the bottom). */
  scroll(): { ty: number; minTy: number };
  /** Scroll to ty; `done` false while the drag runs. */
  scrollTo(ty: number, done: boolean): void;
  /** A stroke (or other tool gesture) is running: the page must not move under it. */
  drawing(): boolean;
}

export interface Scrollbar {
  /** Show, hide and place the handle for the view (call when ty, zoom or the layout changed). */
  update(ty: number, minTy: number, visible: number, content: number): void;
}

/** A scrollbar in `stage`. */
export function createScrollbar(stage: HTMLElement, host: ScrollbarHost): Scrollbar {
  const track = document.createElement('div');
  track.className = 'ink-scroll';
  track.hidden = true;
  const thumb = document.createElement('div');
  thumb.className = 'ink-scroll-thumb';
  thumb.setAttribute('role', 'scrollbar');
  thumb.setAttribute('aria-orientation', 'vertical');
  thumb.setAttribute('aria-label', 'Scroll the page');
  track.appendChild(thumb);
  stage.appendChild(track);

  let box: ThumbBox | null = null;
  let drag: { id: number; y0: number; ty0: number; minTy: number; travel: number } | null = null;

  thumb.addEventListener('pointerdown', e => {
    if (drag || !box || host.drawing()) return;
    e.preventDefault();
    e.stopPropagation();
    const { ty, minTy } = host.scroll();
    drag = { id: e.pointerId, y0: e.clientY, ty0: ty, minTy, travel: box.travel };
    thumb.setPointerCapture?.(e.pointerId);
    track.classList.add('is-dragging');
  });
  thumb.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    host.scrollTo(dragScroll(drag.ty0, e.clientY - drag.y0, drag.minTy, drag.travel), false);
  });
  const end = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    track.classList.remove('is-dragging');
    host.scrollTo(e.type === 'pointercancel' ? host.scroll().ty : dragScroll(d.ty0, e.clientY - d.y0, d.minTy, d.travel), true);
  };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);
  thumb.addEventListener('lostpointercapture', e => { if (drag && e.pointerId === drag.id) end(e); });

  return {
    update(ty, minTy, visible, content) {
      box = thumbBox(ty, minTy, visible, content, track.clientHeight || stage.clientHeight);
      track.hidden = !box;
      if (!box) return;
      thumb.style.height = `${box.size}px`;
      thumb.style.transform = `translateY(${box.offset}px)`;
      thumb.setAttribute('aria-valuenow', String(Math.round(minTy ? 100 * ty / minTy : 0)));
    },
  };
}
