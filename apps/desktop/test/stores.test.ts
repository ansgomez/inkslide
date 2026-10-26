import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPreferences, parsePreferences, savePreferences } from '../src/main/preferences';
import { RecentFiles } from '../src/main/recent';
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
