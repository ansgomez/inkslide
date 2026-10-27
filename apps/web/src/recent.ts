/* Inkslide web - recently opened PDFs (browser / PWA)
 *
 * A browser has no file paths to reopen, so each opened PDF is remembered
 * in one of two ways, keyed by its SHA-256 (as its notes are):
 *   - 'handle': the FileSystemFileHandle the File System Access API gave
 *     (Chromium: open dialog, launchQueue). Reopening reads the file on
 *     disk; the browser may ask the user for read permission again.
 *   - 'copy': where there is no handle (iPad Safari, Firefox, file input,
 *     drag and drop, ?pdf= links) the PDF's bytes are kept in app storage.
 * At most RECENT_LIMIT entries are kept, and the copies together take at
 * most COPY_BYTES_LIMIT: past that, the least recently opened copies are
 * dropped (LRU) after the new copy is written. If that write exceeds the
 * browser's storage quota, the copies the limits would drop go first (else
 * the oldest one) and the write is tried once more. A PDF larger than the limit is not kept at all. An entry whose copy could
 * not be removed stays listed (its bytes still count) and goes next time.
 *
 * The storage itself (IndexedDB, OPFS) is a RecentBackend
 * (platform/recent-storage.ts), so this logic is tested with a fake.
 */

/** Most entries kept. */
export const RECENT_LIMIT = 12;
/** Most bytes all kept copies take together. */
export const COPY_BYTES_LIMIT = 250 * 1024 * 1024;

/** What the start screen shows of a remembered PDF. */
export interface RecentEntry {
  /** SHA-256 of the PDF, hex. */
  id: string;
  name: string;
  /** Page count (PDF pages, without blank pages). */
  pages?: number;
  /** File size in bytes. */
  size: number;
  /** Last opened, ms since the epoch. */
  openedAt: number;
  source: 'handle' | 'copy';
}

/** A stored entry: a 'handle' entry carries its handle. */
export interface RecentRecord extends RecentEntry {
  handle?: FileSystemFileHandle;
}

/** Storage of the recent files (IndexedDB / OPFS, or a fake in tests). */
export interface RecentBackend {
  all(): Promise<RecentRecord[]>;
  put(rec: RecentRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** Keep a copy of the PDF; rejects if it could not be stored. */
  writeCopy(id: string, bytes: Uint8Array): Promise<void>;
  readCopy(id: string): Promise<Uint8Array | null>;
  removeCopy(id: string): Promise<void>;
}

/** A remembered PDF that can not be opened: gone, or the user denied access. */
export class RecentError extends Error {
  constructor(readonly reason: 'missing' | 'denied', message: string) {
    super(message);
    this.name = 'RecentError';
  }
}

/** The PDF of a recent entry, ready to open. */
export interface RecentFile {
  name: string;
  bytes: Uint8Array;
  handle?: FileSystemFileHandle;
}

type PermissionMode = { mode: 'read' };
/** Permission methods of the File System Access API (Chromium; not in lib.dom). */
type PermissionHandle = FileSystemFileHandle & {
  queryPermission?(d: PermissionMode): Promise<PermissionState>;
  requestPermission?(d: PermissionMode): Promise<PermissionState>;
};

const newestFirst = (a: RecentEntry, b: RecentEntry): number => b.openedAt - a.openedAt;

/**
 * Ids of the records to drop: everything past the `limit` newest, then the
 * oldest copies until the remaining copies fit in `bytesLimit`.
 */
export function planEviction(records: readonly RecentEntry[], limit = RECENT_LIMIT, bytesLimit = COPY_BYTES_LIMIT): string[] {
  const drop: string[] = [];
  let bytes = 0;
  [...records].sort(newestFirst).forEach((r, i) => {
    if (i >= limit) drop.push(r.id);
    else if (r.source === 'copy' && (bytes += r.size) > bytesLimit) drop.push(r.id);
  });
  return drop;
}

/** The recent files of the start screen. */
export interface RecentFiles {
  /** Remembered PDFs, most recently opened first. */
  list(): Promise<RecentEntry[]>;
  /**
   * Remember an opened PDF, from its handle or as a copy of its bytes.
   * Resolves false if it is not kept (a copy above the size limit, or
   * storage failed).
   */
  remember(info: { id: string; name: string; pages?: number; size: number }, from: { handle: FileSystemFileHandle } | { bytes: Uint8Array }): Promise<boolean>;
  remove(id: string): Promise<void>;
  /**
   * Read a remembered PDF. A handle may need the user's permission again
   * (call from a click). Rejects with a RecentError if it is gone or denied.
   */
  load(id: string): Promise<RecentFile>;
}

/** Recent files over a storage backend. */
export function createRecentFiles(backend: RecentBackend, opts: { limit?: number; bytesLimit?: number; now?: () => number } = {}): RecentFiles {
  const { limit = RECENT_LIMIT, bytesLimit = COPY_BYTES_LIMIT, now = Date.now } = opts;

  /** Changes run one after another: each plans on what the one before left. */
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(change: () => Promise<T>): Promise<T> {
    const run = queue.then(change, change);
    queue = run.catch(() => {});
    return run;
  }

  /** Forget an entry and remove its copy; if the copy can not be removed, the entry stays (rejects). */
  async function drop(rec: RecentRecord): Promise<void> {
    if (rec.source === 'copy') await backend.removeCopy(rec.id);
    await backend.remove(rec.id);
  }

  /** Drop entries while remembering; a failure only leaves them for the next time. */
  const evict = (recs: Iterable<RecentRecord>): Promise<unknown> =>
    Promise.all([...recs].map(r => drop(r).catch(e => console.warn('Could not drop the recent file', e))));

  const isQuota = (e: unknown): boolean => (e as Error | null)?.name === 'QuotaExceededError';

  return {
    async list() {
      return (await backend.all()).map(({ handle: _h, ...entry }) => entry).sort(newestFirst);
    },

    remember: (info, from) => serial(async () => {
      const all = await backend.all();
      const old = all.find(r => r.id === info.id);
      const entry = { ...info, openedAt: now() };
      let rec: RecentRecord;
      const gone = new Set<RecentRecord>();
      if ('handle' in from) {
        // The same file on disk under an older content hash (it was edited): one entry per file.
        const same = await Promise.all(all.map(r =>
          r.id !== info.id && r.handle ? r.handle.isSameEntry(from.handle).catch(() => false) : false));
        all.forEach((r, i) => { if (same[i]) gone.add(r); });
        rec = { ...entry, source: 'handle', handle: from.handle };
      } else if (old) {
        // Already kept (a copy, or a handle that reopens the same bytes): just move it up.
        rec = { ...old, ...entry };
      } else {
        if (info.size > bytesLimit) return false;
        rec = { ...entry, source: 'copy' };
        try {
          try {
            await backend.writeCopy(info.id, from.bytes);
          } catch (e) {
            // Over the storage quota: make room (the copies the limits drop with
            // this one counted, else the oldest copy) and write once more.
            const copies = all.filter(r => r.source === 'copy');
            if (!isQuota(e) || !copies.length) throw e;
            await backend.removeCopy(info.id).catch(() => {});
            const planned = new Set(planEviction([...copies, rec], limit, bytesLimit));
            const room = copies.filter(r => planned.has(r.id));
            await Promise.all((room.length ? room : [copies.sort(newestFirst)[copies.length - 1]]).map(drop));
            await backend.writeCopy(info.id, from.bytes);
          }
        } catch (_) {
          await backend.removeCopy(info.id).catch(() => {});
          return false;
        }
      }
      await backend.put(rec);
      if (old && old.source === 'copy' && rec.source === 'handle') await backend.removeCopy(old.id); // replaced by the handle
      const goneIds = new Set([...gone].map(r => r.id));
      const kept = [...(await backend.all()).filter(r => r.id !== rec.id && !goneIds.has(r.id)), rec];
      const evicted = new Set(planEviction(kept, limit, bytesLimit));
      await evict([...gone, ...kept.filter(r => evicted.has(r.id))]);
      return true;
    }),

    remove: id => serial(async () => {
      const rec = (await backend.all()).find(r => r.id === id);
      if (rec) await drop(rec);
    }),

    async load(id) {
      const rec = (await backend.all()).find(r => r.id === id);
      if (!rec) throw new RecentError('missing', 'it is no longer in the recent files');
      if (rec.source === 'copy') {
        const bytes = await backend.readCopy(id);
        if (!bytes) throw new RecentError('missing', 'its stored copy is gone');
        return { name: rec.name, bytes };
      }
      const handle = rec.handle as PermissionHandle | undefined;
      if (!handle) throw new RecentError('missing', 'its file handle is gone');
      const read: PermissionMode = { mode: 'read' };
      if (handle.queryPermission && (await handle.queryPermission(read)) !== 'granted') {
        if (!handle.requestPermission || (await handle.requestPermission(read)) !== 'granted') {
          throw new RecentError('denied', 'reading the file was not allowed');
        }
      }
      let file: File;
      try {
        file = await handle.getFile();
      } catch (e) {
        if ((e as Error).name === 'NotFoundError') throw new RecentError('missing', 'the file was moved or deleted');
        throw e;
      }
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle };
    },
  };
}
