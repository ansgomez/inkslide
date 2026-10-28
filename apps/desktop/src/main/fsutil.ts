/* Inkslide desktop - file helpers (no Electron) */
import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, type FileHandle, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
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
 * Flags for opening a file to read. O_NONBLOCK: opening a FIFO does not wait
 * for a writer (it is then refused as not a file); regular files ignore it.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * The whole content of the open file `fh`, which must be a regular file
 * (not a FIFO or a device such as /dev/zero) of at most `maxBytes`. The size
 * comes from the handle (fstat), and the read stops there: a file that grows
 * meanwhile is refused, one that shrinks gives what it has. `name` is for the errors.
 */
async function readHandle(fh: FileHandle, name: string, maxBytes: number, st?: Stats): Promise<Buffer> {
  st ??= await fh.stat();
  if (!st.isFile()) throw new Error(`${name} is not a file`);
  if (st.size > maxBytes) throw new Error(`${name} is too large`);
  // Not pooled, zero-filled: the bytes may cross IPC as a view, which clones its whole ArrayBuffer.
  const buf = Buffer.alloc(st.size);
  let n = 0;
  while (n < buf.length) {
    const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
    if (!bytesRead) break;
    n += bytesRead;
  }
  if (n === buf.length && (await fh.read(Buffer.alloc(1), 0, 1, n)).bytesRead) throw new Error(`${name} changed while it was read`);
  return buf.subarray(0, n);
}

/**
 * Bytes of `file`, or null if it does not exist (also a dangling link). A
 * symlink is followed only if `follow` allows its target, else this throws
 * RefusedLinkError without opening the target. The link is resolved once;
 * the file checked is then opened without following links (O_NOFOLLOW where
 * the OS has it) and read through that handle only if it is still the same
 * file (device and inode), so a link swapped in meanwhile is not read. Only
 * a regular file of at most `maxBytes` is read (readHandle).
 */
export async function readFileChecked(file: string, follow: FollowLink = () => true, maxBytes = MAX_TEXT_BYTES): Promise<Buffer | null> {
  try {
    let path = file;
    let checked = await lstat(file, { bigint: true });
    if (checked.isSymbolicLink()) {
      path = await realpath(file);
      checked = await lstat(path, { bigint: true }); // the file `follow` decides on
      if (!follow(path)) throw new RefusedLinkError(file, path);
    }
    if (!checked.isFile()) throw new Error(`${basename(file)} is not a file`);
    const fh = await open(path, READ_FLAGS | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await fh.stat({ bigint: true });
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw new Error(`${basename(file)} changed while it was read`);
      return await readHandle(fh, basename(file), maxBytes);
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Bytes of `file` (links followed: the user chose it) and its size and
 * modification time, opened once: the file whose type and size are checked
 * is the one read, a regular file of at most `maxBytes` (readHandle). For
 * PDFs and imported notes.
 */
export async function readFileLimited(file: string, maxBytes: number): Promise<{ bytes: Buffer; size: number; mtimeMs: number }> {
  const fh = await open(file, READ_FLAGS);
  try {
    const st = await fh.stat();
    return { bytes: await readHandle(fh, basename(file), maxBytes, st), size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    await fh.close();
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

/**
 * Write an exported PDF to `file` (from the save dialog), crash-safe. Never
 * over `openPdf`, the PDF that is open (also not through a link or another
 * spelling). A symlink at `file` is replaced by the export, not written
 * through: its target may be any file (a link in a downloaded folder).
 */
export async function writeExport(file: string, bytes: Uint8Array, openPdf: string | null): Promise<void> {
  if (openPdf && await sameFile(file, openPdf)) {
    throw new Error('The export cannot replace the PDF that is open; choose another name.');
  }
  await writeFileAtomic(file, bytes, () => false);
}

/** Create `dir` and its parents if needed. */
export const ensureDir = (dir: string): Promise<string | undefined> => mkdir(dir, { recursive: true });
