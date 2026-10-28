import { describe, expect, it } from 'vitest';
import { swAllowed } from '../src/pwa';
import { desktopRecentSource, entryDetails, formatOpened, formatSize } from '../src/recent-list';
import { RecentError } from '../src/recent';
import type { InkslideBridge } from '../src/platform';

describe('service worker registration', () => {
  const web = { protocol: 'https:', electron: false, production: true, serviceWorker: true };

  it('runs in the built page over http(s)', () => {
    expect(swAllowed(web)).toBe(true);
    expect(swAllowed({ ...web, protocol: 'http:' })).toBe(true); // localhost (vite preview)
  });

  it('never in Electron, the dev server or without service workers', () => {
    expect(swAllowed({ ...web, electron: true })).toBe(false);
    expect(swAllowed({ ...web, protocol: 'file:' })).toBe(false);
    expect(swAllowed({ ...web, production: false })).toBe(false);
    expect(swAllowed({ ...web, serviceWorker: false })).toBe(false);
  });
});

describe('recent files labels', () => {
  const now = Date.UTC(2026, 9, 26, 12);
  const MIN = 60_000;

  it('says when a file was opened', () => {
    expect(formatOpened(now - 10_000, now)).toBe('just now');
    expect(formatOpened(now - 5 * MIN, now)).toBe('5 min ago');
    expect(formatOpened(now - 3 * 60 * MIN, now)).toBe('3 h ago');
    expect(formatOpened(now - 30 * 60 * MIN, now)).toBe('yesterday');
    expect(formatOpened(now - 4 * 24 * 60 * MIN, now)).toBe('4 days ago');
    expect(formatOpened(now - 30 * 24 * 60 * MIN, now)).toBe(new Date(now - 30 * 24 * 60 * MIN).toLocaleDateString());
  });

  it('shows pages, size and last opened', () => {
    expect(formatSize(1536)).toBe('2 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(entryDetails({ id: 'a', name: 'a.pdf', pages: 37, size: 2048, openedAt: now - 5 * MIN }, now))
      .toBe('37 pages · 2 KB · opened 5 min ago');
    expect(entryDetails({ id: 'a', name: 'a.pdf', pages: 1, size: 2048, openedAt: now }, now))
      .toBe('1 page · 2 KB · opened just now');
    expect(entryDetails({ id: 'a', name: 'a.pdf', size: 2048, openedAt: now }, now))
      .toBe('2 KB · opened just now');
  });

  it('shows the pages with notes, and leaves out an unknown open time', () => {
    expect(entryDetails({ id: 'a', name: 'a.pdf', pages: 12, size: 2048, openedAt: now, annotatedPages: 3 }, now))
      .toBe('12 pages · notes on 3 pages · 2 KB · opened just now');
    expect(entryDetails({ id: 'a', name: 'a.pdf', size: 2048, openedAt: 0, annotatedPages: 1, annotatedBlankPages: 2 }, now))
      .toBe('notes on 1 page and 2 blank pages · 2 KB');
    expect(entryDetails({ id: 'a', name: 'a.pdf', size: 2048, openedAt: 0, annotatedPages: 0, annotatedBlankPages: 1 }, now))
      .toBe('notes on 1 blank page · 2 KB');
  });
});

describe('desktop recent source', () => {
  const info = { path: '/a.pdf', name: 'a.pdf', size: 10, openedAt: 5, annotatedPages: 2, annotatedBlankPages: 0 };
  const bridge = (openRecent: InkslideBridge['openRecent']) => {
    const handlers: (() => void)[] = [];
    return {
      recentFiles: async () => [info],
      removeRecent: async () => {},
      openRecent,
      onRecentChanged: (fn: () => void) => { handlers.push(fn); return () => {}; },
      handlers,
    } as unknown as InkslideBridge & { handlers: (() => void)[] };
  };

  it('lists the files with the path as id', async () => {
    const src = desktopRecentSource(bridge(async () => null));
    expect(await src.list()).toEqual([{ ...info, id: '/a.pdf' }]);
  });

  it('reports a file that main could not open again as missing', async () => {
    const src = desktopRecentSource(bridge(async () => null));
    await expect(src.read('/a.pdf')).rejects.toSatisfy(e => e instanceof RecentError && e.reason === 'missing');
    const other = desktopRecentSource(bridge(async () => { throw new Error('a.pdf is too large'); }));
    await expect(other.read('/a.pdf')).rejects.not.toBeInstanceOf(RecentError);
  });

  it('passes on changes made in main', () => {
    const b = bridge(async () => null);
    let calls = 0;
    desktopRecentSource(b).onChange!(() => calls++);
    b.handlers.forEach(h => h());
    expect(calls).toBe(1);
  });
});
