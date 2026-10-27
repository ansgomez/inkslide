/* Presenter mode (desktop): the app window's presenter messages shown in the
 * audience page. Both windows get a stand-in Electron bridge; the test passes
 * the messages from one page to the other in order, as the main process
 * does (the main process's relay and window handling are tested in
 * apps/desktop). */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE, firePointers, pageBox, penStroke } from './helpers';

interface Stub {
  /** Messages sent to the audience, the PDF bytes as a plain array. */
  sent: unknown[];
  presenter(on: boolean): void;
}

/** The app window with a stand-in bridge that records presenter messages; opens the fixture. */
async function openPresenter(page: Page): Promise<void> {
  await page.addInitScript(bytes => {
    const st: Stub = { sent: [], presenter: () => {} };
    (window as unknown as { stub: Stub }).stub = st;
    let initial: string | null = '/docs/deck.pdf';
    (window as unknown as { inkslide: unknown }).inkslide = {
      platform: 'electron',
      initialPath: async () => { const p = initial; initial = null; return p; },
      openPdf: async (path: string) => ({ path, name: 'deck.pdf', bytes: new Uint8Array(bytes) }),
      readNotes: async () => null,
      writeNotes: async () => {},
      readBackup: async () => null,
      revertToBackup: async () => '',
      keepUnreadableNotes: async () => '',
      opened: async () => {},
      confirm: async () => true,
      exportPdf: async () => false,
      print: async () => false,
      importNotes: async () => null,
      onOpenRequest: () => () => {},
      onMenuCommand: () => () => {},
      onCloseRequest: () => () => {},
      pathForFile: () => '',
      onPresenter: (h: (on: boolean) => void) => { st.presenter = h; return () => {}; },
      presenterSend: (m: { pdf?: Uint8Array }) => { st.sent.push(m.pdf ? { ...m, pdf: [...m.pdf] } : structuredClone(m)); },
      onAudience: () => () => {},
    };
  }, [...readFileSync(FIXTURE)]);
  await page.goto('/');
  await expect(page.locator('.ink-page svg.ann-page')).toHaveCount(1);
}

/** The audience page with a stand-in bridge: window.deliver(message) is main's relay. */
async function openAudience(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { inkslide: unknown }).inkslide = {
      platform: 'electron',
      onAudience: (h: (m: unknown) => void) => {
        (window as unknown as { deliver(m: { pdf?: number[] }): void }).deliver = m => h(m.pdf ? { ...m, pdf: new Uint8Array(m.pdf) } : m);
        return () => {};
      },
    };
  });
  await page.goto('/audience.html');
}

/** Pass the messages sent so far from the presenter to the audience; returns their types. */
async function relay(presenter: Page, audience: Page): Promise<string[]> {
  const sent = await presenter.evaluate(() => (window as unknown as { stub: Stub }).stub.sent.splice(0));
  await audience.evaluate(list => {
    for (const m of list) (window as unknown as { deliver(m: unknown): void }).deliver(m);
  }, sent);
  return sent.map(m => (m as { type: string }).type);
}

const presenting = (page: Page, on: boolean) => page.evaluate(o => (window as unknown as { stub: Stub }).stub.presenter(o), on);
const audienceStrokes = (page: Page) => page.locator('.ink-page svg.ann-page .ann-pen path.ann-stroke-pen:not(.ann-live)');

test('the audience page shows the presenter\'s page, ink, live stroke, laser and blank pages', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const presenter = await context.newPage();
  const audience = await context.newPage();
  await openAudience(audience);
  await expect(audience.locator('.ink-waiting')).toHaveText('Waiting for the presenter…');
  await openPresenter(presenter);
  await penStroke(presenter, [0.2, 0.2], [0.6, 0.4]);

  // The audience window opens: it gets the PDF, the notes and the page.
  await presenting(presenter, true);
  expect(await relay(presenter, audience)).toEqual(['open', 'notes', 'page']);
  await expect(audience.locator('.ink-waiting')).toBeHidden();
  await expect(audience.locator('.ink-page svg.ann-page')).toHaveCount(1);
  await expect(audienceStrokes(audience)).toHaveCount(1);
  await expect.poll(() => audience.locator('canvas.ink-pdf').evaluate(c => (c as HTMLCanvasElement).width)).toBeGreaterThan(100);
  // The page fills the window (no toolbar, no margin).
  const box = (await audience.locator('.ink-page').boundingBox())!;
  expect(Math.max(box.width / 1280, box.height / 800)).toBeCloseTo(1, 2);

  // A stroke being written shows as it is written, then as the finished stroke.
  const at = async (fx: number, fy: number) => {
    const b = await pageBox(presenter);
    return { x: b.x + b.width * fx, y: b.y + b.height * fy };
  };
  const pen = { pointerType: 'pen', id: 9 } as const;
  await firePointers(presenter, [
    { ...pen, type: 'pointerover', ...(await at(0.3, 0.6)), buttons: 0 },
    { ...pen, type: 'pointerdown', ...(await at(0.3, 0.6)), buttons: 1 },
    { ...pen, type: 'pointermove', ...(await at(0.4, 0.65)), buttons: 1 },
  ]);
  await firePointers(presenter, [{ ...pen, type: 'pointermove', ...(await at(0.5, 0.7)), buttons: 1 }]);
  await presenter.waitForTimeout(100); // the tool's next frame and the live message after LIVE_MS
  expect(await relay(presenter, audience)).toContain('live');
  await expect(audience.locator('path.ann-live')).toHaveCount(1);
  await firePointers(presenter, [{ ...pen, type: 'pointerup', ...(await at(0.5, 0.7)), buttons: 0 }]);
  await presenter.waitForTimeout(50);
  expect(await relay(presenter, audience)).toEqual(['strokes', 'live-end']);
  await expect(audience.locator('path.ann-live')).toHaveCount(0);
  await expect(audienceStrokes(audience)).toHaveCount(2);

  // The laser.
  await presenter.keyboard.press('l');
  await firePointers(presenter, [
    { ...pen, type: 'pointerover', ...(await at(0.5, 0.5)), buttons: 0 },
    { ...pen, type: 'pointermove', ...(await at(0.55, 0.5)), buttons: 0 },
  ]);
  await presenter.waitForTimeout(50);
  expect(await relay(presenter, audience)).toContain('laser');
  await expect(audience.locator('.ann-laser')).toHaveCount(1);

  // A blank page, and back.
  await presenter.keyboard.press('b');
  expect(await relay(presenter, audience)).toEqual(expect.arrayContaining(['blanks', 'page']));
  await expect(audience.locator('.ink-page svg.ann-page.ink-blank')).toHaveCount(1);
  await presenter.keyboard.press('ArrowLeft');
  await presenter.waitForTimeout(50);
  expect(await relay(presenter, audience)).toEqual(['page']);
  await expect(audience.locator('.ink-page svg.ann-page:not(.ink-blank)')).toHaveCount(1);
  await expect(audienceStrokes(audience)).toHaveCount(2);

  // The audience window closes: nothing more is sent.
  await presenting(presenter, false);
  await presenter.keyboard.press('ArrowRight');
  expect(await relay(presenter, audience)).toEqual([]);
  await context.close();
});

test('the audience page without the desktop app says what it is', async ({ page }) => {
  await page.goto('/audience.html');
  await expect(page.locator('.ink-waiting')).toContainText('presenter mode');
});
