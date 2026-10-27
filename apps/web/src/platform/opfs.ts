/* Inkslide web - Origin Private File System helpers (notes, recent-file copies) */

/** A storage key as a file name: anything but [A-Za-z0-9_-] becomes '_'. */
export const safeFileName = (key: string, ext: string): string => `${key.replace(/[^A-Za-z0-9_-]/g, '_')}${ext}`;

/**
 * Directory `name` in the origin's OPFS (created); null where there is none.
 * strict: only "no OPFS here" (SecurityError: private browsing, file://
 * origin) is null; other failures reject (a read must not take them for
 * "no notes").
 */
export async function opfsDir(name: string, strict = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  } catch (e) {
    if (strict && (e as Error | null)?.name !== 'SecurityError') throw e;
    return null; // e.g. private browsing, file:// origin
  }
}

/**
 * Whether the page can write OPFS files (createWritable: Chromium, Firefox,
 * Safari 26+; Safari 17-18 has OPFS but can write it only from a worker).
 * False without FileSystemFileHandle (no OPFS at all).
 */
export function canWriteOpfs(): boolean {
  return typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
}

/**
 * Write a file through createWritable() (a swap file, applied on close()).
 * Checks for createWritable first: a file created that can not be written
 * would stay behind empty. Resolves false if it could not be written.
 */
export async function writeOpfsFile(dir: FileSystemDirectoryHandle, name: string, data: string | Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (!canWriteOpfs()) return false;
  try {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(data);
    await w.close();
    return true;
  } catch (_) {
    return false;
  }
}
