import { describe, expect, it } from 'vitest';
import { swAllowed } from '../src/pwa';
import { entryDetails, formatOpened, formatSize } from '../src/recent-list';

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
    expect(entryDetails({ id: 'a', name: 'a.pdf', pages: 37, size: 2048, openedAt: now - 5 * MIN, source: 'copy' }, now))
      .toBe('37 pages · 2 KB · opened 5 min ago');
    expect(entryDetails({ id: 'a', name: 'a.pdf', pages: 1, size: 2048, openedAt: now, source: 'handle' }, now))
      .toBe('1 page · 2 KB · opened just now');
    expect(entryDetails({ id: 'a', name: 'a.pdf', size: 2048, openedAt: now, source: 'handle' }, now))
      .toBe('2 KB · opened just now');
  });
});
