import { expect, type Page } from '@playwright/test';
import { FIXTURE } from './global-setup';

export { FIXTURE };

/** Counter text with the thin spaces made plain. */
export async function counter(page: Page): Promise<string> {
  const text = await page.locator('.ann-bar [data-id="page-label"]').textContent();
  return (text || '').replace(/ /g, ' ');
}

export async function expectCounter(page: Page, text: string): Promise<void> {
  await expect.poll(() => counter(page)).toBe(text);
}

/**
 * Make the page open PDFs through its file input, as Safari and Firefox do:
 * Playwright's file chooser does not handle Chromium's showOpenFilePicker
 * (that path is tested with a stub in pwa.spec.ts).
 */
export async function useFileInput(page: Page): Promise<void> {
  await page.evaluate(() => { delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
}

/** Open a PDF through the "Open PDF" button and the file chooser. */
export async function openPdf(page: Page, file = FIXTURE): Promise<void> {
  await useFileInput(page);
  const chooser = page.waitForEvent('filechooser');
  if (await page.locator('.ink-open').isVisible()) await page.locator('.ink-open').click();
  else await page.locator('.ann-bar [data-id="open"]').click();
  await (await chooser).setFiles(file);
  await expect(page.locator('.ink-stage')).toBeVisible();
  await expect(page.locator('.ink-page svg.ann-page')).toHaveCount(1);
}

/** One synthetic pointer event; x, y in client px. Pressure defaults to 0.5 with a button down. */
export interface PointerStep {
  type: 'pointerover' | 'pointerdown' | 'pointermove' | 'pointerup';
  pointerType: 'pen' | 'touch' | 'mouse';
  id: number;
  x: number;
  y: number;
  buttons: number;
  pressure?: number;
}

/**
 * Dispatch pointer events in one task, all at the element under the first
 * one (as with pointer capture). A touch is primary unless another touch is
 * already down.
 */
export async function firePointers(page: Page, steps: readonly PointerStep[]): Promise<void> {
  await page.evaluate(steps => {
    const target = document.elementFromPoint(steps[0].x, steps[0].y)!;
    const touches = new Set<number>();
    for (const s of steps) {
      if (s.pointerType === 'touch' && s.type === 'pointerdown') touches.add(s.id);
      target.dispatchEvent(new PointerEvent(s.type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: s.id, pointerType: s.pointerType, isPrimary: s.pointerType !== 'touch' || [...touches][0] === s.id,
        buttons: s.buttons, button: s.type === 'pointermove' || s.type === 'pointerover' ? -1 : 0,
        pressure: s.pressure ?? (s.buttons ? 0.5 : 0), clientX: s.x, clientY: s.y,
      }));
      if (s.type === 'pointerup') touches.delete(s.id);
    }
  }, steps);
}

/** The page box in client px (zoom and scroll applied). */
export const pageBox = async (page: Page) => (await page.locator('.ink-page').boundingBox())!;

/**
 * Draw a pen stroke with synthetic pointer events (pointerType "pen", rising
 * then falling pressure) across the current page, from (x0, y0) to (x1, y1)
 * given as fractions of the page box.
 */
export async function penStroke(page: Page, from: [number, number], to: [number, number], steps = 24): Promise<void> {
  const box = await pageBox(page);
  const at = (t: number) => ({
    x: box.x + box.width * (from[0] + (to[0] - from[0]) * t),
    y: box.y + box.height * (from[1] + (to[1] - from[1]) * t),
  });
  const pen = { pointerType: 'pen', id: 7 } as const;
  await firePointers(page, [
    { ...pen, type: 'pointerover', ...at(0), buttons: 0 },
    { ...pen, type: 'pointerdown', ...at(0), buttons: 1, pressure: 0.2 },
    ...Array.from({ length: steps }, (_, i) => ({
      ...pen, type: 'pointermove' as const, ...at((i + 1) / steps), buttons: 1, pressure: 0.2 + 0.7 * Math.sin(Math.PI * (i + 1) / steps),
    })),
    { ...pen, type: 'pointerup', ...at(1), buttons: 0 },
  ]);
}

export const penStrokes = (page: Page) => page.locator('.ink-page svg.ann-page .ann-pen path.ann-stroke-pen');
