/* The port must behave like the original Marp Notes modules: run the same
 * inputs through legacy/*.js and the TypeScript port. The legacy modules are
 * scripts that register themselves on globalThis.MarpNotes. */
import { describe, expect, it } from 'vitest';
import * as g from '../src/geometry';
import { NotesDoc, createStroke } from '../src/model';
import type { Point } from '../src/geometry';

// @ts-expect-error untyped legacy script
await import('../legacy/geometry.js');
// @ts-expect-error untyped legacy script
await import('../legacy/model.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { geometry: legacyGeometry, model: legacyModel } = (globalThis as any).MarpNotes;

// Small deterministic PRNG, so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomPoints(rand: () => number, n: number): Point[] {
  const out: Point[] = [];
  let x = rand() * 500, y = rand() * 300;
  for (let i = 0; i < n; i++) {
    x += (rand() - 0.5) * 40;
    y += (rand() - 0.5) * 40;
    out.push([x, y, rand()]);
  }
  return out;
}

// The port also keeps one-point fragments, which legacy dropped.
const multiPoint = (pieces: Point[][] | null) => pieces && pieces.filter(p => p.length > 1);

describe('geometry matches legacy geometry.js', () => {
  const rand = rng(42);
  const cases = Array.from({ length: 40 }, (_, i) => randomPoints(rand, 1 + (i % 15)));

  it('smoothing, outline and paths', () => {
    for (const pts of cases) {
      expect(g.smoothPoints(pts)).toEqual(legacyGeometry.smoothPoints(pts));
      for (const size of [2, 7, 12]) {
        const poly = g.strokeOutline(pts, size);
        expect(poly).toEqual(legacyGeometry.strokeOutline(pts, size));
        expect(g.outlinePath(poly)).toBe(legacyGeometry.outlinePath(poly));
      }
      expect(g.centerlinePath(pts)).toBe(legacyGeometry.centerlinePath(pts));
    }
  });

  it('hit tests, partial erase and selection', () => {
    for (const [i, pts] of cases.entries()) {
      const stroke = { id: `s${i}`, tool: i % 3 ? 'pen' : 'highlighter', color: '#000', size: 4 + (i % 4) * 3, points: pts } as const;
      const legacyStroke = { ...stroke, points: pts.map(p => p.slice()) };
      const a: Point = [pts[0][0] + 5, pts[0][1] - 3, 0.5];
      const b: Point = [a[0] + 30, a[1] + 20, 0.5];
      for (const r of [4, 16, 64]) {
        expect(g.strokeHitsSegment(stroke, a, b, r)).toBe(legacyGeometry.strokeHitsSegment(legacyStroke, a, b, r));
        expect(multiPoint(g.splitByEraser(stroke, a, b, r))).toEqual(legacyGeometry.splitByEraser(legacyStroke, a, b, r));
      }
      expect(g.strokeBBox(stroke)).toEqual(legacyGeometry.strokeBBox(legacyStroke));
      const poly = g.rectPolygon([0, 0], [300, 200]);
      expect(g.strokesInPolygon([stroke], poly)).toEqual(legacyGeometry.strokesInPolygon([legacyStroke], poly));
      expect(g.isLasso(pts)).toBe(legacyGeometry.isLasso(pts));
      expect(g.laserTrail(pts, 140)).toEqual(legacyGeometry.laserTrail(pts, 140));
      expect(g.resample(pts, 5)).toEqual(legacyGeometry.resample(pts, 5));
    }
  });

  it('partial erase of long strokes that cross the eraser several times', () => {
    const rand = rng(9);
    for (let i = 0; i < 30; i++) {
      // long segments zigzagging across the eraser
      const pts: Point[] = Array.from({ length: 2 + (i % 8) }, (_, k) =>
        [rand() * 400, (k % 2) * 300 + (rand() - 0.5) * 50, rand()]);
      const stroke = { id: `z${i}`, tool: i % 3 ? 'pen' : 'highlighter', color: '#000', size: 2 + (i % 5) * 4, points: pts } as const;
      const legacyStroke = { ...stroke, points: pts.map(p => p.slice()) };
      const a: Point = [rand() * 400, 100 + rand() * 100, 0.5];
      const b: Point = [a[0] + (rand() - 0.5) * 80, a[1] + (rand() - 0.5) * 80, 0.5];
      for (const r of [2, 16, 64]) {
        expect(multiPoint(g.splitByEraser(stroke, a, b, r))).toEqual(legacyGeometry.splitByEraser(legacyStroke, a, b, r));
      }
    }
  });
});

describe('model matches legacy model.js', () => {
  it('produces the same v1 file for the same edits', () => {
    const rand = rng(7);
    const deck = { title: 'Deck', slides: 4, size: [1280, 720] as [number, number] };
    const port = new NotesDoc(deck);
    const legacy = new legacyModel.NotesDoc(deck);
    for (const doc of [port, legacy]) { doc.blankPrefix = 'x'; }
    const make = (id: string) => ({ id, tool: 'pen', color: '#000', size: 4, points: randomPoints(rand, 5) });

    const blanks: string[] = [];
    for (let step = 0; step < 60; step++) {
      const page = `s${1 + Math.floor(rand() * 4)}`;
      const op = Math.floor(rand() * 6);
      const live = blanks.filter(id => port.getPage(id)); // undo may have removed some
      const target = live.length && rand() < 0.3 ? live[Math.floor(rand() * live.length)] : page;
      const run = (doc: NotesDoc, create: (s: ReturnType<typeof make>) => unknown) => {
        switch (op) {
          case 0: case 1: return doc.addStroke(target, create(stroke) as never);
          case 2: return doc.removeStrokes(target, doc.strokes(target).slice(0, 1).map(s => s.id));
          case 3: return doc.moveStrokes(target, doc.strokes(target).map(s => s.id), 3, -2);
          case 4: return doc.undo();
          default: return doc.insertBlankPage(target, 'grid');
        }
      };
      const stroke = make(`k${step}`);
      const r1 = run(port, s => createStroke(s));
      run(legacy as NotesDoc, s => legacyModel.createStroke(s));
      if (op === 5 && r1) blanks.push((r1 as { pageId: string }).pageId);
    }
    expect(port.toJSON()).toEqual(legacy.toJSON());
    expect(port.sequence()).toEqual(legacy.sequence());
    expect(port.toJSON().pages.length).toBeGreaterThan(2); // the run did real work
  });
});
