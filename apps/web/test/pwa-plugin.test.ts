import { describe, expect, it } from 'vitest';
import { precacheList, SW_FILE } from '../plugins/pwa';

describe('precache list', () => {
  const files = [
    { name: 'index.html', source: '<html>' },
    { name: 'assets/index-abc.js', source: 'code' },
    { name: 'pdfjs/cmaps/78-H.bcmap', source: new Uint8Array([1, 2, 3]) },
    { name: 'assets/index-abc.js.map', source: '{}' },
    { name: SW_FILE, source: 'old worker' },
    { name: 'icons/.DS_Store', source: 'finder' },
  ];

  it('lists every file but the service worker and source maps, sorted', () => {
    expect(precacheList(files).urls).toEqual(['assets/index-abc.js', 'index.html', 'pdfjs/cmaps/78-H.bcmap']);
  });

  it('has a version that depends on content and names, not on order', () => {
    const { version } = precacheList(files);
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(precacheList([...files].reverse()).version).toBe(version);
    const changed = files.map(f => (f.name === 'index.html' ? { ...f, source: '<html lang>' } : f));
    expect(precacheList(changed).version).not.toBe(version);
    const renamed = files.map(f => (f.name === 'index.html' ? { ...f, name: 'start.html' } : f));
    expect(precacheList(renamed).version).not.toBe(version);
    // Skipped files do not count.
    expect(precacheList(files.filter(f => f.name !== SW_FILE)).version).toBe(version);
  });
});
