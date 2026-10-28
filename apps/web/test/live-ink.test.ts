// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stroke } from '@inkslide/annotate/geometry';
import type { Layer } from '@inkslide/annotate/render';

// Page coordinates are the client coordinates (the real mapping needs a laid-out SVG).
vi.mock('@inkslide/annotate/input', () => ({
  screenToPage: () => (e: { clientX: number; clientY: number }) => [e.clientX, e.clientY, 0.5],
}));

const { createLiveInk } = await import('../src/live-ink');

/** A canvas whose 2D context counts the strokes drawn (fill: pen, stroke: highlighter). */
function fakeCanvas() {
  const drawn = { fills: 0, strokes: 0 };
  const ctx = {
    setTransform() {}, clearRect() {},
    fill() { drawn.fills++; },
    stroke() { drawn.strokes++; },
  };
  const canvas = { width: 100, height: 100, classList: { toggle() {} }, getContext: () => ctx };
  return { canvas: canvas as unknown as HTMLCanvasElement, drawn };
}

const layer = { size: [100, 100], svg: document.createElementNS('http://www.w3.org/2000/svg', 'svg') } as unknown as Layer;
const stroke = (color = '#000000'): Stroke => ({ id: 'live', tool: 'pen', color, size: 3, points: [[10, 10, 0.5]] });

afterEach(() => vi.unstubAllGlobals());

describe('live ink', () => {
  it('draws each pointer move once: the tool\'s per-frame update does not draw the same stroke again', () => {
    vi.stubGlobal('Path2D', class {});
    const events = document.createElement('div');
    const { canvas, drawn } = fakeCanvas();
    const ink = createLiveInk(canvas, events);
    const pen = { pointerId: 7, pointerType: 'pen', bubbles: true };
    events.dispatchEvent(new PointerEvent('pointerdown', { ...pen, clientX: 10, clientY: 10 }));
    const live = ink.renderer.liveStroke(layer, 'pen');
    live.update(stroke());
    expect(drawn.fills).toBe(1);
    // A long stroke: each move draws once, and the tool's update after it adds nothing.
    for (let i = 1; i <= 200; i++) {
      events.dispatchEvent(new PointerEvent('pointermove', { ...pen, clientX: 10 + i, clientY: 10 + i / 2 }));
      live.update(stroke());
    }
    expect(drawn.fills).toBe(201);
    // A new color does need a redraw.
    live.update(stroke('#ff0000'));
    expect(drawn.fills).toBe(202);
    live.remove();
    ink.destroy();
  });

  it('without pointer events, the tool\'s points are drawn on each update', () => {
    vi.stubGlobal('Path2D', class {});
    const { canvas, drawn } = fakeCanvas();
    const ink = createLiveInk(canvas, document.createElement('div'));
    const live = ink.renderer.liveStroke(layer, 'highlighter'); // no pointerdown seen
    live.update({ ...stroke(), tool: 'highlighter' });
    live.update({ ...stroke(), tool: 'highlighter', points: [[10, 10, 0.5], [20, 20, 0.5]] });
    expect(drawn.strokes).toBe(2);
    ink.destroy();
  });
});
