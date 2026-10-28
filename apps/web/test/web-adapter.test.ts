// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PdfFile } from '@inkslide/annotate';
import { BACKUP_MIN_AGE_MS, OLD_COPIES_MAX_AGE_DAYS } from '@inkslide/annotate/io';
import type { RecentBackend, RecentRecord } from '../src/recent';
import { cleanupNotesStore, createWebAdapter, notesKey } from '../src/platform/web';
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
 * them, those of files matching `failNames`, or where `failWrite(name)` says
 * so; with `failClose`, on close() instead), whose reads of files matching
 * `failReads` fail, and whose removals fail with `failRemoves`. Files keep
 * their write time (`times`); `writes` lists the files written, in order,
 * `aborts` the writables aborted, and `textReads` counts the reads of each
 * file's content. `afterList` runs once a listing (values()) has returned
 * every file.
 */
function fakeOpfs() {
  const files = new Map<string, string>();
  const times = new Map<string, number>();
  const writes: string[] = [];
  const textReads = new Map<string, number>();
  const aborts: string[] = [];
  const state = {
    failWrites: false, failNames: null as RegExp | null, failReads: null as RegExp | null,
    failClose: false, failRemoves: false,
    /** Opening the notes directory fails with this. */
    dirError: null as DOMException | null,
    failWrite: null as ((name: string) => boolean) | null,
    afterList: null as (() => void) | null,
  };
  const fileHandle = (name: string) => ({
    kind: 'file' as const, name,
    async getFile() {
      if (state.failReads?.test(name)) throw new DOMException('busy', 'NotReadableError');
      const data = files.get(name) ?? '';
      return {
        size: data.length,
        lastModified: times.get(name) ?? Date.now(),
        text: async () => {
          textReads.set(name, (textReads.get(name) ?? 0) + 1);
          return data;
        },
      };
    },
    async createWritable() {
      if (state.failWrites || state.failNames?.test(name) || state.failWrite?.(name)) {
        throw new DOMException('locked', 'NoModificationAllowedError');
      }
      let data = '';
      return {
        async write(t: string) { data = t; },
        async close() {
          if (state.failClose) throw new DOMException('disk error', 'InvalidStateError');
          files.set(name, data); times.set(name, Date.now()); writes.push(name);
        },
        async abort() { aborts.push(name); },
      };
    },
  });
  const dir = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name) && !opts?.create) throw new DOMException('missing', 'NotFoundError');
      if (!files.has(name)) files.set(name, '');
      return fileHandle(name);
    },
    async removeEntry(name: string) {
      if (state.failRemoves) throw new DOMException('locked', 'NoModificationAllowedError');
      times.delete(name);
      if (!files.delete(name)) throw new DOMException('missing', 'NotFoundError');
    },
    async *values() {
      for (const name of [...files.keys()]) yield fileHandle(name);
      state.afterList?.();
    },
  };
  const root = {
    getDirectoryHandle: async () => {
      if (state.dirError) throw state.dirError;
      return dir;
    },
  };
  // The page can write OPFS (createWritable: Chromium, Firefox, Safari 26+).
  vi.stubGlobal('FileSystemFileHandle', class { createWritable() {} });
  return { files, times, writes, aborts, textReads, state, storage: { getDirectory: async () => root } };
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

  it('a write that falls back to localStorage is read back even when the older OPFS file can not be removed', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: opfs.storage });
    vi.stubGlobal('localStorage', fakeLocalStorage());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const a = createWebAdapter();
    await a.writeNotes(pdf, 'old', 'abc');
    vi.setSystemTime(1_001_000);
    opfs.state.failClose = true; // the write fails on close() (the file stays locked until aborted)
    opfs.state.failRemoves = true;
    await a.writeNotes(pdf, 'new', 'abc');
    expect(opfs.aborts).toEqual([notesKey(pdf, 'abc').replace(/[^A-Za-z0-9_-]/g, '_') + '.json']);
    expect([...opfs.files.values()]).toContain('old'); // still there, and readable
    expect(await a.readNotes(pdf, 'abc')).toBe('new');
    // OPFS works again: it takes over and the localStorage copy goes.
    vi.setSystemTime(1_002_000);
    opfs.state.failClose = opfs.state.failRemoves = false;
    await a.writeNotes(pdf, 'newest', 'abc');
    expect(await a.readNotes(pdf, 'abc')).toBe('newest');
    expect(localStorage.getItem(notesKey(pdf, 'abc'))).toBeNull();
  });

  it('notes kept in both places without times (an older build) are read from OPFS', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: opfs.storage });
    vi.stubGlobal('localStorage', fakeLocalStorage());
    opfs.files.set(notesKey(pdf, 'abc').replace(/[^A-Za-z0-9_-]/g, '_') + '.json', 'in opfs');
    localStorage.setItem(notesKey(pdf, 'abc'), 'in localStorage');
    expect(await createWebAdapter().readNotes(pdf, 'abc')).toBe('in opfs');
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

  it('a notes directory that can not be opened is an error, not "no notes" (unless there is no OPFS here)', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: opfs.storage });
    vi.stubGlobal('localStorage', fakeLocalStorage());
    const a = createWebAdapter();
    await a.writeNotes(pdf, 'mine', 'abc');
    opfs.state.dirError = new DOMException('broken', 'UnknownError');
    await expect(a.readNotes(pdf, 'abc')).rejects.toThrow('broken');
    await expect(a.readBackup!(pdf, 'abc')).rejects.toThrow('broken'); // the same for the backup
    // No notes file, or no OPFS here (private browsing): no notes, or those in localStorage.
    opfs.state.dirError = null;
    expect(await a.readNotes(pdf, 'other')).toBeNull();
    opfs.state.dirError = new DOMException('denied', 'SecurityError');
    expect(await a.readBackup!(pdf, 'abc')).toBeNull();
    localStorage.setItem(notesKey(pdf, 'abc'), 'kept');
    expect(await a.readNotes(pdf, 'abc')).toBe('kept');
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
const unreadableFile = (sha: string): string => `inkslide-notes_${sha}.notes.unreadable.json`;

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

  it('a PDF dropped from the recent files loses its backup, not its notes or kept unreadable copy', async () => {
    const { opfs, a } = backupSetup();
    const file: PdfFile = { path: null, name: 'a.pdf', bytes: new Uint8Array([1]) };
    await a.opened(file, { sha256: 'abc', pages: 1 });
    await a.writeNotes(file, notes(1), 'abc');
    await a.writeNotes(file, notes(2), 'abc');
    await a.keepUnreadableNotes!(file, 'abc');
    expect(opfs.files.has(backupFile('abc'))).toBe(true);
    expect(opfs.files.has(unreadableFile('abc'))).toBe(true);
    await a.recent.remove('abc');
    expect(opfs.files.has(backupFile('abc'))).toBe(false);
    // The unreadable copy may be the only copy of real notes: only the 90-day sweep deletes it.
    expect(opfs.files.has(unreadableFile('abc'))).toBe(true);
    expect(await a.readNotes(file, 'abc')).toBe(notes(2));
  });

  it('evicted from the recent files (LRU), a PDF keeps its kept unreadable copy', async () => {
    const { opfs, a } = backupSetup();
    const first: PdfFile = { path: null, name: 'first.pdf', bytes: new Uint8Array([0]) };
    await a.opened(first, { sha256: 'first', pages: 1 });
    await a.writeNotes(first, '{"format":"marp-notes","version":99}', 'first');
    await a.keepUnreadableNotes!(first, 'first');
    for (let i = 1; i <= 12; i++) {
      vi.setSystemTime(Date.now() + 1000);
      await a.opened({ path: null, name: `${i}.pdf`, bytes: new Uint8Array([i]) }, { sha256: `n${i}`, pages: 1 });
    }
    expect((await a.recent.list()).map(e => e.id)).not.toContain('first');
    expect(opfs.files.get(unreadableFile('first'))).toBe('{"format":"marp-notes","version":99}');
  });

  // Review findings on the first version (regressions).

  it('keeps a copy of unreadable notes before they are replaced, as they are', async () => {
    const { opfs, a } = backupSetup();
    expect(await a.keepUnreadableNotes!(pdf, 'abc')).toBeNull(); // no notes: nothing to keep
    await a.writeNotes(pdf, '{"format":"marp-notes","version":99', 'abc'); // e.g. from a newer build
    const where = await a.keepUnreadableNotes!(pdf, 'abc');
    expect(where).toContain(unreadableFile('abc'));
    expect(opfs.files.get(unreadableFile('abc'))).toBe('{"format":"marp-notes","version":99');
    // Notes in localStorage (OPFS could not be written then) are kept too.
    localStorage.setItem(notesKey(pdf, 'b'), '{ broken');
    await a.keepUnreadableNotes!(pdf, 'b');
    expect(opfs.files.get(unreadableFile('b'))).toBe('{ broken');
  });

  it('a copy of unreadable notes that can not be made rejects (the viewer then asks)', async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, '{ broken', 'abc');
    opfs.state.failNames = /unreadable/;
    await expect(a.keepUnreadableNotes!(pdf, 'abc')).rejects.toThrow(/could not be written/);
    opfs.state.failNames = null;
    opfs.state.failReads = /abc\.json$/;
    await expect(a.keepUnreadableNotes!(pdf, 'abc')).rejects.toThrow();
    opfs.state.failReads = null;
    vi.stubGlobal('FileSystemFileHandle', class {}); // Safari 17-18
    await expect(a.keepUnreadableNotes!(pdf, 'abc')).rejects.toThrow(/can not keep a copy/);
  });

  it('notes that are there but can not be read are an error, not "no notes"', async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    opfs.state.failReads = /abc\.json$/;
    await expect(a.readNotes(pdf, 'abc')).rejects.toThrow();
  });

  it('an OPFS notes file that can not be read gives way to a localStorage copy (the newer notes)', async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    // OPFS failed once: the notes went to localStorage, and the older OPFS file could not be removed.
    localStorage.setItem(notesKey(pdf, 'abc'), notes(2));
    opfs.state.failReads = /abc\.json$/;
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(2));
    // So does a save, for the backup: the notes it replaces are those of localStorage.
    await a.writeNotes(pdf, notes(3), 'abc');
    opfs.state.failReads = null;
    expect((await a.readBackup!(pdf, 'abc'))?.text).toBe(notes(2));
  });

  it('a revert whose saved notes can not be read changes nothing', async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    await a.writeNotes(pdf, notes(2), 'abc');
    opfs.state.failReads = /abc\.json$/; // the notes file, not the backup
    await expect(a.revertToBackup!(pdf, 'abc')).rejects.toThrow();
    opfs.state.failReads = null;
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(2));
    expect((await a.readBackup!(pdf, 'abc'))?.text).toBe(notes(1));
  });

  it('a revert that can not put the backup back says so', async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    await a.writeNotes(pdf, notes(2), 'abc');
    let backupWrites = 0;
    // The notes write fails, then also the write that puts the backup back.
    opfs.state.failWrite = name => name.endsWith('abc.json') || (name === backupFile('abc') && ++backupWrites > 1);
    vi.stubGlobal('localStorage', fakeLocalStorage({ full: true }));
    await expect(a.revertToBackup!(pdf, 'abc')).rejects.toThrow(/the backup could not be put back/);
    expect(await a.readNotes(pdf, 'abc')).toBe(notes(2));
  });

  it('writes the backup after the notes, and not at all when the notes write fails', async () => {
    const { opfs, a, later } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    opfs.writes.length = 0;
    await a.writeNotes(pdf, notes(2), 'abc');
    expect(opfs.writes).toEqual(['inkslide-notes_abc.json', backupFile('abc')]);
    // Near the quota: the notes can not be written (nor fall back): no new backup either.
    later(BACKUP_MIN_AGE_MS);
    opfs.writes.length = 0;
    opfs.state.failNames = /abc\.json$/;
    vi.stubGlobal('localStorage', fakeLocalStorage({ full: true }));
    await expect(a.writeNotes(pdf, notes(3), 'abc')).rejects.toThrow();
    expect(opfs.writes).toEqual([]);
    expect((await a.readBackup!(pdf, 'abc'))?.text).toBe(notes(1));
  });

  it('a save looks at the backup\'s time only, not its content', async () => {
    const { opfs, a, later } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    await a.writeNotes(pdf, notes(2), 'abc');
    for (let i = 3; i < 6; i++) {
      later(1000);
      await a.writeNotes(pdf, notes(i), 'abc');
    }
    expect(opfs.textReads.get(backupFile('abc')) ?? 0).toBe(0);
  });

  it(`at startup, deletes backups and unreadable copies older than ${OLD_COPIES_MAX_AGE_DAYS} days, never notes`, async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'old');
    await a.writeNotes(pdf, notes(2), 'old');
    await a.keepUnreadableNotes!(pdf, 'old');
    await a.writeNotes(pdf, notes(1), 'new');
    await a.writeNotes(pdf, notes(2), 'new');
    const day = 24 * 60 * 60_000;
    const longAgo = Date.now() - (OLD_COPIES_MAX_AGE_DAYS + 1) * day;
    for (const name of opfs.files.keys()) if (name.includes('_old')) opfs.times.set(name, longAgo);
    expect((await cleanupNotesStore()).sort()).toEqual([backupFile('old'), unreadableFile('old')]);
    expect([...opfs.files.keys()].sort()).toEqual(['inkslide-notes_new.json', backupFile('new'), 'inkslide-notes_old.json'].sort());
  });

  it('the startup sweep spares a copy written again after it listed the files', async () => {
    const { opfs, a } = backupSetup();
    await a.writeNotes(pdf, notes(1), 'abc');
    await a.writeNotes(pdf, notes(2), 'abc');
    await a.keepUnreadableNotes!(pdf, 'abc');
    const longAgo = Date.now() - (OLD_COPIES_MAX_AGE_DAYS + 1) * 24 * 60 * 60_000;
    opfs.times.set(backupFile('abc'), longAgo);
    opfs.times.set(unreadableFile('abc'), longAgo);
    // Between the listing and the deletes, a save rewrites the backup (here: its time).
    opfs.state.afterList = () => opfs.times.set(backupFile('abc'), Date.now());
    expect(await cleanupNotesStore()).toEqual([unreadableFile('abc')]);
    expect(opfs.files.get(backupFile('abc'))).toBe(notes(1));
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

describe('web adapter export with the save dialog', () => {
  it('downloads the PDF when the save dialog is blocked (no recent tap)', async () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => { throw new DOMException('must be handling a user gesture', 'SecurityError'); }));
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    try {
      expect(await createWebAdapter().exportPdf(new Uint8Array([1, 2]), 'a-notes.pdf')).toBe(true);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      createObjectURL.mockRestore();
    }
  });

  it('a cancelled dialog exports nothing; other dialog errors reject', async () => {
    const picker = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); });
    vi.stubGlobal('showSaveFilePicker', picker);
    expect(await createWebAdapter().exportPdf(new Uint8Array([1]), 'a.pdf')).toBe(false);
    picker.mockImplementation(async () => { throw new TypeError('bad options'); });
    await expect(createWebAdapter().exportPdf(new Uint8Array([1]), 'a.pdf')).rejects.toThrow('bad options');
  });

  it('a failed write aborts the writable', async () => {
    const w = {
      write: vi.fn(async () => { throw new DOMException('disk full', 'QuotaExceededError'); }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => ({ createWritable: async () => w })));
    await expect(createWebAdapter().exportPdf(new Uint8Array([1]), 'a.pdf')).rejects.toThrow('disk full');
    expect(w.abort).toHaveBeenCalledTimes(1);
    expect(w.close).not.toHaveBeenCalled();
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
