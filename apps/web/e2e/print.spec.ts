import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { expectCounter, openPdf, penStroke } from './helpers';

/* Print on the web: the annotated PDF as page images and window.print().
 * window.print() is replaced by a recorder (headless Chromium has no print
 * dialog); page.pdf() then prints the page as the browser would (Chromium
 * only). */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as unknown as { printCalls: number };
    w.printCalls = 0;
    window.print = () => { w.printCalls++; };
  });
});

const printCalls = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { printCalls: number }).printCalls);

test('prints the PDF pages with the notes and blank pages as images', async ({ page }) => {
  await openPdf(page);
  await penStroke(page, [0.2, 0.3], [0.7, 0.6]);
  await page.locator('.ann-bar [data-id="page-insert"]').click();
  await expectCounter(page, '1 / 3 · blank 1/1');

  await page.locator('.ann-bar [data-id="print"]').click();
  await expect.poll(() => printCalls(page)).toBe(1);
  await expect(page.locator('body')).toHaveClass(/ink-printing/);
  const imgs = page.locator('.ink-print .ink-print-page img');
  await expect(imgs).toHaveCount(4);

  // The ink is in the first page's image, where it was drawn (black pen; the page has no content there).
  const ink = await imgs.first().evaluate(el => {
    const img = el as HTMLImageElement;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    let dark = 0;
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const [r, g, b] = ctx.getImageData(Math.round(c.width * (0.2 + 0.5 * t)), Math.round(c.height * (0.3 + 0.3 * t)), 1, 1).data;
      if (r < 80 && g < 80 && b < 80) dark++;
    }
    return { dark, width: img.naturalWidth };
  });
  expect(ink.dark).toBeGreaterThan(15);
  expect(ink.width).toBeGreaterThan(2000); // 960 pt at 200 dpi

  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('.ink-print')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/ink-printing/);
});

test('the browser prints only the page images, each page at its own size', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'page.pdf() (the browser\'s print output) is Chromium only');
  await openPdf(page);
  await page.locator('.ann-bar [data-id="page-insert"]').click();
  await expectCounter(page, '1 / 3 · blank 1/1');
  await page.locator('.ann-bar [data-id="print"]').click();
  await expect(page.locator('.ink-print .ink-print-page img')).toHaveCount(4);
  const pdf = await PDFDocument.load(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  const sizes = pdf.getPages().map(p => p.getSize()).map(s => `${Math.round(s.width)}x${Math.round(s.height)}`);
  expect(sizes).toEqual(['960x540', '960x540', '960x540', '595x842']);
});

test('Ctrl+P prints the document, not the screen', async ({ page }) => {
  await page.keyboard.press('Control+p'); // no document: left to the browser, not ours
  await openPdf(page);
  await page.keyboard.press('Control+p');
  await expect.poll(() => printCalls(page)).toBe(1);
  await expect(page.locator('.ink-print .ink-print-page img')).toHaveCount(3);
  // Printing again replaces the container.
  await page.keyboard.press('Control+p');
  await expect.poll(() => printCalls(page)).toBe(2);
  await expect(page.locator('.ink-print')).toHaveCount(1);
});
