// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Fake PDF.js: renders finish when the test says so; cancel() rejects the running one. */
const fake = vi.hoisted(() => {
  const state = {
    pages: 6,
    renders: [] as { n: number; done(): void; cancelled: boolean }[],
    cleanups: [] as number[],
    /** getPage calls not yet answered, and the most of them at once. */
    fetching: 0, mostFetching: 0, fetched: 0,
    destroyed: 0,
  };
  const page = (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 100 * scale }),
    render() {
      let done!: () => void, fail!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => { done = res; fail = rej; });
      const r = { n, done, cancelled: false };
      state.renders.push(r);
      return {
        promise,
        cancel() {
          r.cancelled = true;
          fail(Object.assign(new Error('Rendering cancelled'), { name: 'RenderingCancelledException' }));
        },
      };
    },
    cleanup() { state.cleanups.push(n); return true; },
  });
  return { state, page };
});

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: fake.state.pages,
      getPage: async (n: number) => {
        fake.state.fetched++;
        fake.state.mostFetching = Math.max(fake.state.mostFetching, ++fake.state.fetching);
        await new Promise(r => setTimeout(r, 0));
        fake.state.fetching--;
        return fake.page(n);
      },
      getMetadata: async () => ({ info: {} }),
    }),
    destroy: async () => { fake.state.destroyed++; },
  }),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));

const { isCancelled, MAX_PAGES, openPdfDoc, PRIORITY } = await import('../src/pdf');

const tick = () => new Promise(r => setTimeout(r, 0));

afterEach(() => {
  fake.state.renders.length = 0;
  fake.state.cleanups.length = 0;
  Object.assign(fake.state, { pages: 6, fetching: 0, mostFetching: 0, fetched: 0, destroyed: 0 });
  vi.unstubAllGlobals();
});

describe('PDF render queue', () => {
  it('a cancelled job is dropped from the queue; a running one has its render cancelled', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({}));
    const pdf = await openPdfDoc(new Uint8Array());
    const first = pdf.renderBitmap(1, 1, PRIORITY.current);
    const queued = pdf.renderBitmap(2, 1, PRIORITY.current);
    await tick();
    expect(fake.state.renders.map(r => r.n)).toEqual([1]);
    queued.cancel();
    expect(isCancelled(await queued.promise.catch(e => e))).toBe(true);
    first.cancel();
    expect(fake.state.renders[0].cancelled).toBe(true);
    expect(isCancelled(await first.promise.catch(e => e))).toBe(true);
    await tick();
    expect(fake.state.renders.map(r => r.n)).toEqual([1]); // page 2 never rendered
  });

  it('a job moved up runs before the others', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({}));
    const pdf = await openPdfDoc(new Uint8Array());
    const jobs = [1, 2, 3].map(n => pdf.renderBitmap(n, 1, PRIORITY.neighbor));
    jobs[2].setPriority(PRIORITY.current);
    await tick();
    fake.state.renders[0].done(); // page 1 was already running
    await jobs[0].promise;
    await tick();
    expect(fake.state.renders.map(r => r.n)).toEqual([1, 3]);
  });

  it('frees the render resources of pages no longer among the last rendered', async () => {
    const pdf = await openPdfDoc(new Uint8Array());
    const canvas = document.createElement('canvas');
    for (const n of [1, 2, 3, 4, 2, 5, 6]) {
      const p = pdf.renderInto(canvas, n, 1);
      await tick();
      fake.state.renders.at(-1)!.done();
      await p;
    }
    expect(fake.state.cleanups).toEqual([1, 3]);
  });
});

describe('closing a PDF', () => {
  it('cancels the render running and those queued: none is left waiting', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({}));
    const pdf = await openPdfDoc(new Uint8Array());
    const canvas = document.createElement('canvas');
    const running = pdf.renderBitmap(1, 1, PRIORITY.current).promise;
    const queued = [pdf.renderBitmap(2, 1, PRIORITY.neighbor).promise, pdf.renderInto(canvas, 3, 1)];
    await tick();
    expect(fake.state.renders.map(r => r.n)).toEqual([1]);
    await pdf.destroy();
    for (const p of [running, ...queued]) expect(isCancelled(await p.catch(e => e))).toBe(true);
    expect(fake.state.renders[0].cancelled).toBe(true);
    await tick();
    expect(fake.state.renders.map(r => r.n)).toEqual([1]); // nothing else rendered
  });
});

describe('opening a PDF', () => {
  it('asks PDF.js for a few pages at a time, not every page at once', async () => {
    fake.state.pages = 500;
    const pdf = await openPdfDoc(new Uint8Array());
    expect(pdf.pageSizes).toHaveLength(500);
    expect(fake.state.fetched).toBe(500);
    expect(fake.state.mostFetching).toBeGreaterThan(1);
    expect(fake.state.mostFetching).toBeLessThanOrEqual(16);
  });

  it('refuses a PDF with more than MAX_PAGES pages, before fetching any', async () => {
    fake.state.pages = MAX_PAGES + 1;
    await expect(openPdfDoc(new Uint8Array())).rejects.toThrow(/100,001 pages; Inkslide opens PDFs of up to 100,000 pages/);
    expect(fake.state.fetched).toBe(0);
    expect(fake.state.destroyed).toBe(1); // its worker does not stay
  });
});
