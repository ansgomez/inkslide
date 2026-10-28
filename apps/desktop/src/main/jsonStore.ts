/* Inkslide desktop - small JSON files in userData (window state, recent files) */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Parsed JSON of `file`, or `fallback` if it is missing or broken. */
export function readJson(file: string, fallback: unknown = null): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

/**
 * Write JSON synchronously (also usable while the app quits), through a temp
 * file that is flushed to disk (fsync) before it is renamed over `file`, so
 * a crash never leaves half a file. Failures (full disk,
 * read-only userData) are logged, not thrown: losing the window state or the
 * recent files must not stop a PDF from opening or the notes from being saved
 * on close.
 */
export function writeJson(file: string, data: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      try {
        writeFileSync(fd, JSON.stringify(data, null, 1)); // the whole text, unlike one writeSync
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch (err) {
      try { unlinkSync(tmp); } catch (_) { /* already gone */ }
      throw err;
    }
  } catch (err) {
    console.warn(`could not write ${file}: ${(err as Error).message}`);
  }
}
