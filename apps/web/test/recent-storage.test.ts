// @vitest-environment happy-dom
/* Inkslide web - tests of the recent files' browser storage (OPFS copies, IndexedDB fallback) */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentBackend } from '../src/recent';

/** Just enough IndexedDB for recent-storage.ts: open with an upgrade, stores with get / put / delete / getAll. */
function fakeIndexedDb() {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  const state = { opens: 0, conns: [] as { closed: boolean; onclose: null | (() => void); onversionchange: null | (() => void) }[] };
  const request = <T>(run: () => T) => {
    const req = { result: undefined as T | undefined, error: null, onsuccess: null as null | (() => void), onerror: null };
    queueMicrotask(() => { req.result = run(); req.onsuccess?.(); });
    return req;
  };
  const connection = () => ({
    closed: false,
    onclose: null as null | (() => void),
    onversionchange: null as null | (() => void),
    close() { this.closed = true; },
    createObjectStore(name: string) { stores.set(name, new Map()); },
    transaction(name: string) {
      if (this.closed) throw new DOMException('The database connection is closing.', 'InvalidStateError');
      const m = stores.get(name)!;
      return {
        objectStore: () => ({
          get: (k: IDBValidKey) => request(() => m.get(k)),
          put: (v: unknown, k?: IDBValidKey) => request(() => { m.set(k ?? (v as { id: string }).id, v); return k; }),
          delete: (k: IDBValidKey) => request(() => { m.delete(k); }),
          getAll: () => request(() => [...m.values()]),
        }),
      };
    },
  });
  return {
    stores,
    state,
    indexedDB: {
      open() {
        const db = connection();
        state.opens++;
        state.conns.push(db);
        const req = {
          result: db, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null,
          onblocked: null,
        };
        queueMicrotask(() => { if (!stores.size) req.onupgradeneeded?.(); req.onsuccess?.(); });
        return req;
      },
    },
  };
}

/** In-memory OPFS directory "pdfs" whose writes can be made to fail (after creating an empty file, as browsers do). */
function fakeOpfs() {
  const files = new Map<string, Uint8Array>();
  const state = { failWrites: false };
  const dir = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name) && !opts?.create) throw new DOMException('missing', 'NotFoundError');
      if (!files.has(name)) files.set(name, new Uint8Array());
      return {
        async getFile() {
          const data = files.get(name)!;
          return { size: data.byteLength, arrayBuffer: async () => data.slice().buffer };
        },
        async createWritable() {
          let data = new Uint8Array();
          return {
            async write(d: Uint8Array) {
              if (state.failWrites) throw new DOMException('quota', 'QuotaExceededError');
              data = d.slice();
            },
            async close() { files.set(name, data); },
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException('missing', 'NotFoundError');
    },
  };
  return { files, state, storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } };
}

let idb: ReturnType<typeof fakeIndexedDb>;
let opfs: ReturnType<typeof fakeOpfs>;
let backend: RecentBackend;
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49]);

beforeEach(async () => {
  idb = fakeIndexedDb();
  opfs = fakeOpfs();
  vi.stubGlobal('indexedDB', idb.indexedDB);
  vi.stubGlobal('navigator', { storage: opfs.storage });
  vi.stubGlobal('FileSystemFileHandle', class { createWritable() {} });
  vi.resetModules(); // the module keeps its database connection
  backend = (await import('../src/platform/recent-storage')).createRecentStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recent copies', () => {
  it('go to OPFS where the page can write it', async () => {
    await backend.writeCopy('abc', PDF);
    expect([...opfs.files.keys()]).toEqual(['abc.pdf']);
    expect(idb.stores.get('copies')?.size ?? 0).toBe(0);
    expect(await backend.readCopy('abc')).toEqual(PDF);
  });

  it('fall back to IndexedDB when the OPFS write fails, leaving no empty file', async () => {
    opfs.state.failWrites = true;
    await backend.writeCopy('abc', PDF);
    expect(opfs.files.size).toBe(0);
    expect(idb.stores.get('copies')!.size).toBe(1);
    expect(await backend.readCopy('abc')).toEqual(PDF);
  });

  it('a failed OPFS write keeps the older OPFS copy when IndexedDB fails too', async () => {
    await backend.writeCopy('abc', PDF);
    opfs.state.failWrites = true;
    vi.stubGlobal('indexedDB', { open() { throw new DOMException('quota', 'QuotaExceededError'); } });
    vi.resetModules();
    backend = (await import('../src/platform/recent-storage')).createRecentStorage();
    await expect(backend.writeCopy('abc', PDF)).rejects.toThrow();
    expect(opfs.files.get('abc.pdf')).toEqual(PDF);
  });

  it('go to IndexedDB where the page can not write OPFS (Safari 17-18)', async () => {
    vi.stubGlobal('FileSystemFileHandle', class {});
    await backend.writeCopy('abc', PDF.subarray(1));
    expect(opfs.files.size).toBe(0);
    expect(await backend.readCopy('abc')).toEqual(PDF.subarray(1));
  });

  it('an empty OPFS file counts as missing: the IndexedDB copy is read', async () => {
    vi.stubGlobal('FileSystemFileHandle', class {});
    await backend.writeCopy('abc', PDF);
    opfs.files.set('abc.pdf', new Uint8Array()); // left by a write that failed
    expect(await backend.readCopy('abc')).toEqual(PDF);
    await backend.removeCopy('abc');
    expect(await backend.readCopy('abc')).toBeNull();
    expect(opfs.files.size).toBe(0);
  });
});

describe('recent files database connection', () => {
  it('is opened again after WebKit closed it (with or without a close event) or another window upgrades', async () => {
    await backend.put({ id: 'a', name: 'a.pdf', size: 1, openedAt: 1, source: 'copy' });
    expect(idb.state.opens).toBe(1);
    // Dropped without an event: the transaction throws InvalidStateError, retried once.
    idb.state.conns[0].closed = true;
    expect((await backend.all()).map(r => r.id)).toEqual(['a']);
    expect(idb.state.opens).toBe(2);
    // A close event.
    idb.state.conns[1].closed = true;
    idb.state.conns[1].onclose!();
    expect((await backend.all()).map(r => r.id)).toEqual(['a']);
    expect(idb.state.opens).toBe(3);
    // Another window upgrades: this connection closes so it is not blocked.
    idb.state.conns[2].onversionchange!();
    expect(idb.state.conns[2].closed).toBe(true);
    expect((await backend.all()).map(r => r.id)).toEqual(['a']);
    expect(idb.state.opens).toBe(4);
  });
});
