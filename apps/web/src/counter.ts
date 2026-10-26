/* Inkslide web - page counter text and page-number helpers (pure) */
import type { NotesDoc } from '@inkslide/annotate';
import { formatLabel } from '@inkslide/annotate/pages';

/** "3 / 37", "3 / 37 · +2 blank", "3 / 37 · blank 1/2" (as pages.js); "– / –" without a page. */
export function pageCounter(doc: NotesDoc | null, pageId: string | null): string {
  if (!doc || !pageId || !doc.deck.slides) return '–\u2009/\u2009–';
  return formatLabel(doc.position(pageId), doc.deck.slides);
}

/** PDF page number of a "p<n>" page id, else null. */
export function pdfPageNumber(pageId: string): number | null {
  const m = /^p(\d+)$/.exec(pageId);
  return m ? Number(m[1]) : null;
}

/**
 * Target of Alt+PgDn / Alt+PgUp: the next / previous PDF page, skipping
 * blank pages. From a blank page, back goes to its own PDF page.
 */
export function sourceStep(doc: NotesDoc, pageId: string, dir: -1 | 1): string | null {
  const n = doc.ownerSlide(pageId);
  if (n == null) return null;
  const onBlank = pdfPageNumber(pageId) === null;
  const target = dir < 0 && onBlank ? n : n + dir;
  return target >= 1 && target <= doc.deck.slides ? `p${target}` : null;
}
