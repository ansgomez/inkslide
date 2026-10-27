import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { expectCounter, FIXTURE, openPdf } from './helpers';

const SW_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'sw.js');

const recentItems = (page: Page) => page.locator('.ink-recent-item');

/** Wait until the service worker controls the page (precache complete). */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

/** Number of PDF copies in OPFS (the recent files' "pdfs" directory); 0 without OPFS. */
const opfsCopies = (page: Page): Promise<number> => page.evaluate(async () => {
  let n = 0;
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('pdfs', { create: true });
    for await (const _ of (dir as unknown as AsyncIterable<unknown>)) n++;
  } catch (_) { /* no OPFS (Playwright's WebKit on Linux) */ }
  return n;
});

/** Wait until the recent files hold `n` entries (they are written after the PDF opens). */
async function remembered(page: Page, n = 1): Promise<void> {
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const req = indexedDB.open('inkslide');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recent')) { db.close(); resolve(0); return; }
      const count = db.transaction('recent').objectStore('recent').count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
      count.onerror = () => reject(count.error);
    };
  }))).toBe(n);
}

test.describe('recent files', () => {
  test('lists a PDF opened from a file input after a reload, reopens and removes it', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.ink-recent')).toBeHidden();
    await openPdf(page);
    await remembered(page);

    await page.reload();
    await expect(recentItems(page)).toHaveCount(1);
    await expect(recentItems(page).locator('.ink-recent-name')).toHaveText('small.pdf');
    await expect(recentItems(page).locator('.ink-recent-details')).toContainText('3 pages');
    await expect(recentItems(page).locator('.ink-recent-details')).toContainText('opened just now');

    await recentItems(page).locator('.ink-recent-open').click();
    await expect(page.locator('.ink-stage')).toBeVisible();
    await expectCounter(page, '1 / 3');

    await page.reload();
    await recentItems(page).locator('.ink-recent-remove').click();
    await expect(page.locator('.ink-recent')).toBeHidden();
    expect(await opfsCopies(page)).toBe(0);
    await page.reload();
    await expect(page.locator('.ink-empty')).toBeVisible();
    await expect(recentItems(page)).toHaveCount(0);
  });

  test('keeps the file handle from the open dialog instead of a copy (Chromium)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'File System Access API');
    // showOpenFilePicker hands out a handle to a file in OPFS (a real FileSystemFileHandle).
    const pdf = [...readFileSync(FIXTURE)];
    await page.addInitScript(bytes => {
      (window as unknown as { showOpenFilePicker: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker = async () => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('picked.pdf', { create: true });
        const w = await handle.createWritable();
        await w.write(new Uint8Array(bytes));
        await w.close();
        return [handle];
      };
    }, pdf);
    await page.goto('/');
    await page.locator('.ink-open').click();
    await expect(page.locator('.ink-stage')).toBeVisible();
    await expectCounter(page, '1 / 3');
    await remembered(page);

    await page.reload();
    await expect(recentItems(page)).toHaveCount(1);
    await expect(recentItems(page).locator('.ink-recent-name')).toHaveText('picked.pdf');
    expect(await opfsCopies(page)).toBe(0);
    await recentItems(page).locator('.ink-recent-open').click();
    await expectCounter(page, '1 / 3');

    // The file is gone: the entry is dropped with a message.
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('picked.pdf'));
    await page.reload();
    await recentItems(page).locator('.ink-recent-open').click();
    await expect(page.locator('.ann-banner')).toContainText('can not be opened again');
    await expect(page.locator('.ink-recent')).toBeHidden();
  });

  test('falls back to the file input when the open dialog is blocked', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { showOpenFilePicker: () => Promise<never> }).showOpenFilePicker =
        async () => { throw new DOMException('cross-origin frame', 'SecurityError'); };
    });
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.ink-open').click();
    await (await chooser).setFiles(FIXTURE);
    await expectCounter(page, '1 / 3');
  });

  test('keeps the copy in IndexedDB where OPFS can not be written (Safari before 26)', async ({ page }) => {
    await page.addInitScript(() => { delete (FileSystemFileHandle.prototype as Partial<FileSystemFileHandle>).createWritable; });
    await page.goto('/');
    await openPdf(page);
    await remembered(page);
    await page.reload();
    await expect(recentItems(page)).toHaveCount(1);
    expect(await opfsCopies(page)).toBe(0);
    await recentItems(page).locator('.ink-recent-open').click();
    await expectCounter(page, '1 / 3');
  });
});

test.describe('service worker', () => {
  test('serves the app and renders a PDF with the network off', async ({ page, context }) => {
    await page.goto('/');
    await controlled(page);
    await openPdf(page);
    await remembered(page);

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.ink-empty h1')).toHaveText('Inkslide');
    await recentItems(page).locator('.ink-recent-open').click();
    await expectCounter(page, '1 / 3');
    // A real render: the PDF.js worker and the standard fonts came from the cache.
    await expect.poll(() => page.locator('canvas.ink-pdf').evaluate(c => (c as HTMLCanvasElement).width)).toBeGreaterThan(500);
    // ?pdf= links still get the app shell offline.
    await page.goto('/?pdf=missing.pdf');
    await expect(page.locator('.ink-empty h1')).toHaveText('Inkslide');
    await context.setOffline(false);
  });

  test('a new version shows "Reload to update", takes over after the click and tells other windows', async ({ page }) => {
    await page.goto('/');
    await controlled(page);
    const original = readFileSync(SW_JS, 'utf8');
    const oldVersion = /"version":"([0-9a-f]+)"/.exec(original)![1];
    /** Build caches, sorted (not the active-build record, inkslide:meta). */
    const cacheNames = () => page.evaluate(async () => (await caches.keys()).filter(n => n.startsWith('inkslide-')).sort());
    expect(await cacheNames()).toEqual([`inkslide-${oldVersion}`]);
    const update = async (version: string) => {
      writeFileSync(SW_JS, original.replace(oldVersion, version));
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
      await expect.poll(cacheNames, { timeout: 15_000 }).toContain(`inkslide-${version}`);
      await expect.poll(() => page.evaluate(async () => {
        const r = (await navigator.serviceWorker.getRegistration())!;
        return `${!!r.installing} ${!!r.waiting} ${r.waiting?.state}`;
      }), { timeout: 15_000 }).toBe('false true installed'); // installing, waiting, its state
    };
    try {
      // An update that was never applied: replaced by the next one while waiting. Its cache is not kept.
      await update('e2e1111111111111');
      await update('e2e0000000000000');
      const action = page.locator('.ann-banner .ink-banner-action');
      await expect(action).toHaveText('Reload to update');
      const other = await page.context().newPage(); // a second window on the old version
      await other.goto('/');
      await expect(other.locator('.ann-banner .ink-banner-action')).toHaveText('Reload to update');
      const reloaded = page.waitForEvent('framenavigated');
      await action.click();
      await reloaded;
      await expect(other.locator('.ann-banner-warn')).toContainText('updated in another window');
      await controlled(page);
      // The build that was active is kept (the other window may still load its files lazily), the skipped one goes.
      await expect.poll(cacheNames).toEqual([`inkslide-${oldVersion}`, 'inkslide-e2e0000000000000'].sort());
      const lazy = await page.evaluate(async () => {
        const cache = await caches.open('inkslide-e2e0000000000000');
        const name = (await cache.keys()).map(r => r.url).find(u => /pdf\.worker/.test(u))!;
        await cache.delete(name); // now only the build before has it
        return name;
      });
      await page.context().setOffline(true);
      try {
        expect(await other.evaluate(async u => (await fetch(u)).status, lazy)).toBe(200);
      } finally {
        await page.context().setOffline(false);
      }
    } finally {
      writeFileSync(SW_JS, original);
    }
  });

  test('is not registered in Electron (window.inkslide)', async ({ page }) => {
    // Electron is told apart by window.inkslide (the preload bridge); here a stand-in.
    await page.addInitScript(() => {
      (window as unknown as { inkslide: unknown }).inkslide = {
        platform: 'electron', onMenuCommand() {}, onCloseRequest() {}, openPdf: async () => null,
        readNotes: async () => null, writeNotes: async () => {}, exportPdf: async () => false,
        initialPath: async () => null, recentFiles: async () => [], onRecentChanged() {},
      };
    });
    await page.goto('/');
    await page.waitForTimeout(500);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    // The desktop lists its own recent files (main process), not the browser's: none here.
    await expect(page.locator('.ink-recent')).toHaveCount(1);
    await expect(page.locator('.ink-recent')).toBeHidden();
  });
});
