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
 * PDF's SHA-256 (`notes/<sha256>.notes.json`, written to a temp file, then renamed).
 * Import and export move notes and annotated PDFs in and out.
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

/** Notes file of a PDF in the app data directory: notes/<sha256>.notes.json, as the desktop's app storage. */
export const notesFile = (pdf: Pick<PdfFile, 'name'>, sha256?: string): string =>
  `notes/${sha256 && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : safeFileName(`name-${pdf.name}`, '')}${NOTES_SUFFIX}`;

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
]);

export function createTauriAdapter(os: MobileOs = mobileOs()): TauriAdapter {
  let plugins: ReturnType<typeof loadPlugins> | null = null;
  const use = (): ReturnType<typeof loadPlugins> => (plugins ??= loadPlugins().catch(e => {
    plugins = null; // a failed chunk load is tried again on the next call
    throw e;
  }));
  let notesDir: Promise<void> | null = null;
  /** iOS: the last shared file, removed at the next share (see share()). */
  let lastShared: { file: string; baseDir: number } | null = null;

  /** Pick one file; its path or URI, null if cancelled. */
  async function pick(filter: { name: string; extensions: string[] }): Promise<string | null> {
    const [dialog] = await use();
    return orCancel(dialog.open({ filters: [filter], multiple: false, directory: false }), null);
  }

  /**
   * Where shared files go. iOS: tmp/, where the share plugin copies the file
   * to (it does not replace an older copy of the same name, so the export is
   * written there itself). Android: cache/share/, the plugin copies it into
   * the cache root (a copy onto itself would empty it) and shares that
   * through its FileProvider; the OS clears that copy.
   */
  async function shareTarget(): Promise<{ baseDir: number; sub: string; abs: string }> {
    const [, fs, path] = await use();
    if (os === 'ios') return { baseDir: path.BaseDirectory.Temp, sub: '', abs: await path.tempDir() };
    const baseDir = path.BaseDirectory.AppCache;
    await fs.mkdir('share', { baseDir, recursive: true }); // every time: Android may clear the cache meanwhile
    return { baseDir, sub: 'share/', abs: await path.join(await path.appCacheDir(), 'share') };
  }

  /**
   * Write the PDF to a temp file and hand it to the share sheet; false if
   * cancelled. Android: the temp file is removed once the plugin is done (it
   * copies it before showing the chooser). iOS: the share sheet shares that
   * very file, and an activity (AirDrop, Print) may still read it after the
   * sheet closed, so it is removed at the next share (or by the OS).
   */
  async function share(bytes: Uint8Array, name: string): Promise<boolean> {
    const [, fs, , { shareFile }] = await use();
    const { baseDir, sub, abs } = await shareTarget();
    const file = sub + shareName(name);
    const remove = (f: { file: string; baseDir: number }) => fs.remove(f.file, { baseDir: f.baseDir }).catch(() => { /* the OS clears it */ });
    if (lastShared && lastShared.file !== file) await remove(lastShared);
    lastShared = null;
    await fs.writeFile(file, bytes, { baseDir });
    try {
      return await orCancel(shareFile(fileUrl(`${abs.replace(/\/$/, '')}/${file.slice(sub.length)}`), { mimeType: 'application/pdf', title: name }).then(() => true), false);
    } finally {
      if (os === 'ios') lastShared = { file, baseDir };
      else await remove({ file, baseDir });
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
      const [, fs, { BaseDirectory }] = await use();
      const file = notesFile(pdf, sha256);
      const baseDir = BaseDirectory.AppData;
      notesDir ??= fs.mkdir('notes', { baseDir, recursive: true }).catch(e => {
        notesDir = null; // try again on the next write
        throw e;
      });
      await notesDir;
      // A temp name of its own: an older write of the same notes may still be under way.
      const tmp = `${file}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        await fs.writeTextFile(tmp, text, { baseDir });
        await fs.rename(tmp, file, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
      } catch (e) {
        await fs.remove(tmp, { baseDir }).catch(() => { /* not written */ });
        throw e;
      }
    },

    async exportPdf(bytes, suggestedName) {
      if (os === 'ios') return share(bytes, suggestedName);
      const [dialog, fs] = await use();
      const target = await orCancel(dialog.save({ defaultPath: suggestedName, filters: [PDF_FILTER] }), null);
      if (!target) return false;
      await fs.writeFile(target, bytes);
      return true;
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
