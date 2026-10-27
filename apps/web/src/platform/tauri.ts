/* Inkslide web - Tauri platform adapter (apps/mobile: iPad and Android)
 *
 * Selected when the page runs in a Tauri web view (window.__TAURI_INTERNALS__).
 * The plugin packages are imported on first use, so the browser and Electron
 * builds only carry this small module.
 *
 * PDFs come from the system picker (dialog plugin) and are read with the fs
 * plugin: iOS hands over a copy in the app's inbox (or a security-scoped URL),
 * Android a content:// URI. Next to such a file the app can rarely write, so
 * there are no sidecars: notes live in the app data directory, keyed by the
 * PDF's SHA-256 (`notes/<sha256>.notes.json`). Import and export move notes
 * and annotated PDFs in and out.
 *
 * The fs plugin only reads: every picked file is in its scope, so the page
 * must not be able to write there. Writes are the app's own commands
 * (apps/mobile/src-tauri/src/lib.rs), which take a file name, not a path:
 * write_notes (temp file, then rename), write_share_file and
 * remove_share_file (the share folder), and save_pdf (a save dialog the
 * command opens itself, and a write to the file picked there).
 *
 * Export: the share sheet on iOS (Save to Files, AirDrop, Mail, Print; as the
 * PWA on the iPad), the system save dialog elsewhere (Android: Storage Access
 * Framework). Print hands the PDF to the share sheet on iOS and Android, whose
 * web views have no window.print(); the desktop shell (development only)
 * prints page images like the browser.
 */
import type { PdfFile, PlatformAdapter } from '@inkslide/annotate';
import { NOTES_SUFFIX } from '@inkslide/annotate/io';
import { safeFileName } from './opfs';

export interface TauriAdapter extends PlatformAdapter {
  platform: 'tauri';
}

type MobileOs = 'ios' | 'android' | null;

/** The mobile OS from the user agent (iPadOS reports a Mac, but with touch). */
export function mobileOs(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): MobileOs {
  if (/Android/i.test(ua)) return 'android';
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  return null;
}

/**
 * File name from a picked path or URI, `fallback` if it has none: iOS gives
 * file URLs (percent-encoded), Android content URIs whose last segment is
 * often an id ("msf:1234") or "primary:Download/a.pdf". Only in content URIs
 * is ':' a separator; elsewhere it can be part of the name.
 */
export function nameFromPath(path: string, fallback: string): string {
  let last = path.split(/[/\\]/).pop() || '';
  try {
    last = decodeURIComponent(last);
  } catch (_) { /* keep it encoded */ }
  last = last.split(/^content:/i.test(path) ? /[/:]/ : '/').pop() || '';
  return /^[^.].*\.[A-Za-z0-9]+$/.test(last) ? last : fallback;
}

/** file:// URL of an absolute path (the share plugin wants URLs). */
export const fileUrl = (path: string): string => `file://${path.split('/').map(encodeURIComponent).join('/')}`;

/** Max. UTF-8 bytes of a shared file's name before ".pdf" (file systems allow 255 in all). */
const SHARE_NAME_BYTES = 200;

/**
 * File name for a shared PDF: path separators, ':', control characters and
 * lone surrogates become '_', no leading dots or spaces, at most 200 UTF-8
 * bytes (whole characters), always ending in .pdf (the share scope allows
 * only PDFs).
 */
export function shareName(name: string): string {
  const clean = name
    .replace(/[/\\:\0-\x1f\x7f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_')
    .replace(/^[.\s]+/, '').replace(/\.pdf$/i, '').trim();
  const enc = new TextEncoder();
  let base = '', bytes = 0;
  for (const ch of clean) {
    bytes += enc.encode(ch).length;
    if (bytes > SHARE_NAME_BYTES) break;
    base += ch;
  }
  return `${base.trim() || 'document'}.pdf`;
}

/** Key of a PDF's notes: its SHA-256, else a safe form of its name ([A-Za-z0-9_-] only, as write_notes requires). */
export const notesKey = (pdf: Pick<PdfFile, 'name'>, sha256?: string): string =>
  sha256 && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : safeFileName(`name-${pdf.name}`, '');

/** Notes file of a PDF in the app data directory: notes/<sha256>.notes.json, as the desktop's app storage. */
export const notesFile = (pdf: Pick<PdfFile, 'name'>, sha256?: string): string =>
  `notes/${notesKey(pdf, sha256)}${NOTES_SUFFIX}`;

/** invoke() options sending a file name with raw bytes (percent-encoded: headers are ASCII). */
const nameHeader = (name: string) => ({ headers: { name: encodeURIComponent(name) } });

/** The user dismissed a picker (Android's dialog plugin) or the share sheet (sharekit). */
const isCancel = (e: unknown): boolean =>
  /^(File picker|Share) cancelled$/.test(String((e as Error | null)?.message ?? e));

/** `p`, or `cancelled` if the user dismissed the dialog or share sheet. */
const orCancel = <T, C>(p: Promise<T>, cancelled: C): Promise<T | C> =>
  p.catch(e => {
    if (isCancel(e)) return cancelled;
    throw e;
  });

const PDF_FILTER = { name: 'PDF', extensions: ['pdf'] };

const loadPlugins = () => Promise.all([
  import('@tauri-apps/plugin-dialog'),
  import('@tauri-apps/plugin-fs'),
  import('@tauri-apps/api/path'),
  import('@choochmeque/tauri-plugin-sharekit-api'),
  import('@tauri-apps/api/core'),
]);

export function createTauriAdapter(os: MobileOs = mobileOs()): TauriAdapter {
  let plugins: ReturnType<typeof loadPlugins> | null = null;
  const use = (): ReturnType<typeof loadPlugins> => (plugins ??= loadPlugins().catch(e => {
    plugins = null; // a failed chunk load is tried again on the next call
    throw e;
  }));
  /** iOS: the name of the last shared file, removed at the next share (see share()). */
  let lastShared: string | null = null;

  /** Pick one file; its path or URI, null if cancelled. */
  async function pick(filter: { name: string; extensions: string[] }): Promise<string | null> {
    const [dialog] = await use();
    return orCancel(dialog.open({ filters: [filter], multiple: false, directory: false }), null);
  }

  /**
   * Write the PDF to the share folder (write_share_file) and hand it to the
   * share sheet; false if cancelled. The folder is iOS: tmp/, where the share
   * plugin copies the file to (it does not replace an older copy of the same
   * name, so the export is written there itself); Android: cache/share/, the
   * plugin copies it into the cache root (a copy onto itself would empty it)
   * and shares that through its FileProvider; the OS clears that copy.
   * Android: the file is removed once the plugin is done (it copies it before
   * showing the chooser). iOS: the share sheet shares that very file, and an
   * activity (AirDrop, Print) may still read it after the sheet closed, so it
   * is removed at the next share (or by the OS).
   */
  async function share(bytes: Uint8Array, name: string): Promise<boolean> {
    const [, , , { shareFile }, { invoke }] = await use();
    const file = shareName(name);
    const remove = (f: string) => invoke('remove_share_file', { name: f }).catch(() => { /* the OS clears it */ });
    if (lastShared && lastShared !== file) await remove(lastShared);
    lastShared = null;
    const abs = await invoke<string>('write_share_file', bytes, nameHeader(file));
    try {
      return await orCancel(shareFile(fileUrl(abs), { mimeType: 'application/pdf', title: name }).then(() => true), false);
    } finally {
      if (os === 'ios') lastShared = file;
      else await remove(file);
    }
  }

  const adapter: TauriAdapter = {
    platform: 'tauri',

    async openPdf(given) {
      const path = given || (await pick(PDF_FILTER));
      if (!path) return null;
      const [, fs] = await use();
      return { path: null, name: nameFromPath(path, 'document.pdf'), bytes: await fs.readFile(path) };
    },

    async readNotes(pdf, sha256) {
      const [, fs, { BaseDirectory }] = await use();
      const file = notesFile(pdf, sha256);
      const baseDir = BaseDirectory.AppData;
      if (!(await fs.exists(file, { baseDir }))) return null;
      return (await fs.readTextFile(file, { baseDir })) || null;
    },

    async writeNotes(pdf, text, sha256) {
      // notes/<key>.notes.json in the app data directory, through a temp file of its own.
      const [, , , , { invoke }] = await use();
      await invoke('write_notes', { key: notesKey(pdf, sha256), text });
    },

    async exportPdf(bytes, suggestedName) {
      if (os === 'ios') return share(bytes, suggestedName);
      // The command opens the save dialog and writes to the picked file; false if cancelled.
      const [, , , , { invoke }] = await use();
      return orCancel(invoke<boolean>('save_pdf', bytes, nameHeader(suggestedName)), false);
    },

    async importNotes() {
      const path = await pick({ name: 'Notes', extensions: ['json'] });
      if (!path) return null;
      const [, fs] = await use();
      return { name: nameFromPath(path, 'notes.json'), text: await fs.readTextFile(path) };
    },

    async confirm(message) {
      const [dialog] = await use();
      return dialog.confirm(message, { title: 'Inkslide', kind: 'warning' });
    },
  };
  if (os) adapter.print = share;
  return adapter;
}
