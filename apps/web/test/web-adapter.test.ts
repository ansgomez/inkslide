// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PdfFile } from '@inkslide/annotate';
import { createWebAdapter, notesKey } from '../src/platform/web';
import { canWriteOpfs } from '../src/platform/opfs';

const pdf: PdfFile = { path: null, name: 'a.pdf', bytes: new Uint8Array() };

/** In-memory OPFS "notes" directory whose writes can be made to fail. */
function fakeOpfs() {
  const files = new Map<string, string>();
  const state = { failWrites: false };
  const dir = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name) && !opts?.create) throw new DOMException('missing', 'NotFoundError');
      if (!files.has(name)) files.set(name, '');
      return {
        async getFile() { return { text: async () => files.get(name) ?? '' }; },
        async createWritable() {
          if (state.failWrites) throw new DOMException('locked', 'NoModificationAllowedError');
          let data = '';
          return { async write(t: string) { data = t; }, async close() { files.set(name, data); } };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException('missing', 'NotFoundError');
    },
  };
  const root = { getDirectoryHandle: async () => dir };
  // The page can write OPFS (createWritable: Chromium, Firefox, Safari 26+).
  vi.stubGlobal('FileSystemFileHandle', class { createWritable() {} });
  return { files, state, storage: { getDirectory: async () => root } };
}

function fakeLocalStorage(opts: { full?: boolean } = {}) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.full) throw new DOMException('full', 'QuotaExceededError');
      m.set(k, v);
    },
    removeItem: (k: string) => { m.delete(k); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web adapter notes storage', () => {
  it('writes to OPFS and reads back', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: opfs.storage });
    vi.stubGlobal('localStorage', fakeLocalStorage());
    const a = createWebAdapter();
    await a.writeNotes(pdf, 'one', 'abc');
    expect(await a.readNotes(pdf, 'abc')).toBe('one');
    expect(localStorage.getItem(notesKey(pdf, 'abc'))).toBeNull();
  });

  it('a write that falls back to localStorage is the one read back, not the older OPFS copy', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: opfs.storage });
    vi.stubGlobal('localStorage', fakeLocalStorage());
    const a = createWebAdapter();
    await a.writeNotes(pdf, 'old', 'abc');
    opfs.state.failWrites = true;
    await a.writeNotes(pdf, 'new', 'abc');
    expect(await a.readNotes(pdf, 'abc')).toBe('new');
    // OPFS works again: it takes over and the localStorage copy goes.
    opfs.state.failWrites = false;
    await a.writeNotes(pdf, 'newest', 'abc');
    expect(await a.readNotes(pdf, 'abc')).toBe('newest');
    expect(localStorage.getItem(notesKey(pdf, 'abc'))).toBeNull();
  });

  it('where OPFS can not be written, a failed write leaves no empty file that hides the older notes', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('FileSystemFileHandle', class {}); // no createWritable (Safari before 26)
    const ls = { full: false };
    const storage = fakeLocalStorage(ls);
    vi.stubGlobal('navigator', { storage: opfs.storage });
    vi.stubGlobal('localStorage', storage);
    const a = createWebAdapter();
    await a.writeNotes(pdf, 'old', 'abc'); // localStorage
    expect(opfs.files.size).toBe(0);
    ls.full = true;
    await expect(a.writeNotes(pdf, 'new', 'abc')).rejects.toThrow();
    expect(opfs.files.size).toBe(0);
    expect(await a.readNotes(pdf, 'abc')).toBe('old');
  });

  it('an empty OPFS file counts as no notes there', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: opfs.storage });
    vi.stubGlobal('localStorage', fakeLocalStorage());
    localStorage.setItem(notesKey(pdf, 'abc'), 'kept');
    opfs.files.set(notesKey(pdf, 'abc').replace(/[^A-Za-z0-9_-]/g, '_') + '.json', '');
    expect(await createWebAdapter().readNotes(pdf, 'abc')).toBe('kept');
  });
});

describe('canWriteOpfs', () => {
  it('needs FileSystemFileHandle with createWritable', () => {
    vi.stubGlobal('FileSystemFileHandle', undefined); // no OPFS at all
    expect(canWriteOpfs()).toBe(false);
    vi.stubGlobal('FileSystemFileHandle', class {}); // Safari 17-18: OPFS, written only from workers
    expect(canWriteOpfs()).toBe(false);
    vi.stubGlobal('FileSystemFileHandle', class { createWritable() {} });
    expect(canWriteOpfs()).toBe(true);
  });
});

describe('web adapter export', () => {
  it('downloads the PDF where the share sheet is not allowed even after the tap', async () => {
    const share = vi.fn(async () => { throw new DOMException('no activation or not allowed', 'NotAllowedError'); });
    vi.stubGlobal('navigator', { maxTouchPoints: 5, share, canShare: () => true });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    try {
      const done = createWebAdapter().exportPdf(new Uint8Array([1, 2]), 'a-notes.pdf');
      await vi.waitFor(() => expect(document.querySelector('.ann-banner .ink-banner-action')).not.toBeNull());
      document.querySelector<HTMLButtonElement>('.ann-banner .ink-banner-action')!.click(); // a fresh tap
      expect(await done).toBe(true);
      expect(share).toHaveBeenCalledTimes(2);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      createObjectURL.mockRestore();
      document.body.replaceChildren();
    }
  });
});

describe('web adapter links (?pdf=)', () => {
  it('opens only PDFs from the page\'s own site', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://inkslide.example/app/');
    const a = createWebAdapter();
    await expect(a.openPdf('https://elsewhere.example/slides.pdf')).rejects.toThrow(/only PDFs from this site/);
    expect(fetch).not.toHaveBeenCalled();
    const file = await a.openPdf('docs/lecture%201.pdf');
    expect(file?.name).toBe('lecture 1.pdf');
    expect(fetch).toHaveBeenCalledWith(new URL('docs/lecture%201.pdf', location.href).href);
  });
});
