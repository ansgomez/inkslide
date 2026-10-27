/* Inkslide annotate - document model, commands and (de)serialization (pure, no DOM)
 *
 * Ported from Marp Notes model.js (© Andres Gomez, MIT).
 * Strokes are immutable: every edit replaces a page's stroke array (and any
 * changed stroke object), so a command only needs the before/after arrays.
 *
 * "Slide" pages are the pages of the source document: Marp slides (ids s1…sN)
 * or PDF pages (ids p1…pN). Blank pages sit after a slide page.
 */
import { round, translatePoints, type Point, type Stroke, type StrokeTool } from './geometry';

/** `format` field of every notes file. */
export const FORMAT = 'marp-notes';
/** Newest notes file version this model reads. Marp decks still write version 1. */
export const VERSION = 2;
/** Stroke tools a notes file may contain. */
export const TOOLS: readonly StrokeTool[] = ['pen', 'highlighter'];
/** Papers of blank pages. */
export const PAPERS = ['plain', 'lined', 'grid'] as const;

/** Paper of a blank page. */
export type Paper = typeof PAPERS[number];
/** [width, height] in page units. */
export type Size = [number, number];
/** 'marp': an HTML deck (slides s<n>); 'pdf': a PDF (pages p<n>). */
export type DeckSource = 'marp' | 'pdf';

/** The document the notes belong to. */
export interface Deck {
  /** 'marp' (HTML deck, page ids s<n>) or 'pdf' (page ids p<n>). */
  source: DeckSource;
  title: string;
  /** Number of source pages (slides or PDF pages). */
  slides: number;
  /** Size of the first page, in viewBox units (PDF: points). */
  size: Size;
  /** Per-page sizes (PDF), index n - 1; pages without an entry use `size`. */
  pageSizes?: Size[];
  /** Hex SHA-256 of the PDF file. */
  sha256?: string;
}

/** Deck for the NotesDoc constructor; missing fields get defaults. */
export type DeckInit = Partial<Deck> & { slides?: number };

/** A page of the source document (Marp slide or PDF page). */
export interface SlidePage {
  id: string;
  kind: 'slide';
  slide: number;
  strokes: readonly Stroke[];
}

/** A page inserted by the user after a slide page. */
export interface BlankPage {
  id: string;
  kind: 'blank';
  /** Number of the slide page this blank page follows. */
  after: number;
  paper: Paper;
  strokes: readonly Stroke[];
}

/** A page of the notes: a source page or a blank page. */
export type Page = SlidePage | BlankPage;

/** An undoable step; `pageId` names the page it changed (if any). */
export interface Command {
  label?: string;
  pageId?: string;
  do(): void;
  undo(): void;
}

/** Unchecked stroke data, as accepted by createStroke. */
export interface StrokeInput {
  id?: string | null;
  tool: string;
  color: unknown;
  size: unknown;
  points: unknown;
}

/** One page as stored in a notes file. */
export interface PageJSON {
  id: string;
  kind: 'slide' | 'blank';
  slide?: number;
  after?: number;
  paper?: Paper;
  strokes: StrokeJSON[];
}

/** One stroke as stored in a notes file. */
export interface StrokeJSON {
  id: string;
  tool: StrokeTool;
  color: string;
  size: number;
  points: Point[];
}

/** Deck information as stored in a notes file (v1: title, slides, size). */
export interface DeckJSON {
  source?: DeckSource;
  title: string;
  slides: number;
  size: Size;
  pageSizes?: Size[];
  sha256?: string;
}

/** A notes file (see docs/NOTES-FORMAT.md). */
export interface NotesJSON {
  format: typeof FORMAT;
  version: number;
  deck: DeckJSON;
  pages: PageJSON[];
}

/** kind: 'strokes' (a page's strokes changed), 'pages' (pages added/removed/restyled) or 'saved'. */
export type ChangeKind = 'strokes' | 'pages' | 'saved';
/** Listener of NotesDoc.onChange; pageId is null for document-wide changes (e.g. 'strokes' of every page after load()). */
export type ChangeListener = (pageId: string | null, kind: ChangeKind) => void;

let idCounter = 0;
// Unique per window, so two windows (presenter + audience) never mint the same id.
const idPrefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/** A new stroke id, unique per window. */
export const newId = (): string => `${idPrefix}-${(idCounter++).toString(36)}`;

/**
 * Largest |x|, |y| and size a stroke may have, in page units. Pages are at most
 * 14400 pt; beyond this the numbers only come from broken files or edits, and
 * would overflow when rounded for saving (null in the file) or exported.
 */
export const MAX_COORD = 1e6;

/** Calls every listener; one that throws is logged and does not stop the others (or the edit that emitted). */
function notify<A extends unknown[]>(listeners: readonly ((...args: A) => void)[], ...args: A): void {
  for (const fn of listeners) {
    try {
      fn(...args);
    } catch (e) {
      if (typeof console !== 'undefined') console.error('Inkslide: a change listener failed', e);
    }
  }
}

/**
 * A checked stroke: known tool, positive finite size, at least one point, finite points within
 * ±MAX_COORD (pressure defaults to 0.5, clamped to 0..1). Throws on bad input; a missing id gets newId().
 */
export function createStroke({ id, tool, color, size, points }: StrokeInput): Stroke {
  if (!TOOLS.includes(tool as StrokeTool)) throw new Error(`Unknown stroke tool: ${tool}`);
  if (!Array.isArray(points)) throw new Error('Stroke points must be an array');
  if (!((size as number) > 0)) throw new Error('Stroke size must be positive');
  if (!(Number(size) <= MAX_COORD)) throw new Error('Stroke size out of range');
  if (!points.length) throw new Error('Stroke has no points');
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  return {
    id: id || newId(),
    tool: tool as StrokeTool,
    color: String(color),
    size: Number(size),
    points: points.map((p: unknown): Point => {
      const q = p as number[] | null;
      const pressure = q && q[2] == null ? 0.5 : q && q[2];
      if (!q || !finite(q[0]) || !finite(q[1]) || !finite(pressure)) {
        throw new Error('Stroke points must be finite numbers');
      }
      if (Math.abs(q[0]) > MAX_COORD || Math.abs(q[1]) > MAX_COORD) throw new Error('Stroke points out of range');
      return [q[0], q[1], Math.min(1, Math.max(0, pressure))];
    }),
  };
}

// ── History ────────────────────────────────────────────────────

/** Command stack; a command is { do(), undo(), label }. */
export class History {
  limit: number;
  undoStack: Command[] = [];
  redoStack: Command[] = [];
  private listeners: ((h: History) => void)[] = [];

  constructor(limit = 500) {
    this.limit = limit;
  }
  /** Run a command and push it on the undo stack (dropping the oldest past `limit`); clears redo. */
  execute<C extends Command>(cmd: C): C {
    cmd.do();
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit();
    return cmd;
  }
  /** Run cmd[method]; a command that fails is dropped (logged), never rethrown. */
  step(from: Command[], to: Command[], method: 'do' | 'undo'): Command | null {
    const cmd = from[from.length - 1];
    if (!cmd) return null;
    try {
      cmd[method]();
    } catch (e) {
      from.pop();
      if (typeof console !== 'undefined') console.warn(`Inkslide: dropped a failing ${cmd.label || 'command'}`, e);
      this.emit();
      return null;
    }
    from.pop();
    to.push(cmd);
    this.emit();
    return cmd;
  }
  undo(): Command | null { return this.step(this.undoStack, this.redoStack, 'undo'); }
  redo(): Command | null { return this.step(this.redoStack, this.undoStack, 'do'); }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  /** The command undo() would revert (the saved state is compared by it). */
  top(): Command | null { return this.undoStack[this.undoStack.length - 1] || null; }
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }
  /** Called after every execute, undo, redo and clear. */
  onChange(fn: (h: History) => void): void { this.listeners.push(fn); }
  emit(): void { notify(this.listeners, this); }
}

// ── Document ───────────────────────────────────────────────────

const sameArray = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const DEFAULT_SIZE: Size = [1280, 720];

/** Page id prefix of the source pages: s<n> for Marp slides, p<n> for PDF pages. */
export const slidePrefix = (source: DeckSource): string => (source === 'pdf' ? 'p' : 's');

/** Whether n is the number of a source page of the deck (an integer in 1..slides). */
const inDeck = (n: number, deck: Deck): boolean => Number.isInteger(n) && n >= 1 && n <= deck.slides;

/** The notes of one document: pages, blank pages, undo history and change events. See the module comment. */
export class NotesDoc {
  deck: Deck;
  pages = new Map<string, Page>();
  blankOrder: string[] = [];   // blank page ids, in sequence order (sorted by .after)
  blankCounter = 0;
  blankPrefix = Math.random().toString(36).slice(2, 8); // per window
  history = new History();
  savedTop: Command | null = null;
  remoteDirty = false; // unsaved changes that arrived from another window
  /**
   * Notes for pages this deck does not have (the PDF got shorter): not shown,
   * written back unchanged so they come back if the pages do.
   */
  kept: PageJSON[] = [];
  private listeners: ChangeListener[] = [];
  private readonly prefix: string;
  private readonly slideRe: RegExp;

  constructor(deck: DeckInit) {
    const source: DeckSource = deck.source === 'pdf' ? 'pdf' : 'marp';
    const pageSizes = deck.pageSizes ? deck.pageSizes.map(s => [s[0], s[1]] as Size) : undefined;
    const size = deck.size ? [deck.size[0], deck.size[1]] as Size
      : pageSizes && pageSizes[0] ? [pageSizes[0][0], pageSizes[0][1]] as Size : DEFAULT_SIZE.slice() as Size;
    this.deck = { source, title: deck.title || '', slides: deck.slides || 0, size };
    if (pageSizes) this.deck.pageSizes = pageSizes;
    if (deck.sha256) this.deck.sha256 = deck.sha256;
    this.prefix = slidePrefix(source);
    this.slideRe = new RegExp(`^${this.prefix}(\\d+)$`);
  }

  // Pages

  /** Id of source page n (s<n> or p<n>); creates the page entry if needed. */
  slidePageId(n: number): string {
    const id = this.slideId(n);
    if (!this.pages.has(id)) this.pages.set(id, { id, kind: 'slide', slide: n, strokes: [] });
    return id;
  }
  getPage(id: string): Page | null { return this.pages.get(id) || null; }
  /** Whether strokes can be written to page `id` (a blank page deleted meanwhile cannot). */
  hasPage(id: string): boolean { return !!(this.pages.get(id) || this.pageOnDemand(id)); }
  private slideId(n: number): string { return `${this.prefix}${n}`; }

  /** Slide pages exist implicitly: create "s<n>" the first time it is written. */
  pageOnDemand(id: string | null | undefined): Page | null {
    const m = this.slideRe.exec(id || '');
    const n = m ? Number(m[1]) : 0;
    return inDeck(n, this.deck) ? this.pages.get(this.slidePageId(n))! : null;
  }

  /** Ids of the blank pages after source page n, in order. */
  blanksAfter(n: number): string[] {
    return this.blankOrder.filter(id => (this.pages.get(id) as BlankPage).after === n);
  }

  /** All pages in reading order: slide 1, its blank pages, slide 2, … */
  sequence(): string[] {
    const blanks = new Map<number, string[]>();
    for (const id of this.blankOrder) {
      const after = (this.pages.get(id) as BlankPage).after;
      const list = blanks.get(after);
      if (list) list.push(id); else blanks.set(after, [id]);
    }
    const out: string[] = [];
    for (let n = 1; n <= this.deck.slides; n++) out.push(this.slideId(n), ...(blanks.get(n) || []));
    return out;
  }

  /** Source page number of a page: its own for a slide page, the one it follows for a blank page. */
  ownerSlide(pageId: string): number | null {
    const page = this.pages.get(pageId);
    if (page) return page.kind === 'slide' ? page.slide : page.after;
    const m = this.slideRe.exec(pageId);
    return m ? Number(m[1]) : null;
  }

  /** { slide, index, count }: index within [slide, ...its blank pages], 1-based. */
  position(pageId: string): { slide: number | null; index: number; count: number } {
    const slide = this.ownerSlide(pageId);
    const group = [`${this.prefix}${slide}`, ...(slide == null ? [] : this.blanksAfter(slide))];
    return { slide, index: group.indexOf(pageId) + 1, count: group.length };
  }

  /** The page `dir` steps away in reading order; null at either end or for an unknown page. */
  neighbor(pageId: string, dir: number): string | null {
    const seq = this.sequence();
    const i = seq.indexOf(pageId);
    return i === -1 ? null : seq[i + dir] || null;
  }

  /** Size of a page in viewBox units; a blank page has the size of its slide page. */
  pageSize(pageId: string): Size {
    const n = this.ownerSlide(pageId);
    const s = n != null && this.deck.pageSizes && this.deck.pageSizes[n - 1];
    return s ? [s[0], s[1]] : [this.deck.size[0], this.deck.size[1]];
  }

  /** Insert a blank page directly after `afterId` (a slide or blank page). */
  insertBlankPage(afterId: string, paper: Paper = 'plain'): Command & { pageId: string } {
    checkPaper(paper);
    const after = this.ownerSlide(afterId);
    if (after == null || !inDeck(after, this.deck)) throw new Error(`No page ${afterId}`);
    let id: string;
    do { id = `b-${this.blankPrefix}-${++this.blankCounter}`; } while (this.pages.has(id) || this.kept.some(k => k.id === id));
    const page: BlankPage = { id, kind: 'blank', after, paper, strokes: [] };
    const anchor = this.pages.get(afterId);
    const idx = anchor && anchor.kind === 'blank'
      ? this.blankOrder.indexOf(afterId) + 1
      : this.blankOrder.filter(b => (this.pages.get(b) as BlankPage).after < after).length;
    return this.history.execute({
      label: 'insert-page', pageId: id,
      do: () => { this.pages.set(id, page); this.blankOrder.splice(idx, 0, id); this.emit(id, 'pages'); },
      undo: () => { this.removeBlank(id); this.emit(id, 'pages'); },
    });
  }

  /** Remove a blank page without a command (undo of an insert, a peer's delete). */
  removeBlank(id: string): void {
    this.pages.delete(id);
    const idx = this.blankOrder.indexOf(id);
    if (idx !== -1) this.blankOrder.splice(idx, 1); // may already be gone (removed by a peer)
  }

  /** Delete a blank page with its strokes; slide pages cannot be deleted. */
  deletePage(id: string): Command | null {
    const page = this.pages.get(id);
    if (!page || page.kind !== 'blank') return null;
    const idx = this.blankOrder.indexOf(id);
    return this.history.execute({
      label: 'delete-page', pageId: id,
      do: () => { this.removeBlank(id); this.emit(id, 'pages'); },
      undo: () => { this.pages.set(id, page); this.blankOrder.splice(idx, 0, id); this.emit(id, 'pages'); },
    });
  }

  /** Change the paper of a blank page (undoable); null if nothing changes. */
  setPaper(id: string, paper: Paper): Command | null {
    checkPaper(paper);
    const page = this.pages.get(id);
    if (!page || page.kind !== 'blank' || page.paper === paper) return null;
    const before = page.paper;
    const set = (v: Paper): void => { page.paper = v; this.emit(id, 'pages'); };
    return this.history.execute({ label: 'paper', pageId: id, do: () => set(paper), undo: () => set(before) });
  }
  /** A page's strokes, bottom to top; empty for an unknown page. */
  strokes(pageId: string): readonly Stroke[] {
    const page = this.pages.get(pageId);
    return page ? page.strokes : [];
  }

  // Changes

  /** Called on every change of strokes or pages and on markSaved (see ChangeKind). */
  onChange(fn: ChangeListener): void { this.listeners.push(fn); }
  emit(pageId: string | null, kind: ChangeKind = 'strokes'): void { notify(this.listeners, pageId, kind); }

  /** Apply fn to a page's stroke list; a page that is gone (deleted by a peer) is skipped. */
  mutate(pageId: string, fn: (list: Stroke[]) => Stroke[]): void {
    const page = this.pages.get(pageId) || this.pageOnDemand(pageId);
    if (!page) return;
    page.strokes = fn(page.strokes.slice());
    this.emit(pageId);
  }

  /**
   * Change a page from its current strokes to `after` in one undoable step
   * (null if nothing changes). The command stores only the delta - strokes
   * removed (with their z-index), added (with their index) and replaced
   * (same id) - so undo/redo leave strokes added meanwhile by another
   * window untouched.
   */
  replaceStrokes(pageId: string, after: readonly Stroke[], label = 'edit'): Command | null {
    const page = this.pages.get(pageId) || this.pageOnDemand(pageId);
    if (!page) throw new Error(`No page ${pageId}`);
    const before = page.strokes;
    if (sameArray(before, after)) return null;
    // Computed outside the closures below, so the undo entry does not keep whole-page maps alive.
    const { removedIds, added, oldById, newById } = strokeDelta(before, after);
    if (!removedIds.size && !added.length && !newById.size) return null; // order-only change
    // New and changed strokes are checked like loaded ones: nothing non-finite is ever stored or saved.
    for (const s of [...added.map(a => a.stroke), ...newById.values()]) createStroke(s);
    const addedIds = new Set(added.map(a => a.stroke.id));
    const insertAll = (list: Stroke[], items: { stroke: Stroke; index: number }[]): Stroke[] => {
      const present = new Set(list.map(s => s.id));
      for (const { stroke, index } of items) {
        if (present.has(stroke.id)) continue;
        list.splice(Math.min(index, list.length), 0, stroke);
        present.add(stroke.id);
      }
      return list;
    };
    let removedAt: { stroke: Stroke; index: number }[] = [];
    return this.history.execute({
      label, pageId,
      do: () => this.mutate(pageId, list => {
        removedAt = [];
        list.forEach((s, index) => { if (removedIds.has(s.id)) removedAt.push({ stroke: s, index }); });
        const kept = list.filter(s => !removedIds.has(s.id)).map(s => newById.get(s.id) || s);
        return insertAll(kept, added);
      }),
      undo: () => this.mutate(pageId, list => {
        const kept = list.filter(s => !addedIds.has(s.id)).map(s => oldById.get(s.id) || s);
        return insertAll(kept, removedAt);
      }),
    });
  }

  addStroke(pageId: string, stroke: Stroke): Command | null {
    return this.replaceStrokes(pageId, [...this.strokes(pageId), stroke], 'draw');
  }

  /** Add strokes on top of a page in one command (a paste); their ids must be new. */
  addStrokes(pageId: string, strokes: readonly Stroke[], label = 'paste'): Command | null {
    return this.replaceStrokes(pageId, [...this.strokes(pageId), ...strokes], label);
  }

  removeStrokes(pageId: string, ids: readonly string[], label = 'delete'): Command | null {
    const gone = new Set(ids);
    return this.replaceStrokes(pageId, this.strokes(pageId).filter(s => !gone.has(s.id)), label);
  }

  clearPage(pageId: string): Command | null {
    if (!this.pages.has(pageId)) return null;
    return this.replaceStrokes(pageId, [], 'clear');
  }

  /** Replace the strokes `ids` by fn(stroke) in one command. */
  updateStrokes(pageId: string, ids: readonly string[], fn: (s: Stroke) => Stroke, label?: string): Command | null {
    const set = new Set(ids);
    return this.replaceStrokes(pageId,
      this.strokes(pageId).map(s => (set.has(s.id) ? fn(s) : s)), label);
  }

  moveStrokes(pageId: string, ids: readonly string[], dx: number, dy: number): Command | null {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return null;
    return this.updateStrokes(pageId, ids,
      s => ({ ...s, points: translatePoints(s.points, dx, dy) }), 'move');
  }

  restyleStrokes(pageId: string, ids: readonly string[], style: StrokeStyle): Command | null {
    return this.updateStrokes(pageId, ids, s => {
      const next = { ...s };
      if (style.color != null) next.color = style.color;
      if (style.size != null) next.size = typeof style.size === 'function' ? style.size(s) : style.size;
      return next.color === s.color && next.size === s.size ? s : next;
    }, 'restyle');
  }

  undo(): Command | null { return this.history.undo(); }
  redo(): Command | null { return this.history.redo(); }

  /** Unsaved changes: local commands since markSaved(), or changes from another window. */
  isDirty(): boolean { return this.remoteDirty || this.history.top() !== this.savedTop; }
  /** The current state is saved (emits 'saved'). */
  markSaved(): void {
    this.savedTop = this.history.top();
    this.remoteDirty = false;
    this.emit(null, 'saved');
  }

  // Changes from another window (presenter view). They bypass the local
  // undo stack; each window undoes only its own commands.

  /** Id, owner and paper of every blank page, in order (for another window). */
  blankMeta(): { id: string; after: number; paper: Paper }[] {
    return this.blankOrder.map(id => {
      const p = this.pages.get(id) as BlankPage;
      return { id, after: p.after, paper: p.paper };
    });
  }

  /** Returns false if the page is unknown here (e.g. its blank page has not arrived yet). */
  applyRemoteStrokes(pageId: string, strokes: readonly StrokeInput[]): boolean {
    const page = this.pages.get(pageId) || this.pageOnDemand(pageId);
    if (!page) return false;
    page.strokes = strokes.map(createStroke);
    this.remoteDirty = true;
    this.emit(pageId);
    return true;
  }

  /**
   * Upsert the peer's blank pages and delete those in `removed`. Local blank
   * pages the peer does not know yet are kept.
   */
  applyRemoteBlanks(list: readonly { id: string; after?: unknown; paper?: unknown }[], removed: readonly string[] = []): void {
    const listed: BlankPage[] = [];
    const seen = new Set<string>();
    for (const meta of list) {
      const after = Number(meta.after);
      if (!inDeck(after, this.deck) || seen.has(meta.id)) continue;
      seen.add(meta.id);
      let page = this.pages.get(meta.id);
      if (!page || page.kind !== 'blank') {
        page = { id: meta.id, kind: 'blank', after, paper: 'plain', strokes: [] };
        this.pages.set(meta.id, page);
      }
      page.after = after;
      page.paper = PAPERS.includes(meta.paper as Paper) ? meta.paper as Paper : 'plain';
      listed.push(page);
    }
    for (const id of removed) {
      const page = this.pages.get(id);
      if (page && page.kind === 'blank' && !seen.has(id)) this.pages.delete(id);
    }
    const localOnly = this.blankOrder.filter(id => !seen.has(id) && this.pages.has(id))
      .map(id => this.pages.get(id) as BlankPage);
    this.blankOrder = [...listed, ...localOnly].sort((a, b) => a.after - b.after).map(p => p.id); // stable
    this.remoteDirty = true;
    this.emit(null, 'pages');
  }

  /** Replace all content with a peer's full state (save-file format). */
  applyRemoteState(data: unknown, dirty = true): void {
    checkFormat(data);
    const pages = ((data as NotesJSON).pages || []).filter(p => p && typeof p.id === 'string');
    const blanks = pages.filter(p => p.kind === 'blank');
    const listed = new Set(blanks.map(p => p.id));
    this.applyRemoteBlanks(blanks, this.blankOrder.filter(id => !listed.has(id)));
    const filled = new Set<string>();
    for (const p of pages) {
      if (this.applyRemoteStrokes(p.id, p.strokes || [])) filled.add(p.id);
    }
    for (const [id, page] of this.pages) {
      if (!filled.has(id) && page.strokes.length) this.applyRemoteStrokes(id, []);
    }
    // Local commands refer to content that was just replaced.
    this.history.clear();
    this.savedTop = null;
    this.remoteDirty = !!dirty;
  }

  // Serialization

  /** Marp decks write version 1 (readable by the HTML decks), PDF decks version 2. */
  toJSON(): NotesJSON {
    const pages: PageJSON[] = [];
    for (const id of this.sequence()) {
      const page = this.pages.get(id);
      if (!page || (page.kind === 'slide' && !page.strokes.length)) continue;
      const out: PageJSON = { id: page.id, kind: page.kind, strokes: [] };
      if (page.kind === 'slide') out.slide = page.slide;
      else { out.after = page.after; out.paper = page.paper; }
      out.strokes = page.strokes.map(serializeStroke);
      pages.push(out);
    }
    for (const k of this.kept) pages.push(structuredClone(k));
    const d = this.deck;
    if (d.source !== 'pdf') {
      return { format: FORMAT, version: 1, deck: { title: d.title, slides: d.slides, size: [d.size[0], d.size[1]] }, pages };
    }
    const deck: DeckJSON = { source: 'pdf', title: d.title, slides: d.slides, size: [d.size[0], d.size[1]] };
    if (d.sha256) deck.sha256 = d.sha256;
    if (d.pageSizes) deck.pageSizes = d.pageSizes.map(s => [s[0], s[1]]);
    return { format: FORMAT, version: 2, deck, pages };
  }

  /** Any content a notes file would keep: strokes, blank pages, or pages kept beyond the deck. */
  hasNotes(): boolean {
    return this.blankOrder.length > 0 || this.kept.length > 0 || [...this.pages.values()].some(p => p.strokes.length > 0);
  }

  /**
   * Replace all content with a parsed save file. `warnings` are problems
   * (skipped pages and strokes, another deck); `notices` tell about pages
   * beyond the deck, which are kept (see `kept`) and are no problem.
   */
  load(data: unknown): { warnings: string[]; notices: string[] } {
    checkFormat(data);
    const file = data as NotesJSON;
    const warnings = deckWarnings(file.deck, this.deck);
    const pages = new Map<string, Page>();
    for (let n = 1; n <= this.deck.slides; n++) {
      const id = this.slideId(n);
      pages.set(id, { id, kind: 'slide', slide: n, strokes: [] });
    }
    const blanks: BlankPage[] = [];
    const strokeIds = new Set<string>();
    const seenPages = new Set<string>();
    const kept: PageJSON[] = [];
    const notices: string[] = [];
    for (const raw of file.pages || []) {
      const page = parsePage(raw, this.deck, warnings, strokeIds, kept, notices);
      if (!page) continue;
      if (seenPages.has(page.id)) { warnings.push(`Skipped duplicate page ${page.id}`); continue; }
      seenPages.add(page.id);
      if (page.kind === 'blank') {
        if (pages.has(page.id)) { warnings.push(`Skipped duplicate page ${page.id}`); continue; }
        blanks.push(page);
      }
      pages.set(page.id, page);
    }
    this.pages = pages;
    this.kept = kept;
    this.blankOrder = blanks.sort((a, b) => a.after - b.after).map(p => p.id); // stable sort
    this.blankCounter = 0;
    this.history.clear();
    this.savedTop = null;
    this.remoteDirty = false;
    // One event for all strokes, not one per page: each would cost the app a full refresh.
    this.emit(null, 'strokes');
    this.emit(null, 'pages');
    return { warnings, notices };
  }
}

/** style: { color?, size?: number | (stroke) => number } */
export interface StrokeStyle {
  color?: string | null;
  size?: number | ((s: Stroke) => number) | null;
}

/** What changes from `before` to `after`: removed ids, added strokes (with index), replaced strokes by id. */
function strokeDelta(before: readonly Stroke[], after: readonly Stroke[]): {
  removedIds: Set<string>;
  added: { stroke: Stroke; index: number }[];
  oldById: Map<string, Stroke>;
  newById: Map<string, Stroke>;
} {
  const beforeById = new Map(before.map(s => [s.id, s]));
  const afterIds = new Set(after.map(s => s.id));
  const removedIds = new Set(before.filter(s => !afterIds.has(s.id)).map(s => s.id));
  const added: { stroke: Stroke; index: number }[] = [];
  const oldById = new Map<string, Stroke>(), newById = new Map<string, Stroke>();
  after.forEach((s, index) => {
    const old = beforeById.get(s.id);
    if (!old) added.push({ stroke: s, index });
    else if (old !== s) { oldById.set(s.id, old); newById.set(s.id, s); }
  });
  return { removedIds, added, oldById, newById };
}

function checkPaper(paper: string): void {
  if (!PAPERS.includes(paper as Paper)) throw new Error(`Unknown paper: ${paper}`);
}

/** A stroke as stored: x and y rounded to 2 decimals, pressure to 3. */
export function serializeStroke(s: Stroke): StrokeJSON {
  return {
    id: s.id, tool: s.tool, color: s.color, size: s.size,
    points: s.points.map(p => [round(p[0], 2), round(p[1], 2), round(p[2], 3)]),
  };
}

/** Throw unless `data` is a notes file of a version this model reads. */
export function checkFormat(data: unknown): asserts data is NotesJSON {
  const d = data as Partial<NotesJSON> | null;
  if (!d || d.format !== FORMAT) throw new Error(`Not a ${FORMAT} file (format mismatch)`);
  if (typeof d.version !== 'number' || d.version > VERSION) {
    throw new Error(`Unsupported notes version: ${d.version}`);
  }
}

/** Warnings when notes made for `fileDeck` are loaded into `deck` (title, checksum, page count, sizes). */
export function deckWarnings(fileDeck: Partial<DeckJSON> | undefined | null, deck: Deck): string[] {
  const w: string[] = [];
  if (!fileDeck) return ['File has no deck information'];
  const sameFile = !!fileDeck.sha256 && !!deck.sha256 && fileDeck.sha256 === deck.sha256;
  if (fileDeck.sha256 && deck.sha256 && !sameFile) w.push('Notes were made for a different version of this PDF (checksum differs)');
  // A renamed but identical PDF is the same document.
  if (!sameFile && fileDeck.title !== deck.title) w.push(`Notes were made for "${fileDeck.title}", not "${deck.title}"`);
  if (fileDeck.slides !== deck.slides) w.push(`Notes deck has ${fileDeck.slides} slides, this deck has ${deck.slides}`);
  const fs = fileDeck.size || [], ds = deck.size;
  const what = deck.source === 'pdf' ? 'Page' : 'Slide';
  if (fs[0] !== ds[0] || fs[1] !== ds[1]) w.push(`${what} size differs (${fs.join('x')} vs ${ds.join('x')})`);
  if (fileDeck.pageSizes && deck.pageSizes) {
    const n = Math.min(fileDeck.pageSizes.length, deck.pageSizes.length);
    let differ = 0;
    for (let i = 1; i < n; i++) { // page 1 is checked above
      const a = fileDeck.pageSizes[i] || [], b = deck.pageSizes[i];
      if (a[0] !== b[0] || a[1] !== b[1]) differ++;
    }
    if (differ) w.push(`${differ} more page size${differ === 1 ? '' : 's'} differ`);
  }
  return w;
}

/** A page beyond the deck's last one (kept, not shown); null if it is within the deck or invalid. */
function beyondDeck(raw: PageJSON, deck: Deck): number | null {
  const n = Number(raw.kind === 'slide' ? raw.slide : raw.kind === 'blank' ? raw.after : NaN);
  return Number.isInteger(n) && n > deck.slides ? n : null;
}

function parsePage(
  raw: PageJSON | null, deck: Deck, warnings: string[], strokeIds: Set<string>, kept: PageJSON[], notices: string[],
): Page | null {
  if (!raw || typeof raw.id !== 'string') { warnings.push('Skipped a page without id'); return null; }
  const beyond = beyondDeck(raw, deck);
  if (beyond !== null) {
    kept.push(structuredClone(raw));
    const what = raw.kind === 'slide' ? `notes for slide ${beyond}` : `blank page ${raw.id} after slide ${beyond}`;
    notices.push(`Kept ${what} (deck has ${deck.slides}): saved with the notes, not shown`);
    return null;
  }
  let page: Page;
  if (raw.kind === 'slide') {
    const n = Number(raw.slide);
    if (!inDeck(n, deck)) {
      warnings.push(`Skipped notes for slide ${raw.slide} (deck has ${deck.slides})`);
      return null;
    }
    // The id follows this deck (s<n> or p<n>), so v1 Marp notes load onto PDF pages.
    page = { id: `${slidePrefix(deck.source)}${n}`, kind: 'slide', slide: n, strokes: [] };
  } else if (raw.kind === 'blank') {
    const after = Number(raw.after);
    if (!inDeck(after, deck)) {
      warnings.push(`Skipped blank page ${raw.id} after slide ${raw.after} (deck has ${deck.slides})`);
      return null;
    }
    const paper = PAPERS.includes(raw.paper as Paper) ? raw.paper as Paper : 'plain';
    page = { id: raw.id, kind: 'blank', after, paper, strokes: [] };
  } else {
    warnings.push(`Skipped page ${raw.id} of unknown kind ${(raw as { kind?: string }).kind}`);
    return null;
  }
  const strokes: Stroke[] = [];
  for (const s of raw.strokes || []) {
    try {
      const stroke = createStroke(strokeIds.has(s && s.id) ? { ...s, id: null } : s);
      strokeIds.add(stroke.id);
      strokes.push(stroke);
    } catch (e) {
      warnings.push(`Skipped a malformed stroke on page ${raw.id}: ${(e as Error).message}`);
    }
  }
  page.strokes = strokes;
  return page;
}
