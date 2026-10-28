import { mkdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_TEXT_BYTES } from '../src/main/fsutil';
import { loadPreferences, parsePreferences, savePreferences } from '../src/main/preferences';
import { recentInfo, RecentFiles } from '../src/main/recent';
import { DEFAULT_STATE, fitToDisplays, loadWindowState, parseWindowState, saveWindowState } from '../src/main/windowState';
import { tempDir } from './helpers';

describe('RecentFiles', () => {
  it('keeps newest first, without duplicates, up to max, and persists', () => {
    const file = join(tempDir(), 'sub', 'recent.json');
    const r = new RecentFiles(file, 3);
    ['/a.pdf', '/b.pdf', '/c.pdf', '/a.pdf', '/d.pdf'].forEach(p => r.add(p));
    expect(r.paths()).toEqual(['/d.pdf', '/a.pdf', '/c.pdf']);
    expect(new RecentFiles(file, 3).paths()).toEqual(['/d.pdf', '/a.pdf', '/c.pdf']);
    expect(r.has('/a.pdf')).toBe(true);
    expect(r.has('/b.pdf')).toBe(false);
    r.remove('/a.pdf');
    expect(new RecentFiles(file).paths()).toEqual(['/d.pdf', '/c.pdf']);
    r.clear();
    expect(new RecentFiles(file).paths()).toEqual([]);
  });
  it('keeps valid entries only, and survives a broken file', () => {
    const dir = tempDir();
    const pdf = join(dir, 'x.pdf');
    writeFileSync(pdf, '%PDF-');
    const file = join(dir, 'recent.json');
    writeFileSync(file, JSON.stringify([pdf, join(dir, 'gone.pdf'), 42, 'relative.pdf']));
    const r = new RecentFiles(file);
    expect(r.paths()).toEqual([pdf, join(dir, 'gone.pdf')]);
    writeFileSync(file, '{ not json');
    expect(new RecentFiles(file).paths()).toEqual([]);
  });
});

describe('recent files records', () => {
  const sha = 'a'.repeat(64);
  const v2 = (dir: string) => join(dir, 'recent-files.v2.json');

  it('reads the bare paths of older builds once, and leaves their file alone', () => {
    const dir = tempDir();
    const legacy = join(dir, 'recent-files.json');
    writeFileSync(legacy, JSON.stringify(['/a.pdf', 'rel.pdf']));
    const r = new RecentFiles(v2(dir), 10, legacy);
    expect(r.records()).toEqual([{ path: '/a.pdf', openedAt: 0 }]);
    r.add('/b.pdf', undefined, 9);
    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toEqual(['/a.pdf', 'rel.pdf']);
    writeFileSync(legacy, JSON.stringify(['/z.pdf']));
    expect(new RecentFiles(v2(dir), 10, legacy).paths()).toEqual(['/b.pdf', '/a.pdf']);
  });

  it('keeps valid fields only, and stamps opens', () => {
    const file = v2(tempDir());
    writeFileSync(file, JSON.stringify([
      { path: '/b.pdf', openedAt: 7, size: 1, mtimeMs: 2, sha256: sha, pages: 3 },
      { path: '/c.pdf', sha256: '../x', pages: 1e300, size: -1, mtimeMs: 2 },
    ]));
    const r = new RecentFiles(file);
    expect(r.records()).toEqual([
      { path: '/b.pdf', openedAt: 7, size: 1, mtimeMs: 2, sha256: sha, pages: 3 },
      { path: '/c.pdf', openedAt: 0 },
    ]);
    r.describe('/c.pdf', { sha256: sha, pages: 12 });
    r.describe('/c.pdf', { pages: 1e300 });
    r.describe('/gone.pdf', { sha256: sha, pages: 1 });
    expect(new RecentFiles(file).records()[1]).toEqual({ path: '/c.pdf', openedAt: 0, sha256: sha, pages: 12 });
  });

  it('forgets the hash and page count of a file that changed', () => {
    const r = new RecentFiles(v2(tempDir()));
    r.add('/a.pdf', { size: 1, mtimeMs: 2 }, 10);
    r.describe('/a.pdf', { sha256: sha, pages: 4 });
    r.add('/a.pdf', { size: 1, mtimeMs: 2 }, 20);
    expect(r.records()[0]).toEqual({ path: '/a.pdf', openedAt: 20, size: 1, mtimeMs: 2, sha256: sha, pages: 4 });
    r.add('/a.pdf', { size: 5, mtimeMs: 2 }, 30);
    expect(r.records()[0]).toEqual({ path: '/a.pdf', openedAt: 30, size: 5, mtimeMs: 2 });
  });

  it('lists the files that exist, with their pages with notes', async () => {
    const dir = tempDir();
    const pdf = join(dir, 'x.pdf');
    writeFileSync(pdf, '%PDF-1.7');
    writeFileSync(`${pdf}.notes.json`, JSON.stringify({
      format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'x.pdf', slides: 2, size: [100, 100] },
      pages: [
        { id: 'p1', kind: 'slide', slide: 1, strokes: [{ id: 's', tool: 'pen', color: '#000', size: 2, points: [[1, 1, 0.5]] }] },
        { id: 'b1', kind: 'blank', after: 1, strokes: [{ id: 't', tool: 'pen', color: '#000', size: 2, points: [[1, 1, 0.5]] }] },
      ],
    }));
    const bare = join(dir, 'y.pdf');
    writeFileSync(bare, '%PDF-1.7');
    const infos = await recentInfo([
      { path: pdf, openedAt: 5, pages: 2 }, { path: join(dir, 'gone.pdf'), openedAt: 4 }, { path: bare, openedAt: 3 },
    ], join(dir, 'userData'));
    expect(infos).toEqual([
      { path: pdf, name: 'x.pdf', size: 8, openedAt: 5, pages: 2, annotatedPages: 1, annotatedBlankPages: 1 },
      { path: bare, name: 'y.pdf', size: 8, openedAt: 3, annotatedPages: 0, annotatedBlankPages: 0 },
    ]);
  });

  it.skipIf(process.platform === 'win32')('without a hash, reads the sidecar with the notes\' rules for links and sizes', async () => {
    const dir = tempDir();
    const userData = join(dir, 'userData');
    const inked = (deck: object) => JSON.stringify({
      format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'x.pdf', slides: 1, size: [100, 100], ...deck },
      pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [{ id: 's', tool: 'pen', color: '#000', size: 2, points: [[1, 1, 0.5]] }] }],
    });
    const pdfWithSidecar = (name: string, target: string) => {
      const pdf = join(dir, name);
      writeFileSync(pdf, '%PDF-1.7');
      symlinkSync(target, `${pdf}.notes.json`);
      return { path: pdf, openedAt: 1 };
    };
    mkdirSync(join(dir, 'synced'));
    const own = join(dir, 'synced', 'a.pdf.notes.json');
    writeFileSync(own, inked({}));
    const other = join(dir, 'synced', 'b.pdf.notes.json');
    writeFileSync(other, inked({ sha256: 'b'.repeat(64) }));
    const secret = join(dir, 'secret.json');
    writeFileSync(secret, inked({}));
    const big = join(dir, 'synced', 'd.pdf.notes.json');
    writeFileSync(big, '');
    truncateSync(big, MAX_TEXT_BYTES + 1);
    const infos = await recentInfo([
      pdfWithSidecar('a.pdf', own), // its own notes kept elsewhere: read
      pdfWithSidecar('b.pdf', other), // records a hash, which is not checked without hashing the PDF: not read
      pdfWithSidecar('c.pdf', secret), // another name: never read
      pdfWithSidecar('d.pdf', big), // too large: not read
      pdfWithSidecar('e.pdf', '/dev/zero'), // not a file: not read (it never ends)
    ], userData);
    expect(infos.map(i => [i.name, i.annotatedPages])).toEqual([['a.pdf', 1], ['b.pdf', 0], ['c.pdf', 0], ['d.pdf', 0], ['e.pdf', 0]]);
  });

  it('reads notes in app storage by hash, unless the file changed since', async () => {
    const dir = tempDir();
    const userData = join(dir, 'userData');
    const pdf = join(dir, 'x.pdf');
    writeFileSync(pdf, '%PDF-1.7');
    const st = statSync(pdf);
    mkdirSync(join(userData, 'notes'), { recursive: true });
    writeFileSync(join(userData, 'notes', `${sha}.notes.json`), JSON.stringify({
      format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'x.pdf', slides: 1, size: [100, 100] },
      pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [{ id: 's', tool: 'pen', color: '#000', size: 2, points: [[1, 1, 0.5]] }] }],
    }));
    const rec = { path: pdf, openedAt: 1, size: st.size, mtimeMs: st.mtimeMs, sha256: sha, pages: 1 };
    expect((await recentInfo([rec], userData))[0]).toMatchObject({ pages: 1, annotatedPages: 1 });
    const changed = await recentInfo([{ ...rec, size: st.size + 1 }], userData);
    expect(changed[0]).toMatchObject({ annotatedPages: 0 });
    expect(changed[0].pages).toBeUndefined();
  });
});

describe('unwritable userData', () => {
  it('keeps working in memory when the files cannot be written', () => {
    const blocker = join(tempDir(), 'file');
    writeFileSync(blocker, ''); // a file where the folder should be: ENOTDIR, also as root
    const r = new RecentFiles(join(blocker, 'recent.json'));
    expect(() => r.add('/a.pdf')).not.toThrow();
    expect(r.has('/a.pdf')).toBe(true);
    expect(() => saveWindowState(join(blocker, 'window-state.json'), DEFAULT_STATE)).not.toThrow();
  });
});

describe('window state', () => {
  it('round-trips through JSON and defaults on missing or bad data', () => {
    const file = join(tempDir(), 'window-state.json');
    expect(loadWindowState(file)).toEqual(DEFAULT_STATE);
    const s = { width: 1000, height: 700, x: 10, y: 20, maximized: true, fullScreen: false, menuHidden: true };
    saveWindowState(file, s);
    expect(loadWindowState(file)).toEqual(s);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(s);
    expect(parseWindowState({ width: 'big', height: 10, x: 5, maximized: 'yes' })).toEqual(DEFAULT_STATE);
  });
  it('fits to the displays', () => {
    const areas = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    const s = { ...DEFAULT_STATE, width: 3000, height: 2000, x: 100, y: 100 };
    expect(fitToDisplays(s, areas)).toMatchObject({ width: 1920, height: 1080, x: 100, y: 100 });
    const off = fitToDisplays({ ...DEFAULT_STATE, x: 5000, y: 100 }, areas);
    expect(off.x).toBeUndefined();
    expect(off.y).toBeUndefined();
    // Second monitor to the left (negative coordinates) still counts.
    const left = fitToDisplays({ ...DEFAULT_STATE, x: -1500, y: 50 }, [...areas, { x: -1920, y: 0, width: 1920, height: 1080 }]);
    expect(left.x).toBe(-1500);
    expect(fitToDisplays(s, [])).toEqual(s);
  });
});

describe('preferences', () => {
  it('turns backups on by default and keeps a saved choice', () => {
    const file = join(tempDir(), 'preferences.json');
    expect(loadPreferences(file)).toEqual({ backups: true });
    savePreferences(file, { backups: false });
    expect(loadPreferences(file)).toEqual({ backups: false });
    writeFileSync(file, '{ broken');
    expect(loadPreferences(file)).toEqual({ backups: true });
    expect(parsePreferences({ backups: 'no' })).toEqual({ backups: true });
  });
});
