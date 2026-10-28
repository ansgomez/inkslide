import { describe, expect, it } from 'vitest';
import {
  MAX_COLOR_LENGTH, MAX_DOC_IMAGES, MAX_ID_LENGTH, MAX_IMAGE_CHARS, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, MAX_PAGE_IMAGES, NotesDoc,
  VERSION, createImage, createStroke, imageInfo, imageType,
  type NotesJSON, type PageImage,
} from '../src/model';
import { deckFromPdf, loadNotesText, parseNotes, serializeNotes } from '../src/io';

/** A 4×2 PNG (red left half, blue right half). */
export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAGUlEQVR4nGP8z8DAwMDAyPCfgYGBiQEJAAAqNwIDlBYW1QAAAABJRU5ErkJggg==';

/** A data URL of `bytes` (padded with zeros to whole base64 groups). */
const dataUrl = (type: string, bytes: number[] | Uint8Array, pad = 0): string => {
  const b = Buffer.concat([Buffer.from(bytes), Buffer.alloc(pad)]);
  return `data:${type};base64,${Buffer.concat([b, Buffer.alloc((3 - (b.length % 3)) % 3)]).toString('base64')}`;
};
/** The start of a PNG of w×h pixels: signature and IHDR (nothing after it is read). */
const pngHead = (w: number, h: number): Uint8Array => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 2;
  return b;
};
const u16 = (v: number) => [v >> 8, v & 255];
const APP0 = [0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
/** A JPEG start: SOI, APP0, a frame header (marker `sof`) of w×h, then a scan marker. */
const jpegHead = (w: number, h: number, sof = 0xc0): number[] =>
  [0xff, 0xd8, ...APP0, 0xff, sof, ...u16(17), 8, ...u16(h), ...u16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda];

const img = (id: string, x = 10, y = 20, w = 100, h = 50, src = PNG): PageImage => createImage({ id, x, y, w, h, src });
const pdfDoc = (slides = 3) => new NotesDoc(deckFromPdf({
  title: 'a', sha256: 'abc', pageSizes: Array.from({ length: slides }, () => [960, 540] as [number, number]),
}));
const pen = (id: string) => createStroke({ id, tool: 'pen', color: '#000', size: 4, points: [[0, 0, 0.5], [10, 10, 0.5]] });

describe('createImage', () => {
  it('accepts PNG and JPEG data URLs with a positive finite rectangle', () => {
    expect(img('a')).toEqual({ id: 'a', x: 10, y: 20, w: 100, h: 50, src: PNG });
    expect(imageType(PNG)).toBe('image/png');
    expect(imageType(dataUrl('image/jpeg', jpegHead(640, 480)))).toBe('image/jpeg');
    expect(createImage({ x: 0, y: 0, w: 1, h: 1, src: PNG }).id).toMatch(/-/);
  });

  it('rejects other types, broken data and bad geometry', () => {
    const bad = (over: object) => () => createImage({ x: 0, y: 0, w: 1, h: 1, src: PNG, ...over });
    expect(bad({ src: 'data:image/svg+xml;base64,PHN2Zz4=' })).toThrow(/PNG or JPEG/);
    expect(bad({ src: 'data:image/gif;base64,R0lGODlh' })).toThrow(/PNG or JPEG/);
    expect(bad({ src: 'https://example.com/a.png' })).toThrow(/PNG or JPEG/);
    expect(bad({ src: 'data:image/png;base64,/9j/AAAA' })).toThrow(/PNG or JPEG/); // JPEG data called PNG
    expect(bad({ src: PNG.replace('iVBOR', 'iVB<R') })).toThrow(/PNG or JPEG/);
    expect(bad({ src: PNG.slice(0, -1) })).toThrow(/PNG or JPEG/); // not a whole base64 group
    expect(bad({ src: dataUrl('image/png', pngHead(10, 10), MAX_IMAGE_CHARS) })).toThrow(/too large/);
    expect(bad({ w: 0 })).toThrow(/size/);
    expect(bad({ h: -5 })).toThrow(/size/);
    expect(bad({ x: NaN })).toThrow(/position/);
    expect(bad({ y: Infinity })).toThrow(/position/);
    expect(bad({ x: '3' })).toThrow(/position/);
    expect(bad({ w: 2e6 })).toThrow(/size/);
    expect(() => createImage(null as never)).toThrow(/PNG or JPEG/);
  });
});

describe('image size in pixels', () => {
  const info = (src: string) => imageInfo(src);
  const err = (src: string) => { try { createImage({ x: 0, y: 0, w: 1, h: 1, src }); return ''; } catch (e) { return (e as Error).message; } };

  it('reads it from a PNG IHDR and a JPEG frame header, past other segments', () => {
    expect(info(PNG)).toEqual({ type: 'image/png', width: 4, height: 2 });
    expect(info(dataUrl('image/png', pngHead(4000, 4000)))).toMatchObject({ width: 4000, height: 4000 });
    expect(info(dataUrl('image/jpeg', jpegHead(1024, 768)))).toEqual({ type: 'image/jpeg', width: 1024, height: 768 });
    expect(info(dataUrl('image/jpeg', jpegHead(800, 600, 0xc2)))).toMatchObject({ width: 800, height: 600 }); // progressive
    // A DHT segment (C4, not a frame header) and fill bytes before the frame header.
    const dht = [0xff, 0xc4, ...u16(5), 0, 0, 0];
    expect(info(dataUrl('image/jpeg', [0xff, 0xd8, ...dht, 0xff, ...jpegHead(300, 200).slice(2)]))).toMatchObject({ width: 300, height: 200 });
  });

  it('refuses images too large in pixels, whatever the file size (decompression bombs)', () => {
    expect(err(dataUrl('image/png', pngHead(16000, 16000)))).toMatch(/Image too large \(16000×16000 pixels/);
    expect(err(dataUrl('image/png', pngHead(MAX_IMAGE_SIDE + 1, 1)))).toMatch(/too large/);
    expect(err(dataUrl('image/png', pngHead(4096, 4096)))).toMatch(/too large/); // 16.8 MP
    expect(err(dataUrl('image/jpeg', jpegHead(65535, 65535)))).toMatch(/too large/);
    expect(MAX_IMAGE_PIXELS).toBe(16_000_000);
  });

  it('refuses images whose size cannot be read', () => {
    const unreadable = /could not be read/;
    expect(err(dataUrl('image/png', pngHead(0, 10)))).toMatch(unreadable);
    expect(err('data:image/png;base64,iVBORw0KGgo=')).toMatch(unreadable); // the signature alone
    expect(err(dataUrl('image/png', pngHead(10, 10).slice(0, 20)))).toMatch(unreadable); // truncated IHDR
    const notIhdr = pngHead(10, 10); notIhdr[12] = 0x58;
    expect(err(dataUrl('image/png', notIhdr))).toMatch(unreadable);
    expect(err(dataUrl('image/jpeg', jpegHead(10, 10).slice(0, 25)))).toMatch(unreadable); // truncated in the frame header
    expect(err(dataUrl('image/jpeg', [0xff, 0xd8, ...APP0]))).toMatch(unreadable); // ends before any frame header
    expect(err(dataUrl('image/jpeg', [0xff, 0xd8, ...APP0, 0xff, 0xda, 0, 2]))).toMatch(unreadable); // scan, no frame header
    expect(err(dataUrl('image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toMatch(unreadable); // segment length 0
    expect(err(dataUrl('image/jpeg', [0xff, 0xd8, ...APP0, 0x12, 0x34]))).toMatch(unreadable); // not at a marker
    expect(err(dataUrl('image/jpeg', [0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, ...new Array(100).fill(0)]))).toMatch(unreadable); // runs past the end
  });
});

describe('ids and colors', () => {
  it('gives images and strokes with an unusable id a new one', () => {
    const long = 'x'.repeat(MAX_ID_LENGTH + 1);
    for (const id of [long, 5, {}, '']) {
      const i = createImage({ id: id as string, x: 0, y: 0, w: 1, h: 1, src: PNG });
      expect(i.id).not.toBe(id);
      expect(i.id.length).toBeLessThanOrEqual(MAX_ID_LENGTH);
      const s = createStroke({ id: id as string, tool: 'pen', color: '#000', size: 2, points: [[0, 0]] });
      expect(s.id).not.toBe(id);
    }
    expect(createImage({ id: 'x'.repeat(MAX_ID_LENGTH), x: 0, y: 0, w: 1, h: 1, src: PNG }).id).toHaveLength(MAX_ID_LENGTH);
  });

  it('refuses a stroke color longer than presenter mode can send', () => {
    expect(() => createStroke({ tool: 'pen', color: 'x'.repeat(MAX_COLOR_LENGTH + 1), size: 2, points: [[0, 0]] })).toThrow(/color/);
  });
});

describe('NotesDoc images', () => {
  it('adds, moves and removes images with strokes, one undo step each', () => {
    const doc = pdfDoc();
    doc.addItems('p1', [pen('s')], [img('i')]);
    expect(doc.images('p1').map(i => i.id)).toEqual(['i']);
    expect(doc.history.undoStack).toHaveLength(1);
    doc.moveItems('p1', ['s', 'i'], 5, -5);
    expect(doc.images('p1')[0]).toMatchObject({ x: 15, y: 15, w: 100, h: 50 });
    expect(doc.strokes('p1')[0].points[0].slice(0, 2)).toEqual([5, -5]);
    doc.removeItems('p1', ['i', 's']);
    expect(doc.images('p1')).toEqual([]);
    expect(doc.strokes('p1')).toEqual([]);
    expect(doc.history.undoStack).toHaveLength(3);
    doc.undo();
    expect(doc.images('p1')[0]).toMatchObject({ id: 'i', x: 15 });
    expect(doc.strokes('p1')).toHaveLength(1);
    doc.undo();
    expect(doc.images('p1')[0]).toMatchObject({ x: 10, y: 20 });
    doc.redo();
    expect(doc.images('p1')[0]).toMatchObject({ x: 15 });
  });

  it('clears images with the page and counts them as notes', () => {
    const doc = pdfDoc();
    expect(doc.hasNotes()).toBe(false);
    doc.addItems('p2', [], [img('i')]);
    expect(doc.hasNotes()).toBe(true);
    doc.clearPage('p2');
    expect(doc.images('p2')).toEqual([]);
    doc.undo();
    expect(doc.images('p2')).toHaveLength(1);
  });

  it('refuses images beyond the limits', () => {
    const doc = pdfDoc(20);
    const many = Array.from({ length: MAX_PAGE_IMAGES }, (_, i) => img(`a${i}`));
    expect(doc.imageRoom('p1', many)).toBeNull();
    doc.addItems('p1', [], many);
    expect(doc.imageRoom('p1', [img('x')])).toMatch(/at most 32 images/);
    expect(() => doc.addItems('p1', [], [img('x')])).toThrow(/at most/);
    expect(doc.images('p1')).toHaveLength(MAX_PAGE_IMAGES);
    // Moving the images that are there needs no room.
    expect(doc.moveItems('p1', ['a0'], 1, 1)).not.toBeNull();
    const rest = MAX_DOC_IMAGES - MAX_PAGE_IMAGES;
    for (let p = 2; p * MAX_PAGE_IMAGES <= MAX_DOC_IMAGES; p++) {
      doc.addItems(`p${p}`, [], Array.from({ length: MAX_PAGE_IMAGES }, (_, i) => img(`p${p}-${i}`)));
    }
    expect(rest % MAX_PAGE_IMAGES).toBe(0);
    expect(doc.imageRoom('p19', [img('y')])).toMatch(/document can hold at most/);
  });

  it('refuses images whose data would make the notes file too large', () => {
    const doc = pdfDoc();
    const big = dataUrl('image/png', pngHead(10, 10), Math.floor((MAX_IMAGE_CHARS - 40) / 4) * 3 - 33);
    const fat = (id: string) => createImage({ id, x: 0, y: 0, w: 1, h: 1, src: big });
    for (let i = 0; i < 8; i++) doc.addItems('p1', [], [fat(`f${i}`)]);
    expect(doc.imageRoom('p2', [fat('g')])).toMatch(/MB/);
  });

  it('writes version 3 only when there are images', () => {
    const doc = pdfDoc();
    doc.addStroke('p1', pen('s'));
    expect(doc.toJSON().version).toBe(2);
    expect(doc.toJSON().pages[0]).not.toHaveProperty('images');
    doc.addItems('p3', [], [createImage({ id: 'i', x: 1.234, y: 2.345, w: 10.006, h: 5, src: PNG })]);
    const json = doc.toJSON();
    expect(json.version).toBe(3);
    expect(VERSION).toBe(3);
    // A page with only images is written; numbers rounded as for strokes.
    expect(json.pages.find(p => p.id === 'p3')).toEqual({
      id: 'p3', kind: 'slide', slide: 3, strokes: [], images: [{ id: 'i', x: 1.23, y: 2.35, w: 10.01, h: 5, src: PNG }],
    });
    doc.undo();
    expect(doc.toJSON().version).toBe(2);
    const marp = new NotesDoc({ title: 'Deck', slides: 2, size: [1280, 720] });
    marp.addItems('s1', [], [img('m')]);
    expect(marp.toJSON().version).toBe(3);
  });
});

describe('notes file with images', () => {
  const file = (images: unknown[], extra: Partial<NotesJSON> = {}): string => JSON.stringify({
    format: 'marp-notes', version: 3,
    deck: { source: 'pdf', title: 'a', slides: 3, size: [960, 540], sha256: 'abc' },
    pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [], images }],
    ...extra,
  });

  it('round-trips images through save and load', () => {
    const doc = pdfDoc();
    doc.addItems('p2', [pen('s')], [img('i', 1, 2, 3, 4)]);
    const again = pdfDoc();
    const { warnings } = loadNotesText(again, serializeNotes(doc));
    expect(warnings).toEqual([]);
    expect(again.images('p2')).toEqual([img('i', 1, 2, 3, 4)]);
    expect(parseNotes(serializeNotes(doc)).version).toBe(3);
  });

  it('skips bad images with a warning and loads the rest', () => {
    const doc = pdfDoc();
    const { warnings } = loadNotesText(doc, file([
      { id: 'ok', x: 0, y: 0, w: 10, h: 10, src: PNG },
      { id: 'svg', x: 0, y: 0, w: 10, h: 10, src: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { id: 'neg', x: 0, y: 0, w: -10, h: 10, src: PNG },
      { id: 'nan', x: null, y: 0, w: 10, h: 10, src: PNG },
      null,
      { id: 'ok', x: 5, y: 5, w: 10, h: 10, src: PNG }, // duplicate id: gets a new one
    ]));
    expect(doc.images('p1').map(i => i.x)).toEqual([0, 5]);
    expect(doc.images('p1')[1].id).not.toBe('ok');
    expect(warnings).toHaveLength(4);
    expect(warnings.every(w => /Skipped an image on page p1/.test(w))).toBe(true);
  });

  it('gives an image whose id is a stroke id a new id', () => {
    const doc = pdfDoc();
    const text = JSON.stringify({
      format: 'marp-notes', version: 3, deck: { source: 'pdf', title: 'a', slides: 3, size: [960, 540], sha256: 'abc' },
      pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [{ id: 'x', tool: 'pen', color: '#000', size: 2, points: [[1, 1]] }],
        images: [{ id: 'x', x: 0, y: 0, w: 1, h: 1, src: PNG }] }],
    });
    loadNotesText(doc, text);
    expect(doc.images('p1')[0].id).not.toBe('x');
  });

  it('keeps at most MAX_PAGE_IMAGES per page and MAX_DOC_IMAGES per file', () => {
    const doc = pdfDoc(12);
    const imgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, x: i, y: 0, w: 1, h: 1, src: PNG }));
    const pages = Array.from({ length: 10 }, (_, k) => ({ id: `p${k + 1}`, kind: 'slide', slide: k + 1, strokes: [], images: imgs(40) }));
    const { warnings } = loadNotesText(doc, JSON.stringify({
      format: 'marp-notes', version: 3, deck: { source: 'pdf', title: 'a', slides: 12, size: [960, 540], sha256: 'abc' }, pages,
    }));
    expect(doc.images('p1')).toHaveLength(MAX_PAGE_IMAGES);
    const total = Array.from({ length: 10 }, (_, k) => doc.images(`p${k + 1}`).length).reduce((a, b) => a + b);
    expect(total).toBe(MAX_DOC_IMAGES);
    expect(warnings.some(w => /more than 32 images on the page/.test(w))).toBe(true);
    expect(warnings.some(w => /more than 256 images in the file/.test(w))).toBe(true);
  });

  it('loads a v2 file without images as before', () => {
    const doc = pdfDoc();
    const { warnings } = loadNotesText(doc, file([], { version: 2 } as Partial<NotesJSON>));
    expect(warnings).toEqual([]);
    expect(doc.images('p1')).toEqual([]);
  });

  it('keeps images of pages beyond the PDF and still writes version 3', () => {
    const doc = pdfDoc(1);
    const text = file([], {
      pages: [{ id: 'p3', kind: 'slide', slide: 3, strokes: [], images: [{ id: 'k', x: 0, y: 0, w: 1, h: 1, src: PNG }] }],
    } as Partial<NotesJSON>);
    const { notices } = loadNotesText(doc, text);
    expect(notices).toHaveLength(1);
    const json = doc.toJSON();
    expect(json.version).toBe(3);
    expect(json.pages[0].images).toHaveLength(1);
  });
});
