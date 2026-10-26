import { describe, expect, it } from 'vitest';
import {
  clampPan, fitTo, MAX_RENDER_PIXELS, pageScroll, renderScale, scaleKey, visibleBox,
} from '../src/fit';

describe("fitTo('page')", () => {
  it('fits a 16:9 page into a wider box by height and centres it', () => {
    const f = fitTo('page', [960, 540], { width: 2000, height: 540 });
    expect(f.scale).toBe(1);
    expect([f.width, f.height, f.left, f.top]).toEqual([960, 540, 520, 0]);
  });

  it('fits a portrait A4 page into a landscape window', () => {
    const f = fitTo('page', [595, 842], { width: 1280, height: 800 }, 6);
    expect(f.scale).toBeCloseTo(788 / 842, 6);
    expect(f.height).toBe(788);
    expect(f.top).toBe(6);
    expect(f.left).toBe(Math.round((1280 - f.width) / 2));
  });

  it('survives empty boxes and pages', () => {
    expect(fitTo('page', [0, 0], { width: 100, height: 100 }).scale).toBe(1);
    expect(fitTo('page', [100, 100], { width: 0, height: 0 }).width).toBeGreaterThanOrEqual(0);
  });
});

describe("fitTo('width')", () => {
  const stage = { width: 1280, height: 800 };

  it('fills the width with a portrait page and starts at its top', () => {
    const f = fitTo('width', [595, 842], stage, 6);
    expect(f.scale).toBeCloseTo(1268 / 595, 6);
    expect([f.width, f.left, f.top]).toEqual([1268, 6, 6]);
    expect(f.height).toBe(Math.round(842 * 1268 / 595));
    expect(f.height).toBeGreaterThan(stage.height);
  });

  it('centres a page that is shorter than the box', () => {
    const f = fitTo('width', [960, 540], stage, 6);
    expect(f.width).toBe(1268);
    expect(f.height).toBe(713);
    expect(f.top).toBe(Math.round((800 - 713) / 2));
  });

  it('renders sharper than the page fit (bigger scale)', () => {
    expect(fitTo('width', [595, 842], stage).scale).toBeGreaterThan(fitTo('page', [595, 842], stage).scale * 2);
  });

  it('survives empty boxes and pages', () => {
    expect(fitTo('width', [0, 0], { width: 100, height: 100 }).scale).toBe(1);
    expect(fitTo('width', [100, 100], { width: 0, height: 0 }).width).toBeGreaterThanOrEqual(0);
  });
});

describe('visibleBox', () => {
  it('is the whole page for a page fit', () => {
    const f = fitTo('page', [595, 842], { width: 1280, height: 800 }, 6);
    expect(visibleBox(f, { width: 1280, height: 800 }, 6)).toEqual({ width: f.width, height: f.height });
  });

  it('is one screenful of a tall page for a width fit', () => {
    const f = fitTo('width', [595, 842], { width: 1280, height: 800 }, 6);
    expect(visibleBox(f, { width: 1280, height: 800 }, 6)).toEqual({ width: 1268, height: 788 });
  });
});

describe('renderScale', () => {
  it('multiplies fit, device pixel ratio and zoom', () => {
    expect(renderScale([960, 540], 1.5, 2, 1)).toBe(3);
    expect(renderScale([960, 540], 1, 2, 2)).toBe(4);
  });

  it('never renders below 1 device pixel per CSS pixel', () => {
    expect(renderScale([960, 540], 1, 0.5, 0.5)).toBe(1);
  });

  it('caps the bitmap size', () => {
    const s = renderScale([960, 540], 4, 2, 4);
    expect(960 * s * 540 * s).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1);
    expect(960 * s * 540 * s).toBeGreaterThan(MAX_RENDER_PIXELS * 0.99);
  });

  it('rounds keys so resize jitter shares a bitmap', () => {
    expect(scaleKey(1.2341)).toBe(scaleKey(1.2349));
    expect(scaleKey(1.23)).not.toBe(scaleKey(1.25));
  });
});

describe('clampPan', () => {
  const box = { width: 100, height: 50 };
  it('keeps the unzoomed page in place', () => {
    expect(clampPan(20, -10, box, 1)).toEqual([0, 0]);
  });
  it('lets a zoomed page move only until its edge reaches the box edge', () => {
    expect(clampPan(-30, -10, box, 2)).toEqual([-30, -10]);
    expect(clampPan(-300, 40, box, 2)).toEqual([-100, 0]);
  });
  it('scrolls a tall page at zoom 1 until its bottom reaches the visible part', () => {
    const tall = { width: 100, height: 300 }, visible = { width: 100, height: 120 };
    expect(clampPan(10, -50, tall, 1, visible)).toEqual([0, -50]);
    expect(clampPan(0, -1000, tall, 1, visible)).toEqual([0, -180]);
    expect(clampPan(-1000, -1000, tall, 2, visible)).toEqual([-100, -480]);
  });
});

describe('pageScroll', () => {
  it('moves by a screen minus the overlap', () => {
    expect(pageScroll(0, -500, 200, 1)).toBe(-180);
    expect(pageScroll(-180, -500, 200, -1)).toBe(0);
  });
  it('stops at the ends', () => {
    expect(pageScroll(-400, -500, 200, 1)).toBe(-500);
    expect(pageScroll(-100, -500, 200, -1)).toBe(0);
  });
  it('returns null at the end (turn the page)', () => {
    expect(pageScroll(-500, -500, 200, 1)).toBeNull();
    expect(pageScroll(0, -500, 200, -1)).toBeNull();
    expect(pageScroll(0, 0, 200, 1)).toBeNull(); // nothing to scroll
  });
});
