import { describe, expect, it } from 'vitest';
import { SNAPSHOT_MAX_PX, dataUrlLength, importImage, snapshotScale } from '../src/snapshot';

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

describe('importImage', () => {
  const pngHead = (w: number, h: number): Blob => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return new Blob([b], { type: 'image/png' });
  };

  it('refuses a pasted image too large in pixels, or of unknown size, before decoding it', async () => {
    // No createImageBitmap here: these must fail before decoding.
    await expect(importImage(pngHead(20000, 20000))).rejects.toThrow(/too large \(20000×20000 pixels\)/);
    await expect(importImage(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))).rejects.toThrow(/could not be read/);
    await expect(importImage(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xda])], { type: 'image/jpeg' }))).rejects.toThrow(/could not be read/);
  });
});
