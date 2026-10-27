import { describe, expect, it, vi } from 'vitest';
import { createPageBitmaps } from '../src/page-bitmaps';
import { isCancelled, PRIORITY, type PdfDoc, type RenderJob } from '../src/pdf';

interface FakeBitmap { id: string; closed: boolean; close(): void }

interface FakeRender {
  n: number;
  scale: number;
  priority: number;
  cancelled: boolean;
  resolve(): void;
  reject(e: Error): void;
  bmp: FakeBitmap;
}

/** A PdfDoc whose renders finish when the test says so. */
function fakePdf(name: string) {
  const renders: FakeRender[] = [];
  const renderBitmap = vi.fn((n: number, scale: number, priority = PRIORITY.current): RenderJob<ImageBitmap> => {
    const bmp: FakeBitmap = { id: `${name}:${n}@${scale}`, closed: false, close() { this.closed = true; } };
    let r!: FakeRender;
    const promise = new Promise<ImageBitmap>((resolve, reject) => {
      r = { n, scale, priority, cancelled: false, bmp, resolve: () => resolve(bmp as unknown as ImageBitmap), reject };
    });
    renders.push(r);
    return {
      promise,
      setPriority: p => { r.priority = p; },
      cancel: () => { r.cancelled = true; r.reject(new DOMException('rendering cancelled', 'AbortError')); },
    };
  });
  return { pdf: { renderBitmap } as unknown as PdfDoc, renderBitmap, renders };
}

/** Renders not cancelled, as "n@scale:priority". */
const live = (renders: FakeRender[]) => renders.filter(r => !r.cancelled).map(r => `${r.n}@${r.scale}:${r.priority}`);

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

  it('holding a page key: renders of pages passed by are cancelled, not queued', async () => {
    const a = fakePdf('a');
    const b = createPageBitmaps(6);
    b.setDoc(a.pdf);
    const shown: Promise<ImageBitmap>[] = [];
    // show(n): paint, then pre-render the neighbours (as the viewer does).
    const show = (n: number) => {
      shown.push(b.get(n, 1, PRIORITY.current));
      b.prefetch([[n + 1, 1], [n - 1, 1]].filter(([m]) => m >= 1) as [number, number][]);
    };
    for (let n = 1; n <= 8; n++) show(n);
    expect(live(a.renders).sort()).toEqual(['7@1:1', '8@1:0', '9@1:1']);
    // A cancelled page on screen rejects as cancelled, not as a failure.
    const e = await shown[0].catch(err => err);
    expect(isCancelled(e)).toBe(true);
  });

  it('a pending pre-render shown now moves up to the page-on-screen priority', () => {
    const a = fakePdf('a');
    const b = createPageBitmaps(6);
    b.setDoc(a.pdf);
    b.prefetch([[2, 1]]);
    void b.get(2, 1, PRIORITY.current);
    expect(a.renderBitmap).toHaveBeenCalledTimes(1);
    expect(live(a.renders)).toEqual([`2@1:${PRIORITY.current}`]);
  });

  it('a new scale of the page on screen (zoom) cancels the render at the old scale', () => {
    const a = fakePdf('a');
    const b = createPageBitmaps(6);
    b.setDoc(a.pdf);
    void b.get(3, 1, PRIORITY.current).catch(() => {});
    void b.get(3, 2, PRIORITY.current);
    expect(live(a.renders)).toEqual([`3@2:${PRIORITY.current}`]);
    // Asked for again: rendered anew.
    void b.get(3, 1, PRIORITY.neighbor).catch(() => {});
    expect(a.renderBitmap).toHaveBeenCalledTimes(3);
  });
});
