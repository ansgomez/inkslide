// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { attachInput, penButton, pressureOf, swipeDirection, type InputHost } from '../src/input';
import type { Surface, Tool } from '../src/tools';
import type { Layer } from '../src/render';

describe('pure helpers', () => {
  it('pressure only for pens', () => {
    expect(pressureOf({ pointerType: 'mouse', pressure: 0.9 })).toBe(0.5);
    expect(pressureOf({ pointerType: 'pen', pressure: 0.9 })).toBe(0.9);
    expect(pressureOf({ pointerType: 'pen', pressure: 0 })).toBe(0.5);
  });

  it('pen buttons: 32 is the eraser end, 2 and 4 the side button', () => {
    expect(penButton({ pointerType: 'pen', buttons: 1 })).toBeNull();
    expect(penButton({ pointerType: 'pen', buttons: 32 })).toBe('eraser');
    expect(penButton({ pointerType: 'pen', buttons: 33 })).toBe('eraser');
    expect(penButton({ pointerType: 'pen', buttons: 2 })).toBe('side');  // Electron
    expect(penButton({ pointerType: 'pen', buttons: 3 })).toBe('side');  // Electron, writing
    expect(penButton({ pointerType: 'pen', buttons: 4 })).toBe('side');  // Chromium / CEF
    expect(penButton({ pointerType: 'pen', buttons: 5 })).toBe('side');
    expect(penButton({ pointerType: 'mouse', buttons: 2 })).toBeNull();  // right mouse button
  });

  it('swipeDirection', () => {
    expect(swipeDirection(-100, 10, 200)).toBe(1);
    expect(swipeDirection(100, 10, 200)).toBe(-1);
    expect(swipeDirection(50, 0, 200)).toBe(0);    // too short
    expect(swipeDirection(100, 60, 200)).toBe(0);  // not horizontal
    expect(swipeDirection(100, 0, 900)).toBe(0);   // too slow
  });
});

describe('attachInput', () => {
  function setup() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    document.body.appendChild(svg);
    // identity screen transform: client px = page units
    (svg as unknown as { getScreenCTM(): DOMMatrix }).getScreenCTM = () => new DOMMatrix();
    svg.setPointerCapture = () => {};
    svg.releasePointerCapture = () => {};
    const surface: Surface = { pageId: 'p1', svg, layer: {} as Layer };
    const mkTool = (id: Tool['id']) => ({
      id, down: vi.fn(), move: vi.fn(), up: vi.fn(), cancel: vi.fn(), hover: vi.fn(), leave: vi.fn(),
    });
    const pen = mkTool('pen'), eraser = mkTool('eraser'), selector = mkTool('selector');
    const host: InputHost = { enabled: true, tools: { eraser }, currentTool: () => pen };
    const input = attachInput(host, [surface]);
    const fire = (type: string, init: PointerEventInit) =>
      svg.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 10, clientY: 20, ...init }));
    return { svg, surface, host, input, fire, pen, eraser, selector };
  }

  it('routes a pen gesture with page coordinates and pressure', () => {
    const { fire, pen, surface, input } = setup();
    fire('pointerdown', { pointerType: 'pen', pressure: 0.7, buttons: 1 });
    expect(input.busy).toBe(true);
    fire('pointermove', { pointerType: 'pen', pressure: 0.8, clientX: 30, buttons: 1 });
    fire('pointerup', { pointerType: 'pen', pressure: 0 });
    expect(pen.down.mock.calls[0].slice(0, 2)).toEqual([surface, [10, 20, 0.7]]);
    expect(pen.move.mock.calls[0][1]).toEqual([30, 20, 0.8]);
    expect(pen.up).toHaveBeenCalledTimes(1);
    expect(input.busy).toBe(false);
    expect(input.penSeen).toBe(true);
  });

  it('uses the eraser for the eraser end and the side button', () => {
    const { fire, eraser, pen } = setup();
    fire('pointerdown', { pointerType: 'pen', buttons: 32 });
    fire('pointerup', { pointerType: 'pen' });
    fire('pointerdown', { pointerType: 'pen', buttons: 3 });
    fire('pointerup', { pointerType: 'pen' });
    expect(eraser.down).toHaveBeenCalledTimes(2);
    expect(pen.down).not.toHaveBeenCalled();
  });

  it('side button tool is configurable', () => {
    const { fire, host, selector, eraser } = setup();
    host.sideButtonTool = () => selector;
    fire('pointerdown', { pointerType: 'pen', buttons: 5 });
    expect(selector.down).toHaveBeenCalled();
    expect(eraser.down).not.toHaveBeenCalled();
  });

  it('rejects touch once a pen was seen, and a pen replaces a palm', () => {
    const { fire, pen } = setup();
    fire('pointerdown', { pointerType: 'touch', pointerId: 5 });
    expect(pen.down).toHaveBeenCalledTimes(1); // touch draws before any pen
    fire('pointerdown', { pointerType: 'pen', pointerId: 6, buttons: 1 });
    expect(pen.cancel).toHaveBeenCalledTimes(1); // palm stroke dropped
    expect(pen.down).toHaveBeenCalledTimes(2);
    fire('pointerup', { pointerType: 'pen', pointerId: 6 });
    fire('pointerdown', { pointerType: 'touch', pointerId: 7 });
    expect(pen.down).toHaveBeenCalledTimes(2);
  });

  it('tells the pointer type of the running gesture', () => {
    const { fire, input } = setup();
    expect(input.activePointerType).toBeNull();
    fire('pointerdown', { pointerType: 'touch', pointerId: 5 });
    expect(input.activePointerType).toBe('touch');
    input.discard();
    expect(input.activePointerType).toBeNull();
  });

  it('a pen starting to hover drops a running finger stroke (it was a palm)', () => {
    const { fire, input, pen } = setup();
    fire('pointerdown', { pointerType: 'touch', pointerId: 5 });
    fire('pointermove', { pointerType: 'pen', pointerId: 6 });
    expect(input.penSeen).toBe(true);
    expect(input.busy).toBe(false);
    expect(pen.cancel).toHaveBeenCalledTimes(1);
    fire('pointerup', { pointerType: 'touch', pointerId: 5 });
    expect(pen.up).not.toHaveBeenCalled();
  });

  it('a second finger drops the first finger\'s stroke and draws nothing', () => {
    const { fire, input, pen } = setup();
    fire('pointerdown', { pointerType: 'touch', pointerId: 5 });
    fire('pointerdown', { pointerType: 'touch', pointerId: 6 });
    expect(pen.cancel).toHaveBeenCalledTimes(1);
    expect(pen.up).not.toHaveBeenCalled();
    expect(pen.down).toHaveBeenCalledTimes(1);
    expect(input.busy).toBe(false);
    // a mouse gesture that lost its pointerup is still committed by the next one
    fire('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 7 });
    fire('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 8 });
    expect(pen.up).toHaveBeenCalledTimes(1);
    expect(pen.down).toHaveBeenCalledTimes(3);
  });

  describe('two-finger swipe', () => {
    const touch = (svg: SVGSVGElement, type: string, xs: number[], timeStamp: number) => {
      const touches = xs.map((x, i) => ({ identifier: i, clientX: x, clientY: 100, target: svg }));
      const e = new TouchEvent(type, { bubbles: true, touches: touches as unknown as Touch[] });
      Object.defineProperty(e, 'timeStamp', { value: timeStamp });
      svg.dispatchEvent(e);
    };
    const swipeLeft = (svg: SVGSVGElement, t0: number) => {
      touch(svg, 'touchstart', [300, 340], t0);
      touch(svg, 'touchmove', [150, 190], t0 + 100);
      touch(svg, 'touchend', [], t0 + 200);
    };
    function withPages() {
      const ctx = setup();
      const step = vi.fn();
      ctx.host.pages = { step };
      ctx.fire('pointerdown', { pointerType: 'pen', pointerId: 2, buttons: 1 });
      return { ...ctx, step, penAt: performance.now() };
    }

    it('turns the page once the pen has been away for a moment', () => {
      const { svg, step, fire, penAt } = withPages();
      fire('pointerup', { pointerType: 'pen', pointerId: 2 });
      swipeLeft(svg, penAt + 2000);
      expect(step).toHaveBeenCalledWith(1);
    });

    it('not while a stroke is being written, nor right after a pen event', () => {
      const { svg, step, fire, penAt } = withPages();
      swipeLeft(svg, penAt + 2000); // the pen is still down
      fire('pointerup', { pointerType: 'pen', pointerId: 2 });
      swipeLeft(svg, performance.now()); // the hand lifts with the pen
      expect(step).not.toHaveBeenCalled();
    });
  });

  it('hover goes to the current tool; disabled mode ignores input', () => {
    const { fire, pen, host } = setup();
    fire('pointermove', { pointerType: 'mouse' });
    expect(pen.hover).toHaveBeenCalledTimes(1);
    host.enabled = false;
    fire('pointerdown', { pointerType: 'mouse', button: 0 });
    expect(pen.down).not.toHaveBeenCalled();
  });

  it('a gesture with a pen-button tool ends with leave, so its cursor does not stay', () => {
    const { fire, eraser, pen } = setup();
    fire('pointerdown', { pointerType: 'pen', buttons: 32 });
    fire('pointerup', { pointerType: 'pen' });
    expect(eraser.leave).toHaveBeenCalledTimes(1);
    fire('pointerdown', { pointerType: 'pen', buttons: 1 });
    fire('pointerup', { pointerType: 'pen' });
    expect(pen.leave).not.toHaveBeenCalled(); // the current tool keeps hovering
  });

  it('a gesture stays on the surface it started on', () => {
    const { fire, pen, surface, input } = setup();
    const other = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    document.body.appendChild(other);
    (other as unknown as { getScreenCTM(): DOMMatrix }).getScreenCTM = () => new DOMMatrix().translate(100, 0);
    input.attach({ pageId: 'p2', svg: other, layer: {} as Layer });
    fire('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 9 });
    // Without pointer capture the move and up reach the other surface.
    const at = (type: string) => other.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 9, pointerType: 'mouse', clientX: 40, clientY: 20,
    }));
    at('pointermove');
    at('pointerup');
    expect(pen.move.mock.calls.at(-1)!.slice(0, 2)).toEqual([surface, [40, 20, 0.5]]);
    expect(pen.up.mock.calls.at(-1)!.slice(0, 2)).toEqual([surface, [40, 20, 0.5]]);
  });

  it('destroy drops the running gesture and removes the surface listeners', () => {
    const { fire, pen, input } = setup();
    fire('pointerdown', { pointerType: 'mouse', button: 0 });
    input.destroy();
    expect(pen.cancel).toHaveBeenCalledTimes(1);
    expect(pen.up).not.toHaveBeenCalled();
    expect(input.busy).toBe(false);
    fire('pointerup', { pointerType: 'mouse' });
    fire('pointerdown', { pointerType: 'mouse', button: 0 });
    fire('pointermove', { pointerType: 'mouse' });
    expect(pen.down).toHaveBeenCalledTimes(1);
    expect(pen.hover).not.toHaveBeenCalled();
  });

  it('cancel commits, discard drops the running gesture', () => {
    const { fire, pen, input } = setup();
    fire('pointerdown', { pointerType: 'mouse', button: 0 });
    input.cancel();
    expect(pen.up).toHaveBeenCalledTimes(1);
    fire('pointerdown', { pointerType: 'mouse', button: 0 });
    input.discard();
    expect(pen.cancel).toHaveBeenCalledTimes(1);
  });
});
