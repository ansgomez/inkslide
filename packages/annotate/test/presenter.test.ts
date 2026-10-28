import { describe, expect, it } from 'vitest';
import type { Point } from '../src/geometry';
import { commonPrefix, parsePresenterMessage, PRESENTER_LIMITS } from '../src/presenter';
import { NotesDoc } from '../src/model';
import { deckFromPdf } from '../src/io';

const stroke = { id: 's1', tool: 'pen', color: '#000', size: 4, points: [[1, 2, 0.4], [3, 4]] };

describe('parsePresenterMessage', () => {
  it('takes every message type and keeps only the known fields', () => {
    const pdf = new Uint8Array([37, 80, 68, 70]);
    expect(parsePresenterMessage({ type: 'open', pdf, title: 'Deck', extra: 1 })).toEqual({ type: 'open', pdf, title: 'Deck' });
    expect(parsePresenterMessage({ type: 'notes', notes: '{}' })).toEqual({ type: 'notes', notes: '{}' });
    expect(parsePresenterMessage({ type: 'close', page: 'p1' })).toEqual({ type: 'close' });
    expect(parsePresenterMessage({ type: 'live-end' })).toEqual({ type: 'live-end' });
    expect(parsePresenterMessage({ type: 'page', page: 'p3' })).toEqual({ type: 'page', page: 'p3' });
    expect(parsePresenterMessage({ type: 'strokes', page: 'p1', strokes: [{ ...stroke, evil: '<script>' }] })).toEqual({
      type: 'strokes', page: 'p1', strokes: [{ id: 's1', tool: 'pen', color: '#000', size: 4, points: [[1, 2, 0.4], [3, 4, 0.5]] }],
    });
    expect(parsePresenterMessage({ type: 'delta', page: 'p1', order: ['a', 's1'], strokes: [stroke], x: 1 })).toEqual({
      type: 'delta', page: 'p1', order: ['a', 's1'], strokes: [{ ...stroke, points: [[1, 2, 0.4], [3, 4, 0.5]] }],
    });
    expect(parsePresenterMessage({ type: 'close', reason: 'too-large' })).toEqual({ type: 'close', reason: 'too-large' });
    expect(parsePresenterMessage({ type: 'blanks', blanks: [{ id: 'b-x-1', after: 2, paper: 'grid', z: 1 }] }))
      .toEqual({ type: 'blanks', blanks: [{ id: 'b-x-1', after: 2, paper: 'grid' }] });
    expect(parsePresenterMessage({ type: 'live', page: 'p1', tool: 'highlighter', color: '#ff0', size: 20, from: 3, points: [[5, 6, 1]] }))
      .toEqual({ type: 'live', page: 'p1', tool: 'highlighter', color: '#ff0', size: 20, from: 3, points: [[5, 6, 1]] });
    expect(parsePresenterMessage({ type: 'laser', page: 'p1', points: [[1, 2], [3, 4, 0.5]] }))
      .toEqual({ type: 'laser', page: 'p1', points: [[1, 2], [3, 4]] });
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      null, 'page', [], { type: 'eval' }, { type: 'open', pdf: [1, 2], title: '' }, { type: 'open', pdf: new Uint8Array(1) },
      { type: 'notes', notes: '' }, { type: 'notes', notes: 5 },
      { type: 'page', page: '' }, { type: 'page', page: 'p'.repeat(PRESENTER_LIMITS.id + 1) }, { type: 'page' },
      { type: 'strokes', page: 'p1', strokes: [{ ...stroke, tool: 'laser' }] },
      { type: 'strokes', page: 'p1', strokes: [{ ...stroke, size: -1 }] },
      { type: 'strokes', page: 'p1', strokes: [{ ...stroke, id: '' }] },
      { type: 'strokes', page: 'p1', strokes: [{ ...stroke, points: [[NaN, 0]] }] },
      { type: 'strokes', page: 'p1', strokes: [{ ...stroke, points: [[0, 0, 'x']] }] },
      { type: 'strokes', page: 'p1', strokes: [{ ...stroke, color: { toString: () => 'x' } }] },
      { type: 'strokes', page: 'p1', strokes: {} },
      { type: 'close', reason: 'other' },
      { type: 'delta', page: 'p1', order: ['a', 5], strokes: [] },
      { type: 'delta', page: 'p1', order: ['a', ''], strokes: [] },
      { type: 'delta', page: 'p1', order: 'a', strokes: [] },
      { type: 'delta', page: 'p1', order: [], strokes: [{ ...stroke, tool: 'laser' }] },
      { type: 'delta', page: 'p1', order: [] },
      { type: 'blanks', blanks: [{ id: 'b', after: 1.5, paper: 'plain' }] },
      { type: 'blanks', blanks: [{ id: 'b', after: 1, paper: 'dots' }] },
      { type: 'live', page: 'p1', tool: 'pen', color: '#000', size: 4, from: -1, points: [] },
      { type: 'live', page: 'p1', tool: 'pen', color: '#000', size: Infinity, from: 0, points: [] },
      { type: 'laser', page: 'p1', points: [[1]] },
      { type: 'laser', page: 'p1', points: Array.from({ length: PRESENTER_LIMITS.laserPoints + 1 }, () => [0, 0]) },
    ];
    for (const m of bad) expect(() => parsePresenterMessage(m), JSON.stringify(m)).toThrow(/invalid presenter message/);
    // A PDF too large to mirror (it would cross IPC twice).
    expect(() => parsePresenterMessage({ type: 'open', pdf: new Uint8Array(PRESENTER_LIMITS.pdfBytes + 1), title: '' })).toThrow(/pdf/);
  });

  it('counts the points of all strokes against one limit', () => {
    // Sparse arrays: only their length counts here (map skips the holes).
    const many = Array.from({ length: 6 }, (_, i) => ({ ...stroke, id: `s${i}`, points: new Array(2_000_000) }));
    expect(() => parsePresenterMessage({ type: 'strokes', page: 'p1', strokes: many })).toThrow(/points/);
  });
});

describe('commonPrefix', () => {
  it('counts the leading points two strokes share, by value', () => {
    const a: Point[] = [[0, 0, 0.5], [1, 1, 0.5], [2, 2, 0.5]];
    expect(commonPrefix(a, a)).toBe(3);
    expect(commonPrefix(a, [...a, [3, 3, 0.5]])).toBe(3);
    expect(commonPrefix(a, [[0, 0, 0.5], [1, 1, 0.5], [2, 2.5, 0.5]])).toBe(2);
    expect(commonPrefix(a, [[0, 0, 0.5], [2, 2, 0.5]])).toBe(1);
    expect(commonPrefix([], a)).toBe(0);
    expect(commonPrefix(a, [[0, 0, 0.6]])).toBe(0);
  });
});

describe('parsePresenterMessage: images', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAGUlEQVR4nGP8z8DAwMDAyPCfgYGBiQEJAAAqNwIDlBYW1QAAAABJRU5ErkJggg==';
  const msg = (images: unknown) => ({ type: 'images', page: 'p1', images, extra: 1 });

  it('keeps the known fields of each image; the data is optional', () => {
    expect(parsePresenterMessage(msg([{ id: 'a', x: 1, y: 2, w: 3, h: 4, src: PNG, z: 9 }, { id: 'b', x: 0, y: 0, w: 1, h: 1 }])))
      .toEqual({ type: 'images', page: 'p1', images: [{ id: 'a', x: 1, y: 2, w: 3, h: 4, src: PNG }, { id: 'b', x: 0, y: 0, w: 1, h: 1 }] });
  });

  it('refuses bad images, other data and too many', () => {
    const ok = { id: 'a', x: 1, y: 2, w: 3, h: 4 };
    expect(() => parsePresenterMessage(msg([{ ...ok, w: 0 }]))).toThrow(/image geometry/);
    expect(() => parsePresenterMessage(msg([{ ...ok, x: NaN }]))).toThrow(/image geometry/);
    expect(() => parsePresenterMessage(msg([{ ...ok, src: 'data:image/svg+xml;base64,PHN2Zz4=' }]))).toThrow(/image data/);
    expect(() => parsePresenterMessage(msg([{ ...ok, id: 5 }]))).toThrow(/image id/);
    expect(() => parsePresenterMessage(msg('x'))).toThrow(/images/);
    expect(() => parsePresenterMessage(msg(Array.from({ length: PRESENTER_LIMITS.images + 1 }, () => ok)))).toThrow(/images/);
  });
});

describe('NotesDoc.applyRemoteImages', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAGUlEQVR4nGP8z8DAwMDAyPCfgYGBiQEJAAAqNwIDlBYW1QAAAABJRU5ErkJggg==';

  it('sets a page\'s images, keeps unchanged ones as they are and skips bad ones', () => {
    const doc = new NotesDoc(deckFromPdf({ title: 't', pageSizes: [[960, 540]] }));
    expect(doc.applyRemoteImages('p1', [{ id: 'a', x: 1, y: 2, w: 3, h: 4, src: PNG }, { id: 'bad', x: 0, y: 0, w: -1, h: 1, src: PNG }])).toBe(true);
    const [a] = doc.images('p1');
    expect(doc.images('p1').map(i => i.id)).toEqual(['a']);
    doc.applyRemoteImages('p1', [{ id: 'a', x: 1, y: 2, w: 3, h: 4, src: PNG }, { id: 'b', x: 5, y: 5, w: 5, h: 5, src: PNG }]);
    expect(doc.images('p1')[0]).toBe(a);
    expect(doc.history.canUndo()).toBe(false);
    expect(doc.applyRemoteImages('b-unknown', [])).toBe(false);
  });
});
