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
 * backup that can not be written never fails the save. A PDF dropped from the
 * recent files loses its backup (its notes stay).
 */
import type { NotesBackup, PdfFile, PlatformAdapter } from '@inkslide/annotate';
import { BACKUP_MIN_AGE_MS, BACKUP_SUFFIX, isUsableNotes } from '@inkslide/annotate/io';
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

/** The notes in OPFS; an empty file (left by a failed write of an older build) counts as none. */
async function opfsRead(key: string): Promise<string | null> {
  const dir = await opfsDir(OPFS_DIR);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(fileName(key));
    return (await (await handle.getFile()).text()) || null;
  } catch (_) {
    return null;
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

/** The saved notes: OPFS first, then localStorage. */
const readSaved = async (key: string): Promise<string | null> => (await opfsRead(key)) ?? storedItem(key);

/** Write the notes: OPFS, else localStorage (throws when full). */
async function writeSaved(key: string, text: string): Promise<void> {
  if (await opfsWrite(key, text)) storeItem(key, null); // do not leave an older copy behind
  else {
    localStorage.setItem(key, text); // throws when full: autosave reports it and retries
    if (canWriteOpfs()) await opfsRemove(key); // an older OPFS copy would be read first
  }
}

// ── Backup ─────────────────────────────────────────────────────

const backupName = (key: string): string => safeFileName(key, BACKUP_SUFFIX);

/** The backup with its modification time; null if there is none (an empty file is a failed write). */
async function readBackupOf(key: string): Promise<NotesBackup | null> {
  const dir = await opfsDir(OPFS_DIR);
  if (!dir) return null;
  try {
    const file = await (await dir.getFileHandle(backupName(key))).getFile();
    const text = await file.text();
    return text ? { text, time: file.lastModified } : null;
  } catch (_) {
    return null;
  }
}

/** Delete the backup, quietly. */
async function removeBackupOf(key: string): Promise<void> {
  const dir = await opfsDir(OPFS_DIR);
  if (dir) await dir.removeEntry(backupName(key)).catch(() => {});
}

/**
 * Before a save: copy the saved notes to the backup if they are usable
 * (isUsableNotes) and the backup is missing or older than BACKUP_MIN_AGE_MS.
 * Returns whether it copied. Only where the page can write OPFS.
 */
async function backupBeforeSave(key: string, now = Date.now()): Promise<boolean> {
  const dir = canWriteOpfs() ? await opfsDir(OPFS_DIR) : null;
  if (!dir) return false;
  const old = await readBackupOf(key);
  if (old && now - old.time < BACKUP_MIN_AGE_MS) return false;
  const saved = await readSaved(key);
  if (saved === null || !isUsableNotes(saved)) return false;
  return writeOpfsFile(dir, backupName(key), saved);
}

/**
 * Revert to Backup: the backup becomes the notes and the saved notes become
 * the backup (when usable), so a second revert undoes the first. Returns the
 * notes text now saved. Throws if there is no usable backup. The saved notes
 * go to the backup first: if writing the notes then fails, they are still
 * the notes, and the backup is put back.
 */
async function revertToBackupOf(key: string): Promise<string> {
  const backup = (await readBackupOf(key))?.text ?? null;
  if (backup === null || !isUsableNotes(backup)) throw new Error('there is no usable backup of these notes');
  const dir = canWriteOpfs() ? await opfsDir(OPFS_DIR) : null;
  if (!dir) throw new Error('this browser can not write the backup');
  const saved = await readSaved(key);
  const swap = saved !== null && saved !== backup && isUsableNotes(saved);
  if (swap && !(await writeOpfsFile(dir, backupName(key), saved))) {
    throw new Error('the current notes could not be kept as the backup (storage full?)');
  }
  try {
    await writeSaved(key, backup);
  } catch (err) {
    if (swap) await writeOpfsFile(dir, backupName(key), backup);
    throw err;
  }
  return backup;
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
  // A PDF dropped from the recent files (evicted, or removed by the user) loses its backup.
  const storage = createRecentStorage();
  const recent = createRecentFiles({
    ...storage,
    async remove(id) {
      await storage.remove(id);
      await removeBackupOf(NOTES_KEY_PREFIX + id);
    },
  });

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

    async writeNotes(pdf, text, sha256) {
      const key = notesKey(pdf, sha256);
      await backupBeforeSave(key).catch(e => console.warn('The notes backup failed', e));
      await writeSaved(key, text);
    },

    readBackup: (pdf, sha256) => readBackupOf(notesKey(pdf, sha256)),

    revertToBackup: (pdf, sha256) => revertToBackupOf(notesKey(pdf, sha256)),

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
