import { describe, expect, it } from 'vitest';
import {
  CLIP_FORMAT, getClip, makeClip, parseClip, placeClip, serializeClip, setClip, type Clip,
} from '../src/clipboard';
import { NotesDoc, createStroke } from '../src/model';
import { strokeBBox, unionBBox, type Point, type Stroke } from '../src/geometry';
import { deckFromPdf } from '../src/io';

const line = (id: string, x0: number, y0: number, x1: number, y1: number, size = 4): Stroke =>
  createStroke({ id, tool: 'pen', color: '#000', size, points: [[x0, y0, 0.5], [x1, y1, 0.7]] });
const xy = (s: Stroke): number[][] => s.points.map(p => [p[0], p[1]]);
const box = (strokes: readonly Stroke[]) => unionBBox(strokes.map(strokeBBox))!;

describe('placeClip', () => {
  const a = line('a', 100, 100, 200, 150);
  const b = line('b', 120, 300, 180, 320);
  const clip = makeClip([a, b], [960, 540])!;

  it('gives new ids and keeps the place on an empty page of the same size', () => {
    const out = placeClip(clip, { size: [960, 540], strokes: [], step: 12 });
    expect(out.map(s => s.id)).not.toContain('a');
    expect(new Set(out.map(s => s.id)).size).toBe(2);
    expect(out.map(xy)).toEqual([xy(a), xy(b)]);
    expect(out.map(s => [s.size, s.color, s.tool])).toEqual([[4, '#000', 'pen'], [4, '#000', 'pen']]);
    expect(out[0].points.map(p => p[2])).toEqual([0.5, 0.7]); // pressure kept
  });

  it('offsets on a page that has the originals, and again for every repeated paste', () => {
    const page: Stroke[] = [a, b];
    const first = placeClip(clip, { size: [960, 540], strokes: page, step: 12 });
    expect(first[0].points[0].slice(0, 2)).toEqual([112, 112]);
    page.push(...first);
    const second = placeClip(clip, { size: [960, 540], strokes: page, step: 12 });
    expect(second[0].points[0].slice(0, 2)).toEqual([124, 124]);
    expect(new Set([...first, ...second].map(s => s.id)).size).toBe(4);
  });

  it('does not offset when the originals moved away or another color sits there', () => {
    const recolored = { ...a, color: '#f00' };
    const out = placeClip(clip, { size: [960, 540], strokes: [recolored], step: 12 });
    expect(xy(out[0])).toEqual(xy(a));
  });

  it('finds the originals after the rounding of a saved file', () => {
    const saved = { ...a, points: a.points.map((p): Point => [p[0] + 0.004, p[1] - 0.004, p[2]]) };
    const out = placeClip(clip, { size: [960, 540], strokes: [saved], step: 12 });
    expect(out[0].points[0][0]).toBe(112);
  });

  it('scales to a page of another size, keeping the relative place', () => {
    // 960×540 → 1920×1080: twice as large everywhere.
    const big = placeClip(clip, { size: [1920, 1080], strokes: [], step: 12 });
    expect(xy(big[0])).toEqual([[200, 200], [400, 300]]);
    expect(big[0].size).toBe(8);
    // 960×540 → A4 portrait (595×842): scaled by 595/960, centre at the same relative place.
    const a4 = placeClip(clip, { size: [595, 842], strokes: [], step: 12 });
    const s = 595 / 960;
    expect(a4[0].size).toBeCloseTo(4 * s);
    const w = (st: Stroke) => st.points[1][0] - st.points[0][0];
    expect(w(a4[0])).toBeCloseTo(100 * s);
    const c = box(a4), c0 = box([a, b]);
    const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
    const cx0 = (c0.minX + c0.maxX) / 2, cy0 = (c0.minY + c0.maxY) / 2;
    expect(cx / 595).toBeCloseTo(cx0 / 960, 2);
    expect(cy / 842).toBeCloseTo(cy0 / 540, 2);
  });

  it('clamps to the page', () => {
    const edge = makeClip([line('e', 900, 500, 1000, 600)], [1280, 720])!;
    const out = placeClip(edge, { size: [1280, 720], strokes: [], step: 12 });
    expect(out[0].points[0].slice(0, 2)).toEqual([900, 500]); // fits: unchanged
    const small = placeClip(edge, { size: [640, 360], strokes: [], step: 12 })[0];
    const b2 = strokeBBox(small);
    expect(b2.maxX).toBeLessThanOrEqual(640 + 1e-9);
    expect(b2.maxY).toBeLessThanOrEqual(360 + 1e-9);
    const off = makeClip([line('o', -50, -20, 30, 40)], [1280, 720])!;
    const b3 = strokeBBox(placeClip(off, { size: [1280, 720], strokes: [], step: 12 })[0]);
    expect(b3.minX).toBeCloseTo(0);
    expect(b3.minY).toBeCloseTo(0);
  });

  it('stops offsetting in a corner of the page', () => {
    const corner = line('c', 1270, 710, 1275, 715);
    const out = placeClip(makeClip([corner], [1280, 720])!, { size: [1280, 720], strokes: [corner], step: 12 });
    expect(strokeBBox(out[0]).maxX).toBeLessThanOrEqual(1280 + 1e-9);
  });

  it('puts a clip larger than the page at its top-left corner', () => {
    const wide = makeClip([line('w', 100, 100, 2000, 200)], [1280, 720])!;
    const b4 = strokeBBox(placeClip(wide, { size: [1280, 720], strokes: [], step: 12 })[0]);
    expect(b4.minX).toBeCloseTo(0);
  });
});

describe('clip text', () => {
  it('round-trips through the system clipboard text', () => {
    const clip = makeClip([line('a', 1, 2, 3, 4)], [960, 540])!;
    const text = serializeClip(clip);
    expect(JSON.parse(text).format).toBe(CLIP_FORMAT);
    const back = parseClip(text)!;
    expect(back.size).toEqual([960, 540]);
    expect(xy(back.strokes[0])).toEqual([[1, 2], [3, 4]]);
  });

  it('is null for other text, newer versions and clips without valid strokes', () => {
    expect(parseClip('hello')).toBeNull();
    expect(parseClip(null)).toBeNull();
    expect(parseClip(`{"format":"${CLIP_FORMAT}"`)).toBeNull();
    expect(parseClip(JSON.stringify({ format: CLIP_FORMAT, version: 99, size: [1, 1], strokes: [] }))).toBeNull();
    expect(parseClip(JSON.stringify({ format: CLIP_FORMAT, version: 1, size: [0, 1], strokes: [] }))).toBeNull();
    const bad = { id: 'x', tool: 'brush', color: '#000', size: 1, points: [[0, 0]] };
    expect(parseClip(JSON.stringify({ format: CLIP_FORMAT, version: 1, size: [10, 10], strokes: [bad] }))).toBeNull();
    const good = { id: 'y', tool: 'pen', color: '#000', size: 1, points: [[0, 0]] };
    const mixed = parseClip(JSON.stringify({ format: CLIP_FORMAT, version: 1, size: [10, 10], strokes: [bad, good] }))!;
    expect(mixed.strokes.length).toBe(1);
  });

  it('keeps one clip per window', () => {
    const clip: Clip = makeClip([line('a', 1, 2, 3, 4)], [10, 10])!;
    setClip(clip);
    expect(getClip()).toBe(clip);
    setClip(null);
    expect(getClip()).toBeNull();
    expect(makeClip([], [10, 10])).toBeNull();
  });
});

describe('pasting into a NotesDoc', () => {
  it('is one undo step that removes exactly the pasted strokes', () => {
    const doc = new NotesDoc(deckFromPdf({ title: 'a.pdf', pageSizes: [[960, 540], [595, 842]] }));
    doc.addStroke('p1', line('a', 10, 10, 50, 50));
    const clip = makeClip(doc.strokes('p1'), doc.pageSize('p1'))!;
    const pasted = placeClip(clip, { size: doc.pageSize('p2'), strokes: doc.strokes('p2'), step: 12 });
    const pasted2 = placeClip(clip, { size: doc.pageSize('p2'), strokes: [], step: 12 }).concat(line('z', 1, 1, 2, 2));
    expect(doc.addStrokes('p2', pasted)!.label).toBe('paste');
    doc.addStrokes('p2', pasted2);
    expect(doc.strokes('p2').length).toBe(3);
    doc.undo();
    expect(doc.strokes('p2').map(s => s.id)).toEqual(pasted.map(s => s.id));
    doc.undo();
    expect(doc.strokes('p2')).toEqual([]);
    expect(doc.strokes('p1').map(s => s.id)).toEqual(['a']);
    doc.redo();
    expect(doc.strokes('p2').map(s => s.id)).toEqual(pasted.map(s => s.id));
  });
});
