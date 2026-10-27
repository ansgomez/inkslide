import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { expectCounter, firePointers, openPdf, pageBox, penStroke } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const images = (page: import('@playwright/test').Page) => page.locator('.ink-page svg.ann-page .ann-img image');

/** Drag a snapshot rectangle with the pen, from and to fractions of the page box. */
async function penDrag(page: import('@playwright/test').Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await pageBox(page);
  const at = (f: [number, number]) => ({ x: box.x + box.width * f[0], y: box.y + box.height * f[1] });
  const pen = { pointerType: 'pen', id: 9 } as const;
  await firePointers(page, [
    { ...pen, type: 'pointerover', ...at(from), buttons: 0 },
    { ...pen, type: 'pointerdown', ...at(from), buttons: 1 },
    ...[0.25, 0.5, 0.75, 1].map(t => ({
      ...pen, type: 'pointermove' as const, buttons: 1,
      ...at([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]),
    })),
    { ...pen, type: 'pointerup', ...at(to), buttons: 0 },
  ]);
}

test('snapshot an area, paste it on another page, reload, export', async ({ page }) => {
  await openPdf(page);
  const bar = page.locator('.ann-bar');
  // Red ink in the area: the snapshot has the ink on top of the PDF.
  await bar.locator('[data-id="color-red"]').click();
  await penStroke(page, [0.1, 0.35], [0.4, 0.4]);
  await page.keyboard.press('h'); // the tool to come back to
  await page.keyboard.press('c');
  await expect(bar.locator('[data-id="snapshot"]')).toHaveClass(/is-active/);
  await penDrag(page, [0.05, 0.1], [0.5, 0.45]);
  await expect(page.locator('.ann-banners')).toContainText('Snapshot copied');
  await expect(bar.locator('[data-id="highlighter"]')).toHaveClass(/is-active/);
  await expect(bar.locator('[data-id="paste"]')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expectCounter(page, '2 / 3');
  await page.keyboard.press('Control+V');
  await expect(images(page)).toHaveCount(1);
  expect(await images(page).getAttribute('href')).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  // Same page size: the area's place (the fixture's pages 1 and 2 are both 960×540).
  expect(Number(await images(page).getAttribute('x'))).toBeCloseTo(0.05 * 960, 0);
  expect(Number(await images(page).getAttribute('width'))).toBeCloseTo(0.45 * 960, 0);
  await expect(bar.locator('[data-id="selector"]')).toHaveClass(/is-active/);
  // The snapshot is about 2048 px wide at most, decoded fine by the browser.
  const { natural, dark, red } = await images(page).evaluate(async node => {
    const img = new Image();
    img.src = node.getAttribute('href')!;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, red = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] + px[i + 1] + px[i + 2] < 150) n++;
      if (px[i] > 150 && px[i + 1] < 80 && px[i + 2] < 100) red++;
    }
    return { natural: [img.naturalWidth, img.naturalHeight], dark: n / (px.length / 4), red };
  });
  expect(Math.max(...natural)).toBeLessThanOrEqual(2048);
  expect(natural[0]).toBeGreaterThan(0.45 * 960); // at least 1 px per point (2 per CSS px)
  // The PDF render is in it: the fixture's "Page 1" text (dark) is in the area, on white.
  expect(dark).toBeGreaterThan(0.005);
  expect(dark).toBeLessThan(0.5);
  expect(red).toBeGreaterThan(100);
  if (process.env.INKSLIDE_SNAPSHOT_OUT) {
    const href = (await images(page).getAttribute('href'))!;
    (await import('node:fs')).writeFileSync(process.env.INKSLIDE_SNAPSHOT_OUT, Buffer.from(href.split(',')[1], 'base64'));
  }

  // Saved (2 s after the change), and back after a reload.
  await expect(bar.locator('[data-id="save"]')).not.toHaveClass(/is-unsaved/, { timeout: 5000 });
  await page.reload();
  await openPdf(page);
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, '2 / 3');
  await expect(images(page)).toHaveCount(1);

  // The export has the image as an image XObject.
  await page.evaluate(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  const [download] = await Promise.all([page.waitForEvent('download'), bar.locator('[data-id="pdf"]').click()]);
  const pdf = await PDFDocument.load(readFileSync((await download.path())!));
  const xobjects = pdf.context.enumerateIndirectObjects().map(([, o]) => (o as { dict?: PDFDict }).dict)
    .filter(d => !!d && d.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  expect(xobjects).toHaveLength(1);
});

test('a second finger cancels a finger snapshot; Escape leaves the tool', async ({ page }) => {
  await openPdf(page);
  await page.keyboard.press('c');
  const box = await pageBox(page);
  const p = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await firePointers(page, [
    { type: 'pointerdown', pointerType: 'touch', id: 1, ...p(0.1, 0.1), buttons: 1 },
    { type: 'pointermove', pointerType: 'touch', id: 1, ...p(0.4, 0.4), buttons: 1 },
    { type: 'pointerdown', pointerType: 'touch', id: 2, ...p(0.6, 0.6), buttons: 1 },
    { type: 'pointerup', pointerType: 'touch', id: 1, ...p(0.4, 0.4), buttons: 0 },
    { type: 'pointerup', pointerType: 'touch', id: 2, ...p(0.6, 0.6), buttons: 0 },
  ]);
  await page.waitForTimeout(300);
  await expect(page.getByText('Snapshot copied')).toHaveCount(0);
  await expect(page.locator('.ann-bar [data-id="paste"]')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ann-bar [data-id="pen"]')).toHaveClass(/is-active/);
});
