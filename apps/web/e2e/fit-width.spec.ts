import { expect, test, type Page } from '@playwright/test';
import { expectCounter, firePointers, openPdf } from './helpers';

/* Fit-width mode: the fixture's page 3 is A4 portrait, taller than the
 * 1280×800 window when it fills the width; pages 1-2 (16:9) are not. */

const MARGIN = 6;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;

/** Open the fixture, switch to fit width (W) and go to the portrait page 3. */
async function portraitInWidthMode(page: Page): Promise<void> {
  await openPdf(page);
  await page.keyboard.press('w');
  await expect(page.locator('.ann-bar [data-id="fit-width"]')).toHaveClass(/is-active/);
  await page.keyboard.press('End');
  await expectCounter(page, '3 / 3');
}

test('W fills the stage width; the mode is remembered', async ({ page }) => {
  await openPdf(page);
  const before = await box(page, '.ink-page');
  await page.keyboard.press('w');
  const stage = await box(page, '.ink-stage');
  // 16:9 page: fills the width, still shorter than the stage, centred.
  const wide = await box(page, '.ink-page');
  expect(Math.abs(wide.width - (stage.width - 2 * MARGIN))).toBeLessThanOrEqual(1);
  expect(wide.width).toBeGreaterThanOrEqual(before.width);
  await page.keyboard.press('End');
  await expectCounter(page, '3 / 3');
  const tall = await box(page, '.ink-page');
  expect(Math.abs(tall.width - (stage.width - 2 * MARGIN))).toBeLessThanOrEqual(1);
  expect(tall.height).toBeGreaterThan(stage.height);
  expect(Math.abs(tall.y - (stage.y + MARGIN))).toBeLessThanOrEqual(1); // starts at the top
  // Rendered at the width fit (sharp), not stretched from the page fit.
  await expect.poll(() => page.locator('canvas.ink-pdf').evaluate(c => (c as HTMLCanvasElement).width))
    .toBeGreaterThanOrEqual(Math.floor(tall.width) - 1);

  await page.reload();
  await openPdf(page);
  await expect(page.locator('.ann-bar [data-id="fit-width"]')).toHaveClass(/is-active/);
  await page.locator('.ann-bar [data-id="fit-width"]').click();
  await expect(page.locator('.ann-bar [data-id="fit-width"]')).not.toHaveClass(/is-active/);
  const fitted = await box(page, '.ink-page');
  expect(Math.abs(fitted.width - before.width)).toBeLessThanOrEqual(1);
});

test('wheel scrolls; PgDn / Space scroll, then turn the page; PgUp goes back to the bottom', async ({ page }) => {
  await portraitInWidthMode(page);
  await page.keyboard.press('b'); // blank page after page 3, same size: something to turn to
  await expectCounter(page, '3 / 3 · blank 1/1');
  await page.keyboard.press('ArrowLeft');
  await expectCounter(page, '3 / 3 · +1 blank');
  const stage = await box(page, '.ink-stage');
  const top0 = (await box(page, '.ink-page')).y;

  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await box(page, '.ink-page')).y).toBeCloseTo(top0 - 200, 0);
  // Its own compositor layer while it moves (nothing redrawn per step), not after.
  expect(await page.evaluate(() => {
    document.querySelector('.ink-stage')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }));
    return document.querySelector('.ink-page')!.classList.contains('is-moving');
  })).toBe(true);
  await expect(page.locator('.ink-page')).not.toHaveClass(/is-moving/);
  await page.mouse.wheel(0, -1000); // clamped at the top
  await expect.poll(async () => (await box(page, '.ink-page')).y).toBeCloseTo(top0, 0);

  await page.keyboard.press('PageDown');
  await expectCounter(page, '3 / 3 · +1 blank');
  const scrolled = (await box(page, '.ink-page')).y;
  expect(top0 - scrolled).toBeGreaterThan(0.8 * (stage.height - 2 * MARGIN));
  // Keep going: the page bottom reaches the stage bottom, then the next page starts at its top.
  for (let i = 0; i < 6 && (await page.locator('.ink-page').getAttribute('data-page-id')) === 'p3'; i++) {
    await page.keyboard.press('Space');
  }
  await expectCounter(page, '3 / 3 · blank 1/1');
  expect(Math.abs((await box(page, '.ink-page')).y - top0)).toBeLessThanOrEqual(1);

  await page.keyboard.press('PageUp'); // at the top: the previous page, from its bottom
  await expectCounter(page, '3 / 3 · +1 blank');
  const bottom = await box(page, '.ink-page');
  expect(Math.abs(bottom.y + bottom.height - (stage.y + stage.height - MARGIN))).toBeLessThanOrEqual(1);
  await page.keyboard.press('Shift+Space');
  await expectCounter(page, '3 / 3 · +1 blank');
  expect((await box(page, '.ink-page')).y).toBeGreaterThan(bottom.y);

  // Arrow keys turn pages; the page turn starts at the top.
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, '3 / 3 · blank 1/1');
  await page.keyboard.press('ArrowLeft');
  expect(Math.abs((await box(page, '.ink-page')).y - top0)).toBeLessThanOrEqual(1);
});

test('page keys do not scroll or turn the page while the pen draws', async ({ page }) => {
  await portraitInWidthMode(page);
  const stage = await box(page, '.ink-stage');
  const top0 = (await box(page, '.ink-page')).y;
  const x = stage.x + stage.width / 2, y = stage.y + stage.height / 2;
  await firePointers(page, [
    { type: 'pointerdown', pointerType: 'pen', id: 5, x, y, buttons: 1 },
    { type: 'pointermove', pointerType: 'pen', id: 5, x: x + 40, y: y + 10, buttons: 1 },
  ]);
  for (const key of ['PageDown', 'Space', 'PageUp', 'ArrowLeft', 'Home']) await page.keyboard.press(key);
  await expectCounter(page, '3 / 3');
  expect(Math.abs((await box(page, '.ink-page')).y - top0)).toBeLessThanOrEqual(1);
  await firePointers(page, [{ type: 'pointerup', pointerType: 'pen', id: 5, x: x + 40, y: y + 10, buttons: 0 }]);
  await page.keyboard.press('PageDown'); // pen up: scrolls again
  await expect.poll(async () => (await box(page, '.ink-page')).y).toBeLessThan(top0 - 100);
});

test('with the laser held, a clicker\'s page key still turns the page', async ({ page }) => {
  await portraitInWidthMode(page);
  await page.keyboard.press('l');
  const stage = await box(page, '.ink-stage');
  const x = stage.x + stage.width / 2, y = stage.y + stage.height / 2;
  await firePointers(page, [
    { type: 'pointerdown', pointerType: 'pen', id: 6, x, y, buttons: 1 },
    { type: 'pointermove', pointerType: 'pen', id: 6, x: x + 40, y, buttons: 1 },
  ]);
  await page.keyboard.press('ArrowLeft');
  await expectCounter(page, '2 / 3');
  await firePointers(page, [{ type: 'pointerup', pointerType: 'pen', id: 6, x: x + 40, y, buttons: 0 }]);
});

test('ink lands under the pen on a scrolled page (live canvas and SVG)', async ({ page }) => {
  await portraitInWidthMode(page);
  const stage = await box(page, '.ink-stage');
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await box(page, '.ink-page')).y).toBeLessThan(stage.y - 300);

  const r = await page.evaluate(({ x0, y0 }) => {
    const target = document.elementFromPoint(x0, y0)!;
    const fire = (type: string, i: number, buttons: number) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 11, pointerType: 'pen', isPrimary: true,
      pressure: buttons ? 0.6 : 0, buttons, clientX: x0 + 20 * i, clientY: y0,
    }));
    fire('pointerdown', 0, 1);
    for (let i = 1; i <= 10; i++) fire('pointermove', i, 1);
    // The live canvas has ink under the pen's path (x0 + 100, y0).
    const cv = document.querySelector<HTMLCanvasElement>('canvas.ink-live')!;
    const cr = cv.getBoundingClientRect();
    const k = cv.width / cr.width;
    const px = cv.getContext('2d')!.getImageData(Math.round((x0 + 100 - cr.left) * k), Math.round((y0 - cr.top) * k), 1, 1).data;
    const offPx = cv.getContext('2d')!.getImageData(Math.round((x0 + 100 - cr.left) * k), Math.round((y0 + 60 - cr.top) * k), 1, 1).data;
    fire('pointerup', 10, 0);
    const path = document.querySelector('.ink-page svg.ann-page .ann-pen path')!.getBoundingClientRect();
    return { live: px[3], off: offPx[3], path: { left: path.left, right: path.right, top: path.top, bottom: path.bottom } };
  }, { x0: stage.x + 300, y0: stage.y + stage.height / 2 });
  expect(r.live).toBeGreaterThan(0);
  expect(r.off).toBe(0);
  const y0 = stage.y + stage.height / 2;
  expect(r.path.left).toBeLessThan(stage.x + 300 + 10);
  expect(r.path.right).toBeGreaterThan(stage.x + 500 - 10);
  expect(r.path.top).toBeLessThan(y0 + 1);
  expect(r.path.bottom).toBeGreaterThan(y0 - 1);
  expect(r.path.bottom - r.path.top).toBeLessThan(30);
});

test('one finger scrolls once a pen was seen; not while the pen is busy', async ({ page }) => {
  await portraitInWidthMode(page);
  const stage = await box(page, '.ink-stage');
  const top0 = (await box(page, '.ink-page')).y;
  const x = stage.x + stage.width / 2, y = stage.y + stage.height / 2;
  /** One-finger drag up by 200 px; `pen` first puts the pen down (palm while writing). */
  const drag = (pen: boolean) => firePointers(page, [
    ...(pen ? [{ type: 'pointerdown', pointerType: 'pen', id: 3, x, y, buttons: 1 } as const] : []),
    { type: 'pointerdown', pointerType: 'touch', id: 21, x, y, buttons: 1 },
    ...[1, 2, 3, 4, 5].map(i => ({ type: 'pointermove', pointerType: 'touch', id: 21, x, y: y - 40 * i, buttons: 1 } as const)),
    { type: 'pointerup', pointerType: 'touch', id: 21, x, y: y - 200, buttons: 0 },
    ...(pen ? [{ type: 'pointerup', pointerType: 'pen', id: 3, x, y, buttons: 0 } as const] : []),
  ]);

  await drag(true); // the pen is down (and now seen): the finger is a palm
  await page.waitForTimeout(100);
  expect((await box(page, '.ink-page')).y).toBeCloseTo(top0, 0);
  await page.waitForTimeout(600); // past the pen's grace time
  await drag(false); // touch no longer draws: one finger scrolls
  await expect.poll(async () => (await box(page, '.ink-page')).y).toBeCloseTo(top0 - 200, 0);
});

test('zoom works on top of the width fit and re-renders sharper', async ({ page }) => {
  await portraitInWidthMode(page);
  const stage = await box(page, '.ink-stage');
  const w0 = (await box(page, '.ink-page')).width;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -150);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await box(page, '.ink-page')).width).toBeGreaterThan(w0 * 1.5);
  await expect.poll(() => page.locator('canvas.ink-pdf').evaluate(c => (c as HTMLCanvasElement).width))
    .toBeGreaterThan(w0 * 1.5);
  // The zoomed page still covers the stage width: no gap at the left edge.
  expect((await box(page, '.ink-page')).x).toBeLessThanOrEqual(stage.x + MARGIN + 1);
});
