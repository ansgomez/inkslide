/* Inkslide annotate - notes file format and the platform adapter interface
 *
 * The pure part of Marp Notes io.js (© Andres Gomez, MIT): no DOM, no file
 * system. Banners, the file picker, drag and drop and print-to-PDF stay in
 * the app; file access goes through a PlatformAdapter (Electron, Tauri, PWA).
 *
 * Notes file ("marp-notes" JSON):
 *   v1 (Marp HTML decks): deck { title, slides, size }, pages s<n> / blank.
 *   v2 (PDF): deck { source: "pdf", title, slides, size, pageSizes, sha256 },
 *      pages p<n> / blank. Sidecar "<name>.pdf.notes.json".
 * Backup (same format, desktop only): app storage "<sha256>.notes.backup.json",
 * the saved notes as they were before a save (apps/desktop/src/main/notes.ts).
 * v1 files load into a PDF document; their strokes are scaled from the slide
 * size to the PDF page size when both have the same aspect ratio (Marp
 * exports 1280×720 px slides as 960×540 pt pages).
 */
import { checkFormat, type DeckInit, type NotesDoc, type NotesJSON, type PageJSON, type Size } from './model';

/** Appended to the PDF path for the sidecar notes file. */
export const NOTES_SUFFIX = '.notes.json';

/** Sidecar path of a PDF: "<name>.pdf.notes.json". */
export const notesPathFor = (pdfPath: string): string => `${pdfPath}${NOTES_SUFFIX}`;

/** Appended to the PDF's SHA-256 for the desktop's notes backup in app storage. */
export const BACKUP_SUFFIX = '.notes.backup.json';

/** File-name friendly form of a title ("Signals – Übung 1" -> "signals-ubung-1"). */
export function slug(title: string | null | undefined): string {
  return (title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'slides';
}

// ── Deck from a PDF ────────────────────────────────────────────

/** What deckFromPdf needs to know about a PDF. */
export interface PdfInfo {
  title: string;
  /** Page sizes in PDF points (page.getViewport({ scale: 1 })), page 1 first. */
  pageSizes: readonly Size[];
  /** Hex SHA-256 of the PDF bytes (sha256Hex). */
  sha256?: string;
}

/** NotesDoc deck for a PDF. */
export function deckFromPdf(info: PdfInfo): DeckInit {
  const pageSizes = info.pageSizes.map(s => [s[0], s[1]] as Size);
  return {
    source: 'pdf', title: info.title, slides: pageSizes.length,
    size: pageSizes[0] ? [pageSizes[0][0], pageSizes[0][1]] : undefined,
    pageSizes, sha256: info.sha256,
  };
}

/** Hex SHA-256 via Web Crypto (browsers, Electron, Tauri web views, Node 22). */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// ── Save ───────────────────────────────────────────────────────

/** The notes as file text (one space indent, like Marp Notes). */
export function serializeNotes(doc: NotesDoc): string {
  return JSON.stringify(doc.toJSON(), null, 1);
}

// ── Load ───────────────────────────────────────────────────────

/** Parse and check notes file text. Throws an Error with a user-facing message. */
export function parseNotes(text: string): NotesJSON {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('not valid JSON');
  }
  checkFormat(data); // reject a wrong file before asking anything
  return data;
}

const ASPECT_TOLERANCE = 0.01;

/**
 * Scale a v1 (Marp slide units) file onto the pages of a PDF deck, deciding
 * per page: a page is scaled when its aspect ratio matches the slides'.
 * Returns a new object, the scale (page 1's, else that of the first page
 * scaled; null if nothing is scaled) and a warning naming the pages left
 * unscaled when page 1 or another page fits. The deck size counts as matching
 * whenever page 1 fits; otherwise the model's size warning stays. The data is
 * returned unchanged when no page fits. Only numbers are scaled; anything
 * else is passed on for the model to reject.
 */
export function scaleV1ToPdf(data: NotesJSON, doc: NotesDoc): { data: NotesJSON; scale: number | null; warnings: string[] } {
  const from = data.deck && data.deck.size;
  const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (data.version !== 1 || doc.deck.source !== 'pdf' || !Array.isArray(from) || !positive(from[0]) || !positive(from[1])) {
    return { data, scale: null, warnings: [] };
  }
  const scaleFor = (n: number): number | null => {
    const to = doc.deck.pageSizes && doc.deck.pageSizes[n - 1] || doc.deck.size;
    const sx = to[0] / from[0], sy = to[1] / from[1];
    return Math.abs(sx - sy) / sx <= ASPECT_TOLERANCE ? sx : null;
  };
  const times = (v: unknown, s: number): unknown => (typeof v === 'number' ? v * s : v);
  const first = scaleFor(1);
  let scale: number | null = null, matched = false;
  const unscaled: string[] = [];
  // Not an array: passed on for the model to warn about.
  const pages = !Array.isArray(data.pages) ? data.pages : data.pages.map((page: PageJSON): PageJSON => {
    if (!page || !Array.isArray(page.strokes) || !page.strokes.length) return page;
    const n = Number(page.kind === 'blank' ? page.after : page.slide);
    if (!Number.isInteger(n) || n < 1) return page; // the model skips it
    // Pages beyond the PDF are kept and saved as v2 too: scaleFor scales them by the deck size.
    const s = scaleFor(n);
    if (s === null) {
      unscaled.push(page.kind === 'blank' ? `blank page ${page.id}` : `slide ${n}`);
      return page;
    }
    matched = true;
    if (s === 1) return page;
    if (scale === null) scale = s;
    return {
      ...page,
      strokes: page.strokes.map(st => (st && Array.isArray(st.points) ? {
        ...st,
        size: times(st.size, s),
        points: st.points.map(p => (Array.isArray(p) ? [times(p[0], s), times(p[1], s), p[2]] : p)),
      } : st)),
    } as PageJSON;
  });
  // Nothing fits the PDF at all: the size warning says so.
  const warnings = (first !== null || matched) && unscaled.length
    ? [`Notes not scaled to the PDF (page aspect ratio differs): ${unscaled.join(', ')}`] : [];
  if (first === null && scale === null) return { data, scale: null, warnings };
  // Page 1 fits: its size no longer differs once notes are scaled to it.
  const deck = first === null ? data.deck : { ...data.deck, size: [doc.deck.size[0], doc.deck.size[1]] as Size };
  return { data: { ...data, deck, pages }, scale: first !== null && first !== 1 ? first : scale, warnings };
}

/** Result of loadNotes. */
export interface LoadResult {
  /** Problems: skipped pages and strokes, notes of another deck. */
  warnings: string[];
  /** Pages beyond the PDF, kept and saved but not shown (NotesDoc.load). */
  notices: string[];
  /** Scale applied to a v1 file (e.g. 0.75 for 1280×720 slides on a 960×540 pt PDF). */
  scaled: number | null;
}

/** Replace the document's content with a parsed notes file (v1 or v2). */
export function loadNotes(doc: NotesDoc, data: NotesJSON): LoadResult {
  const { data: fitted, scale, warnings: scaling } = scaleV1ToPdf(data, doc);
  const { warnings, notices } = doc.load(fitted);
  return { warnings: [...warnings, ...scaling], notices, scaled: scale };
}

/** parseNotes + loadNotes. */
export function loadNotesText(doc: NotesDoc, text: string): LoadResult {
  return loadNotes(doc, parseNotes(text));
}

// ── Platform adapter ───────────────────────────────────────────

/** An opened PDF. `path` is null where there is no file system path (PWA, iOS). */
export interface PdfFile {
  path: string | null;
  name: string;
  bytes: Uint8Array;
}

/**
 * File access, implemented per shell (Electron preload, Tauri plugins, PWA).
 * The front end never touches the file system directly.
 */
export interface PlatformAdapter {
  /** Read a PDF: from `path` (command line, file association, drop) or an open dialog. null if cancelled. */
  openPdf(path?: string): Promise<PdfFile | null>;
  /** Text of the PDF's notes (sidecar or app storage keyed by sha256); null if there are none. */
  readNotes(pdf: PdfFile, sha256?: string): Promise<string | null>;
  /** Write the notes crash-safe where the platform allows (desktop: temp file, then rename). Rejects on failure. */
  writeNotes(pdf: PdfFile, text: string, sha256?: string): Promise<void>;
  /** Save an exported (annotated) PDF; asks for the location. false if cancelled. */
  exportPdf(bytes: Uint8Array, suggestedName: string): Promise<boolean>;
  /**
   * Print an exported (annotated) PDF through the system print dialog, as a
   * PDF (vector). false if cancelled. Without it the front end prints page
   * images with window.print().
   */
  print?(bytes: Uint8Array, name: string): Promise<boolean>;
  /** Pick a notes file to import (e.g. v1 notes from a Marp HTML deck). null if cancelled. */
  importNotes?(): Promise<{ name: string; text: string } | null>;
  /** Ask a yes/no question (e.g. replace unsaved notes). */
  confirm?(message: string): Promise<boolean>;
  /** Files the OS asks the app to open while it runs (second instance, file association). */
  onOpenRequest?(handler: (path: string) => void): () => void;
  /**
   * The notes backup (desktop only): the saved notes as they were before a
   * save, at most once every 2 minutes, made by writeNotes. Its text and time;
   * null if there is none or backups are off.
   */
  readBackup?(pdf: PdfFile, sha256?: string): Promise<NotesBackup | null>;
  /**
   * Swap the saved notes and the backup (File → Revert to Backup…), so a
   * second revert undoes the first. Resolves with the notes text now saved;
   * rejects if there is no valid backup.
   */
  revertToBackup?(pdf: PdfFile, sha256?: string): Promise<string>;
  /**
   * The saved notes could not be read and are about to be replaced: keep the
   * file as it is (desktop: app storage, <sha256>.notes.unreadable.json).
   * Resolves with where the copy is, or null if there was no file.
   */
  keepUnreadableNotes?(pdf: PdfFile, sha256?: string): Promise<string | null>;
}

/** A notes backup found by PlatformAdapter.readBackup. */
export interface NotesBackup {
  text: string;
  /** Modification time, ms since the epoch. */
  time: number;
}
