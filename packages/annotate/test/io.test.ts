import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deckFromPdf, inkedPages, loadNotes, loadNotesText, notesPathFor, parseNotes, scaleV1ToPdf, serializeNotes, sha256Hex, slug,
} from '../src/io';
import { NotesDoc, createStroke, type BlankPage, type NotesJSON } from '../src/model';

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
