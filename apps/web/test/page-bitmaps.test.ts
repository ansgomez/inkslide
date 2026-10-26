import { describe, expect, it, vi } from 'vitest';
import { createPageBitmaps } from '../src/page-bitmaps';
import { PRIORITY, type PdfDoc } from '../src/pdf';

interface FakeBitmap { id: string; closed: boolean; close(): void }

/** A PdfDoc whose renders finish when the test says so. */
function fakePdf(name: string) {
  const renders: { n: number; resolve(): void; reject(e: Error): void; bmp: FakeBitmap }[] = [];
  const renderBitmap = vi.fn((n: number, scale: number) => new Promise<ImageBitmap>((resolve, reject) => {
    const bmp: FakeBitmap = { id: `${name}:${n}@${scale}`, closed: false, close() { this.closed = true; } };
    renders.push({ n, bmp, resolve: () => resolve(bmp as unknown as ImageBitmap), reject });
  }));
  return { pdf: { renderBitmap } as unknown as PdfDoc, renderBitmap, renders };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('page bitmaps', () => {
  it('shares one render between callers and caches it', async () => {
    const a = fakePdf('a');
    const b = createPageBitmaps(6);
    b.setDoc(a.pdf);
    const p1 = b.get(1, 1.5, PRIORITY.current);
    const p2 = b.get(1, 1.5, PRIORITY.neighbor);
    expect(a.renderBitmap).toHaveBeenCalledTimes(1);
    a.renders[0].resolve();
    expect(await p1).toBe(await p2);
    expect(b.cached(1, 1.5)).toBe(await p1);
    expect(b.standIn(1)).toBe(await p1);
    expect(b.standIn(2)).toBeUndefined();
  });

  it('closes a bitmap that arrives after its document was closed', async () => {
    const a = fakePdf('a');
    const b = createPageBitmaps(6);
    b.setDoc(a.pdf);
    const p = b.get(1, 1, PRIORITY.current);
    b.setDoc(null);
    a.renders[0].resolve();
    await p;
    expect(a.renders[0].bmp.closed).toBe(true);
    expect(b.cached(1, 1)).toBeUndefined();
  });

  it("a render of the closed document does not end the next document's render of the same page", async () => {
    const a = fakePdf('a'), next = fakePdf('next');
    const b = createPageBitmaps(6);
    b.setDoc(a.pdf);
    const old = b.get(1, 1, PRIORITY.current);
    b.setDoc(next.pdf);
    void b.get(1, 1, PRIORITY.current);
    a.renders[0].reject(new Error('document closed'));
    await old.catch(() => {});
    await flush();
    void b.get(1, 1, PRIORITY.current); // still the render in flight
    expect(next.renderBitmap).toHaveBeenCalledTimes(1);
  });
});
