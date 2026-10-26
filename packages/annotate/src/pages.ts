/* Inkslide annotate - page counter, slide-number parsing and the pages toolbar group
 *
 * The DOM-free parts of Marp Notes pages.js (© Andres Gomez, MIT). Marp's
 * navigation (bespoke buttons, hash, fragments) is left out: the viewer
 * implements PagesController for PDF pages and blank pages.
 */
import type { Paper } from './model';
import type { GroupBuilder, ToolbarHost } from './toolbar';

/** Paper buttons of the pages group. */
export const PAPERS: readonly { id: Paper; label: string; icon: string }[] = [
  { id: 'plain', label: 'Plain paper', icon: 'pagePlain' },
  { id: 'lined', label: 'Lined paper', icon: 'pageLined' },
  { id: 'grid', label: 'Grid paper', icon: 'pageGrid' },
];

/** Page navigation and blank pages, as the toolbar and keys use them. */
export interface PagesController {
  step(dir: -1 | 1): void;
  canStep(dir: -1 | 1): boolean;
  /** Counter text, see formatLabel. */
  label(): string;
  /** Insert a blank page after the current page (with the current paper). */
  insert(paper?: Paper): void;
  /** Paper of the current blank page, else the paper for new blank pages. */
  paper(): Paper;
  setPaper(paper: Paper): void;
  deleteCurrent(): void;
  /** Is a blank page shown? */
  onBlank(): boolean;
}

/** What the pages group needs from the app. */
export interface PagesHost extends ToolbarHost {
  pages: PagesController;
  overview?: { open(): void; prompt?(): string | null } | null;
}

/**
 * Compact page counter (thin spaces around the slash): "3 / 44" on a slide, "3 / 44 · +2 blank" on a slide
 * followed by blank pages, "3 / 44 · blank 1/2" on its first blank page.
 * pos is doc.position() ({ slide, index, count }, index 1 = the slide itself);
 * total counts source pages only.
 */
export function formatLabel(pos: { slide: number | null; index: number; count: number }, total: number): string {
  const base = `${pos.slide} / ${total}`; // thin spaces: the bar is dense
  const blanks = pos.count - 1;
  if (blanks < 1) return base;
  if (pos.index <= 1) return `${base} · +${blanks} blank`;
  return `${base} · blank ${pos.index - 1}/${blanks}`;
}

/** Slide number typed after G: digits only, clamped to 1..total; null if none. */
export function parseSlideNumber(text: string | null | undefined, total: number): number | null {
  if (!/^\d+$/.test(text || '')) return null;
  return Math.max(1, Math.min(total, Number(text)));
}

/** Toolbar group of pages.js (toolbar.ts uses it instead of its placeholder once registered). */
export const pagesGroup: GroupBuilder<PagesHost> = app => ({
  id: 'pages', label: 'Pages',
  items: [
    { id: 'page-prev', title: 'Previous page (←, two-finger swipe right)', icon: 'prev', edge: 'start', onClick: () => app.pages.step(-1),
      disabled: () => !app.pages.canStep(-1) },
    { id: 'page-label', text: () => (app.overview && app.overview.prompt && app.overview.prompt()) || app.pages.label(),
      title: 'Page overview: click to jump to a page (or G, a number, Enter)',
      onClick: () => app.overview && app.overview.open() },
    { id: 'page-next', title: 'Next page (→, two-finger swipe left)', icon: 'next', edge: 'end', onClick: () => app.pages.step(1),
      disabled: () => !app.pages.canStep(1) },
    { id: 'page-insert', title: 'Insert blank page after this page (B)', icon: 'pageInsert',
      onClick: () => app.pages.insert() },
    ...PAPERS.map(p => ({
      id: `paper-${p.id}`, title: `${p.label} (for this and new blank pages)`, icon: p.icon,
      onClick: () => app.pages.setPaper(p.id),
      active: () => app.pages.paper() === p.id,
    })),
    { id: 'page-delete', title: 'Delete this blank page', icon: 'pageDelete',
      onClick: () => app.pages.deleteCurrent(), disabled: () => !app.pages.onBlank() },
  ],
});
