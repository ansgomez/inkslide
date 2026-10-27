/* Inkslide web - browser platform adapter (also the future PWA)
 *
 * PDFs come from the open dialog of the File System Access API where
 * there is one (Chromium: the file handle is kept for reopening), else a
 * file input (or a URL, for links and tests); there is no file system
 * path, so notes are kept in the origin's storage keyed by the PDF's
 * SHA-256: OPFS when the browser has it, else localStorage. Opened PDFs are
 * remembered for the start screen (../recent.ts). Exports go through the
 * save dialog of the File System Access API where there is one, else the
 * share sheet on touch devices (iPad: "Save to Files"), else a download.
 *
 * The notes backup works as on the desktop (apps/desktop/src/main/notes.ts):
 * before a save replaces the notes, the saved notes are copied to the backup
 * if they are usable (not empty, they load) and the backup is missing or
 * older than 2 minutes; Revert to Backup swaps the two, so a second revert
 * undoes the first. The backup is an OPFS file next to the notes,
 * "<notes file>.notes.backup.json", and exists only where the page can write
 * OPFS: localStorage (about 5 MB, shared with the notes that fall back to it)
 * would fill up twice as fast, and there a full store fails the save. A
 * backup that can not be written never fails the save (it is written after
 * the notes). Saved notes that can not be read are copied as they are to
 * "<notes file>.notes.unreadable.json" before they are replaced. A PDF
 * dropped from the recent files loses its backup (its notes and unreadable
 * copy stay); backups and unreadable copies older than 90 days go at startup.
 */
import type { NotesBackup, PdfFile, PlatformAdapter } from '@inkslide/annotate';
import {
  BACKUP_MIN_AGE_MS, BACKUP_SUFFIX, isUsableNotes, OLD_COPIES_MAX_AGE_DAYS, UNREADABLE_SUFFIX,
} from '@inkslide/annotate/io';
import { banner } from '../banner';
import { storedItem, storeItem } from '../dom';
import { createRecentFiles, type RecentFiles } from '../recent';
import { canWriteOpfs, opfsDir, safeFileName, writeOpfsFile } from './opfs';
import { createRecentStorage } from './recent-storage';

/** localStorage key prefix of notes. */
export const NOTES_KEY_PREFIX = 'inkslide-notes:';
const OPFS_DIR = 'notes';

/** The browser's platform adapter, with the recent files. */
export interface WebAdapter extends PlatformAdapter {
  platform: 'web';
  fromFile(file: File): Promise<PdfFile>;
  /** PdfFile for a handle (launchQueue); the handle is remembered with it. */
  fromHandle(handle: FileSystemFileHandle): Promise<PdfFile>;
  opened(file: PdfFile, info: { sha256: string; pages: number }): Promise<void>;
  readonly recent: RecentFiles;
  /** Read a recent file (from a click: it may ask for permission). Rejects with a RecentError. */
  openRecent(id: string): Promise<PdfFile>;
}

/** A PdfFile read through the File System Access API keeps its handle (recent files). */
type WebPdfFile = PdfFile & { handle?: FileSystemFileHandle };

/** Storage key of a PDF's notes: its hash, else its name. */
export const notesKey = (pdf: Pick<PdfFile, 'name'>, sha256?: string): string =>
  NOTES_KEY_PREFIX + (sha256 || `name:${pdf.name}`);

const fileName = (key: string): string => safeFileName(key, '.json');

/** A file or directory that is not there (any other error is a real failure). */
const isNotFound = (e: unknown): boolean => (e as Error | null)?.name === 'NotFoundError';

/**
 * The notes in OPFS; an empty file (left by a failed write of an older build)
 * counts as none. Rejects if they are there but can not be read.
 */
async function opfsRead(key: string): Promise<string | null> {
  const dir = await opfsDir(OPFS_DIR);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(fileName(key));
    return (await (await handle.getFile()).text()) || null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function opfsWrite(key: string, text: string): Promise<boolean> {
  const dir = canWriteOpfs() ? await opfsDir(OPFS_DIR) : null;
  return !!dir && writeOpfsFile(dir, fileName(key), text);
}

async function opfsRemove(key: string): Promise<void> {
  const dir = await opfsDir(OPFS_DIR);
  if (!dir) return;
  try {
    await dir.removeEntry(fileName(key));
  } catch (_) { /* not there */ }
}

/**
 * The saved notes: OPFS first, then localStorage. If the OPFS file can not be
 * read, a localStorage copy is the newer notes (writeSaved puts them there when
 * OPFS fails, and removes it after an OPFS write); rejects only without one.
 */
async function readSaved(key: string): Promise<string | null> {
  let text: string | null;
  try {
    text = await opfsRead(key);
  } catch (e) {
    const stored = storedItem(key);
    if (stored !== null) return stored;
    throw e;
  }
  return text ?? storedItem(key);
}

/** Write the notes: OPFS, else localStorage (throws when full). */
async function writeSaved(key: string, text: string): Promise<void> {
  if (await opfsWrite(key, text)) storeItem(key, null); // do not leave an older copy behind
  else {
    localStorage.setItem(key, text); // throws when full: autosave reports it and retries
    if (canWriteOpfs()) await opfsRemove(key); // an older OPFS copy would be read first
  }
}

// ── Backup and kept unreadable notes ───────────────────────────

const backupName = (key: string): string => safeFileName(key, BACKUP_SUFFIX);
const unreadableName = (key: string): string => safeFileName(key, UNREADABLE_SUFFIX);

/** The notes directory where the page can write it, else null (no backups there). */
const writableDir = async (): Promise<FileSystemDirectoryHandle | null> => (canWriteOpfs() ? opfsDir(OPFS_DIR) : null);

/**
 * Modification time of file `name` in `dir`, without reading it; -1 if it is
 * missing or empty (a failed write). Rejects on other errors.
 */
async function fileTime(dir: FileSystemDirectoryHandle, name: string): Promise<number> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return file.size > 0 ? file.lastModified : -1;
  } catch (e) {
    if (isNotFound(e)) return -1;
    throw e;
  }
}

/** The backup with its modification time; null if there is none (an empty file is a failed write). */
async function readBackupOf(key: string): Promise<NotesBackup | null> {
  const dir = await opfsDir(OPFS_DIR);
  if (!dir) return null;
  try {
    const file = await (await dir.getFileHandle(backupName(key))).getFile();
    const text = await file.text();
    return text ? { text, time: file.lastModified } : null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Delete the backup, quietly. Not the kept unreadable copy: it may be the
 * only copy of real notes (e.g. from a newer Inkslide); the startup sweep
 * deletes it after OLD_COPIES_MAX_AGE_DAYS.
 */
async function removeBackupOf(key: string): Promise<void> {
  const dir = await opfsDir(OPFS_DIR);
  if (dir) await dir.removeEntry(backupName(key)).catch(() => {});
}

/**
 * What a save should copy to the backup: the saved notes, if they are usable
 * (isUsableNotes) and the backup is missing or older than BACKUP_MIN_AGE_MS
 * (by its time only: the backup itself is not read). Else null; always null
 * where the page can not write OPFS.
 */
async function backupDue(key: string, now = Date.now()): Promise<string | null> {
  const dir = await writableDir();
  if (!dir) return null;
  const time = await fileTime(dir, backupName(key));
  if (time >= 0 && now - time < BACKUP_MIN_AGE_MS) return null;
  const saved = await readSaved(key);
  return saved !== null && isUsableNotes(saved) ? saved : null;
}

/** Write the backup; false if it could not be written. */
async function writeBackup(key: string, text: string): Promise<boolean> {
  const dir = await writableDir();
  return !!dir && writeOpfsFile(dir, backupName(key), text);
}

/**
 * Save `text` as the notes, copying the notes it replaces to the backup when
 * one is due (backupDue). The backup is written after the notes, so near the
 * quota it never takes the room the notes need; a backup that can not be
 * read or written is logged and does not fail the save.
 */
async function saveWithBackup(key: string, text: string): Promise<void> {
  const before = await backupDue(key).catch(e => {
    console.warn('The notes backup failed', e);
    return null;
  });
  await writeSaved(key, text);
  if (before !== null && !(await writeBackup(key, before))) console.warn('The notes backup could not be written');
}

/**
 * Revert to Backup: the backup becomes the notes and the saved notes become
 * the backup (when usable), so a second revert undoes the first. Returns the
 * notes text now saved. Throws if there is no usable backup, or if the saved
 * notes can not be read (they would be lost). The saved notes go to the
 * backup first: if writing the notes then fails, they are still the notes,
 * and the backup is put back.
 */
async function revertToBackupOf(key: string): Promise<string> {
  const backup = (await readBackupOf(key))?.text ?? null;
  if (backup === null || !isUsableNotes(backup)) throw new Error('there is no usable backup of these notes');
  const dir = await writableDir();
  if (!dir) throw new Error('this browser can not write the backup');
  const saved = await readSaved(key);
  const swap = saved !== null && saved !== backup && isUsableNotes(saved);
  if (swap && !(await writeOpfsFile(dir, backupName(key), saved))) {
    throw new Error('the current notes could not be kept as the backup (storage full?)');
  }
  try {
    await writeSaved(key, backup);
  } catch (err) {
    if (swap && !(await writeOpfsFile(dir, backupName(key), backup))) {
      throw new Error(`${(err as Error).message || err}; the backup could not be put back (it now holds the current notes)`);
    }
    throw err;
  }
  return backup;
}

/**
 * The saved notes could not be read or loaded and are about to be replaced:
 * copy their text as it is to "<notes file>.notes.unreadable.json" (only the
 * latest copy is kept). Resolves with where it is, or null if there are no
 * notes; rejects if they can not be read or the copy can not be written.
 */
async function keepUnreadableOf(key: string): Promise<string | null> {
  const text = await readSaved(key);
  if (text === null) return null;
  const dir = await writableDir();
  if (!dir) throw new Error('this browser can not keep a copy');
  const name = unreadableName(key);
  if (!(await writeOpfsFile(dir, name, text))) throw new Error('the copy could not be written (storage full?)');
  return `${OPFS_DIR}/${name} in the browser's storage for this site`;
}

/**
 * At startup: delete backups and kept unreadable copies older than
 * OLD_COPIES_MAX_AGE_DAYS (backups of PDFs dropped from the recent files are
 * already gone; this catches the others). Returns the names deleted.
 * Nothing where the directory can not be listed. Each file's time is read
 * again just before it is deleted: a save may have rewritten it since the
 * listing.
 */
export async function cleanupNotesStore(now = Date.now()): Promise<string[]> {
  const dir = await opfsDir(OPFS_DIR);
  const values = (dir as { values?(): AsyncIterable<FileSystemHandle> } | null)?.values;
  if (!dir || typeof values !== 'function') return [];
  const before = now - OLD_COPIES_MAX_AGE_DAYS * 24 * 60 * 60_000;
  const old: string[] = [];
  for await (const h of values.call(dir)) {
    if (h.kind !== 'file' || !(h.name.endsWith(BACKUP_SUFFIX) || h.name.endsWith(UNREADABLE_SUFFIX))) continue;
    if ((await (h as FileSystemFileHandle).getFile()).lastModified < before) old.push(h.name);
  }
  // Removed after the listing: changing a directory while it is listed is not well defined.
  const removed: string[] = [];
  for (const name of old) {
    try {
      if ((await (await dir.getFileHandle(name)).getFile()).lastModified >= before) continue; // written since
      await dir.removeEntry(name);
      removed.push(name);
    } catch (_) { /* gone already, or busy: next time */ }
  }
  return removed;
}

/** Let the user pick one file; null if cancelled. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let done = false;
    const finish = (f: File | null): void => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener('change', () => finish(input.files && input.files[0] || null));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

async function fromFile(file: File): Promise<PdfFile> {
  return { path: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

type OpenPicker = (opts: unknown) => Promise<FileSystemFileHandle[]>;
type SavePicker = (opts: unknown) => Promise<FileSystemFileHandle>;
const PDF_TYPES = [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }];

const openPicker = (): OpenPicker | undefined => (window as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;

/** The user cancelled a dialog or the share sheet. */
const isAbort = (e: unknown): boolean => (e as Error | null)?.name === 'AbortError';

function download(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** How long the "tap to share" banner waits (it holds the exported PDF). */
const SHARE_WAIT_MS = 120_000;

/**
 * Hand the PDF to the share sheet (touch devices without a save dialog:
 * iPad "Save to Files", Android). null: no share sheet for files here, or it failed.
 * The share sheet needs a recent tap, which a long export may outlast:
 * then a banner asks for one. null also when the share sheet failed.
 */
async function share(bytes: Uint8Array, name: string): Promise<boolean | null> {
  if (!(navigator.maxTouchPoints > 0) || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return null;
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/pdf' });
  if (!navigator.canShare({ files: [file] })) return null;
  const run = (): Promise<boolean> => navigator.share({ files: [file] }).then(() => true, (e: Error) => {
    if (isAbort(e)) return false;
    throw e;
  });
  try {
    return await run();
  } catch (e) {
    if ((e as Error).name !== 'NotAllowedError') return null; // the share sheet failed: download instead
  }
  return new Promise<boolean | null>(resolve => {
    banner(`${name} is ready.`, 'info', SHARE_WAIT_MS, {
      // Failing even with a fresh tap: sharing is blocked here (permissions policy).
      action: { label: 'Save or share…', run: () => void run().catch(() => null).then(resolve) },
      onClose: () => resolve(false),
    });
  });
}

/** The platform adapter of the browser build. */
export function createWebAdapter(): WebAdapter {
  // A PDF dropped from the recent files (evicted, or removed by the user) loses
  // its backup; old backups of other PDFs and old unreadable copies go at startup.
  const storage = createRecentStorage();
  const recent = createRecentFiles({
    ...storage,
    async remove(id) {
      await storage.remove(id);
      await removeBackupOf(NOTES_KEY_PREFIX + id);
    },
  });
  void cleanupNotesStore().catch(e => console.warn('Cleaning up old notes backups failed', e));

  async function fromHandle(handle: FileSystemFileHandle): Promise<WebPdfFile> {
    return { ...(await fromFile(await handle.getFile())), handle };
  }

  return {
    platform: 'web',
    fromFile,
    fromHandle,
    recent,

    async opened(file, { sha256, pages }) {
      const { handle } = file as WebPdfFile;
      const info = { id: sha256, name: file.name, pages, size: file.bytes.byteLength };
      try {
        await recent.remember(info, handle ? { handle } : { bytes: file.bytes });
      } catch (e) {
        console.warn('Could not remember the recent file', e); // e.g. IndexedDB blocked (private browsing)
      }
    },

    async openRecent(id) {
      const { name, bytes, handle } = await recent.load(id);
      return { path: null, name, bytes, handle } satisfies WebPdfFile;
    },

    async openPdf(path) {
      if (path) {
        // A URL (?pdf=…); the web has no file system paths. Same site only: the
        // page's CSP (connect-src, see vite.config.ts) allows nothing else.
        const url = new URL(path, location.href);
        if (url.origin !== location.origin) throw new Error(`only PDFs from this site can be opened by link, not ${url.origin}`);
        const res = await fetch(url.href);
        if (!res.ok) throw new Error(`could not load ${path} (${res.status})`);
        const name = decodeURIComponent(new URL(res.url || url.href).pathname.split('/').pop() || 'document.pdf');
        return { path: null, name, bytes: new Uint8Array(await res.arrayBuffer()) };
      }
      const picker = openPicker();
      if (typeof picker === 'function') {
        try {
          const [handle] = await picker({ types: PDF_TYPES, multiple: false });
          return handle ? fromHandle(handle) : null;
        } catch (e) {
          if (isAbort(e)) return null;
          // Blocked (cross-origin frame, permissions policy): the file input still works.
          console.warn('The open dialog is not available, using a file input', e);
        }
      }
      const file = await pickFile('application/pdf,.pdf');
      return file ? fromFile(file) : null;
    },

    readNotes: (pdf, sha256) => readSaved(notesKey(pdf, sha256)),

    writeNotes: (pdf, text, sha256) => saveWithBackup(notesKey(pdf, sha256), text),

    readBackup: (pdf, sha256) => readBackupOf(notesKey(pdf, sha256)),

    revertToBackup: (pdf, sha256) => revertToBackupOf(notesKey(pdf, sha256)),

    keepUnreadableNotes: (pdf, sha256) => keepUnreadableOf(notesKey(pdf, sha256)),

    async exportPdf(bytes, suggestedName) {
      const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      if (typeof picker === 'function') {
        let handle: FileSystemFileHandle;
        try {
          handle = await picker({ suggestedName, types: PDF_TYPES });
        } catch (e) {
          if (isAbort(e)) return false;
          throw e;
        }
        const w = await handle.createWritable();
        await w.write(bytes as Uint8Array<ArrayBuffer>);
        await w.close();
        return true;
      }
      const shared = await share(bytes, suggestedName);
      if (shared !== null) return shared;
      download(bytes, suggestedName);
      return true;
    },

    async importNotes() {
      const file = await pickFile('application/json,.json');
      return file ? { name: file.name, text: await file.text() } : null;
    },

    async confirm(message) {
      return window.confirm(message);
    },
  };
}
