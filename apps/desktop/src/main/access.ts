/* Inkslide desktop - which PDF paths the renderer may read
 *
 * Paths the user chose: open dialog, command line, OS open requests, drops
 * (through the preload's pathForFile, which needs a real File object) and the
 * recent files list. The renderer cannot name arbitrary files. Main cannot
 * tell a real drop from a renderer that just sends a path, so a drop grants
 * only .pdf files (others open from their bytes, without a path).
 *
 * Notes are found by the PDF's hash, so the hashes are checked too
 * (HashGrants): only those main computed itself, from a PDF it read or from
 * the bytes of a PDF without a path, reach notes, backups or revert.
 */
import { resolve } from 'node:path';
import { MAX_PDF_BYTES, MAX_TEXT_BYTES } from './fsutil';
import { sha256OfBytes, type NotesTarget } from './notes';

/** Paths the renderer may read: granted ones plus those `extra` accepts (the recent files). */
export class PathGrants {
  private readonly granted = new Set<string>();

  constructor(private readonly extra: (path: string) => boolean = () => false) {}

  /** Allow `path`; returns it resolved. */
  grant(path: string): string {
    const p = resolve(path);
    this.granted.add(p);
    return p;
  }

  allows(path: string): boolean {
    const p = resolve(path);
    return this.granted.has(p) || this.extra(p);
  }
}

/** A path argument from IPC: a non-empty string without NUL bytes. */
export function checkPath(value: unknown, what = 'path'): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 4096) {
    throw new Error(`invalid ${what}`);
  }
  return value;
}

/** A dropped file's path from IPC (pathForFile): a valid path ending in .pdf. */
export function checkDroppedPdf(value: unknown): string {
  const p = checkPath(value, 'dropped file');
  if (!/\.pdf$/i.test(p)) throw new Error('only PDF files can be dropped with their path');
  return p;
}

/**
 * Notes text from IPC: a string of at most MAX_TEXT_BYTES in UTF-8 (what is
 * written), not in UTF-16 code units (`length`), which count a 3-byte
 * character once. The length check first: UTF-8 never has fewer bytes than code units.
 */
export function checkText(value: unknown, maxBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string') throw new Error('notes must be a string');
  if (value.length > maxBytes || Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error('notes too large');
  return value;
}

/** PDF bytes from IPC (export, print): a Uint8Array of at most `maxBytes`. */
export function checkPdfBytes(value: unknown, what: string, maxBytes = MAX_PDF_BYTES): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${what} bytes must be a Uint8Array`);
  if (value.byteLength > maxBytes) throw new Error(`${what}: the PDF is too large`);
  return value;
}

/**
 * PDF hashes the renderer may use for notes: those main computed, from a PDF
 * it read (readPdf) or from bytes the page sent. A hash alone, made up or of
 * a PDF never opened here, reaches no notes in app storage.
 */
export class HashGrants {
  private readonly granted = new Set<string>();

  /** Allow the hash of `bytes`; returns it. */
  grantBytes(bytes: Uint8Array): string {
    const sha = sha256OfBytes(bytes);
    this.granted.add(sha);
    return sha;
  }

  allows(sha256: string): boolean {
    return this.granted.has(sha256);
  }
}

/**
 * The notes target of an IPC call (`ref` with a granted path, `sha256`
 * already checked as hex), with a hash main can vouch for. Bytes that come
 * along (a PDF without a path) are hashed here, and that hash is granted; a
 * sha256 given must be it, or one granted before. Without either, the PDF
 * is hashed from its path when needed (notes.ts).
 */
export function notesTargetFor(ref: { path: string | null; bytes?: Uint8Array }, sha256: string | undefined, hashes: HashGrants): NotesTarget {
  if (ref.bytes) {
    const sha = hashes.grantBytes(checkPdfBytes(ref.bytes, 'notes'));
    if (sha256 !== undefined && sha256 !== sha) throw new Error('sha256 is not the hash of the PDF');
    return { path: ref.path, sha256: sha };
  }
  if (sha256 !== undefined && !hashes.allows(sha256)) throw new Error('sha256 is not of a PDF opened here');
  return { path: ref.path, sha256 };
}
