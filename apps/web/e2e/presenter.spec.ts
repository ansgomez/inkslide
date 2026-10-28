/* Presenter mode. Desktop: the app window's presenter messages shown in the
 * audience page. Both windows get a stand-in Electron bridge; the test passes
 * the messages from one page to the other in order, as the main process
 * does (the main process's relay and window handling are tested in
 * apps/desktop). Browser: the real thing, a pop-up and a BroadcastChannel. */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE, firePointers, openPdf, pageBox, penStroke } from './helpers';

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

/**
 * Wait until the presenter has sent messages of all `types` (frames and the
 * LIVE_MS timer run on their own time), then relay what it sent; returns their types.
 */
async function relayOnce(presenter: Page, audience: Page, types: string[]): Promise<string[]> {
  await expect.poll(() => presenter.evaluate(() =>
    (window as unknown as { stub: Stub }).stub.sent.map(m => (m as { type: string }).type))).toEqual(expect.arrayContaining(types));
  return relay(presenter, audience);
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
  expect(await relayOnce(presenter, audience, ['live'])).toContain('live');
  await expect(audience.locator('path.ann-live')).toHaveCount(1);
  await firePointers(presenter, [{ ...pen, type: 'pointerup', ...(await at(0.5, 0.7)), buttons: 0 }]);
  // The update of the last move may still be on its way: the finished stroke goes before live-end.
  expect((await relayOnce(presenter, audience, ['live-end'])).filter(t => t !== 'live')).toEqual(['strokes', 'live-end']);
  await expect(audience.locator('path.ann-live')).toHaveCount(0);
  await expect(audienceStrokes(audience)).toHaveCount(2);

  // A later stroke on the page comes as a delta; the strokes already shown keep their nodes.
  await audience.evaluate(() => {
    (window as unknown as { kept: Element[] }).kept = [...document.querySelectorAll('.ann-pen path.ann-stroke-pen')];
  });
  await penStroke(presenter, [0.2, 0.8], [0.7, 0.85]);
  expect(await relayOnce(presenter, audience, ['live-end'])).toEqual(['live', 'delta', 'live-end']);
  await expect(audienceStrokes(audience)).toHaveCount(3);
  expect(await audience.evaluate(() => (window as unknown as { kept: Element[] }).kept.every(n => n.isConnected))).toBe(true);

  // The laser.
  await presenter.keyboard.press('l');
  await firePointers(presenter, [
    { ...pen, type: 'pointerover', ...(await at(0.5, 0.5)), buttons: 0 },
    { ...pen, type: 'pointermove', ...(await at(0.55, 0.5)), buttons: 0 },
  ]);
  expect(await relayOnce(presenter, audience, ['laser'])).toContain('laser');
  await expect(audience.locator('.ann-laser')).toHaveCount(1);

  // A blank page, and back.
  await presenter.keyboard.press('b');
  expect(await relayOnce(presenter, audience, ['blanks', 'page'])).toEqual(expect.arrayContaining(['blanks', 'page']));
  await expect(audience.locator('.ink-page svg.ann-page.ink-blank')).toHaveCount(1);
  await presenter.keyboard.press('ArrowLeft');
  expect(await relayOnce(presenter, audience, ['page'])).toEqual(['page']);
  await expect(audience.locator('.ink-page svg.ann-page:not(.ink-blank)')).toHaveCount(1);
  await expect(audienceStrokes(audience)).toHaveCount(3);

  // The audience window closes: nothing more is sent.
  await presenting(presenter, false);
  await presenter.keyboard.press('ArrowRight');
  expect(await relay(presenter, audience)).toEqual([]);
  await context.close();
});

test('the audience sees erasing and moving while they happen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const presenter = await context.newPage();
  const audience = await context.newPage();
  await openAudience(audience);
  await openPresenter(presenter);
  await penStroke(presenter, [0.2, 0.3], [0.6, 0.3]);
  await penStroke(presenter, [0.2, 0.7], [0.6, 0.7]);
  await presenting(presenter, true);
  await relay(presenter, audience);
  await expect(audienceStrokes(audience)).toHaveCount(2);

  const at = async (fx: number, fy: number) => {
    const b = await pageBox(presenter);
    return { x: b.x + b.width * fx, y: b.y + b.height * fy };
  };
  const pen = { pointerType: 'pen', id: 9 } as const;

  // The stroke eraser: the stroke it crosses goes on the audience before the pen lifts.
  await presenter.keyboard.press('e');
  await firePointers(presenter, [
    { ...pen, type: 'pointerover', ...(await at(0.4, 0.15)), buttons: 0 },
    { ...pen, type: 'pointerdown', ...(await at(0.4, 0.15)), buttons: 1 },
    { ...pen, type: 'pointermove', ...(await at(0.4, 0.45)), buttons: 1 },
  ]);
  expect(await relayOnce(presenter, audience, ['erasing'])).toContain('erasing');
  await expect(audienceStrokes(audience)).toHaveCount(1);
  await firePointers(presenter, [{ ...pen, type: 'pointerup', ...(await at(0.4, 0.45)), buttons: 0 }]);
  // The page's first change since the notes: all its strokes, then the end of the preview.
  expect((await relayOnce(presenter, audience, ['preview-end'])).filter(t => t !== 'erasing')).toEqual(['strokes', 'preview-end']);
  await expect(audienceStrokes(audience)).toHaveCount(1);

  // The selector: the selected stroke moves along on the audience, then lands where it was dropped.
  const moved = audience.locator('.ann-pen path.ann-stroke-pen[transform]:not([transform="translate(0 0)"])');
  const before = (await audienceStrokes(audience).first().boundingBox())!;
  await presenter.keyboard.press('s');
  await firePointers(presenter, [
    { ...pen, type: 'pointerover', ...(await at(0.4, 0.7)), buttons: 0 },
    { ...pen, type: 'pointerdown', ...(await at(0.4, 0.7)), buttons: 1 },
    { ...pen, type: 'pointerup', ...(await at(0.4, 0.7)), buttons: 0 },
  ]);
  await firePointers(presenter, [
    { ...pen, type: 'pointerdown', ...(await at(0.4, 0.7)), buttons: 1 },
    { ...pen, type: 'pointermove', ...(await at(0.4, 0.5)), buttons: 1 },
  ]);
  expect(await relayOnce(presenter, audience, ['moving'])).toContain('moving');
  await expect(moved).toHaveCount(1);
  await firePointers(presenter, [
    { ...pen, type: 'pointermove', ...(await at(0.4, 0.55)), buttons: 1 },
    { ...pen, type: 'pointerup', ...(await at(0.4, 0.55)), buttons: 0 },
  ]);
  expect((await relayOnce(presenter, audience, ['preview-end'])).filter(t => t !== 'moving')).toEqual(['delta', 'preview-end']);
  await expect(moved).toHaveCount(0);
  const after = (await audienceStrokes(audience).first().boundingBox())!;
  const page = (await audience.locator('.ink-page').boundingBox())!;
  expect((before.y - after.y) / page.height).toBeCloseTo(0.15, 1);

  // A page turn ends a preview, also to a page the audience does not know yet.
  const ids = await presenter.evaluate(() =>
    (window as unknown as { inkslideViewer: { session: { doc: { strokes(p: string): { id: string }[] } } } }).inkslideViewer.session.doc.strokes('p1').map(x => x.id));
  const deliver = (m: unknown) => audience.evaluate(msg => (window as unknown as { deliver(m: unknown): void }).deliver(msg), m);
  await deliver({ type: 'moving', page: 'p1', ids, dx: 30, dy: 30 });
  await expect(moved).toHaveCount(1);
  await deliver({ type: 'page', page: 'b-not-yet' });
  await expect(moved).toHaveCount(0);
  await deliver({ type: 'page', page: 'p1' });

  // Undo: the audience follows.
  await presenter.keyboard.press('Control+z');
  expect(await relayOnce(presenter, audience, ['delta'])).toEqual(['delta']);
  await expect.poll(async () => (await audienceStrokes(audience).first().boundingBox())!.y).toBeCloseTo(before.y, 0);
  await context.close();
});

test('the audience page opened on its own says what it is', async ({ page }) => {
  await page.goto('/audience.html');
  await expect(page.locator('.ink-waiting')).toContainText('presenter mode');
  await expect(page.locator('.ink-fullscreen-hint')).toBeHidden();
});

test('browser: F5 opens the audience window, which mirrors the tab; reloads, closing and a blocked pop-up', async ({ page }) => {
  const context = page.context();
  await page.goto('/');
  await openPdf(page);
  await penStroke(page, [0.2, 0.3], [0.6, 0.3]);
  const present = page.locator('.ann-bar .ann-btn[data-id="present"]');
  await expect(present).toBeVisible();
  await expect(present).not.toHaveClass(/is-active/);

  const opened = context.waitForEvent('page');
  await page.keyboard.press('F5');
  const audience = await opened;
  await expect(audience).toHaveURL(/audience\.html#[0-9a-f]+$/);
  await expect(audience.locator('.ink-page svg.ann-page')).toHaveCount(1);
  await expect(audienceStrokes(audience)).toHaveCount(1);
  await expect(present).toHaveClass(/is-active/);
  await expect(audience.locator('.ink-fullscreen-hint')).toHaveText('Click or press F11 for full screen');

  // Ink and a page turn follow.
  await penStroke(page, [0.2, 0.6], [0.6, 0.6]);
  await expect(audienceStrokes(audience)).toHaveCount(2);
  await page.keyboard.press('b');
  await expect(audience.locator('.ink-page svg.ann-page.ink-blank')).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await expect(audience.locator('.ink-page svg.ann-page:not(.ink-blank)')).toHaveCount(1);

  // The audience reloads: it asks for everything again.
  await audience.reload();
  await expect(audienceStrokes(audience)).toHaveCount(2);

  // The presenter tab reloads: the audience waits, then follows it again (no PDF open after a reload).
  await page.reload();
  await expect(audience.locator('.ink-waiting')).toHaveText('No PDF is open.');
  await openPdf(page);
  await expect(audienceStrokes(audience)).toHaveCount(2);
  await expect(present).toHaveClass(/is-active/);

  // F5 again ends presenter mode: the audience window closes.
  const closed = audience.waitForEvent('close');
  await page.keyboard.press('F5');
  await closed;
  await expect(present).not.toHaveClass(/is-active/);

  // The toolbar button opens it again; closing the window ends presenter mode.
  const again = context.waitForEvent('page');
  await present.click();
  const second = await again;
  await expect(audienceStrokes(second)).toHaveCount(2);
  await second.close();
  await expect(present).not.toHaveClass(/is-active/);

  // A blocked pop-up: the user is told.
  await page.evaluate(() => { window.open = () => null; });
  await page.keyboard.press('F5');
  await expect(page.locator('.ann-banner')).toContainText('blocked the audience window');
});

test('browser: two presenter tabs each have their own audience window, also a duplicated tab', async ({ page }) => {
  const context = page.context();
  const other = await context.newPage();
  // A tab duplicated by the browser starts with its original's sessionStorage: the same tab id.
  await page.addInitScript(() => sessionStorage.setItem('inkslide:presenter-id', 'e2e-same-tab'));
  await other.addInitScript(() => sessionStorage.setItem('inkslide:presenter-id', 'e2e-same-tab'));
  for (const p of [page, other]) {
    await p.goto('/');
    await openPdf(p);
  }
  await penStroke(page, [0.2, 0.3], [0.6, 0.3]);
  const first = context.waitForEvent('page');
  await page.keyboard.press('F5');
  const audience = await first;
  await expect(audienceStrokes(audience)).toHaveCount(1);
  const second = context.waitForEvent('page');
  await other.keyboard.press('F5');
  const audience2 = await second;
  await expect(audience2.locator('.ink-page svg.ann-page')).toHaveCount(1);
  await expect(audienceStrokes(audience2)).toHaveCount(0);
  // Ink in the second tab shows in its own audience window only.
  await penStroke(other, [0.2, 0.6], [0.6, 0.6]);
  await expect(audienceStrokes(audience2)).toHaveCount(1);
  await expect(audienceStrokes(audience)).toHaveCount(1);
  await expect.poll(() => audience.evaluate(() => document.querySelectorAll('.ann-pen path').length)).toBe(1);
  expect(audience.url()).not.toBe(audience2.url());
  expect(audience.isClosed()).toBe(false);
});
