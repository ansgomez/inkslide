/* The exported PDF in other PDF readers (acceptance check for the export: it
 * looks the same in Evince / Okular / Acrobat and its text stays selectable).
 *
 * Checks the export with the command line tools of two independent engines
 * when they are installed: Poppler (pdfinfo, pdftotext, pdftoppm; the engine
 * of Evince and Okular) and MuPDF (mutool), plus qpdf --check. Each missing
 * tool skips its checks. Acrobat (PDFium / Adobe's engine) is not covered here;
 * Chromium's PDF viewer (PDFium) is exercised by the desktop print smoke test.
 *
 * The fixture has a plain, a rotated (/Rotate 90) and a cropped page, each
 * with pen and highlighter strokes, and blank pages with plain, lined and
 * grid paper. Pages render at 72 dpi, so a pixel is a point of the shown page
 * (the crop box, as viewers show it; pdftoppm needs -cropbox for that).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StrokeJSON } from '@inkslide/annotate/model';
import { exportAnnotatedPdfWithReport } from '../src/export';
import { SIZE, fixturePdf, hl, notesFile, pen } from './helpers';

const has = (tool: string, arg = '-v'): boolean => !spawnSync(tool, [arg]).error;
const tools = {
  poppler: has('pdftoppm') && has('pdftotext') && has('pdfinfo'),
  mutool: has('mutool', '-v'),
  qpdf: has('qpdf', '--version'),
};

function run(cmd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(cmd, args, { encoding: 'latin1' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** A binary PPM (P6) image. */
interface Image { width: number; height: number; px(x: number, y: number): [number, number, number] }

function readPpm(file: string): Image {
  const buf = readFileSync(file);
  // Header: P6 <ws> width <ws> height <ws> maxval <one ws> data; comments start with #.
  const fields: string[] = [];
  let i = 0;
  while (fields.length < 4) {
    while (/\s/.test(String.fromCharCode(buf[i]))) i++;
    if (buf[i] === 0x23) { while (buf[i] !== 0x0a) i++; continue; }
    let f = '';
    while (!/\s/.test(String.fromCharCode(buf[i]))) f += String.fromCharCode(buf[i++]);
    fields.push(f);
  }
  i++;
  const [magic, w, h] = [fields[0], Number(fields[1]), Number(fields[2])];
  if (magic !== 'P6') throw new Error(`not a P6 PPM: ${magic}`);
  return {
    width: w, height: h,
    px(x, y) {
      const o = i + 3 * (Math.round(y) * w + Math.round(x));
      return [buf[o], buf[o + 1], buf[o + 2]];
    },
  };
}

type Rgb = [number, number, number];
const near = (a: Rgb, b: Rgb, tol: number): boolean => a.every((v, k) => Math.abs(v - b[k]) <= tol);
/** Some pixel within `r` of (x, y) has about this color. */
const colorAround = (img: Image, x: number, y: number, rgb: Rgb, tol = 60, r = 2): boolean => {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (near(img.px(x + dx, y + dy), rgb, tol)) return true;
  return false;
};
/** Pixels in a row that are not (nearly) white. */
const inkedInRow = (img: Image, y: number): number => {
  let n = 0;
  for (let x = 0; x < img.width; x++) if (img.px(x, y).some(v => v < 235)) n++;
  return n;
};

const RED: Rgb = [0xbe, 0x1e, 0x3c];
const BLUE: Rgb = [0x15, 0x65, 0xc0];
const WHITE: Rgb = [255, 255, 255];
const HIGHLIGHT: Rgb = [255, 240, 166];

/** Ink on every page at the same shown positions (points of the 600×400 page). */
const ink = (tag: string): StrokeJSON[] => [
  hl(`${tag}-h`, [[320, 300], [560, 300]]),                      // yellow band at y = 300, x 320..560
  pen(`${tag}-r`, [[300, 60], [560, 60]], '#be1e3c', 6),         // red line at y = 60
  pen(`${tag}-b`, [[450, 120], [450, 250]], '#1565c0', 6),       // blue line at x = 450
];

const notes = notesFile([
  { id: 'p1', kind: 'slide', slide: 1, strokes: ink('p1') },
  { id: 'b-t-1', kind: 'blank', after: 1, paper: 'plain', strokes: ink('b1') },
  { id: 'b-t-2', kind: 'blank', after: 1, paper: 'lined', strokes: ink('b2') },
  { id: 'p2', kind: 'slide', slide: 2, strokes: ink('p2') },
  { id: 'p3', kind: 'slide', slide: 3, strokes: ink('p3') },
  { id: 'b-t-3', kind: 'blank', after: 3, paper: 'grid', strokes: ink('b3') },
]);
/** Exported page order and what each page is. */
const PAGES = ['p1', 'plain', 'lined', 'p2 (rotated)', 'p3 (cropped)', 'grid'];
const TEXT: Record<number, string> = { 0: 'Hello page one', 3: 'Rotated page two', 4: 'Cropped page three' };

let dir = '';
let file = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'inkslide-readers-'));
  file = join(dir, 'annotated.pdf');
  const { bytes, warnings } = await exportAnnotatedPdfWithReport(await fixturePdf(), notes);
  expect(warnings).toEqual([]);
  writeFileSync(file, bytes);
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!tools.qpdf)('qpdf', () => {
  it('--check finds no problems', () => {
    const r = run('qpdf', ['--check', file]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/No syntax or stream encoding errors/);
  });
});

describe.skipIf(!tools.poppler)('Poppler (Evince, Okular)', () => {
  it('reads the file without errors, all pages at the shown size', () => {
    const r = run('pdfinfo', ['-f', '1', '-l', '99', file]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/Pages:\s+6/);
    // Rotation as in the original: page 4 is the 400×600 page turned by 90°.
    const sizes = [...r.stdout.matchAll(/Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/g)].map(m => `${m[1]}x${m[2]}`);
    expect(sizes).toEqual(['600x400', '600x400', '600x400', '400x600', '600x400', '600x400']);
    const rot = [...r.stdout.matchAll(/Page\s+\d+ rot:\s+(\d+)/g)].map(m => Number(m[1]));
    expect(rot).toEqual([0, 0, 0, 90, 0, 0]);
  });

  it('extracts the original text of every PDF page', () => {
    for (const [i, text] of Object.entries(TEXT)) {
      const n = Number(i) + 1;
      const r = run('pdftotext', ['-cropbox', '-f', String(n), '-l', String(n), file, '-']);
      expect(r.stdout.replace(/\s+/g, ' '), `page ${n}`).toContain(text);
    }
  });

  it('renders the ink where it was drawn on every page, and the paper', () => {
    const r = run('pdftoppm', ['-r', '72', '-cropbox', file, join(dir, 'poppler')]);
    expect(r.status, r.stderr).toBe(0);
    const images = readdirSync(dir).filter(f => f.startsWith('poppler')).sort().map(f => readPpm(join(dir, f)));
    checkRenders(images);
  });
});

describe.skipIf(!tools.mutool)('MuPDF (mutool)', () => {
  it('reads and rewrites the file without warnings', () => {
    const r = run('mutool', ['clean', '-s', file, join(dir, 'clean.pdf')]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/error|warning/i);
  });

  it('extracts the original text', () => {
    const r = run('mutool', ['draw', '-F', 'txt', '-o', '-', file]);
    expect(r.status).toBe(0);
    for (const text of Object.values(TEXT)) expect(r.stdout.replace(/\s+/g, ' ')).toContain(text);
  });

  it('renders the ink where it was drawn on every page, and the paper', () => {
    const r = run('mutool', ['draw', '-r', '72', '-o', join(dir, 'mupdf-%d.ppm'), file]);
    expect(r.status, r.stderr).toBe(0);
    const images = PAGES.map((_p, i) => readPpm(join(dir, `mupdf-${i + 1}.ppm`)));
    checkRenders(images);
  });
});

/** The checks on rendered pages, the same for every engine. */
function checkRenders(images: Image[]): void {
  expect(images).toHaveLength(PAGES.length);
  images.forEach((img, i) => {
    const what = PAGES[i];
    expect([img.width, img.height], what).toEqual(SIZE);
    expect(colorAround(img, 430, 60, RED), `${what}: red pen at (430, 60)`).toBe(true);
    expect(colorAround(img, 450, 185, BLUE), `${what}: blue pen at (450, 185)`).toBe(true);
    // Highlighter: yellow #ffd200 at 35 % (multiply) over white.
    expect(near(img.px(360, 300), HIGHLIGHT, 25), `${what}: highlighter at (360, 300) is ${img.px(360, 300)}`).toBe(true);
    // Nothing where no ink was drawn (the page's own content is left of x = 300).
    expect(near(img.px(590, 200), WHITE, 20), `${what}: white at (590, 200)`).toBe(true);
    expect(near(img.px(450, 60), RED, 60) && !colorAround(img, 450, 30, RED, 60, 0), `${what}: line ends`).toBe(true);
  });
  // Paper: plain has no rules, lined and grid have them across the page.
  const ruled = (img: Image): number => Math.max(...Array.from({ length: 60 }, (_v, k) => inkedInRow(img, 330 + k)));
  expect(ruled(images[1]), 'plain paper').toBe(0);
  expect(ruled(images[2]), 'lined paper').toBeGreaterThan(500);
  expect(ruled(images[5]), 'grid paper').toBeGreaterThan(500);
}
