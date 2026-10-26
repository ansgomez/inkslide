/* Inkslide web - printing where the platform has no PDF print (browsers, PWA)
 *
 * Electron prints the annotated PDF itself (adapter.print, vector). Here the
 * same PDF (the export: PDF pages with notes, blank pages with their paper)
 * is rendered with PDF.js into one image per page in a print-only container,
 * and window.print() prints those; the rest of the page is hidden for print.
 *
 * Why images and not the PDF in an iframe + contentWindow.print(): that is
 * vector in desktop Chromium, but WebKit (Safari, the iPad PWA) prints only
 * the first page or a blank one, and Chromium without its PDF viewer
 * (headless, some kiosk setups) cannot show it at all. Images print the same
 * everywhere; at PRINT_DPI text stays sharp on paper.
 *
 * Each page gets a named @page with its own size (Chromium, Safari 18.2+);
 * elsewhere the image is scaled into the printer's page. The container
 * stays until `afterprint` (window.print() returns before printing on some
 * browsers) or the next pointerdown. Long documents print at a lower
 * resolution (printDpi) so the decoded images fit in an iPad's memory.
 * window.print() is called after the rendering, outside the click's user
 * activation; Chromium allows that, Safari may ask the user first.
 */
import type { Size } from '@inkslide/annotate';
import { renderScale } from './fit';
import { openPdfDoc, PRIORITY } from './pdf';

/** Print resolution of the page images, dots per inch. */
export const PRINT_DPI = 200;
/** All page images together stay under this many pixels (memory of the decoded images, iPad). */
export const PRINT_PIXEL_BUDGET = 150_000_000;

/**
 * Print resolution for pages of these sizes (points): PRINT_DPI, lowered
 * for long documents so all images stay within PRINT_PIXEL_BUDGET.
 */
export function printDpi(sizes: readonly Size[], dpi = PRINT_DPI, budget = PRINT_PIXEL_BUDGET): number {
  const k = dpi / 72;
  const pixels = sizes.reduce((sum, [w, h]) => sum + w * k * h * k, 0);
  return pixels > budget ? dpi * Math.sqrt(budget / pixels) : dpi;
}

/** Named @page of a page size: one rule per distinct size. */
export const pageRuleName = (size: Size): string => `ink-${Math.round(size[0])}x${Math.round(size[1])}`;

/** @page rules for the given page sizes (points), margins zero. */
export function pageRules(sizes: readonly Size[]): string {
  let css = '@page { margin: 0; }\n';
  for (const [name, size] of new Map(sizes.map(s => [pageRuleName(s), s]))) {
    css += `@page ${name} { size: ${Math.round(size[0])}pt ${Math.round(size[1])}pt; margin: 0; }\n`;
  }
  return css;
}

let cleanup: (() => void) | null = null;

/** Remove the print container (after printing, or before the next print). */
export function endPrint(): void {
  if (cleanup) cleanup();
}

/** Wait until an image has loaded (not decode(): that would keep every page decoded at once). */
const loaded = (img: HTMLImageElement): Promise<void> => new Promise((resolve, reject) => {
  if (img.complete && img.naturalWidth) resolve();
  else {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => reject(new Error(`could not load ${img.alt}`)), { once: true });
  }
});

/** Revoke the blob URLs of the page images in `box`. */
const revokeImages = (box: HTMLElement): void =>
  box.querySelectorAll('img').forEach(img => URL.revokeObjectURL(img.src));

const toBlob = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode a page image'))), 'image/png');
});

/**
 * Print PDF `bytes` as page images with window.print(). Resolves once the
 * print dialog was asked for.
 */
export async function printPageImages(bytes: Uint8Array): Promise<void> {
  endPrint();
  const pdf = await openPdfDoc(bytes);
  const box = document.createElement('div');
  box.className = 'ink-print';
  const style = document.createElement('style');
  try {
    style.textContent = pageRules(pdf.pageSizes);
    const canvas = document.createElement('canvas');
    const dpi = printDpi(pdf.pageSizes);
    for (let n = 1; n <= pdf.numPages; n++) {
      const size = pdf.pageSizes[n - 1];
      // Below the page on screen: turning pages meanwhile stays quick.
      await pdf.renderInto(canvas, n, renderScale(size, dpi / 72), PRIORITY.neighbor);
      const url = URL.createObjectURL(await toBlob(canvas));
      const page = document.createElement('div');
      page.className = 'ink-print-page';
      page.style.setProperty('page', pageRuleName(size));
      page.style.aspectRatio = `${size[0]} / ${size[1]}`;
      const img = new Image();
      img.alt = `Page ${n}`;
      img.src = url;
      page.appendChild(img);
      box.appendChild(page);
    }
    canvas.width = canvas.height = 0;
    await Promise.all([...box.querySelectorAll('img')].map(loaded));
  } catch (e) {
    revokeImages(box);
    throw e;
  } finally {
    void pdf.destroy();
  }
  document.head.appendChild(style);
  document.body.appendChild(box);
  document.documentElement.classList.add('ink-printing');
  document.body.classList.add('ink-printing');
  cleanup = () => {
    cleanup = null;
    window.removeEventListener('afterprint', endPrint);
    window.removeEventListener('pointerdown', endPrint, true);
    document.documentElement.classList.remove('ink-printing');
    document.body.classList.remove('ink-printing');
    box.remove();
    style.remove();
    revokeImages(box);
  };
  window.addEventListener('afterprint', endPrint);
  window.print();
  // Chromium has printed already (print() blocks; afterprint cleaned up). Elsewhere the dialog
  // is modal: if afterprint never comes (a print the browser blocked or the user declined),
  // the next touch or click on the page cleans up.
  if (box.isConnected) window.addEventListener('pointerdown', endPrint, true);
}
