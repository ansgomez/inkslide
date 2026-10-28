// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { attachGestures, PEN_GRACE_MS, type GestureHost } from '../src/gestures';

function setup(opts: { scrolls?: boolean; drawing?: boolean } = {}) {
  const stage = document.createElement('div');
  document.body.appendChild(stage);
  let view = { zoom: 1, tx: 0, ty: 0 };
  const host: GestureHost = {
    discardStroke: vi.fn(),
    setView: vi.fn((zoom, tx, ty) => { view = { zoom, tx, ty }; }),
    view: () => view,
    scrolls: () => !!opts.scrolls,
    drawing: () => !!opts.drawing,
    pageRect: () => new DOMRect(0, 0, 800, 600),
    step: vi.fn(),
  };
  attachGestures(stage, host);
  const fire = (type: string, pointerType: string, pointerId: number, x: number, y: number, timeStamp: number) => {
    const e = new PointerEvent(type, { bubbles: true, pointerType, pointerId, clientX: x, clientY: y });
    Object.defineProperty(e, 'timeStamp', { value: timeStamp });
    stage.dispatchEvent(e);
  };
  /** Two fingers spreading apart from x = 400. */
  const pinch = (t: number) => {
    fire('pointerdown', 'touch', 1, 380, 300, t);
    fire('pointerdown', 'touch', 2, 420, 300, t);
    fire('pointermove', 'touch', 2, 424, 300, t + 25); // past the slop: the zoom starts
    fire('pointermove', 'touch', 2, 520, 300, t + 50);
    fire('pointerup', 'touch', 1, 380, 300, t + 100);
    fire('pointerup', 'touch', 2, 520, 300, t + 100);
  };
  const wheel = (deltaY: number, init: WheelEventInit = {}) => {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...init });
    if (init.ctrlKey) Object.defineProperty(e, 'ctrlKey', { value: true }); // happy-dom drops it
    stage.dispatchEvent(e);
    return e;
  };
  return { host, fire, pinch, wheel, view: () => view };
}

describe('gestures', () => {
  it('two fingers zoom', () => {
    const g = setup();
    g.pinch(1000);
    expect(g.view().zoom).toBeGreaterThan(2);
  });

  it('ignore touch while the pen is down or just hovered', () => {
    const g = setup();
    g.fire('pointerdown', 'pen', 7, 100, 100, 1000);
    g.pinch(1010);
    expect(g.view().zoom).toBe(1);
    g.fire('pointerup', 'pen', 7, 100, 100, 1200);
    g.pinch(1300); // within the grace time
    expect(g.view().zoom).toBe(1);
    g.fire('pointermove', 'pen', 7, 100, 100, 2000); // hover
    g.pinch(2100);
    expect(g.view().zoom).toBe(1);
    g.pinch(2000 + PEN_GRACE_MS + 100);
    expect(g.view().zoom).toBeGreaterThan(2);
  });

  it('the pen ends a running pinch and the fingers stay ignored', () => {
    const g = setup();
    g.fire('pointerdown', 'touch', 1, 380, 300, 1000);
    g.fire('pointerdown', 'touch', 2, 420, 300, 1000);
    g.fire('pointermove', 'touch', 2, 424, 300, 1025);
    g.fire('pointermove', 'touch', 2, 460, 300, 1050);
    const zoom = g.view().zoom;
    expect(zoom).toBeGreaterThan(1);
    g.fire('pointerdown', 'pen', 7, 100, 100, 1100);
    g.fire('pointermove', 'touch', 2, 600, 300, 1150);
    expect(g.view().zoom).toBe(zoom);
    expect(g.host.setView).toHaveBeenLastCalledWith(zoom, expect.any(Number), expect.any(Number), true);
  });

  it('one finger never scrolls or pans, even zoomed', () => {
    const g = setup({ scrolls: true });
    g.fire('pointerdown', 'touch', 1, 400, 500, 1000);
    g.fire('pointermove', 'touch', 1, 400, 300, 1050);
    g.fire('pointerup', 'touch', 1, 400, 300, 1100);
    expect(g.host.setView).not.toHaveBeenCalled();
    g.pinch(2000);
    vi.mocked(g.host.setView).mockClear();
    g.fire('pointerdown', 'touch', 1, 400, 500, 3000);
    g.fire('pointermove', 'touch', 1, 300, 300, 3050);
    expect(g.host.setView).not.toHaveBeenCalled();
  });

  it('two fingers scroll without zooming while their spread stays within the slop', () => {
    const g = setup({ scrolls: true });
    g.fire('pointerdown', 'touch', 1, 380, 500, 1000);
    g.fire('pointerdown', 'touch', 2, 420, 500, 1000);
    g.fire('pointermove', 'touch', 1, 380, 400, 1050);
    g.fire('pointermove', 'touch', 2, 422, 400, 1100); // spread 40 to 42: 5 %
    g.fire('pointermove', 'touch', 1, 380, 300, 1150);
    g.fire('pointermove', 'touch', 2, 422, 300, 1200);
    expect(g.view()).toEqual({ zoom: 1, tx: 1, ty: -200 });
    g.fire('pointerup', 'touch', 1, 380, 400, 1300);
    expect(g.host.setView).toHaveBeenLastCalledWith(1, 1, -200, true);
    expect(g.host.step).not.toHaveBeenCalled();
  });

  it('a pinch zooms from where it passed the slop, without a jump', () => {
    const g = setup();
    g.fire('pointerdown', 'touch', 1, 380, 300, 1000);
    g.fire('pointerdown', 'touch', 2, 420, 300, 1000);
    g.fire('pointermove', 'touch', 2, 424, 300, 1050); // 44 / 40: zoom starts here
    expect(g.view().zoom).toBe(1);
    g.fire('pointermove', 'touch', 2, 468, 300, 1100); // 88 / 44
    expect(g.view().zoom).toBeCloseTo(2, 6);
  });

  it('the wheel scrolls (lines count 16 px), but not while the pen is down', () => {
    const g = setup({ scrolls: true });
    g.wheel(120);
    expect(g.view()).toEqual({ zoom: 1, tx: 0, ty: -120 });
    g.wheel(3, { deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(g.view().ty).toBe(-168);
    g.fire('pointerdown', 'pen', 7, 100, 100, 1000);
    g.wheel(100);
    expect(g.view().ty).toBe(-168);
  });

  it('ctrl + wheel zooms', () => {
    const g = setup();
    g.wheel(-200, { ctrlKey: true, clientX: 400, clientY: 300 });
    expect(g.view().zoom).toBeCloseTo(Math.E, 6);
  });

  it('ctrl + wheel (a touchpad pinch) does not zoom under a stroke being drawn, nor the browser page', () => {
    const drawing = setup({ drawing: true });
    expect(drawing.wheel(-200, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(drawing.host.setView).not.toHaveBeenCalled();
    const g = setup();
    g.fire('pointerdown', 'pen', 7, 100, 100, 1000);
    g.wheel(-200, { ctrlKey: true });
    expect(g.host.setView).not.toHaveBeenCalled();
  });

  it('a pen lifted outside the stage ends the pen-busy time', () => {
    const g = setup();
    g.fire('pointerdown', 'pen', 7, 100, 100, 1000);
    const up = new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen', pointerId: 7 });
    Object.defineProperty(up, 'timeStamp', { value: 1100 });
    document.body.dispatchEvent(up); // over the toolbar, not the stage
    g.pinch(1100 + PEN_GRACE_MS + 50);
    expect(g.view().zoom).toBeGreaterThan(2);
  });

  it('a window blur ends a pen that never came up', () => {
    const g = setup();
    g.fire('pointerdown', 'pen', 7, 100, 100, 1000);
    const blur = new Event('blur');
    Object.defineProperty(blur, 'timeStamp', { value: 1100 });
    window.dispatchEvent(blur);
    g.pinch(1100 + PEN_GRACE_MS + 50);
    expect(g.view().zoom).toBeGreaterThan(2);
  });

  it('the wheel leaves an unzoomed page fit alone and never moves a stroke being drawn', () => {
    const fitted = setup();
    fitted.wheel(120);
    expect(fitted.host.setView).not.toHaveBeenCalled();
    const drawing = setup({ scrolls: true, drawing: true });
    drawing.wheel(120);
    expect(drawing.host.setView).not.toHaveBeenCalled();
  });
});
