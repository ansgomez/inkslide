/* Inkslide desktop - printing an annotated PDF
 *
 * The front end sends the exported PDF (PDF pages with the notes and the
 * blank pages, as the export). It goes to a temp file that a hidden window
 * opens in Chromium's built-in PDF viewer; webContents.print() then prints
 * the PDF itself through the system dialog: vector text and ink, each page
 * at its own size. Printing the app window would print the screen, and page
 * images (the web front end's fallback) would lose the vector output.
 *
 * The viewer has the document once it sets the window title; did-finish-load
 * comes earlier, and printing then gives a single blank page. A window that
 * showed a PDF is closed, not destroyed: destroying it made the next PDF
 * load fail (Electron 39).
 */
import { BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { lockNavigation, SAFE_WEB_PREFERENCES } from './harden';

/** Longest wait for the PDF viewer before printing anyway. */
const LOAD_TIMEOUT_MS = 15_000;

export interface PrintOptions {
  /** Window the hidden print window belongs to. */
  parent?: BrowserWindow | null;
  /** Tests: write what would be printed to this PDF file instead of showing the dialog. */
  toPdf?: string;
}

/** File name for the temp copy: the export's name, without path or odd characters. */
function printFileName(name: string): string {
  const base = basename(name || '').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^\.+/, '').slice(0, 120);
  return /\.pdf$/i.test(base) ? base : `${base || 'document'}.pdf`;
}

/**
 * Print PDF `bytes` with the system print dialog. Resolves false if the user
 * cancelled; rejects if printing failed.
 */
export async function printPdf(bytes: Uint8Array, name: string, opts: PrintOptions = {}): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'inkslide-print-'));
  const file = join(dir, printFileName(name));
  const w = new BrowserWindow({
    show: false,
    ...(opts.parent ? { parent: opts.parent } : {}),
    webPreferences: SAFE_WEB_PREFERENCES,
  });
  const wc = w.webContents;
  lockNavigation(wc);
  try {
    await writeFile(file, bytes);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>(resolve => {
      wc.once('page-title-updated', () => resolve());
      timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
    });
    await w.loadFile(file);
    await ready;
    clearTimeout(timer);
    if (opts.toPdf) {
      await writeFile(opts.toPdf, await wc.printToPDF({}));
      return true;
    }
    return await new Promise<boolean>((resolve, reject) => {
      // The app window closing during the dialog closes this one too; the callback may never come.
      w.once('closed', () => resolve(false));
      wc.print({ silent: false, printBackground: true }, (ok, reason) => {
        if (ok) resolve(true);
        else if (reason === 'cancelled') resolve(false);
        else reject(new Error(`printing failed (${reason || 'unknown reason'})`));
      });
    });
  } finally {
    // Remove the temp copy once the viewer has let go of it (Windows refuses to delete open files).
    if (!w.isDestroyed()) {
      const closed = new Promise<void>(resolve => {
        w.once('closed', () => resolve());
        setTimeout(resolve, 5_000); // never hang the print request on a window that does not close
      });
      w.close();
      await closed;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(() => { /* temp dir; the OS cleans up */ });
  }
}
