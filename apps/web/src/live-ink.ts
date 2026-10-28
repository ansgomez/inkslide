/* Inkslide web - low-latency live stroke on a desynchronized canvas
 *
 * The pen and highlighter tools draw their stroke in progress through
 * ToolRenderer.liveStroke(). This module replaces that SVG path with a 2D
 * canvas over the page (pointer-events: none) created with
 * { desynchronized: true }, so Chromium can show it without waiting for the
 * compositor. Points come straight from the pointer events (coalesced ones,
 * plus the predicted ones drawn ahead of the pen), and the canvas is redrawn
 * in the event handler, not once per frame; the tool's own once-per-frame
 * update() then redraws only what the pointer events did not (a new color or
 * size, or the tool's points when no pointer events came). A redraw still
 * goes over the whole stroke (its outline is not cut into pieces: joins
 * would show). On pen up the tool removes the live stroke and adds the real
 * one to the document, which syncs the SVG in the same task, so nothing
 * flickers.
 */
import { centerlinePath, outlinePath, smoothPoints, strokeOutline, type Point, type Stroke, type StrokeTool } from '@inkslide/annotate/geometry';
import { screenToPage } from '@inkslide/annotate/input';
import * as render from '@inkslide/annotate/render';
import type { Layer } from '@inkslide/annotate/render';
import type { ToolRenderer } from '@inkslide/annotate/tools';

interface Session {
  layer: Layer;
  tool: StrokeTool;
  pointerId: number | null;
  raw: Point[];
  predicted: Point[];
  straight: boolean;
  style: Pick<Stroke, 'color' | 'size'> | null;
  /** Smoothed points from the tool (fallback when no pointer events were seen). */
  toolPoints: readonly Point[];
  /** The canvas shows the points as they are (nothing changed since the last draw). */
  drawn: boolean;
}

/** The live stroke canvas of the viewer. */
export interface LiveInk {
  /** The tool renderer: render.ts with liveStroke() drawing on the canvas. */
  renderer: ToolRenderer;
  /** Size the canvas backing store to its CSS box × factor (dpr × zoom). */
  resize(cssWidth: number, cssHeight: number, factor: number): void;
  readonly drawing: boolean;
  destroy(): void;
}

/** Live ink on `canvas`, fed by the pointer events on `events` (the page box). */
export function createLiveInk(canvas: HTMLCanvasElement, events: HTMLElement): LiveInk {
  const ctx = (canvas.getContext('2d', { desynchronized: true, alpha: true }) ||
    canvas.getContext('2d')) as CanvasRenderingContext2D;
  let session: Session | null = null;
  let pendingDown: { pointerId: number; pt: Point | null; shift: boolean } | null = null;


  function clear(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function draw(): void {
    const s = session;
    if (!s || !s.style) return;
    let pts: Point[];
    if (s.raw.length) {
      const all = s.predicted.length ? s.raw.concat(s.predicted) : s.raw;
      pts = s.straight ? [all[0], all[all.length - 1]] : smoothPoints(all);
    } else {
      pts = s.toolPoints.slice();
    }
    if (!pts.length) return;
    s.drawn = true;
    clear();
    const k = canvas.width / s.layer.size[0];
    ctx.setTransform(k, 0, 0, k, 0, 0);
    if (s.tool === 'pen') {
      ctx.fillStyle = s.style.color;
      ctx.fill(new Path2D(outlinePath(strokeOutline(pts, s.style.size))));
    } else {
      ctx.strokeStyle = s.style.color;
      ctx.lineWidth = s.style.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const d = pts.length === 1 ? `M${pts[0][0]} ${pts[0][1]}l0.01 0` : centerlinePath(pts);
      ctx.stroke(new Path2D(d));
    }
  }

  // Capture phase on the page box: runs before input.ts's handlers on the
  // SVG (they stop propagation), so the down is known when the tool starts.
  const onDown = (e: PointerEvent): void => {
    pendingDown = { pointerId: e.pointerId, pt: null, shift: e.shiftKey };
  };
  const onMove = (e: PointerEvent): void => {
    const s = session;
    if (!s || s.pointerId !== e.pointerId) return;
    const toPage = screenToPage(s.layer.svg);
    if (!toPage) return;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of list.length ? list : [e]) {
      const pt = toPage(ev);
      if (pt) s.raw.push(pt);
    }
    s.predicted = [];
    const pred = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];
    for (const ev of pred) {
      const pt = toPage(ev);
      if (pt) s.predicted.push(pt);
    }
    s.straight = e.shiftKey;
    s.drawn = false;
    draw();
  };
  events.addEventListener('pointerdown', onDown, true);
  events.addEventListener('pointermove', onMove, true);

  function begin(layer: Layer, tool: StrokeTool): { update(stroke: Stroke): void; remove(): void } {
    const down = pendingDown;
    pendingDown = null;
    const s: Session = {
      layer, tool, pointerId: down ? down.pointerId : null, raw: [], predicted: [],
      straight: !!(down && down.shift), style: null, toolPoints: [], drawn: false,
    };
    session = s;
    canvas.classList.toggle('is-hl', tool === 'highlighter');
    return {
      update(stroke) {
        if (session !== s) return;
        const was = s.style;
        s.style = { color: stroke.color, size: stroke.size };
        if (!was || was.color !== stroke.color || was.size !== stroke.size) s.drawn = false;
        s.toolPoints = stroke.points;
        // The tool's first point is the pointerdown position (not in the raw list yet).
        if (!s.raw.length && s.pointerId !== null && stroke.points[0]) s.raw.push(stroke.points[0].slice() as Point);
        // The pointer events drew their points already: no second redraw of the same stroke.
        if (!s.raw.length || !s.drawn) draw();
      },
      remove() {
        if (session !== s) return;
        session = null;
        clear();
      },
    };
  }

  return {
    renderer: { ...render, liveStroke: begin },
    resize(w, h, factor) {
      const pw = Math.max(1, Math.round(w * factor)), ph = Math.max(1, Math.round(h * factor));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
        draw();
      }
    },
    get drawing() { return !!session; },
    destroy() {
      events.removeEventListener('pointerdown', onDown, true);
      events.removeEventListener('pointermove', onMove, true);
    },
  };
}
