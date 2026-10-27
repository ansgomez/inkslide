/* Inkslide desktop - file helpers (no Electron) */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Write a file crash-safe: temp file in the same directory, fsync, rename
 * over the target, then fsync the directory (POSIX). A crash leaves either
 * the old or the new content, never a partial file. A symlink is written
 * through (the link stays), and a file that is replaced keeps its permissions.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const file = await realpath(path).catch(() => path);
  const dir = dirname(file);
  const old = await stat(file).catch(() => null);
  // Short stem: the temp name must fit the 255-byte limit when the target's name nearly does.
  const tmp = join(dir, `.${basename(file).slice(0, 40)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o644);
  try {
    try {
      if (old && process.platform !== 'win32') await fh.chmod(old.mode & 0o7777);
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameRetrying(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  if (process.platform !== 'win32') {
    // Persist the rename itself; not all file systems allow it, which is fine.
    const dh = await open(dir, 'r').catch(() => null);
    if (dh) await dh.sync().catch(() => {}).finally(() => dh.close());
  }
}

/** Windows: the waits before each new rename attempt (about 0.7 s in all). */
const RENAME_RETRY_MS = [50, 100, 150, 200, 200];
/** Errors Windows gives while another program (antivirus, indexer, OneDrive) has the file open. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * rename(from, to). On Windows a target that another program holds open
 * for a moment fails the rename (EPERM, EBUSY, EACCES); it is tried again a
 * few times before giving up, so the notes do not move to app storage for that.
 */
export async function renameRetrying(
  from: string, to: string, platform: NodeJS.Platform = process.platform,
  doRename: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await doRename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (platform !== 'win32' || i >= RENAME_RETRY_MS.length || !BUSY_CODES.has(code)) throw err;
      await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS[i]));
    }
  }
}

/** Whether new files can be created in `dir` (and `file`, if it exists, overwritten). */
export async function canWriteIn(dir: string, file?: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK | constants.X_OK);
    if (file) {
      try {
        await access(file, constants.W_OK);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

/** Text of a file, or null if it does not exist. */
export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Whether `a` and `b` are the same file, also through links or another
 * spelling (letter case on macOS and Windows); false if either is missing.
 */
export async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch (_) {
    return false;
  }
}

/** Create `dir` and its parents if needed. */
export const ensureDir = (dir: string): Promise<string | undefined> => mkdir(dir, { recursive: true });
