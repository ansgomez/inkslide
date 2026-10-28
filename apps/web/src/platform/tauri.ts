/* Inkslide web - Tauri platform adapter (apps/mobile: iPad and Android)
 *
 * Selected when the page runs in a Tauri web view (window.__TAURI_INTERNALS__).
 * The Tauri packages are imported on first use, so the browser and Electron
 * builds only carry this small module.
 *
 * The page has no fs plugin permission and no file dialog of its own: every
 * file access is one of the app's commands (apps/mobile/src-tauri/src/lib.rs),
 * which take a notes key or a checked file name, never a free path.
 * pick_file opens the system picker (iOS hands over a copy in the app's inbox
 * or a security-scoped URL, Android a content:// URI) and read_picked reads
 * only files picked that way, each once. Next to such a file the app can rarely write,
 * so there are no sidecars: notes live in the app data directory, keyed by
 * the PDF's SHA-256 (`notes/<sha256>.notes.json`; read_notes, write_notes).
 * write_share_file and remove_share_file use the share folder, and share_pdf
 * hands a file written there to the share sheet (the page has no sharekit
 * permission); save_pdf opens the save dialog itself and writes to the file
 * picked there.
 *
 * File bytes go to the app as a raw request body with the name in a header,
 * except on Android, whose IPC has no raw bodies: there they go as JSON
 * { name, data } with data in base64.
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

/** Max. UTF-8 bytes of a shared file's name before ".pdf" (file systems allow 255 in all). */
const SHARE_NAME_BYTES = 200;

/**
 * File name for a shared PDF: path separators, ':', control characters (C0,
 * DEL and C1, as Rust's char::is_control) and lone surrogates become '_', no
 * leading dots or spaces, at most 200 UTF-8 bytes (whole characters), always
 * ending in .pdf (write_share_file accepts only such names).
 */
export function shareName(name: string): string {
  const clean = name
    .replace(/[/\\:\0-\x1f\x7f-\x9f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_')
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

/** Base64 of bytes, in chunks (String.fromCharCode takes a limited number of arguments). */
export function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Max. size of a PDF handed to the app (export, share): MAX_FILE_BYTES of
 * apps/mobile/src-tauri/src/lib.rs. Android sends it as base64, a third
 * larger, and web views cap strings at a few hundred MB.
 */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Max. UTF-8 bytes of a notes file: MAX_NOTES_BYTES of lib.rs, where
 * write_notes refuses more and read_notes and read_picked (an imported notes
 * file) read no more. A picked PDF may have up to MAX_PICKED_PDF_BYTES there
 * (512 MiB); the app refuses a larger one with a message.
 */
export const MAX_NOTES_BYTES = 256 * 1024 * 1024;

/** Why a PDF over MAX_FILE_BYTES can not be exported or shared on the iPad or Android. */
export const tooLargeMessage = (size: number): string =>
  `This PDF is too large to export or share here (${Math.ceil(size / 2 ** 20)} MB; at most ${MAX_FILE_BYTES / 2 ** 20} MB).`;

/**
 * invoke() arguments sending a file's bytes and name: a raw body with the
 * name percent-encoded in a header (headers are ASCII), or on Android, whose
 * IPC has no raw bodies, JSON with the bytes in base64. Throws, before any
 * encoding, for a file over MAX_FILE_BYTES.
 */
export function fileArgs(os: MobileOs, bytes: Uint8Array, name: string):
  [Uint8Array | { name: string; data: string }, { headers: Record<string, string> } | undefined] {
  if (bytes.length > MAX_FILE_BYTES) throw new Error(tooLargeMessage(bytes.length));
  return os === 'android'
    ? [{ name, data: base64(bytes) }, undefined]
    : [bytes, { headers: { name: encodeURIComponent(name) } }];
}

/** Bytes of a raw IPC response (an ArrayBuffer, or a number array where the IPC has no raw responses). */
const responseBytes = (r: ArrayBuffer | number[]): Uint8Array => (r instanceof ArrayBuffer ? new Uint8Array(r) : Uint8Array.from(r));

/** The user dismissed a picker (Android's dialog plugin) or the share sheet (sharekit). */
const isCancel = (e: unknown): boolean =>
  /^(File picker|Share) cancelled$/.test(String((e as Error | null)?.message ?? e));

/** `p`, or `cancelled` if the user dismissed the dialog or share sheet. */
const orCancel = <T, C>(p: Promise<T>, cancelled: C): Promise<T | C> =>
  p.catch(e => {
    if (isCancel(e)) return cancelled;
    throw e;
  });

const loadPlugins = () => Promise.all([
  import('@tauri-apps/plugin-dialog'),
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

  /** Pick one file (pick_file); its path or URI, null if cancelled. */
  async function pick(kind: 'pdf' | 'notes'): Promise<string | null> {
    const [, { invoke }] = await use();
    return orCancel(invoke<string | null>('pick_file', { kind }), null);
  }

  /** Bytes of a file picked in this session and not read yet (read_picked refuses any other). */
  async function readPicked(id: string): Promise<Uint8Array> {
    const [, { invoke }] = await use();
    return responseBytes(await invoke<ArrayBuffer | number[]>('read_picked', { id }));
  }

  /**
   * Write the PDF to the share folder (write_share_file) and hand it to the
   * share sheet (share_pdf, which shares only a file write_share_file wrote);
   * false if cancelled. The folder is iOS: tmp/, where the share
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
    const [, { invoke }] = await use();
    const file = shareName(name);
    const remove = (f: string) => invoke('remove_share_file', { name: f }).catch(() => { /* the OS clears it */ });
    if (lastShared && lastShared !== file) await remove(lastShared);
    lastShared = null;
    await invoke('write_share_file', ...fileArgs(os, bytes, file));
    try {
      return await orCancel(invoke('share_pdf', { name: file }).then(() => true), false);
    } finally {
      if (os === 'ios') lastShared = file;
      else await remove(file);
    }
  }

  const adapter: TauriAdapter = {
    platform: 'tauri',

    async openPdf(given) {
      // `given`: only a file picked in this session and not read yet (read_picked reads each pick
      // once); the app hands none (no initialPath or onOpenRequest), so every open picks first.
      const path = given || (await pick('pdf'));
      if (!path) return null;
      return { path: null, name: nameFromPath(path, 'document.pdf'), bytes: await readPicked(path) };
    },

    async readNotes(pdf, sha256) {
      const [, { invoke }] = await use();
      return (await invoke<string | null>('read_notes', { key: notesKey(pdf, sha256) })) || null;
    },

    async writeNotes(pdf, text, sha256) {
      // notes/<key>.notes.json in the app data directory, through a temp file of its own.
      // A string has at most as many UTF-16 units as UTF-8 bytes: one this long is surely too
      // large, so it is not sent at all (write_notes checks the exact size).
      if (text.length > MAX_NOTES_BYTES) throw new Error(`The notes are larger than ${MAX_NOTES_BYTES / 2 ** 20} MB.`);
      const [, { invoke }] = await use();
      await invoke('write_notes', { key: notesKey(pdf, sha256), text });
    },

    async exportPdf(bytes, suggestedName) {
      if (os === 'ios') return share(bytes, suggestedName);
      // The command opens the save dialog and writes to the picked file; false if cancelled.
      const [, { invoke }] = await use();
      return orCancel(invoke<boolean>('save_pdf', ...fileArgs(os, bytes, suggestedName)), false);
    },

    async importNotes() {
      const path = await pick('notes');
      if (!path) return null;
      return { name: nameFromPath(path, 'notes.json'), text: new TextDecoder().decode(await readPicked(path)) };
    },

    async confirm(message) {
      const [dialog] = await use();
      return dialog.confirm(message, { title: 'Inkslide', kind: 'warning' });
    },
  };
  if (os) adapter.print = share;
  return adapter;
}
