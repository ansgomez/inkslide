/* Inkslide desktop - which PDF paths the renderer may read
 *
 * Paths the user chose: open dialog, command line, OS open requests, drops
 * (through the preload's pathForFile, which needs a real File object) and the
 * recent files list. The renderer cannot name arbitrary files. Main cannot
 * tell a real drop from a renderer that just sends a path, so a drop grants
 * only .pdf files (others open from their bytes, without a path).
 */
import { resolve } from 'node:path';

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
