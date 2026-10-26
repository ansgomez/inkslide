/* Notes backup (desktop): reading unreadable notes again, offering the
 * backup, keeping the unreadable file, and File → Revert to Backup…. The
 * Electron bridge is a stand-in
 * (window.inkslide) that keeps its files in memory; the backup itself is
 * made by the main process (tested in apps/desktop). */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE, penStroke, penStrokes } from './helpers';

const sha = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');

/** Notes for the fixture with `n` pen strokes on page 1. */
const notes = (n: number): string => JSON.stringify({
  format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'fixture', slides: 3, size: [960, 540], sha256: sha },
  pages: [{
    id: 'p1', kind: 'slide', slide: 1,
    strokes: Array.from({ length: n }, (_, i) => ({
      id: `s${i}`, tool: 'pen', color: '#000000', size: 3, points: [[50 + 20 * i, 50, 0.5], [60 + 20 * i, 150, 0.5]],
    })),
  }],
});

interface Files {
  /** Saved notes text; 'unreadable' makes readNotes reject. */
  notes: string | null;
  backup: string | null;
  /** Answers to confirm(), in order. */
  answers: boolean[];
  /** What the first reads of the notes return, before `notes` (e.g. unreadable once, then fine). */
  firstReads?: (string | null)[];
  /** keepUnreadableNotes rejects. */
  keepFails?: boolean;
}

interface Stub extends Files {
  calls: string[];
  questions: string[];
  menu(command: string): void;
}

/** Install the stand-in bridge and open the fixture through initialPath(). */
async function openWith(page: Page, files: Files): Promise<void> {
  await page.addInitScript(([bytes, init]) => {
    const st: Stub = { ...init, calls: [], questions: [], menu: () => {} };
    (window as unknown as { stub: Stub }).stub = st;
    let initial: string | null = '/docs/deck.pdf';
    (window as unknown as { inkslide: unknown }).inkslide = {
      platform: 'electron',
      initialPath: async () => { const p = initial; initial = null; return p; },
      openPdf: async (path: string) => ({ path, name: 'deck.pdf', bytes: new Uint8Array(bytes) }),
      readNotes: async () => {
        st.calls.push('readNotes');
        const text = st.firstReads?.length ? st.firstReads.shift()! : st.notes;
        if (text === 'unreadable') throw new Error('EBUSY: file is in use');
        return text;
      },
      keepUnreadableNotes: async () => {
        st.calls.push('keepUnreadableNotes');
        if (st.keepFails) throw new Error('ENOSPC');
        return '/ud/notes/abc.notes.unreadable.json';
      },
      writeNotes: async (_pdf: unknown, text: string) => { st.calls.push('writeNotes'); st.notes = text; },
      readBackup: async () => (st.backup === null ? null : { text: st.backup, time: Date.UTC(2026, 9, 26, 9, 30) }),
      revertToBackup: async () => {
        st.calls.push('revertToBackup');
        [st.notes, st.backup] = [st.backup, st.notes];
        return st.notes;
      },
      opened: async () => { st.calls.push('opened'); },
      confirm: async (message: string) => { st.questions.push(message); return st.answers.shift() ?? false; },
      exportPdf: async () => false,
      print: async () => false,
      importNotes: async () => null,
      onOpenRequest: () => () => {},
      onMenuCommand: (h: (c: string) => void) => { st.menu = h; return () => {}; },
      onCloseRequest: () => () => {},
      pathForFile: () => '',
    };
  }, [[...readFileSync(FIXTURE)], files] as const);
  await page.goto('/');
}

const stub = (page: Page): Promise<Stub> => page.evaluate(() => {
  const { calls, questions, notes, backup } = (window as unknown as { stub: Stub }).stub;
  return { calls, questions, notes, backup } as Stub;
});
const menu = (page: Page, command: string) =>
  page.evaluate(c => (window as unknown as { stub: Stub }).stub.menu(c), command);
const strokesIn = (text: string | null): number => (text ? JSON.parse(text).pages[0].strokes.length : -1);

const writes = (s: Stub) => s.calls.filter(c => c !== 'readNotes' && c !== 'opened');

test('notes unreadable for a moment are read again after a second, without asking', async ({ page }) => {
  await openWith(page, { notes: notes(1), firstReads: ['unreadable'], backup: notes(3), answers: [] });
  await expect(penStrokes(page)).toHaveCount(1);
  const s = await stub(page);
  expect(s.calls.filter(c => c === 'readNotes')).toHaveLength(2);
  expect(s.questions).toEqual([]);
  expect(writes(s)).toEqual([]);
});

for (const [what, saved] of [['cannot be read', 'unreadable'], ['cannot be parsed', '{ broken']] as const) {
  test(`notes that ${what}: the backup is offered; yes opens it and keeps the unreadable file`, async ({ page }) => {
    await openWith(page, { notes: saved, backup: notes(2), answers: [true] });
    await expect(page.locator('.ink-stage')).toBeVisible();
    await expect(penStrokes(page)).toHaveCount(2);
    const s = await stub(page);
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]).toMatch(/^The notes file could not be read \(.+\)\. Open the backup from .+ instead\?$/);
    expect(writes(s)).toEqual(['keepUnreadableNotes']); // nothing else written until the user changes something
    const msg = page.locator('.ann-banner-warn');
    await expect(msg).toContainText(/Opened the backup from .+\./);
    await expect(msg).toContainText('kept as /ud/notes/abc.notes.unreadable.json');
  });
}

test('declining the backup asks to open anyway; yes keeps the unreadable file first', async ({ page }) => {
  await openWith(page, { notes: '{ broken', backup: notes(2), answers: [false, true] });
  await expect(page.locator('.ink-stage')).toBeVisible();
  await expect(penStrokes(page)).toHaveCount(0);
  const s = await stub(page);
  expect(s.questions).toHaveLength(2);
  expect(s.questions[1]).toContain('Open the PDF anyway?');
  expect(writes(s)).toEqual(['keepUnreadableNotes']);
  await expect(page.locator('.ann-banner-warn')).toContainText('kept as /ud/notes/abc.notes.unreadable.json');
});

test('declining both questions opens nothing and keeps nothing', async ({ page }) => {
  await openWith(page, { notes: '{ broken', backup: notes(2), answers: [false, false] });
  await expect.poll(async () => (await stub(page)).questions).toHaveLength(2);
  await page.waitForTimeout(300);
  await expect(page.locator('.ink-stage')).toBeHidden();
  expect(writes(await stub(page))).toEqual([]);
});

test('if the unreadable file cannot be kept, the user is asked before anything opens', async ({ page }) => {
  await openWith(page, { notes: '{ broken', backup: notes(2), answers: [true, false], keepFails: true });
  await expect.poll(async () => (await stub(page)).questions).toHaveLength(2);
  const s = await stub(page);
  expect(s.questions[1]).toContain('could not be kept (ENOSPC)');
  await page.waitForTimeout(300);
  await expect(page.locator('.ink-stage')).toBeHidden();
});

test('unreadable notes without a usable backup: asked as before', async ({ page }) => {
  await openWith(page, { notes: 'unreadable', backup: '{ broken too', answers: [true] });
  await expect(page.locator('.ink-stage')).toBeVisible();
  const s = await stub(page);
  expect(s.questions).toHaveLength(1);
  expect(s.questions[0]).toContain('could not be read');
  expect(s.questions[0]).toContain('Open the PDF anyway?');
  await expect(penStrokes(page)).toHaveCount(0);
  expect(writes(s)).toEqual(['keepUnreadableNotes']);
});

test('readable notes: the backup is not looked at', async ({ page }) => {
  await openWith(page, { notes: notes(1), backup: notes(3), answers: [] });
  await expect(penStrokes(page)).toHaveCount(1);
  await page.waitForTimeout(300);
  expect((await stub(page)).questions).toEqual([]);
});

test('Revert to Backup saves first, asks, swaps, and a second revert undoes it', async ({ page }) => {
  await openWith(page, { notes: notes(1), backup: notes(3), answers: [false, true, true] });
  await expect(penStrokes(page)).toHaveCount(1);
  await penStroke(page, [0.2, 0.6], [0.7, 0.3]); // not saved yet

  // Declined: the stroke is saved, nothing else changes.
  await menu(page, 'revert-backup');
  await expect.poll(async () => (await stub(page)).questions).toHaveLength(1);
  let s = await stub(page);
  expect(s.questions[0]).toMatch(/^Replace the current notes with the backup from .+\?$/);
  expect(writes(s)).toEqual(['writeNotes']);
  expect(strokesIn(s.notes)).toBe(2);
  await expect(penStrokes(page)).toHaveCount(2);

  // Accepted: the backup's 3 strokes are the notes, the 2 saved ones the backup.
  await menu(page, 'revert-backup');
  await expect(penStrokes(page)).toHaveCount(3);
  s = await stub(page);
  expect(s.calls).toContain('revertToBackup');
  expect(strokesIn(s.backup)).toBe(2);
  await expect(page.locator('.ann-banner-info')).toContainText('Reverted to the backup');
  // Not an undo step.
  await page.keyboard.press('Control+z');
  await expect(penStrokes(page)).toHaveCount(3);

  // Again: back to the 2 strokes.
  await menu(page, 'revert-backup');
  await expect(penStrokes(page)).toHaveCount(2);
  expect(strokesIn((await stub(page)).backup)).toBe(3);
});

test('Revert to Backup without a backup says so', async ({ page }) => {
  await openWith(page, { notes: notes(1), backup: null, answers: [] });
  await expect(penStrokes(page)).toHaveCount(1);
  await menu(page, 'revert-backup');
  await expect(page.locator('.ann-banner-warn')).toContainText('There is no backup of these notes.');
  expect((await stub(page)).questions).toEqual([]);
});
