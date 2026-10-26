/* Inkslide web - annotated PDF export
 *
 * The export itself is @inkslide/export (pdf-lib, vector strokes, blank
 * pages). pdf-lib is loaded on first export only, so it stays out of the
 * startup bundle.
 */
import type { NotesJSON } from '@inkslide/annotate';

/** The annotated PDF and what could not be put into it. */
export interface AnnotatedPdf {
  bytes: Uint8Array;
  /** Notes that could not be placed. */
  warnings: string[];
}

/** The PDF with the notes drawn in (loads @inkslide/export on first use). */
export async function buildAnnotatedPdf(pdfBytes: Uint8Array, notesJson: NotesJSON): Promise<AnnotatedPdf> {
  const { exportAnnotatedPdfWithReport } = await import('@inkslide/export');
  return exportAnnotatedPdfWithReport(pdfBytes, notesJson);
}
