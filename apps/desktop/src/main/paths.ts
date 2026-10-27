/* Inkslide desktop - where the front end lives, PDF arguments (no Electron) */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_SUFFIX, NOTES_SUFFIX } from '@inkslide/annotate/io';

/** What the window loads: a URL (dev server) or an HTML file. */
export type WebEntry = { kind: 'url'; url: string } | { kind: 'file'; file: string };

/** Inputs of resolveWebEntry (environment and app paths). */
export interface WebEntryOptions {
  /** INKSLIDE_DEV_URL: load the Vite dev server (http/https only; ignored when packaged). */
  devUrl?: string;
  /** INKSLIDE_PAGE: load this HTML file instead (tests, fixture page). */
  pageOverride?: string;
  isPackaged: boolean;
  /** app.getAppPath(): apps/desktop in development, resources/app.asar packaged. */
  appPath: string;
  /** process.resourcesPath (packaged only). */
  resourcesPath: string;
}

/**
 * The front end to load. Development: `apps/web/dist/index.html` next to
 * `apps/desktop`. Packaged: `resources/web/index.html` (electron-builder
 * extraResources copies apps/web/dist there).
 */
export function resolveWebEntry(o: WebEntryOptions): WebEntry {
  // A packaged app never loads a remote page: it would get the preload bridge.
  if (o.devUrl && !o.isPackaged) {
    let url: URL;
    try {
      url = new URL(o.devUrl);
    } catch (_) {
      throw new Error(`INKSLIDE_DEV_URL is not a URL: ${o.devUrl}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`INKSLIDE_DEV_URL must be http or https: ${o.devUrl}`);
    }
    return { kind: 'url', url: url.href };
  }
  if (o.pageOverride) return { kind: 'file', file: resolve(o.pageOverride) };
  const file = o.isPackaged
    ? join(o.resourcesPath, 'web', 'index.html')
    : join(o.appPath, '..', 'web', 'dist', 'index.html');
  return { kind: 'file', file: resolve(file) };
}

/** The test-only environment variables main.ts honors (see testEnv). */
export interface TestEnv {
  /** INKSLIDE_PAGE: load this HTML file instead of the front end. */
  page?: string;
  /** INKSLIDE_USER_DATA: use this userData folder. */
  userData?: string;
  /** INKSLIDE_SMOKE: smoke test mode, '' when off. */
  smoke: string;
  /** INKSLIDE_PRINT_TO_PDF: smoke test mode, Print writes this file. */
  printToPdf?: string;
}

/**
 * The test-only environment variables, when `allowed`: in development, and
 * in a packaged test build (INKSLIDE_TEST_BUILD=1 at build time, for the
 * smoke test against a package). A release build ignores them all: they
 * would load another page with the preload bridge, or move userData.
 */
export function testEnv(env: Record<string, string | undefined>, allowed: boolean): TestEnv {
  if (!allowed) return { smoke: '' };
  return {
    page: env.INKSLIDE_PAGE || undefined,
    userData: env.INKSLIDE_USER_DATA || undefined,
    smoke: env.INKSLIDE_SMOKE || '',
    printToPdf: env.INKSLIDE_PRINT_TO_PDF || undefined,
  };
}

const isPdfName = (s: string): boolean => /\.pdf$/i.test(s);
/** A URI with a scheme of two or more letters (a Windows drive letter is one). */
const URI_RE = /^[a-z][a-z0-9+.-]+:\/\//i;

/** A PDF from the command line: a local path, or a URI Inkslide can not open (`remote`). */
export type ArgvPdf = { path: string } | { remote: string };

/** A URI argument: file:// of this computer is a path, any other URI `remote`; null if it names no PDF. */
function uriPdf(a: string): ArgvPdf | null {
  let url: URL;
  try {
    url = new URL(a);
  } catch (_) {
    return null;
  }
  if (!isPdfName(url.pathname)) return null;
  try {
    if (url.protocol === 'file:') return { path: fileURLToPath(url) };
  } catch (_) { /* file://host/…: another computer */ }
  return { remote: a };
}

/**
 * The PDF to open from a command line (process.argv or the argv of a second
 * instance): the last argument that is not a switch and names a .pdf file.
 * Paths come back absolute; file:// URLs of this computer are paths (some file
 * managers pass them). Other URIs (`%U` in a desktop entry hands GVfs
 * locations such as sftp://host/a.pdf to the app) are `remote`.
 */
export function pdfFromArgv(argv: readonly string[], cwd: string): ArgvPdf | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    const pdf = URI_RE.test(a) ? uriPdf(a) : isPdfName(a) ? { path: resolve(cwd, a) } : null;
    if (pdf) return pdf;
  }
  return null;
}

/** Folder in userData for notes that cannot be stored next to their PDF. */
export const NOTES_DIR = 'notes';
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Whether `s` is a lower-case hex SHA-256 (64 characters). */
export const isSha256 = (s: unknown): s is string => typeof s === 'string' && SHA256_RE.test(s);

/** userData/notes/<sha256><suffix>; throws unless sha256 is a hex SHA-256 (no path tricks). */
function storagePath(userData: string, sha256: string, suffix: string): string {
  if (!isSha256(sha256)) throw new Error('invalid sha256');
  return join(userData, NOTES_DIR, `${sha256}${suffix}`);
}

/** Whether `name` is "<sha256><suffix>", a file storagePath makes. */
export const isStorageName = (name: string, suffix: string): boolean =>
  name.endsWith(suffix) && isSha256(name.slice(0, -suffix.length));

/** App-storage notes file of a PDF: userData/notes/<sha256>.notes.json. */
export const fallbackNotesPath = (userData: string, sha256: string): string => storagePath(userData, sha256, NOTES_SUFFIX);

/** Which sidecar the app-storage notes of a PDF replace: userData/notes/<sha256>.sidecar.json. */
export const sidecarStatePath = (userData: string, sha256: string): string => storagePath(userData, sha256, '.sidecar.json');

/** App-storage notes backup of a PDF: userData/notes/<sha256>.notes.backup.json. */
export const fallbackBackupPath = (userData: string, sha256: string): string => storagePath(userData, sha256, BACKUP_SUFFIX);

/** Appended to the PDF's SHA-256 for the kept copy of a notes file that could not be read. */
export const UNREADABLE_SUFFIX = '.notes.unreadable.json';

/** The kept copy of an unreadable notes file: userData/notes/<sha256>.notes.unreadable.json. */
export const unreadableNotesPath = (userData: string, sha256: string): string => storagePath(userData, sha256, UNREADABLE_SUFFIX);
