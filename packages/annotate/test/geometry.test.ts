import { describe, expect, it, afterEach } from 'vitest';
import * as g from '../src/geometry';
import type { Point, Stroke } from '../src/geometry';

const pen = (points: Point[], size = 4, id = 'a'): Stroke => ({ id, tool: 'pen', color: '#000', size, points });
const hl = (points: Point[], size = 20, id = 'h'): Stroke => ({ id, tool: 'highlighter', color: '#ff0', size, points });
const line = (x0: number, x1: number, y = 0, step = 10): Point[] => {
  const out: Point[] = [];
  for (let x = x0; x <= x1; x += step) out.push([x, y, 0.5]);
  return out;
};

describe('smoothPoints', () => {
  it('keeps the first and last raw point', () => {
    const raw: Point[] = [[0, 0, 0.2], [10, 0, 0.5], [20, 10, 0.7], [30, 10, 0.9]];
    const out = g.smoothPoints(raw);
    expect(out[0]).toEqual([0, 0, 0.2]);
    expect(out[out.length - 1]).toEqual([30, 10, 0.9]);
  });

  it('moves halfway towards each new point with streamline 0.5', () => {
    const out = g.smoothPoints([[0, 0, 0.5], [10, 0, 0.5], [20, 0, 0.5]]);
    expect(out[1]).toEqual([5, 0, 0.5]);
  });

  it('drops points closer than the minimum gap', () => {
    const out = g.smoothPoints([[0, 0, 0.5], [0.1, 0, 0.5], [0.2, 0, 0.5]]);
    expect(out).toEqual([[0, 0, 0.5], [0.2, 0, 0.5]]);
  });

  it('handles empty and single-point input', () => {
    expect(g.smoothPoints([])).toEqual([]);
    expect(g.smoothPoints([[1, 2, 0.5]])).toEqual([[1, 2, 0.5]]);
  });
});

describe('stroke width', () => {
  it('pen radius follows pressure, highlighter is constant', () => {
    const s = pen([[0, 0, 0.5]], 4);
    expect(g.strokeRadius(s, 0.5)).toBeCloseTo(2);
    expect(g.strokeRadius(s, 1)).toBeCloseTo(4 * (0.5 + 0.6 * 0.5));
    expect(g.strokeRadius(s, 0)).toBeCloseTo(4 * (0.5 - 0.3));
    expect(g.strokeRadius(hl([[0, 0, 0.1]], 20), 0.1)).toBe(10);
  });

  it('has a minimum pen radius', () => {
    expect(g.strokeRadius(pen([], 0.1), 0)).toBe(0.25);
  });

  it('max radius uses the highest pressure and is cached per stroke', () => {
    const s = pen([[0, 0, 0.2], [1, 0, 0.9]], 10);
    expect(g.maxStrokeRadius(s)).toBeCloseTo(10 * (0.5 - 0.6 * (0.5 - 0.9)));
    expect(g.maxStrokeRadius(s)).toBe(g.maxStrokeRadius(s));
  });
});

describe('classic outline', () => {
  it('draws a dot as a circle', () => {
    const out = g.classicOutline([[10, 10, 0.5]], 4);
    expect(out.length).toBe(16);
    for (const p of out) expect(Math.hypot(p[0] - 10, p[1] - 10)).toBeCloseTo(2);
  });

  it('surrounds a straight line at the pen radius', () => {
    const out = g.classicOutline([[0, 0, 0.5], [50, 0, 0.5], [100, 0, 0.5]], 4);
    const ys = out.map(p => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(2);
    expect(Math.min(...ys)).toBeCloseTo(-2);
    const xs = out.map(p => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(-2); // round start cap
    expect(Math.max(...xs)).toBeCloseTo(102); // round end cap
  });

  it('defaults missing pressure to 0.5 and ignores duplicate points', () => {
    const a = g.classicOutline([[0, 0], [10, 0], [10, 0]], 4);
    const b = g.classicOutline([[0, 0, 0.5], [10, 0, 0.5]], 4);
    expect(a).toEqual(b);
  });

  it('adds round joins on sharp turns', () => {
    const sharp = g.classicOutline([[0, 0, 0.5], [50, 0, 0.5], [0, 1, 0.5]], 4);
    const straight = g.classicOutline([[0, 0, 0.5], [50, 0, 0.5], [100, 0, 0.5]], 4);
    expect(sharp.length).toBeGreaterThan(straight.length);
  });

  it('returns nothing for no points', () => {
    expect(g.classicOutline([], 4)).toEqual([]);
  });
});

describe('strokeOutline engines', () => {
  afterEach(() => g.setOutlineEngine('classic'));
  const pts: Point[] = [[0, 0, 0.5], [20, 5, 0.6], [40, 0, 0.7], [60, 10, 0.5]];

  it('uses the classic outline by default', () => {
    expect(g.getOutlineEngine()).toBe('classic');
    expect(g.strokeOutline(pts, 4)).toEqual(g.classicOutline(pts, 4));
  });

  it('uses perfect-freehand when asked', () => {
    const fh = g.strokeOutline(pts, 4, { engine: 'freehand' });
    expect(fh).toEqual(g.freehandOutline(pts, 4));
    expect(fh.length).toBeGreaterThan(4);
    const box = g.pointsBBox(fh);
    expect(box.minX).toBeLessThan(0);
    expect(box.maxX).toBeGreaterThan(60);
    expect(box.maxY - box.minY).toBeLessThan(10 + 2 * 4);
  });

  it('switches the default engine globally', () => {
    g.setOutlineEngine('freehand');
    expect(g.strokeOutline(pts, 4)).toEqual(g.freehandOutline(pts, 4));
  });

  it('freehand width follows pressure with thinning 0.6', () => {
    const thin = g.freehandOutline(line(0, 100).map(p => [p[0], p[1], 0.1] as Point), 10, { streamline: 0, smoothing: 0 });
    const thick = g.freehandOutline(line(0, 100).map(p => [p[0], p[1], 1] as Point), 10, { streamline: 0, smoothing: 0 });
    const h = (poly: g.Vec2[]) => { const b = g.pointsBBox(poly); return b.maxY - b.minY; };
    expect(h(thick)).toBeGreaterThan(h(thin) * 2);
    expect(g.FREEHAND_OPTIONS.thinning).toBe(0.6);
    expect(g.FREEHAND_OPTIONS.streamline).toBe(0.5);
  });

  it('freehand returns nothing for no points', () => {
    expect(g.freehandOutline([], 4)).toEqual([]);
  });
});

describe('SVG paths', () => {
  it('outlinePath is a closed quadratic path', () => {
    const d = g.outlinePath([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(d.startsWith('M5 0')).toBe(true);
    expect(d.endsWith(' Z')).toBe(true);
    expect(d.match(/Q/g)!.length).toBe(4);
    expect(g.outlinePath([[0, 0], [1, 1]])).toBe('');
  });

  it('centerlinePath rounds to two decimals', () => {
    expect(g.centerlinePath([[0.123, 1.456, 0.5]])).toBe('M0.12 1.46 l0.01 0');
    expect(g.centerlinePath([[0, 0], [10, 0], [20, 10]])).toBe('M0 0 Q10 0 15 5 L20 10');
    expect(g.centerlinePath([])).toBe('');
  });
});

describe('bounding boxes', () => {
  it('pads by the stroke radius', () => {
    expect(g.strokeBBox(pen([[0, 0, 0.5], [10, 20, 0.5]], 4))).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 22 });
    expect(g.strokeBBox(hl([[0, 0, 0.5]], 20))).toEqual({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
  });

  it('unions and overlaps', () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const b = { minX: 5, minY: -5, maxX: 20, maxY: 5 };
    expect(g.unionBBox([a, b])).toEqual({ minX: 0, minY: -5, maxX: 20, maxY: 10 });
    expect(g.unionBBox([])).toBeNull();
    expect(g.boxesOverlap(a, b)).toBe(true);
    expect(g.boxesOverlap(a, { minX: 11, minY: 0, maxX: 12, maxY: 1 })).toBe(false);
  });
});

describe('distances and hit tests', () => {
  it('distPointSegment clamps to the ends', () => {
    expect(g.distPointSegment([5, 3], [0, 0], [10, 0])).toBe(3);
    expect(g.distPointSegment([-3, 4], [0, 0], [10, 0])).toBe(5);
    expect(g.distPointSegment([3, 4], [0, 0], [0, 0])).toBe(5);
  });

  it('distSegments is 0 for crossing segments', () => {
    expect(g.distSegments([0, -1], [0, 1], [-1, 0], [1, 0])).toBe(0);
    expect(g.distSegments([0, 0], [10, 0], [0, 5], [10, 5])).toBe(5);
  });

  it('strokeHitsSegment includes eraser and ink radius', () => {
    const s = pen(line(0, 100), 4); // radius 2
    expect(g.strokeHitsSegment(s, [50, 10], [50, 10], 8)).toBe(true);   // 10 <= 8 + 2
    expect(g.strokeHitsSegment(s, [50, 11], [50, 11], 8)).toBe(false);
    expect(g.strokeHitsSegment(s, [50, -30], [50, 30], 1)).toBe(true);  // crossing move
    expect(g.strokeHitsSegment(pen([]), [0, 0], [0, 0], 10)).toBe(false);
    expect(g.strokeHitsSegment(pen([[0, 0, 0.5]], 4), [5, 0], [5, 0], 3)).toBe(true);
  });
});

describe('resample', () => {
  it('inserts points so gaps are at most step', () => {
    const out = g.resample([[0, 0, 0], [10, 0, 1]], 2.5);
    expect(out.length).toBe(5);
    expect(out[2]).toEqual([5, 0, 0.5]);
    expect(g.resample([[1, 1, 1]], 1)).toEqual([[1, 1, 1]]);
  });
});

describe('splitByEraser', () => {
  it('returns null when nothing is erased', () => {
    expect(g.splitByEraser(pen(line(0, 100)), [50, 50], [50, 50], 5)).toBeNull();
  });

  it('cuts a line in two pieces with cut ends', () => {
    const pieces = g.splitByEraser(pen(line(0, 100), 2), [50, 0], [50, 0], 5)!;
    expect(pieces.length).toBe(2);
    const [left, right] = pieces;
    expect(left[0]).toEqual([0, 0, 0.5]);
    expect(right[right.length - 1]).toEqual([100, 0, 0.5]);
    // the cut ends sit just outside eraser radius + ink radius
    const endL = left[left.length - 1][0], startR = right[0][0];
    expect(endL).toBeLessThan(50 - 5);
    expect(endL).toBeGreaterThan(40);
    expect(startR).toBeGreaterThan(50 + 5);
    expect(startR).toBeLessThan(60);
  });

  it('keeps only original points plus the cut ends', () => {
    const pieces = g.splitByEraser(pen(line(0, 100), 2), [50, 0], [50, 0], 5)!;
    const isOrig = (p: Point) => p[0] % 10 === 0;
    for (const piece of pieces) {
      expect(piece.slice(1, -1).every(isOrig)).toBe(true);
    }
  });

  it('keeps a surviving one-point fragment as a dot', () => {
    // Short enough that no samples fall between the two points: the eraser
    // takes the first, the second is a run of one.
    const hl: Stroke = { id: 'h', tool: 'highlighter', color: '#000', size: 40, points: [[0, 0, 0.5], [10, 0, 0.5]] };
    expect(g.splitByEraser(hl, [-31, 0], [-31, 0], 20)).toEqual([[[10, 0, 0.5]]]);
  });

  it('returns [] when the whole stroke is erased', () => {
    expect(g.splitByEraser(pen(line(0, 10), 2), [5, 0], [5, 0], 50)).toEqual([]);
  });

  it('samples only near the eraser: a huge segment is cut fast and precisely', () => {
    const huge = pen([[-1e6, 0, 0.5], [1e6, 0, 0.5]], 2);
    const t = performance.now();
    let pieces: Point[][] | null = null;
    for (let i = 0; i < 20; i++) pieces = g.splitByEraser(huge, [i, -1], [i + 1, 1], 5);
    expect(performance.now() - t).toBeLessThan(200);
    expect(pieces).toHaveLength(2);
    const [left, right] = pieces!;
    expect(left[0]).toEqual([-1e6, 0, 0.5]);
    expect(right[right.length - 1]).toEqual([1e6, 0, 0.5]);
    expect(left[left.length - 1][0]).toBeGreaterThan(19 - 5 - 1 - 2);
    expect(right[0][0]).toBeLessThan(20 + 5 + 1 + 2);
  });

  it('a long eraser move along a huge segment stays bounded', () => {
    const huge = pen([[-1e6, 0, 0.5], [1e6, 0, 0.5]], 2);
    const t = performance.now();
    const pieces = g.splitByEraser(huge, [-5e5, 0], [5e5, 0], 5)!;
    expect(performance.now() - t).toBeLessThan(200);
    expect(pieces).toHaveLength(2);
    expect(pieces[0][pieces[0].length - 1][0]).toBeLessThan(-5e5);
    expect(pieces[1][0][0]).toBeGreaterThan(5e5);
  });
});

describe('selection', () => {
  const square: g.Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('pointInPolygon', () => {
    expect(g.pointInPolygon([5, 5], square)).toBe(true);
    expect(g.pointInPolygon([15, 5], square)).toBe(false);
  });

  it('rectPolygon normalises corners', () => {
    expect(g.rectPolygon([10, 10], [0, 0])).toEqual(square);
  });

  it('strokesInPolygon uses the 75% threshold', () => {
    const inside = pen([[1, 1, 0.5], [2, 2, 0.5], [3, 3, 0.5], [4, 4, 0.5]], 2, 'in');
    const half = pen([[1, 1, 0.5], [2, 2, 0.5], [20, 2, 0.5], [30, 3, 0.5]], 2, 'half');
    const out = pen([[50, 50, 0.5]], 2, 'out');
    expect(g.strokesInPolygon([inside, half, out], square)).toEqual(['in']);
    expect(g.strokesInPolygon([inside, half], square, 0.5)).toEqual(['in', 'half']);
    expect(g.strokesInPolygon([inside], [[0, 0], [1, 1]])).toEqual([]);
  });

  it('isLasso tells a circle from a drag', () => {
    expect(g.isLasso([[0, 0], [100, 0]])).toBe(false);
    expect(g.isLasso([[0, 0], [50, 10], [100, 20]])).toBe(false);
    const circle: g.Vec2[] = [];
    for (let a = 0; a <= 2 * Math.PI * 0.95; a += 0.2) circle.push([50 * Math.cos(a), 50 * Math.sin(a)]);
    expect(g.isLasso(circle)).toBe(true);
  });

  it('pathLength and translatePoints', () => {
    expect(g.pathLength([[0, 0], [3, 4], [3, 10]])).toBe(11);
    expect(g.translatePoints([[1, 2, 0.3]], 10, 20)).toEqual([[11, 22, 0.3]]);
  });
});

describe('laserTrail', () => {
  it('cuts the trail at maxLen and tapers from tail to head', () => {
    const pts: g.Vec2[] = [[0, 0], [100, 0], [200, 0]];
    const out = g.laserTrail(pts, 140);
    expect(out[0][0]).toBeCloseTo(60);
    expect(out[out.length - 1]).toEqual([200, 0, 1]);
    expect(out[0][2]).toBe(0);
    for (let i = 1; i < out.length; i++) expect(out[i][2]).toBeGreaterThanOrEqual(out[i - 1][2]);
  });

  it('gives a single point full pressure', () => {
    expect(g.laserTrail([[5, 5]], 140)).toEqual([[5, 5, 1]]);
  });
});
