/* Inkslide web - browser storage of the recent files (see ../recent.ts)
 *
 * Entries (with their FileSystemFileHandles, which IndexedDB can store)
 * live in the IndexedDB database "inkslide", store "recent". Copies of
 * PDFs go to OPFS (directory "pdfs") where the page can write it
 * (createWritable: Chromium, Firefox, Safari 26+); Safari 17-18 can not
 * write OPFS from the page, so there the copy is an ArrayBuffer in the
 * IndexedDB store "copies" (not a Blob: WebKit can not store Blobs in a
 * private window), as it is when an OPFS write fails. Reads and removals
 * look in both places; an empty OPFS file counts as missing.
 *
 * In Safari, keeping copies asks for persistent storage once (navigator.
 * storage.persist(), no prompt there): Safari otherwise may clear a site's
 * storage after 7 days without a visit (an app on the home screen is
 * exempt). Not elsewhere: Firefox would show a permission prompt out of
 * the blue.
 */
import type { RecentBackend, RecentRecord } from '../recent';
import { canWriteOpfs, opfsDir, safeFileName, writeOpfsFile } from './opfs';

const DB_NAME = 'inkslide';
const RECENT = 'recent';
const COPIES = 'copies';
const OPFS_DIR = 'pdfs';

const done = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/**
 * The open connection, opened again once it closed: WebKit drops the
 * connections of a backgrounded PWA, and another window that upgrades the
 * database (a newer build) asks this one to close.
 */
let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(RECENT, { keyPath: 'id' });
      req.result.createObjectStore(COPIES);
    };
    // Another window keeps an older version open; it closes on its versionchange.
    req.onblocked = () => console.warn('The recent files database waits for another window to close it');
    const p: Promise<IDBDatabase> = done(req).then(conn => {
      const forget = (): void => { if (dbPromise === p) dbPromise = null; };
      conn.onclose = forget;
      conn.onversionchange = () => { conn.close(); forget(); };
      return conn;
    });
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
  }
  return dbPromise;
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const conn = await db();
  try {
    return conn.transaction(name, mode).objectStore(name);
  } catch (e) {
    // Closed without a close event (WebKit): open it again, once.
    if ((e as Error | null)?.name !== 'InvalidStateError') throw e;
    if (dbPromise && (await dbPromise) === conn) dbPromise = null;
    return (await db()).transaction(name, mode).objectStore(name);
  }
}

const fileName = (id: string): string => safeFileName(id, '.pdf');

let persistAsked = false;
function askPersist(): void {
  const webkit = typeof (window as { GestureEvent?: unknown }).GestureEvent !== 'undefined'; // Safari (macOS, iPadOS)
  if (persistAsked || !webkit || !navigator.storage || typeof navigator.storage.persist !== 'function') return;
  persistAsked = true;
  void navigator.storage.persist().catch(() => {});
}

/** IndexedDB + OPFS backend of the recent files. */
export function createRecentStorage(): RecentBackend {
  return {
    async all() {
      return done((await store(RECENT, 'readonly')).getAll() as IDBRequest<RecentRecord[]>);
    },
    async put(rec) {
      await done((await store(RECENT, 'readwrite')).put(rec));
    },
    async remove(id) {
      await done((await store(RECENT, 'readwrite')).delete(id));
    },

    async writeCopy(id, bytes) {
      askPersist();
      const data = bytes as Uint8Array<ArrayBuffer>;
      const dir = canWriteOpfs() ? await opfsDir(OPFS_DIR) : null;
      if (dir && (await writeOpfsFile(dir, fileName(id), data))) return;
      // No OPFS, or its write failed (quota, a locked file): IndexedDB. Then the
      // OPFS file goes: a failed write can leave it empty (readCopy skips those),
      // and a valid older one has the same bytes (the id is their hash).
      const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
      await done((await store(COPIES, 'readwrite')).put(whole ? data.buffer : data.slice().buffer, id));
      if (dir) await dir.removeEntry(fileName(id)).catch(() => {});
    },
    async readCopy(id) {
      const dir = await opfsDir(OPFS_DIR);
      if (dir) {
        try {
          const file = await (await dir.getFileHandle(fileName(id))).getFile();
          if (file.size > 0) return new Uint8Array(await file.arrayBuffer()); // empty: a failed write, not a PDF
        } catch (_) { /* not in OPFS */ }
      }
      const buf = await done((await store(COPIES, 'readonly')).get(id) as IDBRequest<ArrayBuffer | undefined>);
      return buf ? new Uint8Array(buf) : null;
    },
    async removeCopy(id) {
      const dir = await opfsDir(OPFS_DIR);
      if (dir) await dir.removeEntry(fileName(id)).catch(() => {});
      await done((await store(COPIES, 'readwrite')).delete(id));
    },
  };
}
