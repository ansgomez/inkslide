/* Stress: many strokes on an A4 PDF across page turns, then page 2 again
 * (the case that crashed Tafel). No page error, no console error; the notes
 * survive a reload and the export works. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { expectCounter, FIXTURE, openPdf, penStroke, penStrokes } from './helpers';

const A4: [number, number] = [595.28, 841.89];
const PAGES = 5;
const A4_FIXTURE = join(dirname(FIXTURE), 'a4.pdf');

test.beforeAll(async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < PAGES; i++) pdf.addPage(A4);
  mkdirSync(dirname(A4_FIXTURE), { recursive: true });
  writeFileSync(A4_FIXTURE, await pdf.save());
});

test('many strokes on an A4 PDF, page 2 after page turns: no errors, notes round-trip', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('/');
  await openPdf(page, A4_FIXTURE);
  await expectCounter(page, `1 / ${PAGES}`);

  const perPage = new Map<number, number>();
  /** Part of the page box the stage shows, as fractions of the page box (zoom and fit width scroll). */
  const shown = async () => {
    const pb = (await page.locator('.ink-page').boundingBox())!;
    const sb = (await page.locator('.ink-stage').boundingBox())!;
    const fx = (x: number) => (x - pb.x) / pb.width, fy = (y: number) => (y - pb.y) / pb.height;
    return {
      x0: Math.max(0, fx(sb.x)) + 0.02, x1: Math.min(1, fx(sb.x + sb.width)) - 0.02,
      y0: Math.max(0, fy(sb.y)) + 0.02, y1: Math.min(1, fy(sb.y + sb.height)) - 0.02,
    };
  };
  const draw = async (n: number, count: number) => {
    const v = await shown();
    const at = (fx: number, fy: number): [number, number] => [v.x0 + (v.x1 - v.x0) * fx, v.y0 + (v.y1 - v.y0) * fy];
    for (let k = 0; k < count; k++) {
      const y = 0.1 + 0.8 * ((k * 37) % 100) / 100;
      // also a dot (zero length) and a stroke that leaves the page
      if (k % 5 === 0) await penStroke(page, at(0.5, y), at(0.5, y), 3);
      else if (k % 7 === 0) await penStroke(page, at(0.8, y), [1.3, at(0, y)[1] + 0.05]);
      else await penStroke(page, at(0.1, y), at(0.9, 1 - y));
    }
    perPage.set(n, (perPage.get(n) || 0) + count);
    await expect(penStrokes(page)).toHaveCount(perPage.get(n)!);
  };

  for (let n = 1; n <= PAGES; n++) {
    await draw(n, 8);
    if (n < PAGES) {
      await page.keyboard.press('ArrowRight');
      await expectCounter(page, `${n + 1} / ${PAGES}`);
    }
  }
  // Back to page 2 (Home, then a page turn) and on with fit width and zoom.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, `2 / ${PAGES}`);
  await draw(2, 6);
  await page.keyboard.press('w');
  await draw(2, 4);
  await page.keyboard.press('PageDown'); // scrolls the A4 page in fit width
  await draw(2, 4);
  await page.keyboard.press('w');
  await page.mouse.move(400, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await draw(2, 4);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expectCounter(page, `2 / ${PAGES}`);
  await draw(2, 2);

  // Saved, then restored after a reload.
  await expect(page.locator('.ann-bar [data-id="save"]')).not.toHaveClass(/is-unsaved/, { timeout: 10_000 });
  type V = { inkslideViewer: { session: { doc: { toJSON(): { pages: { id: string; strokes: unknown[] }[] } } } } };
  const notesNow = () => page.evaluate(() => JSON.stringify((window as unknown as V).inkslideViewer.session.doc.toJSON()));
  const before = await notesNow();
  expect(before).not.toMatch(/null|NaN|Infinity/);
  expect(JSON.parse(before).pages.map((p: { id: string; strokes: unknown[] }) => [p.id, p.strokes.length]))
    .toEqual([...perPage].sort((a, b) => a[0] - b[0]).map(([n, c]) => [`p${n}`, c]));

  await page.reload();
  await openPdf(page, A4_FIXTURE);
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, `2 / ${PAGES}`);
  await expect(penStrokes(page)).toHaveCount(perPage.get(2)!);
  expect(await notesNow()).toBe(before); // saved and loaded unchanged

  // Export with all of it.
  await page.evaluate(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.ann-bar [data-id="pdf"]').click()]);
  const out = await PDFDocument.load(readFileSync((await download.path())!));
  expect(out.getPageCount()).toBe(PAGES);
  await expect(page.locator('.ann-banners')).toContainText('Exported a4-notes.pdf');

  expect(errors).toEqual([]);
});
