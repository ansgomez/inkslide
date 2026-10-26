/* Inkslide desktop - reading and writing a PDF's notes (no Electron)
 *
 * Notes live in the sidecar "<name>.pdf.notes.json" next to the PDF. When the
 * PDF has no path or the sidecar cannot be written, they go to app storage,
 * userData/notes/<sha256>.notes.json, with userData/notes/<sha256>.sidecar.json
 * saying which sidecar they replace and what it held. Reading takes the newer.
 *
 * The backup is always in app storage, userData/notes/<sha256>.notes.backup.json:
 * before a save replaces the notes, the saved notes are copied there if they
 * are valid and not empty and the backup is missing or older than 2 minutes.
 * Revert to Backup swaps the two, so a second revert undoes the first.
 *
 * A notes file that could not be read is copied as it is to
 * userData/notes/<sha256>.notes.unreadable.json before the app replaces it
 * (keepUnreadableFor). Backups and kept copies older than
 * OLD_COPIES_MAX_AGE_DAYS are deleted at startup (cleanupNotesStore).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BACKUP_SUFFIX, notesPathFor, parseNotes, type NotesBackup } from '@inkslide/annotate/io';
import { canWriteIn, ensureDir, readTextIfExists, writeFileAtomic } from './fsutil';
import { fallbackBackupPath, fallbackNotesPath, isSha256, isStorageName, NOTES_DIR, sidecarStatePath, UNREADABLE_SUFFIX, unreadableNotesPath } from './paths';

/** The PDF whose notes are read or written. */
export interface NotesTarget {
  /** Absolute PDF path, or null (no file system path). */
  path: string | null;
  /** Hex SHA-256 of the PDF, if the caller has it. */
  sha256?: string;
  /** PDF bytes, used to compute the hash when neither sha256 nor path is there. */
  bytes?: Uint8Array;
}

/** Hex SHA-256 of `bytes`. */
export const sha256OfBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function hashOf(t: NotesTarget): Promise<string> {
  if (t.sha256 !== undefined) {
    if (!isSha256(t.sha256)) throw new Error('invalid sha256');
    return t.sha256;
  }
  if (t.bytes) return sha256OfBytes(t.bytes);
  if (t.path) return sha256OfBytes(await readFile(t.path));
  throw new Error('notes need a PDF path, its sha256 or its bytes');
}

/** The PDF's hash if it can be known (a path, a sha256 or bytes), else null. */
const hashIfKnown = (t: NotesTarget): Promise<string | null> =>
  (t.path || t.sha256 !== undefined || t.bytes ? hashOf(t) : Promise.resolve(null));

/**
 * Write `text` crash-safe to `beside` (next to the PDF) if given and its folder
 * is writable, else, or if that write fails, to the app-storage file `stored()`
 * (its folder created). Returns the file written; throws the first error.
 */
async function writeBesideOrStored(beside: string | null, stored: () => Promise<string>, text: string): Promise<string> {
  let besideError: unknown;
  if (beside && await canWriteIn(dirname(beside), beside)) {
    try {
      await writeFileAtomic(beside, text);
      return beside;
    } catch (err) {
      besideError = err;
    }
  }
  try {
    const file = await stored();
    await ensureDir(dirname(file));
    await writeFileAtomic(file, text);
    return file;
  } catch (err) {
    throw besideError ?? err;
  }
}

/** Where notes are written: the sidecar if its folder is writable, else app storage. */
export async function notesWritePath(t: NotesTarget, userData: string): Promise<string> {
  if (t.path) {
    const sidecar = notesPathFor(t.path);
    if (await canWriteIn(dirname(sidecar), sidecar)) return sidecar;
  }
  return fallbackNotesPath(userData, await hashOf(t));
}

/** Modification time of a file in ms, or -1 if it does not exist. */
async function mtimeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return -1;
    throw err;
  }
}

/**
 * What app-storage notes were written instead of (userData/notes/<sha256>.sidecar.json):
 * the sidecar and the SHA-256 of its text then (null: missing or unreadable).
 */
interface SidecarState {
  sidecar: string;
  sha256: string | null;
}

/** SHA-256 of the sidecar's text, null if it is missing or cannot be read. */
const sidecarHash = (sidecar: string): Promise<string | null> =>
  readFile(sidecar).then(sha256OfBytes, () => null);

/** The record in `file`; null if it is missing or broken. */
async function readSidecarState(file: string): Promise<SidecarState | null> {
  try {
    const d = JSON.parse(await readFile(file, 'utf8')) as Partial<SidecarState> | null;
    const ok = d && typeof d.sidecar === 'string' && (d.sha256 === null || isSha256(d.sha256));
    return ok ? { sidecar: d.sidecar!, sha256: d.sha256! } : null;
  } catch (_) {
    return null;
  }
}

/**
 * Whether app storage holds the newer notes. It does if they were written
 * instead of this sidecar and the sidecar has not changed since (a later
 * sidecar write or a restored backup wins, whatever its time). Otherwise,
 * e.g. for notes written without a path or before this was recorded, the
 * newer file wins, the sidecar on a tie.
 */
async function appStorageFirst(sidecar: string, stored: string, state: string): Promise<boolean> {
  const s = await readSidecarState(state);
  if (s && s.sidecar === sidecar) return (await sidecarHash(sidecar)) === s.sha256;
  return (await mtimeOf(stored)) > (await mtimeOf(sidecar));
}

/**
 * Notes text: from the sidecar or app storage, whichever is newer (see
 * appStorageFirst); null if there are none. Both can exist when the sidecar
 * could not be written for a while: the newest notes are then in app storage.
 */
export async function readNotesFor(t: NotesTarget, userData: string): Promise<string | null> {
  return (await readSaved(t, userData))?.text ?? null;
}

/** The saved notes, as readNotesFor reads them, and the file they come from; null if there are none. */
async function readSaved(t: NotesTarget, userData: string): Promise<{ file: string; text: string } | null> {
  for (const file of await savedCandidates(t, userData)) {
    const text = await readTextIfExists(file);
    if (text !== null) return { file, text };
  }
  return null;
}

/** The files the saved notes can be in, the one read first first. */
async function savedCandidates(t: NotesTarget, userData: string): Promise<string[]> {
  const sidecar = t.path ? notesPathFor(t.path) : null;
  const sha = await hashIfKnown(t);
  const stored = sha ? fallbackNotesPath(userData, sha) : null;
  const storedFirst = sidecar && sha && stored ? await appStorageFirst(sidecar, stored, sidecarStatePath(userData, sha)) : !sidecar;
  return (storedFirst ? [stored, sidecar] : [sidecar, stored]).filter((f): f is string => !!f);
}

/**
 * Write the notes crash-safe; returns the file written. If the sidecar
 * cannot be written (not writable, or the write fails), they go to app
 * storage, with a record of the sidecar they replace (see appStorageFirst).
 * With `backup`, the saved notes are copied to the backup first (see
 * backupBeforeSave); a failed copy is logged and does not stop the save.
 */
export async function writeNotesFor(t: NotesTarget, text: string, userData: string, backup = false): Promise<string> {
  if (backup) {
    await backupBeforeSave(t, userData).catch(err => console.warn(`notes backup failed: ${(err as Error).message}`));
  }
  const sidecar = t.path ? notesPathFor(t.path) : null;
  let sha = '';
  const file = await writeBesideOrStored(sidecar, async () => fallbackNotesPath(userData, sha = await hashOf(t)), text);
  if (sidecar && file !== sidecar) {
    const state = sidecarStatePath(userData, sha);
    const record: SidecarState = { sidecar, sha256: await sidecarHash(sidecar) };
    const old = await readSidecarState(state);
    // Rewritten only when it changes (autosave runs every few seconds). Without
    // a record the newer file wins, which here is app storage too.
    if (old?.sidecar !== record.sidecar || old.sha256 !== record.sha256) {
      await writeFileAtomic(state, JSON.stringify(record)).catch(() => rm(state, { force: true }).catch(() => {}));
    }
  }
  return file;
}

// ── Backup ─────────────────────────────────────────────────────

/** The backup is refreshed by a save only when it is at least this old. */
export const BACKUP_MIN_AGE_MS = 2 * 60_000;

/** Whether `text` is a notes file that loads and has something in it (strokes or blank pages). */
export function isUsableNotes(text: string): boolean {
  try {
    return parseNotes(text).pages.some(p => !!p && (p.kind === 'blank' || (Array.isArray(p.strokes) && p.strokes.length > 0)));
  } catch (_) {
    return false;
  }
}

/** The backup file of the PDF in app storage; null if its hash cannot be known. */
async function backupPath(t: NotesTarget, userData: string): Promise<string | null> {
  const sha = await hashIfKnown(t);
  return sha ? fallbackBackupPath(userData, sha) : null;
}

/**
 * Before a save: copy the saved notes to the backup if they are usable
 * (isUsableNotes) and the backup is missing or older than BACKUP_MIN_AGE_MS.
 * Returns whether it copied. An unreadable or empty notes file is never copied.
 */
export async function backupBeforeSave(t: NotesTarget, userData: string, now = Date.now()): Promise<boolean> {
  const file = await backupPath(t, userData);
  if (!file) return false;
  const time = await mtimeOf(file);
  if (time >= 0 && now - time < BACKUP_MIN_AGE_MS) return false;
  const saved = await readSaved(t, userData).catch(() => null);
  if (!saved || !isUsableNotes(saved.text)) return false;
  await ensureDir(dirname(file));
  await writeFileAtomic(file, saved.text);
  return true;
}

/** The backup with its modification time; null if there is none. */
export async function readBackupFor(t: NotesTarget, userData: string): Promise<NotesBackup | null> {
  const file = await backupPath(t, userData);
  const time = file ? await mtimeOf(file) : -1;
  const text = time >= 0 ? await readTextIfExists(file!) : null;
  return text === null ? null : { text, time };
}

/** Whether the PDF has a backup (File → Revert to Backup… is enabled). */
export const hasBackup = async (t: NotesTarget, userData: string): Promise<boolean> => {
  const file = await backupPath(t, userData);
  return !!file && (await mtimeOf(file)) >= 0;
};

/**
 * Revert to Backup: the backup becomes the notes and the saved notes become
 * the backup (when usable), so a second revert undoes the first. Returns the
 * notes text now saved. Throws if there is no usable backup. The saved notes
 * go to the backup first: if writing the notes then fails, they are still
 * the notes, and the backup is put back.
 */
export async function revertToBackupFor(t: NotesTarget, userData: string): Promise<string> {
  const file = await backupPath(t, userData);
  const backup = file ? await readTextIfExists(file) : null;
  if (backup === null || !isUsableNotes(backup)) throw new Error('there is no usable backup of these notes');
  const saved = await readSaved(t, userData);
  const swap = !!saved && saved.text !== backup && isUsableNotes(saved.text);
  if (swap) await writeFileAtomic(file!, saved!.text);
  try {
    await writeNotesFor(t, backup, userData);
  } catch (err) {
    if (swap) await writeFileAtomic(file!, backup).catch(() => {});
    throw err;
  }
  return backup;
}

/** Older development builds wrote "<name>.pdf.notes.backup.json" next to the PDF: delete it, quietly. */
export const removeLegacyBackup = (pdfPath: string): Promise<void> =>
  rm(`${pdfPath}.notes.backup.json`, { force: true }).catch(() => {});

/**
 * The saved notes could not be read or loaded and are about to be replaced
 * (by the backup, or by new notes): copy the file as it is, unparsed, to
 * userData/notes/<sha256>.notes.unreadable.json (only the latest copy is
 * kept). Returns the copy, or null if there is no notes file.
 */
export async function keepUnreadableFor(t: NotesTarget, userData: string): Promise<string | null> {
  for (const file of await savedCandidates(t, userData)) {
    if ((await mtimeOf(file)) < 0) continue;
    const copy = unreadableNotesPath(userData, await hashOf(t));
    await ensureDir(dirname(copy));
    await writeFileAtomic(copy, await readFile(file));
    return copy;
  }
  return null;
}

/** Backups and kept unreadable copies older than this are deleted at startup. */
export const OLD_COPIES_MAX_AGE_DAYS = 90;

/** Delete the files "<sha256><suffix>" in userData/notes (with `olderThan`: only those last changed before it). */
async function removeMatching(userData: string, suffix: string, olderThan = Infinity): Promise<string[]> {
  const dir = join(userData, NOTES_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const removed: string[] = [];
  for (const name of names.filter(n => isStorageName(n, suffix))) {
    const file = join(dir, name);
    if (olderThan !== Infinity && (await mtimeOf(file)) >= olderThan) continue;
    await rm(file, { force: true });
    removed.push(file);
  }
  return removed;
}

/** At startup: delete backups and unreadable copies older than OLD_COPIES_MAX_AGE_DAYS. Returns what was deleted. */
export async function cleanupNotesStore(userData: string, now = Date.now()): Promise<string[]> {
  const before = now - OLD_COPIES_MAX_AGE_DAYS * 24 * 60 * 60_000;
  return [
    ...await removeMatching(userData, BACKUP_SUFFIX, before),
    ...await removeMatching(userData, UNREADABLE_SUFFIX, before),
  ];
}

/** Backups turned off: delete every PDF's backup (the unreadable copies stay). */
export const removeAllBackups = (userData: string): Promise<string[]> => removeMatching(userData, BACKUP_SUFFIX);
