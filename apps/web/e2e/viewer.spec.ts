import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import {
  counter, expectCounter, firePointers, FIXTURE, openPdf, pageBox, penStroke, penStrokes, useFileInput, type PointerStep,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('opens a PDF fitted to the window and turns pages', async ({ page }) => {
  await openPdf(page);
  await expectCounter(page, '1 / 3');
  // Page box fitted: 960×540 pt into the stage, centred.
  const box = (await page.locator('.ink-page').boundingBox())!;
  const stage = (await page.locator('.ink-stage').boundingBox())!;
  expect(Math.abs(box.width / box.height - 960 / 540)).toBeLessThan(0.01);
  expect(box.width <= stage.width && box.height <= stage.height).toBe(true);
  expect(Math.min(stage.width - box.width, stage.height - box.height)).toBeLessThan(20); // touches two edges
  // The PDF canvas got a real render (device pixels, not the 1×1 placeholder).
  await expect.poll(() => page.locator('canvas.ink-pdf').evaluate(c => (c as HTMLCanvasElement).width)).toBeGreaterThan(500);

  await page.keyboard.press('ArrowRight');
  await expectCounter(page, '2 / 3');
  await page.locator('.ann-bar [data-id="page-next"]').click();
  await expectCounter(page, '3 / 3');
  await expect(page.locator('.ann-bar [data-id="page-next"]')).toBeDisabled();
  // Page 3 is portrait.
  const p3 = (await page.locator('.ink-page').boundingBox())!;
  expect(p3.height).toBeGreaterThan(p3.width);
  await page.keyboard.press('PageUp');
  await expectCounter(page, '2 / 3');
  await page.keyboard.press('Space');
  await expectCounter(page, '3 / 3');
  await page.keyboard.press('Home');
  await expectCounter(page, '1 / 3');

  // Refit on resize.
  await page.setViewportSize({ width: 800, height: 700 });
  await expect.poll(async () => (await page.locator('.ink-page').boundingBox())!.width).toBeLessThan(800);
});

test('draws the live stroke on the canvas, then moves it into the SVG', async ({ page }) => {
  await openPdf(page);
  const live = await page.evaluate(() => {
    const box = document.querySelector('.ink-page')!.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width * 0.3, box.top + box.height * 0.3)!;
    const fire = (type: string, f: number, pressure: number, buttons: number) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 9, pointerType: 'pen', isPrimary: true, pressure, buttons,
      clientX: box.left + box.width * (0.3 + 0.3 * f), clientY: box.top + box.height * (0.3 + 0.1 * f),
    }));
    fire('pointerdown', 0, 0.5, 1);
    for (let i = 1; i <= 10; i++) fire('pointermove', i / 10, 0.6, 1);
    const cv = document.querySelector<HTMLCanvasElement>('canvas.ink-live')!;
    const inked = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data.some(v => v !== 0);
    const svgPaths = document.querySelectorAll('.ink-page svg.ann-page .ann-pen path').length;
    fire('pointerup', 1, 0, 0);
    return { inked, svgPaths, pointerEvents: getComputedStyle(cv).pointerEvents };
  });
  expect(live).toEqual({ inked: true, svgPaths: 0, pointerEvents: 'none' });
  await expect(penStrokes(page)).toHaveCount(1);
});

test('draws with the pen, undo and redo', async ({ page }) => {
  await openPdf(page);
  await penStroke(page, [0.2, 0.3], [0.7, 0.6]);
  await expect(penStrokes(page)).toHaveCount(1);
  const d = await penStrokes(page).first().getAttribute('d');
  expect(d && d.length).toBeGreaterThan(50);
  // The live canvas is cleared after pen up.
  const blank = await page.locator('canvas.ink-live').evaluate(c => {
    const cv = c as HTMLCanvasElement;
    const data = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    return data.every(v => v === 0);
  });
  expect(blank).toBe(true);
  await expect(page.locator('.ann-bar [data-id="save"]')).toHaveClass(/is-unsaved/);

  await page.keyboard.press('Control+z');
  await expect(penStrokes(page)).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(penStrokes(page)).toHaveCount(1);
  await page.locator('.ann-bar [data-id="undo"]').click();
  await expect(penStrokes(page)).toHaveCount(0);
  await page.locator('.ann-bar [data-id="redo"]').click();
  await expect(penStrokes(page)).toHaveCount(1);

  // Notes stay with their page.
  await page.keyboard.press('ArrowRight');
  await expect(penStrokes(page)).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(penStrokes(page)).toHaveCount(1);

  // Clear page (undoable).
  await page.locator('.ann-bar [data-id="clear"]').click();
  await expect(penStrokes(page)).toHaveCount(0);
});

test('a two-finger touch (palm) while the pen writes keeps the pen stroke', async ({ page }) => {
  await openPdf(page);
  const box = await pageBox(page);
  const pen = (type: PointerStep['type'], f: number, buttons: number): PointerStep => ({
    type, pointerType: 'pen', id: 7, buttons, pressure: buttons ? 0.6 : 0, x: box.x + box.width * (0.2 + 0.4 * f), y: box.y + box.height * 0.4,
  });
  const touch = (type: PointerStep['type'], id: number, spread = 0): PointerStep => ({
    type, pointerType: 'touch', id, buttons: type === 'pointerup' ? 0 : 1,
    x: box.x + box.width * (0.8 - spread), y: box.y + box.height * (0.7 + id / 1000 + spread),
  });
  await firePointers(page, [
    pen('pointerdown', 0, 1),
    ...[1, 2, 3, 4, 5].map(i => pen('pointermove', i / 10, 1)),
    touch('pointerdown', 20),
    touch('pointerdown', 21),
    ...[6, 7, 8, 9, 10].flatMap(i => [
      pen('pointermove', i / 10, 1),
      touch('pointermove', 21, (i - 5) * 0.04), // the palm spreads: would pinch-zoom
    ]),
    pen('pointerup', 1, 0),
    touch('pointerup', 20),
    touch('pointerup', 21),
  ]);
  await expect(penStrokes(page)).toHaveCount(1);
  // The palm neither zoomed nor panned the page.
  expect(await page.locator('.ink-page').evaluate(el => (el as HTMLElement).style.transform)).toBe('');
});

test('inserts, re-papers and deletes blank pages', async ({ page }) => {
  await openPdf(page);
  await page.locator('.ann-bar [data-id="page-insert"]').click();
  await expectCounter(page, '1 / 3 · blank 1/1');
  await expect(page.locator('.ink-page')).toHaveClass(/is-blank/);
  await expect(page.locator('.ink-page svg.ann-page')).toHaveAttribute('data-paper', 'plain');
  // The paper button cycles plain → lined → grid.
  await page.locator('.ann-bar [data-id="page-paper"]').click();
  await expect(page.locator('.ink-page svg.ann-page')).toHaveAttribute('data-paper', 'lined');
  await page.locator('.ann-bar [data-id="page-paper"]').click();
  await expect(page.locator('.ink-page svg.ann-page')).toHaveAttribute('data-paper', 'grid');
  await expect(page.locator('.ann-bar [data-id="page-paper"]')).toHaveAttribute('data-icon', 'pageGrid');
  await penStroke(page, [0.3, 0.3], [0.6, 0.5]);
  await expect(penStrokes(page)).toHaveCount(1);
  await page.keyboard.press('b'); // second blank page, after this one
  await expectCounter(page, '1 / 3 · blank 2/2');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expectCounter(page, '1 / 3 · +2 blank');
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, '1 / 3 · blank 1/2');
  await page.locator('.ann-bar [data-id="page-delete"]').click();
  await expectCounter(page, '1 / 3 · +1 blank');
  await page.keyboard.press('Control+z'); // undo the delete
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, '1 / 3 · blank 1/2');
  await expect(penStrokes(page)).toHaveCount(1);
  // Alt+PgDn skips the blank pages.
  await page.keyboard.press('Alt+PageDown');
  await expectCounter(page, '2 / 3');
});

test('the paper for new blank pages is remembered', async ({ page }) => {
  await openPdf(page);
  await page.locator('.ann-bar [data-id="page-paper"]').click(); // on a PDF page: only new blank pages
  await expect(page.locator('.ann-bar [data-id="page-paper"]')).toHaveAttribute('data-icon', 'pageLined');
  await page.reload();
  await openPdf(page);
  await expect(page.locator('.ann-bar [data-id="page-paper"]')).toHaveAttribute('data-icon', 'pageLined');
  await page.keyboard.press('b');
  await expect(page.locator('.ink-page svg.ann-page')).toHaveAttribute('data-paper', 'lined');
});

test('− and + next to the counter zoom around the middle; Ctrl+= and Ctrl+− too', async ({ page }) => {
  await openPdf(page);
  const out = page.locator('.ann-bar [data-id="zoom-out"]'), zin = page.locator('.ann-bar [data-id="zoom-in"]');
  const transform = () => page.locator('.ink-page').evaluate(el => (el as HTMLElement).style.transform);
  await expect(out).toBeDisabled();
  await expect(out).toHaveAttribute('title', /now fit page/);
  await zin.click();
  expect(await transform()).toContain('scale(1.25)');
  await expect(out).toBeEnabled();
  await expect(zin).toHaveAttribute('title', /now 125% of fit page/);
  await page.keyboard.press('Control+Equal');
  expect(await transform()).toContain('scale(1.5)');
  await page.keyboard.press('Control+Minus');
  await page.keyboard.press('Control+Minus');
  expect(await transform()).toBe(''); // back at the fit, centred again
  await expect(out).toBeDisabled();
  for (let i = 0; i < 6; i++) await zin.click();
  await expect(zin).toBeDisabled();
  await page.keyboard.press('w'); // fit width starts unzoomed
  await expect(page.locator('.ann-bar [data-id="fit-width"]')).toHaveClass(/is-active/);
  expect(await transform()).toBe('');
  await expect(zin).toBeEnabled();
});

test('a file that is not a PDF shows an error; no PDF.js worker stays behind', async ({ page }) => {
  await useFileInput(page);
  for (let i = 0; i < 2; i++) {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.ink-open').click();
    await (await chooser).setFiles({ name: `broken${i}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
    await expect(page.locator('.ann-banner-error').nth(i)).toContainText(`Could not open broken${i}.pdf`);
  }
  await expect.poll(() => page.workers().length).toBe(0);
  await openPdf(page);
  await openPdf(page); // the first one's worker goes with it
  await expect.poll(() => page.workers().length).toBe(1);
});

test('a PDF asked for while another opens is opened next', async ({ page }) => {
  const two = await PDFDocument.create();
  two.addPage([400, 300]);
  two.addPage([400, 300]);
  const files = [[...readFileSync(FIXTURE)], [...await two.save()]];
  await page.evaluate(([a, b]) => {
    const viewer = (window as unknown as { inkslideViewer: { open(f: unknown): Promise<void> } }).inkslideViewer;
    void viewer.open({ path: null, name: 'small.pdf', bytes: new Uint8Array(a) });
    void viewer.open({ path: null, name: 'two.pdf', bytes: new Uint8Array(b) }); // e.g. from the OS or the recent files
  }, files);
  await expectCounter(page, '1 / 2');
  expect(await page.title()).toBe('two – Inkslide');
});

test('reload restores the notes (web adapter storage)', async ({ page }) => {
  await openPdf(page);
  await penStroke(page, [0.2, 0.2], [0.5, 0.4]);
  await page.locator('.ann-bar [data-id="page-insert"]').click();
  await penStroke(page, [0.2, 0.6], [0.8, 0.6]);
  // Saved 2 s after the last change.
  await expect(page.locator('.ann-bar [data-id="save"]')).toHaveClass(/is-unsaved/);
  await expect(page.locator('.ann-bar [data-id="save"]')).not.toHaveClass(/is-unsaved/, { timeout: 5000 });

  await page.reload();
  await openPdf(page);
  await expectCounter(page, '1 / 3 · +1 blank');
  await expect(penStrokes(page)).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, '1 / 3 · blank 1/1');
  await expect(penStrokes(page)).toHaveCount(1);
});

test('asks before saved notes that cannot be loaded are replaced', async ({ page }) => {
  const key = `inkslide-notes:${createHash('sha256').update(readFileSync(FIXTURE)).digest('hex')}`;
  const newer = JSON.stringify({ format: 'marp-notes', version: 99, deck: {}, pages: [] });
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, newer]);
  const messages: string[] = [];
  let accept = false;
  page.on('dialog', d => { messages.push(d.message()); void (accept ? d.accept() : d.dismiss()); });

  // Declined: the PDF is not opened and the notes stay as they are.
  await useFileInput(page);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.ink-open').click();
  await (await chooser).setFiles(FIXTURE);
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain('Unsupported notes version: 99');
  await expect(page.locator('.ink-stage')).toBeHidden();

  // Accepted: it opens, and what is written now replaces the saved notes.
  accept = true;
  await openPdf(page);
  expect(messages).toHaveLength(2);
  expect(await page.evaluate(k => localStorage.getItem(k), key)).toBe(newer);
  await penStroke(page, [0.2, 0.3], [0.7, 0.6]);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.ann-bar [data-id="save"]')).not.toHaveClass(/is-unsaved/);
});

test('importing asks before it replaces notes kept for pages beyond the PDF', async ({ page }) => {
  await openPdf(page);
  const messages: string[] = [];
  page.on('dialog', d => { messages.push(d.message()); void d.dismiss(); });
  const kept = JSON.stringify({
    format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'x', slides: 9 },
    pages: [{ id: 'p9', kind: 'slide', slide: 9, strokes: [] }],
  });
  const keptCount = () => page.evaluate(() =>
    (window as unknown as { inkslideViewer: { session: { doc: { kept: unknown[] } } } }).inkslideViewer.session.doc.kept.length);
  const importText = (text: string) => page.evaluate(t =>
    (window as unknown as { inkslideViewer: { importNotes(f: { name: string; text: string }): Promise<void> } })
      .inkslideViewer.importNotes({ name: 'n.json', text: t }), text);
  await importText(kept); // nothing to replace yet: no question
  expect(messages).toHaveLength(0);
  expect(await keptCount()).toBe(1);
  await importText(JSON.stringify({ format: 'marp-notes', version: 2, deck: { source: 'pdf' }, pages: [] }));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('Replace the notes');
  expect(await keptCount()).toBe(1); // declined: kept
});

test('an import answered after another PDF opened is dropped', async ({ page }) => {
  await openPdf(page);
  await penStroke(page, [0.2, 0.3], [0.7, 0.6]); // notes to replace: the import asks
  const two = await PDFDocument.create();
  two.addPage([400, 300]);
  two.addPage([400, 300]);
  await page.evaluate(async bytes => {
    const w = window as unknown as {
      inkslideViewer: { open(f: unknown): Promise<void>; importNotes(f: { name: string; text: string }): Promise<void> };
    };
    let answer: (ok: boolean) => void = () => {};
    window.confirm = (() => new Promise<boolean>(r => { answer = r; })) as unknown as typeof window.confirm; // a dialog that waits
    const imported = w.inkslideViewer.importNotes({
      name: 'n.json', text: JSON.stringify({ format: 'marp-notes', version: 2, deck: { source: 'pdf' }, pages: [] }),
    });
    await w.inkslideViewer.open({ path: null, name: 'two.pdf', bytes: new Uint8Array(bytes) }); // meanwhile, from the OS
    answer(true);
    await imported;
  }, [...await two.save()]);
  await expectCounter(page, '1 / 2');
  await expect(page.locator('.ann-banner', { hasText: 'Imported' })).toHaveCount(0);
  await expect(page.locator('.ann-bar [data-id="save"]')).not.toHaveClass(/is-unsaved/);
});

test('overview grid and G + number jump', async ({ page }) => {
  await openPdf(page);
  await page.keyboard.press('g');
  await page.keyboard.press('3');
  expect(await counter(page)).toBe('Go to 3_');
  await page.keyboard.press('Enter');
  await expectCounter(page, '3 / 3');
  await page.locator('.ann-bar [data-id="page-label"]').click();
  await expect(page.locator('#ann-ov')).toBeVisible();
  await expect(page.locator('#ann-ov .ann-ov-item')).toHaveCount(3);
  await expect(page.locator('#ann-ov .ann-ov-item.is-current')).toHaveAttribute('data-n', '3');
  // Thumbnails are PDF.js renders.
  await expect.poll(() => page.locator('#ann-ov .ann-ov-item[data-n="1"] canvas').evaluate(c => (c as HTMLCanvasElement).width)).toBeGreaterThan(100);
  await page.locator('#ann-ov .ann-ov-item[data-n="2"]').click();
  await expect(page.locator('#ann-ov')).toBeHidden();
  await expectCounter(page, '2 / 3');
});

test('annotate mode off: the bar collapses, keys still turn pages', async ({ page }) => {
  await openPdf(page);
  await page.keyboard.press('a');
  await expect(page.locator('body')).not.toHaveClass(/ann-on/);
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, '2 / 3');
  await page.keyboard.press('a');
  await expect(page.locator('body')).toHaveClass(/ann-on/);
  // Dock cycles through the four edges.
  for (const dock of ['right', 'bottom', 'left', 'top']) {
    await page.locator('.ann-bar [data-id="dock"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-ann-dock', dock);
  }
});

// A large real-world PDF of your own; the test is skipped without one.
const BIG = process.env.INKSLIDE_FIXTURE_PDF || '';

test('big PDF: opens and turns pages quickly with a warm cache', async ({ page }) => {
  test.skip(!BIG || !existsSync(BIG), `set INKSLIDE_FIXTURE_PDF to a large PDF (now: "${BIG}")`);
  test.setTimeout(60_000);
  await openPdf(page, BIG);
  const total = Number((await counter(page)).split('/')[1]);
  expect(total).toBeGreaterThan(1);
  await page.keyboard.press('ArrowRight');
  await expectCounter(page, `2 / ${total}`);
  await page.waitForTimeout(1500); // pre-render of the neighbours
  // Time of the key handler: counter, surface swap and drawing the cached bitmap.
  const ms = await page.evaluate(() => {
    const t0 = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true }));
    return performance.now() - t0;
  });
  await expectCounter(page, `1 / ${total}`);
  console.log(`page turn with warm cache: ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(100);
});

test('exports the PDF with the notes and a blank page', async ({ page }) => {
  await openPdf(page);
  await penStroke(page, [0.2, 0.3], [0.7, 0.6]);
  await page.locator('.ann-bar [data-id="page-insert"]').click();
  await expectCounter(page, '1 / 3 · blank 1/1');
  // Chromium has showSaveFilePicker; fall back to the download.
  await page.evaluate(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.ann-bar [data-id="pdf"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('small-notes.pdf');
  const bytes = readFileSync((await download.path())!);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(4);
  await expect(page.locator('.ann-banners')).toContainText('Exported small-notes.pdf');
});

test('?pdf= opens PDFs of the same site only; the CSP lets nothing else be fetched', async ({ page }) => {
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  // No other sites, and no Tauri IPC outside the Tauri build (build:tauri).
  expect(csp).toMatch(/connect-src 'self' blob: data:;/);
  await page.goto('/?pdf=https://example.com/slides.pdf');
  await expect(page.locator('.ann-banner-error')).toContainText('only PDFs from this site');
});
