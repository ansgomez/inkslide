import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deckFromPdf, inkedPages, loadNotes, loadNotesText, notesPathFor, parseNotes, scaleV1ToPdf, serializeNotes, sha256Hex, slug,
} from '../src/io';
import {
  MAX_PAGES, MAX_POINTS, MAX_STROKES, MAX_WARNINGS, NotesDoc, createStroke, type BlankPage, type NotesJSON, type PageJSON,
} from '../src/model';

/** A notes file as saved by the Marp HTML decks (format v1). */
const v1File = (): NotesJSON => ({
  format: 'marp-notes',
  version: 1,
  deck: { title: 'Signals – Übung 1', slides: 3, size: [1280, 720] },
  pages: [
    { id: 's1', kind: 'slide', slide: 1, strokes: [
      { id: 'k1-0', tool: 'pen', color: '#be1e3c', size: 4, points: [[100, 200, 0.5], [400, 600, 0.7]] },
    ] },
    { id: 'b-xy-1', kind: 'blank', after: 1, paper: 'grid', strokes: [
      { id: 'k1-1', tool: 'highlighter', color: '#ffd200', size: 20, points: [[0, 0, 0.5], [1280, 720, 0.5]] },
    ] },
    { id: 's3', kind: 'slide', slide: 3, strokes: [] },
  ],
});

const pdfDeck = (sha = 'f00') => deckFromPdf({
  title: 'lecture.pdf', sha256: sha, pageSizes: [[960, 540], [960, 540], [960, 540]],
});

describe('helpers', () => {
  it('notesPathFor and slug', () => {
    expect(notesPathFor('/x/lecture.pdf')).toBe('/x/lecture.pdf.notes.json');
    expect(slug('Signals – Übung 1: RC')).toBe('signals-ubung-1-rc');
    expect(slug('')).toBe('slides');
  });

  it('deckFromPdf builds a PDF deck', () => {
    expect(deckFromPdf({ title: 't', pageSizes: [[595, 842], [842, 595]], sha256: 'ab' })).toEqual({
      source: 'pdf', title: 't', slides: 2, size: [595, 842], pageSizes: [[595, 842], [842, 595]], sha256: 'ab',
    });
  });

  it('sha256Hex', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('inkedPages', () => {
  it('counts the PDF pages and blank pages with strokes', () => {
    expect(inkedPages(JSON.stringify(v1File()))).toEqual({ pages: 1, blank: 1 });
    const doc = new NotesDoc(pdfDeck());
    expect(inkedPages(serializeNotes(doc))).toEqual({ pages: 0, blank: 0 });
  });
  it('counts pages with only images', () => {
    const image = { id: 'i', x: 0, y: 0, w: 1, h: 1, src: 'data:image/png;base64,iVBORw0KGgo=' };
    const file = { format: 'marp-notes', version: 3, deck: { source: 'pdf', title: 't', slides: 2, size: [960, 540] }, pages: [
      { id: 'p1', kind: 'slide', slide: 1, strokes: [], images: [image] },
      { id: 'b-1', kind: 'blank', after: 1, paper: 'plain', strokes: [], images: [image] },
      { id: 'p2', kind: 'slide', slide: 2, strokes: [], images: 'x' },
    ] };
    expect(inkedPages(JSON.stringify(file))).toEqual({ pages: 1, blank: 1 });
  });
  it('counts nothing in a file that cannot be read', () => {
    expect(inkedPages('{ not json')).toEqual({ pages: 0, blank: 0 });
    expect(inkedPages('{"format":"other"}')).toEqual({ pages: 0, blank: 0 });
  });
});

describe('parseNotes', () => {
  it('rejects non-JSON, other formats and newer versions', () => {
    expect(() => parseNotes('{')).toThrow('not valid JSON');
    expect(() => parseNotes('{"format":"other"}')).toThrow(/format mismatch/);
    expect(() => parseNotes('{"format":"marp-notes","version":9}')).toThrow(/Unsupported notes version/);
    expect(parseNotes(JSON.stringify(v1File())).version).toBe(1);
  });
});

describe('limits of a notes file', () => {
  const file = (pages: unknown[]): NotesJSON => ({
    format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'lecture.pdf', slides: 3, size: [960, 540] },
    pages: pages as PageJSON[],
  });
  const page = (strokes: unknown[]) => ({ id: 'p1', kind: 'slide', slide: 1, strokes });

  it('rejects too many pages, strokes or points before loading anything', () => {
    const doc = new NotesDoc(pdfDeck());
    doc.addStroke('p1', createStroke({ tool: 'pen', color: '#000', size: 4, points: [[1, 1]] }));
    const pages = new Array(MAX_PAGES + 1).fill(null);
    expect(() => parseNotes(JSON.stringify(file(pages)))).toThrow(/Too many pages/);
    expect(() => doc.load(file(pages))).toThrow(/Too many pages/);
    const strokes = [page(new Array(MAX_STROKES / 2).fill(null)), page(new Array(MAX_STROKES / 2 + 1).fill(null))];
    expect(() => loadNotes(doc, file(strokes))).toThrow(/Too many strokes/);
    // A sparse list: its length counts, nothing is allocated.
    const points = [page([{ tool: 'pen', points: new Array(MAX_POINTS) }, { tool: 'pen', points: [[1, 1]] }])];
    expect(() => loadNotes(doc, file(points))).toThrow(/Too many stroke points/);
    expect(doc.strokes('p1')).toHaveLength(1); // the document is unchanged
    // At the limits it loads.
    const dot = { tool: 'pen', color: '#000', size: 1, points: [[1, 1]] };
    doc.load(file([page(new Array(MAX_STROKES).fill(dot))]));
    expect(doc.strokes('p1')).toHaveLength(MAX_STROKES);
  }, 30000); // loads 200 000 strokes

  it('lists at most MAX_WARNINGS warnings, then how many more', () => {
    const doc = new NotesDoc(pdfDeck());
    // Two deck warnings, then one per page (slide 0 is no page).
    const pages = Array.from({ length: MAX_PAGES }, () => ({ id: 'p0', kind: 'slide', slide: 0 }));
    const { warnings } = loadNotes(doc, { ...file(pages), deck: { source: 'pdf', title: 'other.pdf', slides: 4, size: [960, 540] } });
    expect(MAX_PAGES + 2).toBeGreaterThan(MAX_WARNINGS);
    expect(warnings).toHaveLength(MAX_WARNINGS + 1);
    expect(warnings[0]).toMatch(/other\.pdf/);
    expect(warnings[MAX_WARNINGS]).toBe(`…and ${MAX_PAGES + 2 - MAX_WARNINGS} more warnings`);
  });

  it('quotes at most 100 characters of a file\'s text in a warning', () => {
    const doc = new NotesDoc(pdfDeck());
    const long = 'x'.repeat(100_000);
    const { warnings } = loadNotes(doc, {
      ...file([{ id: long, kind: long }, { id: 'p1', kind: 'slide', slide: long }, page([{ tool: long }])]),
      deck: { source: 'pdf', title: long, slides: 3, size: [960, 540] },
    });
    expect(warnings).toHaveLength(4);
    for (const w of warnings) expect(w.length).toBeLessThan(300);
    expect(warnings).toContain(`Skipped page ${'x'.repeat(100)}… of unknown kind ${'x'.repeat(100)}…`);
  });
});

describe('stroke colors on load', () => {
  it('loads other CSS colors as hex, and colors the export cannot draw as black with one warning', () => {
    const doc = new NotesDoc(pdfDeck());
    const st = (color: unknown) => ({ tool: 'pen', color, size: 4, points: [[1, 1]] });
    const { warnings } = loadNotes(doc, {
      format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'lecture.pdf', slides: 3, size: [960, 540] },
      pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [
        st('#be1e3c'), st('hsl(0 100% 50%)'), st('rebeccapurple'), st('transparent'),
        st('oklch(0.5 0.2 30)'), st('oklch(0.5 0.2 30)'), st(5), st('x'.repeat(101)),
      ] } as PageJSON],
    });
    expect(doc.strokes('p1').map(s => s.color)).toEqual(['#be1e3c', '#ff0000', '#663399', '#00000000', '#000000', '#000000', '#000000']);
    expect(warnings).toEqual([
      'Skipped a malformed stroke on page p1: Stroke color too long',
      'Drew 3 strokes in black: colors "oklch(0.5 0.2 30)", "5" not supported',
    ]);
  });
});

describe('v1 load', () => {
  it('loads unchanged into a Marp deck', () => {
    const doc = new NotesDoc({ title: 'Signals – Übung 1', slides: 3, size: [1280, 720] });
    const res = loadNotes(doc, v1File());
    expect(res).toEqual({ warnings: [], notices: [], scaled: null });
    expect(doc.strokes('s1')[0].points).toEqual([[100, 200, 0.5], [400, 600, 0.7]]);
    expect(doc.sequence()).toEqual(['s1', 'b-xy-1', 's2', 's3']);
    expect(JSON.parse(serializeNotes(doc))).toEqual({ ...v1File(), pages: v1File().pages.slice(0, 2) });
  });

  it('scales slide units onto PDF pages of the same aspect ratio', () => {
    const doc = new NotesDoc(pdfDeck());
    const res = loadNotes(doc, v1File());
    expect(res.scaled).toBe(0.75);
    // title still differs from the HTML deck title; size no longer warns
    expect(res.warnings).toEqual(['Notes were made for "Signals – Übung 1", not "lecture.pdf"']);
    const s = doc.strokes('p1')[0];
    expect(s.points).toEqual([[75, 150, 0.5], [300, 450, 0.7]]);
    expect(s.size).toBe(3);
    const hl = doc.strokes('b-xy-1')[0];
    expect(hl.points[1]).toEqual([960, 540, 0.5]);
    expect(hl.size).toBe(15);
    expect((doc.getPage('b-xy-1') as BlankPage).after).toBe(1);
    expect(doc.sequence()).toEqual(['p1', 'b-xy-1', 'p2', 'p3']);
  });

  it('scales v3 Marp notes (with images) too: strokes and images', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAGUlEQVR4nGP8z8DAwMDAyPCfgYGBiQEJAAAqNwIDlBYW1QAAAABJRU5ErkJggg==';
    const file = v1File();
    file.version = 3;
    file.pages[0].images = [{ id: 'i', x: 100, y: 200, w: 400, h: 100, src: PNG }];
    file.pages.push({ id: 's2', kind: 'slide', slide: 2, strokes: [], images: [{ id: 'j', x: 40, y: 40, w: 80, h: 80, src: PNG }] });
    const doc = new NotesDoc(pdfDeck());
    const res = loadNotes(doc, file);
    expect(res.scaled).toBe(0.75);
    expect(doc.strokes('p1')[0].points[0]).toEqual([75, 150, 0.5]);
    expect(doc.images('p1')[0]).toMatchObject({ x: 75, y: 150, w: 300, h: 75 });
    expect(doc.images('p2')[0]).toMatchObject({ x: 30, y: 30, w: 60, h: 60 }); // a page with only images
    // PDF notes (deck.source "pdf") are never scaled, whatever their version.
    const pdfNotes = { ...file, deck: { ...file.deck, source: 'pdf' as const } };
    expect(scaleV1ToPdf(pdfNotes, new NotesDoc(pdfDeck())).scale).toBeNull();
  });

  it('does not scale across different aspect ratios (warns instead)', () => {
    const doc = new NotesDoc(deckFromPdf({ title: 'Signals – Übung 1', pageSizes: [[595, 842], [595, 842], [595, 842]] }));
    const res = loadNotes(doc, v1File());
    expect(res.scaled).toBeNull();
    expect(res.warnings).toEqual(['Page size differs (1280x720 vs 595x842)']);
    expect(doc.strokes('p1')[0].points[0]).toEqual([100, 200, 0.5]);
  });

  it('does not touch the input object', () => {
    const data = v1File();
    scaleV1ToPdf(data, new NotesDoc(pdfDeck()));
    expect(data).toEqual(v1File());
  });

  it('keeps title and slide count warnings', () => {
    const doc = new NotesDoc(deckFromPdf({ title: 'x.pdf', pageSizes: [[960, 540], [960, 540]] }));
    const res = loadNotesText(doc, JSON.stringify(v1File()));
    expect(res.warnings).toEqual([
      'Notes were made for "Signals – Übung 1", not "x.pdf"',
      'Notes deck has 3 slides, this deck has 2',
    ]);
    expect(res.notices).toEqual(['Kept notes for slide 3 (deck has 2): saved with the notes, not shown']);
  });
  it('scales pages beyond the PDF too (they are kept and saved as v2)', () => {
    const data = v1File();
    data.pages.push({ id: 's4', kind: 'slide', slide: 4, strokes: [{ id: 'k', tool: 'pen', color: '#000', size: 4, points: [[100, 200, 0.5]] }] });
    const doc = new NotesDoc(pdfDeck());
    loadNotes(doc, data);
    expect(doc.kept).toHaveLength(1);
    const saved = JSON.parse(serializeNotes(doc));
    expect(saved.version).toBe(2);
    const kept = saved.pages.find((p: { slide?: number }) => p.slide === 4);
    expect(kept.strokes[0]).toMatchObject({ size: 3, points: [[75, 150, 0.5]] });
  });

  it('passes pages or strokes that are not arrays on to the model, which skips them', () => {
    const data = { ...v1File(), pages: 'pages' } as unknown as NotesJSON;
    const res = loadNotes(new NotesDoc(pdfDeck()), data);
    expect(res.scaled).toBe(0.75); // page 1 fits
    expect(res.warnings).toEqual(['Notes were made for "Signals – Übung 1", not "lecture.pdf"', 'Skipped the pages: not a list']);
    const odd = v1File();
    (odd.pages[0] as { strokes: unknown }).strokes = 'ab';
    const doc = new NotesDoc(pdfDeck());
    const again = loadNotes(doc, odd);
    expect(again.scaled).toBe(0.75);
    expect(again.warnings).toContain('Skipped the strokes of page s1: not a list');
    expect(doc.strokes('b-xy-1')[0].size).toBe(15);
  });

  it('scales only numbers: other values reach the model and are rejected, not coerced', () => {
    const data = v1File();
    data.pages[0].strokes.push(...[
      { id: 'nulls', tool: 'pen', color: '#000', size: 4, points: [[null, null, 0.5]] },
      { id: 'strings', tool: 'pen', color: '#000', size: 4, points: [['100', '200', 0.5]] },
      { id: 'size', tool: 'pen', color: '#000', size: '4', points: [[100, 200, 0.5]] },
    ] as never[]);
    const doc = new NotesDoc(pdfDeck());
    const res = loadNotes(doc, data);
    expect(doc.strokes('p1').map(s => s.id)).toEqual(['k1-0']);
    expect(res.warnings.filter(w => /malformed stroke on page s1/.test(w))).toHaveLength(3);
  });

  it('decides per page: scales the pages that fit and warns about the others', () => {
    const doc = new NotesDoc(deckFromPdf({ title: 'lecture.pdf', pageSizes: [[960, 540], [595, 842], [960, 540]] }));
    const data = v1File();
    data.pages.push({ id: 's2', kind: 'slide', slide: 2, strokes: [{ id: 'a4', tool: 'pen', color: '#000', size: 4, points: [[100, 200, 0.5]] }] });
    const res = loadNotes(doc, data);
    expect(res.scaled).toBe(0.75);
    expect(res.warnings).toEqual([
      'Notes were made for "Signals – Übung 1", not "lecture.pdf"',
      'Notes not scaled to the PDF (page aspect ratio differs): slide 2',
    ]);
    expect(doc.strokes('p1')[0].size).toBe(3);
    expect(doc.strokes('p2')[0]).toMatchObject({ size: 4, points: [[100, 200, 0.5]] });
  });

  describe('the deck size matches when page 1 fits, whatever pages have ink', () => {
    // pages 1 and 2 are 16:9 like the slides, page 3 is 4:3
    const mixed = () => new NotesDoc(deckFromPdf({ title: 'Signals – Übung 1', pageSizes: [[960, 540], [960, 540], [720, 540]] }));
    const file = (pages: NotesJSON['pages']): NotesJSON => ({ ...v1File(), pages });
    const ink = { id: 'k', tool: 'pen' as const, color: '#000', size: 4, points: [[100, 200, 0.5]] as [number, number, number][] };

    it('no pages', () => {
      expect(loadNotes(mixed(), file([]))).toEqual({ warnings: [], notices: [], scaled: 0.75 });
    });

    it('only empty pages', () => {
      const res = loadNotes(mixed(), file([{ id: 's1', kind: 'slide', slide: 1, strokes: [] }, { id: 's3', kind: 'slide', slide: 3, strokes: [] }]));
      expect(res).toEqual({ warnings: [], notices: [], scaled: 0.75 });
    });

    it('ink only on the page that does not fit', () => {
      const doc = mixed();
      const res = loadNotes(doc, file([{ id: 's3', kind: 'slide', slide: 3, strokes: [ink] }]));
      expect(res).toEqual({
        warnings: ['Notes not scaled to the PDF (page aspect ratio differs): slide 3'], notices: [], scaled: 0.75,
      });
      expect(doc.strokes('p3')[0]).toMatchObject({ size: 4, points: [[100, 200, 0.5]] });
    });
  });

  it('scales later pages when page 1 needs no scaling or does not fit', () => {
    const data = v1File();
    data.pages.push({ id: 's2', kind: 'slide', slide: 2, strokes: [{ id: 'b', tool: 'pen', color: '#000', size: 4, points: [[100, 200, 0.5]] }] });
    // page 1 has the slide size (scale 1), page 2 is half of it
    const same = new NotesDoc(deckFromPdf({ title: 'Signals – Übung 1', pageSizes: [[1280, 720], [640, 360], [1280, 720]] }));
    const res = loadNotes(same, data);
    expect(res).toEqual({ warnings: [], notices: [], scaled: 0.5 });
    expect(same.strokes('p1')[0].size).toBe(4);
    expect(same.strokes('p2')[0]).toMatchObject({ size: 2, points: [[50, 100, 0.5]] });
    // page 1 does not fit: its size warning stays, the page that fits is scaled
    const portrait = new NotesDoc(deckFromPdf({ title: 'Signals – Übung 1', pageSizes: [[595, 842], [960, 540], [595, 842]] }));
    const res2 = loadNotes(portrait, data);
    expect(res2.scaled).toBe(0.75);
    expect(res2.warnings).toEqual([
      'Page size differs (1280x720 vs 595x842)',
      'Notes not scaled to the PDF (page aspect ratio differs): slide 1, blank page b-xy-1',
    ]);
    expect(portrait.strokes('p1')[0].size).toBe(4);
    expect(portrait.strokes('p2')[0].size).toBe(3);
  });
});

describe('v2 save/load', () => {
  it('round-trips a PDF document', () => {
    const doc = new NotesDoc(pdfDeck('abc123'));
    doc.addStroke('p2', createStroke({ tool: 'pen', color: '#1e64c8', size: 7, points: [[1.111, 2.222, 0.3333], [5, 6, 1]] }));
    const blank = doc.insertBlankPage('p2', 'lined').pageId;
    doc.addStroke(blank, createStroke({ tool: 'highlighter', color: '#ffd200', size: 32, points: [[0, 0, 0.5]] }));
    const text = serializeNotes(doc);
    const data = JSON.parse(text);
    expect(data.version).toBe(2);
    expect(data.deck).toEqual({
      source: 'pdf', title: 'lecture.pdf', slides: 3, size: [960, 540], sha256: 'abc123',
      pageSizes: [[960, 540], [960, 540], [960, 540]],
    });
    expect(data.pages.map((p: { id: string }) => p.id)).toEqual(['p2', blank]);

    const copy = new NotesDoc(pdfDeck('abc123'));
    const res = loadNotesText(copy, text);
    expect(res).toEqual({ warnings: [], notices: [], scaled: null });
    expect(serializeNotes(copy)).toBe(text);
    expect(copy.strokes('p2')[0].points[0]).toEqual([1.11, 2.22, 0.333]);
    expect(copy.isDirty()).toBe(false);
  });

  it('warns when the PDF changed', () => {
    const doc = new NotesDoc(pdfDeck('aaa'));
    doc.addStroke('p1', createStroke({ tool: 'pen', color: '#000', size: 2, points: [[0, 0, 0.5]] }));
    const other = new NotesDoc(pdfDeck('bbb'));
    expect(loadNotesText(other, serializeNotes(doc)).warnings)
      .toEqual(['Notes were made for a different version of this PDF (checksum differs)']);
  });
});

// A real lecture PDF of your own (INKSLIDE_FIXTURE_PDF); skipped without one.
const FIXTURE = process.env.INKSLIDE_FIXTURE_PDF || '';

describe.skipIf(!existsSync(FIXTURE))('fixture PDF', () => {
  it('hashes the PDF and keys a v2 file to it', async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const sha = await sha256Hex(bytes);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const doc = new NotesDoc(deckFromPdf({ title: 'lecture.pdf', sha256: sha, pageSizes: [[960, 540]] }));
    expect(doc.toJSON().deck.sha256).toBe(sha);
  });
});
