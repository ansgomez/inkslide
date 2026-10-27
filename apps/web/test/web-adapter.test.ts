// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PdfFile } from '@inkslide/annotate';
import { BACKUP_MIN_AGE_MS } from '@inkslide/annotate/io';
import type { RecentBackend, RecentRecord } from '../src/recent';
import { createWebAdapter, notesKey } from '../src/platform/web';
import { canWriteOpfs } from '../src/platform/opfs';

// The recent files in memory (the IndexedDB storage has its own tests).
vi.mock('../src/platform/recent-storage', () => ({
  createRecentStorage(): RecentBackend {
    const recs = new Map<string, RecentRecord>();
    const copies = new Map<string, Uint8Array>();
    return {
      all: async () => [...recs.values()],
      put: async rec => { recs.set(rec.id, rec); },
      remove: async id => { recs.delete(id); },
      writeCopy: async (id, bytes) => { copies.set(id, bytes); },
      readCopy: async id => copies.get(id) ?? null,
      removeCopy: async id => { copies.delete(id); },
    };
  },
}));

const pdf: PdfFile = { path: null, name: 'a.pdf', bytes: new Uint8Array() };

/**
 * In-memory OPFS "notes" directory whose writes can be made to fail (all of
 * them, or those of files matching `failNames`). Files keep their write time.
 */
function fakeOpfs() {
  const files = new Map<string, string>();
  const times = new Map<string, number>();
  const state = { failWrites: false, failNames: null as RegExp | null };
  const dir = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name) && !opts?.create) throw new DOMException('missing', 'NotFoundError');
      if (!files.has(name)) files.set(name, '');
      return {
        async getFile() { return { text: async () => files.get(name) ?? '', lastModified: times.get(name) ?? Date.now() }; },
        async createWritable() {
          if (state.failWrites || state.failNames?.test(name)) throw new DOMException('locked', 'NoModificationAllowedError');
          let data = '';
          return {
            async write(t: string) { data = t; },
            async close() { files.set(name, data); times.set(name, Date.now()); },
          };
        },
      };
    },
    async removeEntry(name: string) {
      times.delete(name);
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
  vi.useRealTimers();
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

/** Notes for a PDF with `n` pen strokes on page 1 (0: empty notes). */
const notes = (n: number): string => JSON.stringify({
  format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'a', slides: 1, size: [960, 540], sha256: 'abc' },
  pages: [{
    id: 'p1', kind: 'slide', slide: 1,
    strokes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, tool: 'pen', color: '#000000', size: 3, points: [[10, 10, 0.5], [20, 20, 0.5]] })),
  }],
});

const backupFile = (sha: string): string => `inkslide-notes_${sha}.notes.backup.json`;

/** An adapter over a fake OPFS and localStorage, with the clock at `start`. */
function backupSetup(start = 1_000_000) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  const opfs = fakeOpfs();
  vi.stubGlobal('navigator', { storage: opfs.storage });
  vi.stubGlobal('localStorage', fakeLocalStorage());
  return { opfs, a: createWebAdapter(), later: (ms: number) => vi.setSystemTime(Date.now() + ms) };
}

describe('web adapter notes backup', () => {
  it('copies the saved notes to the backup before a save, at most once every 2 minutes', async () => {
    const { opfs, a, later } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc'); // nothing saved before: no backup
    expect(await a.readBackup!(pdf, 'abc')).toBeNull();
    later(1000);
    await a.writeNotes(pdf, notes(2), 'abc');
    expect(await a.readBackup!(pdf, 'abc')).toEqual({ text: notes(1), time: Date.now() });
    const first = Date.now();
    later(BACKUP_MIN_AGE_MS - 1000);
    await a.writeNotes(pdf, notes(3), 'abc'); // the backup is too fresh to replace
    expect(await a.readBackup!(pdf, 'abc')).toEqual({ text: notes(1), time: first });
    later(2000);
    await a.writeNotes(pdf, notes(4), 'abc');
    expect(await a.readBackup!(pdf, 'abc')).toEqual({ text: notes(3), time: Date.now() });
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(4));
    expect(opfs.files.has(backupFile('abc'))).toBe(true);
  });

  it('never copies empty or unreadable notes', async () => {
    const { a, later } = backupSetup();
    await a.writeNotes(pdf, notes(0), 'abc');
    await a.writeNotes(pdf, notes(1), 'abc');
    expect(await a.readBackup!(pdf, 'abc')).toBeNull();
    localStorage.setItem(notesKey(pdf, 'b'), '{ broken');
    await a.writeNotes(pdf, notes(1), 'b');
    expect(await a.readBackup!(pdf, 'b')).toBeNull();
    later(BACKUP_MIN_AGE_MS);
    await a.writeNotes(pdf, notes(2), 'b'); // now the saved notes are usable
    expect((await a.readBackup!(pdf, 'b'))?.text).toBe(notes(1));
  });

  it('a backup that can not be written does not fail the save', async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    opfs.state.failNames = /backup/;
    await a.writeNotes(pdf, notes(2), 'abc');
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(2));
    expect(await a.readBackup!(pdf, 'abc')).toBeNull(); // the empty file the failed write left is no backup
  });

  it('keeps no backup where the page can not write OPFS (no localStorage copy)', async () => {
    const { a } = backupSetup();
    vi.stubGlobal('FileSystemFileHandle', class {}); // Safari 17-18
    await a.writeNotes(pdf, notes(1), 'abc');
    await a.writeNotes(pdf, notes(2), 'abc');
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(2));
    expect(await a.readBackup!(pdf, 'abc')).toBeNull();
    await expect(a.revertToBackup!(pdf, 'abc')).rejects.toThrow(/no usable backup/);
  });

  it('revert swaps the notes and the backup, so a second revert undoes the first', async () => {
    const { a, later } = backupSetup();
    await expect(a.revertToBackup!(pdf, 'abc')).rejects.toThrow(/no usable backup/);
    await a.writeNotes(pdf, notes(1), 'abc');
    await a.writeNotes(pdf, notes(2), 'abc');
    later(5000);
    expect(await a.revertToBackup!(pdf, 'abc')).toBe(notes(1));
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(1));
    expect(await a.readBackup!(pdf, 'abc')).toEqual({ text: notes(2), time: Date.now() });
    // The viewer writes the reloaded notes again: the fresh backup stays.
    await a.writeNotes(pdf, notes(1), 'abc');
    expect((await a.readBackup!(pdf, 'abc'))?.text).toBe(notes(2));
    expect(await a.revertToBackup!(pdf, 'abc')).toBe(notes(2));
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(2));
    expect((await a.readBackup!(pdf, 'abc'))?.text).toBe(notes(1));
  });

  it('a revert whose notes write fails leaves notes and backup as they were', async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    await a.writeNotes(pdf, notes(2), 'abc');
    opfs.state.failNames = /abc\.json$/; // the notes file, not the backup
    vi.stubGlobal('localStorage', fakeLocalStorage({ full: true }));
    await expect(a.revertToBackup!(pdf, 'abc')).rejects.toThrow();
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(2));
    expect((await a.readBackup!(pdf, 'abc'))?.text).toBe(notes(1));
  });

  it('a PDF dropped from the recent files loses its backup, not its notes', async () => {
    const { opfs, a } = backupSetup();
    const file: PdfFile = { path: null, name: 'a.pdf', bytes: new Uint8Array([1]) };
    await a.opened(file, { sha256: 'abc', pages: 1 });
    await a.writeNotes(file, notes(1), 'abc');
    await a.writeNotes(file, notes(2), 'abc');
    expect(opfs.files.has(backupFile('abc'))).toBe(true);
    await a.recent.remove('abc');
    expect(opfs.files.has(backupFile('abc'))).toBe(false);
    expect(await a.readNotes(file, 'abc')).toBe(notes(2));
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
