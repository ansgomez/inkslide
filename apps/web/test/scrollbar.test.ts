import { describe, expect, it } from 'vitest';
import { dragScroll, MIN_THUMB, thumbBox } from '../src/scrollbar';

describe('thumbBox', () => {
  it('is null when the page does not scroll', () => {
    expect(thumbBox(0, 0, 800, 800, 800)).toBeNull();
    expect(thumbBox(0, -0.2, 800, 800.2, 800)).toBeNull();
    expect(thumbBox(0, -400, 800, 1200, 0)).toBeNull();
  });

  it('sizes the handle by the visible share and places it by the scroll position', () => {
    // 800 of 1600 px visible on an 800 px track: half-length handle.
    expect(thumbBox(0, -800, 800, 1600, 800)).toEqual({ size: 400, offset: 0, travel: 400 });
    expect(thumbBox(-400, -800, 800, 1600, 800)).toEqual({ size: 400, offset: 200, travel: 400 });
    expect(thumbBox(-800, -800, 800, 1600, 800)).toEqual({ size: 400, offset: 400, travel: 400 });
  });

  it('keeps the handle at least MIN_THUMB long and on the track', () => {
    const b = thumbBox(-1e5, -1e5, 800, 1e5 + 800, 800)!;
    expect(b.size).toBe(MIN_THUMB);
    expect(b.offset).toBe(800 - MIN_THUMB);
    expect(thumbBox(50, -800, 800, 1600, 800)!.offset).toBe(0);
  });
});

describe('dragScroll', () => {
  it('maps handle travel to the scroll range', () => {
    expect(dragScroll(0, 200, -800, 400)).toBe(-400);
    expect(dragScroll(-400, -200, -800, 400)).toBe(0);
  });

  it('clamps to the page ends', () => {
    expect(dragScroll(0, 9999, -800, 400)).toBe(-800);
    expect(dragScroll(-100, -9999, -800, 400)).toBe(0);
    expect(dragScroll(-100, 50, -800, 0)).toBe(-100);
  });
});
