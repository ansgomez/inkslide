import { describe, expect, it } from 'vitest';
import { SNAPSHOT_MAX_PX, dataUrlLength, snapshotScale } from '../src/snapshot';

describe('snapshotScale', () => {
  it('uses the render scale of the page on screen', () => {
    // A 1.5 CSS px/pt page on a 2x screen renders at 3 px/pt.
    expect(snapshotScale({ x: 0, y: 0, w: 200, h: 100 }, 3, 1.5)).toBe(3);
  });

  it('takes at least 2 px per CSS px (a 1x screen)', () => {
    expect(snapshotScale({ x: 0, y: 0, w: 200, h: 100 }, 1.5, 1.5)).toBe(3);
  });

  it('caps the long side at SNAPSHOT_MAX_PX', () => {
    const k = snapshotScale({ x: 0, y: 0, w: 960, h: 540 }, 4, 2);
    expect(960 * k).toBe(SNAPSHOT_MAX_PX);
    expect(snapshotScale({ x: 0, y: 0, w: 100, h: 4000 }, 4, 2) * 4000).toBe(SNAPSHOT_MAX_PX);
  });

  it('never gives a broken scale', () => {
    expect(snapshotScale({ x: 0, y: 0, w: 0, h: 0 }, NaN, NaN)).toBe(1);
  });
});

describe('dataUrlLength', () => {
  it('is the length of a base64 data URL', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const url = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    expect(dataUrlLength(bytes.length, 'image/png')).toBe(url.length);
  });
});
