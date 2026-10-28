/* Inkslide desktop - file helpers (no Electron) */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Largest PDF that is read (open, recent files) or taken from the page (export, print). */
export const MAX_PDF_BYTES = 2 ** 31 - 1;
/** Largest notes file that is read or written, in bytes (UTF-8). */
export const MAX_TEXT_BYTES = 256 * 2 ** 20;

/** Whether a symlink to `target` (resolved) may be followed. */
export type FollowLink = (target: string) => boolean;

/**
 * The file that reading or writing `path` should use: the file a symlink at
 * `path` points to (resolved, as realpath does) if `follow` allows it, else
 * `path` itself. `path` too if it is missing or a dangling link.
 */
async function linkTarget(path: string, follow: FollowLink = () => true): Promise<string> {
  const real = await realpath(path).catch(() => null);
  return real !== null && follow(real) ? real : path;
}

/** The target of a symlink at `path` that `follow` does not allow; null if there is no such link. */
export async function refusedLink(path: string, follow: FollowLink = () => true): Promise<string | null> {
  if (!await lstat(path).then(s => s.isSymbolicLink(), () => false)) return null;
  const real = await realpath(path).catch(() => null); // null: dangling, as good as missing
  return real !== null && !follow(real) ? real : null;
}

/**
 * Write a file crash-safe: temp file in the same directory, fsync, rename
 * over the target, then fsync the directory (POSIX). A crash leaves either
 * the old or the new content, never a partial file. A symlink is written
 * through (the link stays) if `follow` allows its target, else the link
 * itself is replaced by the file. A file that is replaced keeps its permissions.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, follow?: FollowLink): Promise<void> {
  const file = await linkTarget(path, follow);
  const dir = dirname(file);
  // lstat: a link that is replaced must not give its target's permissions (or its own 0777) to the file.
  const old = await lstat(file).catch(() => null);
  // Short stem: the temp name must fit the 255-byte limit when the target's name nearly does.
  const tmp = join(dir, `.${basename(file).slice(0, 40)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o644);
  try {
    try {
      if (old?.isFile() && process.platform !== 'win32') await fh.chmod(old.mode & 0o7777);
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

/**
 * Whether new files can be created in `dir` (and `file`, if it exists, overwritten).
 * A symlink `file` that `follow` does not allow is replaced, not written through,
 * so only `dir` counts then.
 */
export async function canWriteIn(dir: string, file?: string, follow?: FollowLink): Promise<boolean> {
  try {
    await access(dir, constants.W_OK | constants.X_OK);
    if (file && !await refusedLink(file, follow)) {
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

/** A symlink that is not followed: nothing of its target is read. */
export class RefusedLinkError extends Error {
  constructor(file: string, readonly target: string) {
    super(`${basename(file)} is a link to ${target}, which is not followed`);
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Bytes of `file`, or null if it does not exist (also a dangling link). A
 * symlink is followed only if `follow` allows its target, else this throws
 * RefusedLinkError without opening the target. The link is resolved once;
 * the file checked is then opened without following links (O_NOFOLLOW where
 * the OS has it) and read through that handle only if it is still the same
 * file (device and inode), so a link swapped in meanwhile is not read.
 */
export async function readFileChecked(file: string, follow: FollowLink = () => true): Promise<Buffer | null> {
  try {
    let path = file;
    let checked = await lstat(file, { bigint: true });
    if (checked.isSymbolicLink()) {
      path = await realpath(file);
      checked = await lstat(path, { bigint: true }); // the file `follow` decides on
      if (!follow(path)) throw new RefusedLinkError(file, path);
    }
    const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await fh.stat({ bigint: true });
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw new Error(`${basename(file)} changed while it was read`);
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Text of a file, or null if it does not exist; links as readFileChecked. */
export async function readTextIfExists(file: string, follow?: FollowLink): Promise<string | null> {
  return (await readFileChecked(file, follow))?.toString('utf8') ?? null;
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
