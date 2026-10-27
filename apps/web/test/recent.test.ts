import { describe, expect, it } from 'vitest';
import { createRecentFiles, planEviction, RecentError, type RecentBackend, type RecentEntry, type RecentRecord } from '../src/recent';

/** In-memory backend; copies can be made to fail. */
function fakeBackend() {
  const records = new Map<string, RecentRecord>();
  const copies = new Map<string, Uint8Array>();
  /** quota: bytes the copies may take in all (QuotaExceededError past it); failRemoves: removeCopy rejects. */
  const state = { failCopies: false, failPuts: false, failRemoves: false, writes: 0, quota: Infinity };
  const backend: RecentBackend = {
    all: async () => [...records.values()].map(r => ({ ...r })),
    put: async rec => {
      if (state.failPuts) throw new DOMException('aborted', 'AbortError');
      records.set(rec.id, { ...rec });
    },
    remove: async id => { records.delete(id); },
    writeCopy: async (id, bytes) => {
      state.writes++;
      if (state.failCopies) throw new DOMException('full', 'QuotaExceededError');
      const used = [...copies.values()].reduce((n, c) => n + c.byteLength, 0);
      if (used + bytes.byteLength > state.quota) throw new DOMException('full', 'QuotaExceededError');
      copies.set(id, bytes.slice());
    },
    readCopy: async id => copies.get(id) ?? null,
    removeCopy: async id => {
      if (state.failRemoves) throw new DOMException('locked', 'NoModificationAllowedError');
      copies.delete(id);
    },
  };
  return { backend, records, copies, state };
}

/** A FileSystemFileHandle stand-in: `same` names the file on disk. */
function fakeHandle(same: string, file: { name: string; bytes: Uint8Array } | null, permission: PermissionState = 'granted', grant: PermissionState = 'granted') {
  const h = {
    kind: 'file' as const,
    name: file?.name ?? 'gone.pdf',
    same,
    requests: 0,
    async isSameEntry(other: { same?: string }) { return other.same === same; },
    async queryPermission() { return permission; },
    async requestPermission() { h.requests++; permission = grant; return grant; },
    async getFile() {
      if (!file) throw new DOMException('gone', 'NotFoundError');
      return new File([file.bytes as Uint8Array<ArrayBuffer>], file.name);
    },
  };
  return h as typeof h & FileSystemFileHandle;
}

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);

function clock(start = 1000) {
  let t = start;
  return { now: () => (t += 10) };
}

describe('planEviction', () => {
  const e = (id: string, openedAt: number, size: number, source: RecentEntry['source'] = 'copy'): RecentEntry =>
    ({ id, name: `${id}.pdf`, size, openedAt, source });

  it('drops entries past the limit, oldest first', () => {
    expect(planEviction([e('a', 1, 1), e('b', 3, 1), e('c', 2, 1)], 2, 100)).toEqual(['a']);
  });

  it('drops the oldest copies until the copies fit; handles take no space', () => {
    const recs = [e('new', 5, 60), e('h', 4, 1000, 'handle'), e('mid', 3, 30), e('old', 2, 20), e('older', 1, 5)];
    // Copies newest first: 60, 30, 20, 5 (115 bytes).
    expect(planEviction(recs, 10, 115)).toEqual([]);
    expect(planEviction(recs, 10, 110)).toEqual(['older']);
    expect(planEviction(recs, 10, 100)).toEqual(['old', 'older']); // never a newer copy for an older one
    expect(planEviction(recs, 10, 59)).toEqual(['new', 'mid', 'old', 'older']);
  });
});

describe('recent files', () => {
  it('keeps a copy of a PDF without a handle and reads it back', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, clock());
    expect(await recent.remember({ id: 'a', name: 'a.pdf', pages: 3, size: 4 }, { bytes: bytes(4, 7) })).toBe(true);
    expect(await recent.list()).toEqual([{ id: 'a', name: 'a.pdf', pages: 3, size: 4, openedAt: 1010, source: 'copy' }]);
    const file = await recent.load('a');
    expect(file.name).toBe('a.pdf');
    expect([...file.bytes]).toEqual([7, 7, 7, 7]);
    expect(file.handle).toBeUndefined();
  });

  it('lists newest first and moves a reopened PDF up without writing its copy again', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, clock());
    await recent.remember({ id: 'a', name: 'a.pdf', size: 1 }, { bytes: bytes(1) });
    await recent.remember({ id: 'b', name: 'b.pdf', size: 1 }, { bytes: bytes(1) });
    expect((await recent.list()).map(e => e.id)).toEqual(['b', 'a']);
    await recent.remember({ id: 'a', name: 'a.pdf', pages: 2, size: 1 }, { bytes: bytes(1) });
    expect((await recent.list()).map(e => e.id)).toEqual(['a', 'b']);
    expect((await recent.list())[0].pages).toBe(2);
    expect(f.state.writes).toBe(2);
  });

  it('evicts the least recently opened copies past the byte limit (LRU) and past the entry limit', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, { ...clock(), bytesLimit: 10, limit: 3 });
    await recent.remember({ id: 'a', name: 'a.pdf', size: 4 }, { bytes: bytes(4) });
    await recent.remember({ id: 'b', name: 'b.pdf', size: 4 }, { bytes: bytes(4) });
    await recent.remember({ id: 'a', name: 'a.pdf', size: 4 }, { bytes: bytes(4) }); // a is used again
    await recent.remember({ id: 'c', name: 'c.pdf', size: 4 }, { bytes: bytes(4) }); // 12 > 10: b goes
    expect((await recent.list()).map(e => e.id)).toEqual(['c', 'a']);
    expect([...f.copies.keys()].sort()).toEqual(['a', 'c']);
    const h = fakeHandle('d', { name: 'd.pdf', bytes: bytes(1) });
    await recent.remember({ id: 'd', name: 'd.pdf', size: 1000 }, { handle: h }); // a handle takes no space
    await recent.remember({ id: 'e', name: 'e.pdf', size: 1 }, { bytes: bytes(1) }); // 4 entries > 3: a goes
    expect((await recent.list()).map(e => e.id)).toEqual(['e', 'd', 'c']);
    expect([...f.copies.keys()].sort()).toEqual(['c', 'e']);
  });

  it('does not keep a PDF larger than the limit or one whose copy fails', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, { ...clock(), bytesLimit: 10 });
    expect(await recent.remember({ id: 'big', name: 'big.pdf', size: 11 }, { bytes: bytes(11) })).toBe(false);
    f.state.failCopies = true;
    expect(await recent.remember({ id: 'a', name: 'a.pdf', size: 1 }, { bytes: bytes(1) })).toBe(false);
    expect(await recent.list()).toEqual([]);
    expect(f.copies.size).toBe(0);
  });

  it('keeps a handle instead of a copy and drops the copy it replaces', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, clock());
    await recent.remember({ id: 'a', name: 'a.pdf', size: 2 }, { bytes: bytes(2) });
    const h = fakeHandle('disk-a', { name: 'a.pdf', bytes: bytes(2, 5) });
    await recent.remember({ id: 'a', name: 'a.pdf', size: 2 }, { handle: h });
    expect((await recent.list())[0].source).toBe('handle');
    expect(f.copies.size).toBe(0);
    // Opened again from a file input: the handle stays, no copy.
    await recent.remember({ id: 'a', name: 'a.pdf', size: 2 }, { bytes: bytes(2) });
    expect((await recent.list())[0].source).toBe('handle');
    expect(f.copies.size).toBe(0);
    const file = await recent.load('a');
    expect(file.handle).toBe(h);
    expect([...file.bytes]).toEqual([5, 5]);
  });

  it('keeps the copy when the entry with the handle that replaces it can not be stored', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, clock());
    await recent.remember({ id: 'a', name: 'a.pdf', size: 2 }, { bytes: bytes(2, 3) });
    f.state.failPuts = true;
    const h = fakeHandle('disk-a', { name: 'a.pdf', bytes: bytes(2, 5) });
    await expect(recent.remember({ id: 'a', name: 'a.pdf', size: 2 }, { handle: h })).rejects.toThrow();
    expect([...(await recent.load('a')).bytes]).toEqual([3, 3]); // still the copy it was
  });

  it('keeps one entry per file on disk when its content (hash) changed', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, clock());
    await recent.remember({ id: 'v1', name: 'a.pdf', size: 1 }, { handle: fakeHandle('disk-a', null) });
    await recent.remember({ id: 'x', name: 'x.pdf', size: 1 }, { handle: fakeHandle('disk-x', null) });
    await recent.remember({ id: 'v2', name: 'a.pdf', size: 1 }, { handle: fakeHandle('disk-a', null) });
    expect((await recent.list()).map(e => e.id)).toEqual(['v2', 'x']);
  });

  it('asks for permission again, and reports denied or missing files', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, clock());
    const asks = fakeHandle('p', { name: 'p.pdf', bytes: bytes(1) }, 'prompt', 'granted');
    await recent.remember({ id: 'p', name: 'p.pdf', size: 1 }, { handle: asks });
    expect((await recent.load('p')).name).toBe('p.pdf');
    expect(asks.requests).toBe(1);

    await recent.remember({ id: 'd', name: 'd.pdf', size: 1 }, { handle: fakeHandle('d', { name: 'd.pdf', bytes: bytes(1) }, 'prompt', 'denied') });
    await expect(recent.load('d')).rejects.toMatchObject({ name: 'RecentError', reason: 'denied' });

    await recent.remember({ id: 'g', name: 'g.pdf', size: 1 }, { handle: fakeHandle('g', null) });
    const err = await recent.load('g').catch(e => e);
    expect(err).toBeInstanceOf(RecentError);
    expect(err.reason).toBe('missing');

    await recent.remember({ id: 'c', name: 'c.pdf', size: 1 }, { bytes: bytes(1) });
    f.copies.clear();
    await expect(recent.load('c')).rejects.toMatchObject({ reason: 'missing' });
    await expect(recent.load('nope')).rejects.toMatchObject({ reason: 'missing' });
  });

  it('removes an entry and its copy', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, clock());
    await recent.remember({ id: 'a', name: 'a.pdf', size: 1 }, { bytes: bytes(1) });
    await recent.remove('a');
    await recent.remove('a'); // twice is fine
    expect(await recent.list()).toEqual([]);
    expect(f.copies.size).toBe(0);
  });
});

describe('recent files near the storage quota', () => {
  it('drops the copies past the byte limit before writing the new one', async () => {
    const { backend, records, copies, state } = fakeBackend();
    state.quota = 100; // the storage is full at the byte limit
    const r = createRecentFiles(backend, { bytesLimit: 100, ...clock() });
    expect(await r.remember({ id: 'a', name: 'a.pdf', size: 60 }, { bytes: bytes(60) })).toBe(true);
    expect(await r.remember({ id: 'b', name: 'b.pdf', size: 60 }, { bytes: bytes(60) })).toBe(true);
    expect([...records.keys()]).toEqual(['b']);
    expect([...copies.keys()]).toEqual(['b']);
  });

  it('over the quota anyway, drops the oldest copy left and writes once more', async () => {
    const { backend, records, copies, state } = fakeBackend();
    const r = createRecentFiles(backend, { bytesLimit: 1000, ...clock() });
    await r.remember({ id: 'a', name: 'a.pdf', size: 40 }, { bytes: bytes(40) });
    await r.remember({ id: 'b', name: 'b.pdf', size: 40 }, { bytes: bytes(40) });
    state.quota = 100; // the browser's quota, below the app's limit
    expect(await r.remember({ id: 'c', name: 'c.pdf', size: 40 }, { bytes: bytes(40) })).toBe(true);
    expect([...records.keys()].sort()).toEqual(['b', 'c']);
    expect([...copies.keys()].sort()).toEqual(['b', 'c']);
  });

  it('an entry whose copy can not be removed stays listed (its bytes still count)', async () => {
    const { backend, records, copies, state } = fakeBackend();
    const r = createRecentFiles(backend, { bytesLimit: 100, ...clock() });
    await r.remember({ id: 'a', name: 'a.pdf', size: 60 }, { bytes: bytes(60) });
    state.failRemoves = true;
    expect(await r.remember({ id: 'b', name: 'b.pdf', size: 60 }, { bytes: bytes(60) })).toBe(true);
    expect([...records.keys()].sort()).toEqual(['a', 'b']);
    await expect(r.remove('a')).rejects.toThrow('locked');
    expect(records.has('a')).toBe(true);
    // Removable again: it goes with the next change.
    state.failRemoves = false;
    await r.remember({ id: 'c', name: 'c.pdf', size: 10 }, { bytes: bytes(10) });
    expect([...records.keys()].sort()).toEqual(['b', 'c']);
    expect([...copies.keys()].sort()).toEqual(['b', 'c']);
  });
});

describe('recent files, overlapping calls', () => {
  it('plans each change on what the one before left (opens in quick succession)', async () => {
    const f = fakeBackend();
    const recent = createRecentFiles(f.backend, { ...clock(), bytesLimit: 10 });
    await Promise.all([
      recent.remember({ id: 'a', name: 'a.pdf', size: 6 }, { bytes: bytes(6) }),
      recent.remember({ id: 'b', name: 'b.pdf', size: 6 }, { bytes: bytes(6) }),
    ]);
    expect((await recent.list()).map(e => e.id)).toEqual(['b']);
    expect([...f.copies.keys()]).toEqual(['b']);
  });
});
