/* Inkslide desktop - recent files list (JSON in userData) */
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { inkedPages } from '@inkslide/annotate/io';
import { MAX_PDF_PAGES } from '@inkslide/annotate/model';
import type { RecentFileInfo } from '../shared/bridge';
import { readJson, writeJson } from './jsonStore';
import { readNotesFor, readSidecarFor } from './notes';
import { isSha256 } from './paths';

/** Longest recent files list. */
export const RECENT_MAX = 10;
/** Largest page count kept: the most pages of a PDF Inkslide opens (anything above is not a real PDF's). */
const MAX_PAGES = MAX_PDF_PAGES;

/** A recently opened PDF. Older builds saved bare paths; those load with openedAt 0. */
export interface RecentRecord {
  /** Absolute path. */
  path: string;
  /** Last opened, ms since the epoch (0 if unknown). */
  openedAt: number;
  /** Size and modification time when last opened: a PDF replaced since has another hash. */
  size?: number;
  mtimeMs?: number;
  /** SHA-256 of the PDF when it was last opened (finds notes kept in app storage). */
  sha256?: string;
  /** Page count (PDF pages, without blank pages). */
  pages?: number;
}

/** The file of a PDF as stat() sees it. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_PAGES;
const isStampValue = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function parseRecord(v: unknown): RecentRecord | null {
  if (typeof v === 'string') return isAbsolute(v) ? { path: v, openedAt: 0 } : null;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string' || !isAbsolute(o.path)) return null;
  const rec: RecentRecord = { path: o.path, openedAt: typeof o.openedAt === 'number' && o.openedAt > 0 ? o.openedAt : 0 };
  if (isStampValue(o.size) && isStampValue(o.mtimeMs)) {
    rec.size = o.size;
    rec.mtimeMs = o.mtimeMs;
  }
  if (isSha256(o.sha256)) rec.sha256 = o.sha256;
  if (isCount(o.pages)) rec.pages = o.pages;
  return rec;
}

/** Whether `rec` describes the file as it is now (true if it was saved without a stamp). */
const sameFile = (rec: RecentRecord, now: FileStamp): boolean =>
  rec.size === undefined || (rec.size === now.size && rec.mtimeMs === now.mtimeMs);

/**
 * Recently opened PDFs (newest first), saved to `file` on every change. Older
 * builds kept bare paths in `legacyFile`: it is read once when `file` does not
 * exist yet, and left as it is, so going back to an older build keeps its list.
 */
export class RecentFiles {
  private list: RecentRecord[];

  constructor(private readonly file: string, private readonly max = RECENT_MAX, legacyFile?: string) {
    let data = readJson(file, null);
    if (data === null && legacyFile) data = readJson(legacyFile, []);
    this.list = Array.isArray(data)
      ? data.map(parseRecord).filter((r): r is RecentRecord => r !== null).slice(0, max)
      : [];
  }

  /** Paths, newest first. */
  paths(): string[] {
    return this.list.map(r => r.path);
  }

  /** Records, newest first. */
  records(): RecentRecord[] {
    return this.list.map(r => ({ ...r }));
  }

  has(path: string): boolean {
    const p = resolve(path);
    return this.list.some(r => r.path === p);
  }

  /**
   * Move `path` to the front (adding it if new), stamp it opened now, and save.
   * When the file changed since (`stamp`), its hash and page count are dropped.
   */
  add(path: string, stamp?: FileStamp, now = Date.now()): void {
    const p = resolve(path);
    const old = this.list.find(r => r.path === p);
    const keep = old && (!stamp || sameFile(old, stamp)) ? { sha256: old.sha256, pages: old.pages } : {};
    const rec: RecentRecord = { path: p, openedAt: now, ...(stamp ? { size: stamp.size, mtimeMs: stamp.mtimeMs } : {}) };
    if (keep.sha256) rec.sha256 = keep.sha256;
    if (keep.pages) rec.pages = keep.pages;
    this.list = [rec, ...this.list.filter(r => r.path !== p)].slice(0, this.max);
    this.save();
  }

  /** Remember the hash and page count of a listed PDF (after the front end loaded it). */
  describe(path: string, info: { sha256?: string; pages?: number }): void {
    const rec = this.list.find(r => r.path === resolve(path));
    if (!rec) return;
    if (isSha256(info.sha256)) rec.sha256 = info.sha256;
    if (isCount(info.pages)) rec.pages = info.pages;
    this.save();
  }

  remove(path: string): void {
    const p = resolve(path);
    this.list = this.list.filter(r => r.path !== p);
    this.save();
  }

  clear(): void {
    this.list = [];
    this.save();
  }

  private save(): void {
    writeJson(this.file, this.list);
  }
}

/**
 * What the start screen shows of the recent files: the ones that are still
 * files, with their size and the pages that have notes. Without a hash for
 * the file as it is now, only the sidecar is looked at (hashing every PDF
 * would be slow), with the notes' rules for links and sizes (readSidecarFor).
 */
export async function recentInfo(records: RecentRecord[], userData: string): Promise<RecentFileInfo[]> {
  const infos = await Promise.all(records.map(async (r): Promise<RecentFileInfo | null> => {
    const st = await stat(r.path).catch(() => null);
    if (!st?.isFile()) return null;
    const known = sameFile(r, st);
    const text = await (known && r.sha256
      ? readNotesFor({ path: r.path, sha256: r.sha256 }, userData)
      : readSidecarFor(r.path, userData)).catch(() => null);
    const inked = text ? inkedPages(text) : { pages: 0, blank: 0 };
    return {
      path: r.path,
      name: basename(r.path),
      size: st.size,
      openedAt: r.openedAt,
      ...(known && r.pages ? { pages: r.pages } : {}),
      annotatedPages: inked.pages,
      annotatedBlankPages: inked.blank,
    };
  }));
  return infos.filter((i): i is RecentFileInfo => i !== null);
}
