import { describe, expect, it } from 'vitest';
import { BitmapCache } from '../src/bitmap-cache';

describe('BitmapCache', () => {
  it('evicts and disposes the least recently used entry', () => {
    const disposed: string[] = [];
    const c = new BitmapCache<string>(3, v => disposed.push(v));
    c.set('a', 'A'); c.set('b', 'B'); c.set('c', 'C');
    expect(c.get('a')).toBe('A'); // a is now the most recent
    c.set('d', 'D');
    expect(c.keys()).toEqual(['c', 'a', 'd']);
    expect(disposed).toEqual(['B']);
  });

  it('disposes a replaced value, but not the same value set again', () => {
    const disposed: string[] = [];
    const c = new BitmapCache<string>(2, v => disposed.push(v));
    c.set('a', 'A1');
    c.set('a', 'A1');
    c.set('a', 'A2');
    expect(disposed).toEqual(['A1']);
    expect(c.size).toBe(1);
  });

  it('finds the latest entry matching a key test', () => {
    const c = new BitmapCache<string>(6);
    c.set('3@1.00', 'small'); c.set('4@1.00', 'other'); c.set('3@2.00', 'big');
    expect(c.find(k => k.startsWith('3@'))).toBe('big');
    expect(c.find(k => k.startsWith('9@'))).toBeUndefined();
  });

  it('delete and clear dispose', () => {
    const disposed: string[] = [];
    const c = new BitmapCache<string>(6, v => disposed.push(v));
    c.set('a', 'A'); c.set('b', 'B');
    c.delete('a');
    c.delete('missing');
    c.clear();
    expect(disposed).toEqual(['A', 'B']);
    expect(c.size).toBe(0);
  });
});
