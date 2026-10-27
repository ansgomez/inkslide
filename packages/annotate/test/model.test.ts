import { describe, expect, it, vi } from 'vitest';
import { History, NotesDoc, createStroke, checkFormat, deckWarnings, type BlankPage, type Command } from '../src/model';
import type { Point, Stroke } from '../src/geometry';
import { deckFromPdf } from '../src/io';

const pts: Point[] = [[0, 0, 0.5], [10, 10, 0.5]];
const stroke = (id: string, extra: Partial<Stroke> = {}): Stroke =>
  createStroke({ id, tool: 'pen', color: '#000', size: 4, points: pts, ...extra });
const marpDoc = (slides = 3) => new NotesDoc({ title: 'Deck', slides, size: [1280, 720] });
const pdfDoc = (slides = 3) => new NotesDoc({
  source: 'pdf', title: 'a.pdf', slides, sha256: 'abc',
  pageSizes: Array.from({ length: slides }, (_, i) => (i === 1 ? [595, 842] : [960, 540]) as [number, number]),
});
const ids = (doc: NotesDoc, page: string) => doc.strokes(page).map(s => s.id);

describe('createStroke', () => {
  it('validates and normalises', () => {
    const s = createStroke({ tool: 'highlighter', color: 5, size: 3, points: [[1, 2], [3, 4, 0.9]] });
    expect(s.id).toMatch(/-/);
    expect(s.color).toBe('5');
    expect(s.size).toBe(3);
    expect(s.points).toEqual([[1, 2, 0.5], [3, 4, 0.9]]);
  });

  it('rejects bad input', () => {
    expect(() => createStroke({ tool: 'laser', color: '', size: 1, points: [] })).toThrow(/Unknown stroke tool/);
    expect(() => createStroke({ tool: 'pen', color: '', size: 1, points: 'x' })).toThrow(/array/);
    expect(() => createStroke({ tool: 'pen', color: '', size: 0, points: [] })).toThrow(/positive/);
    expect(() => createStroke({ tool: 'pen', color: '', size: 1, points: [[NaN, 0]] })).toThrow(/finite/);
    expect(() => createStroke({ tool: 'pen', color: '', size: 1, points: [null] })).toThrow(/finite/);
  });

  it('mints unique ids', () => {
    expect(stroke('').id).not.toBe(stroke('').id);
  });

  it('rejects a size that is not a number and replaces an id that is not a string', () => {
    expect(() => createStroke({ tool: 'pen', color: '', size: '4', points: pts })).toThrow(/positive number/);
    const s = createStroke({ id: 7 as unknown as string, tool: 'pen', color: '', size: 4, points: pts });
    expect(typeof s.id).toBe('string');
    expect(s.id).not.toBe('7');
  });
});

describe('History', () => {
  const counter = () => {
    const state = { n: 0 };
    const cmd = (): Command => ({ label: 'inc', do: () => { state.n++; }, undo: () => { state.n--; } });
    return { state, cmd };
  };

  it('executes, undoes and redoes', () => {
    const h = new History();
    const { state, cmd } = counter();
    h.execute(cmd());
    h.execute(cmd());
    expect(state.n).toBe(2);
    h.undo();
    expect(state.n).toBe(1);
    expect(h.canRedo()).toBe(true);
    h.redo();
    expect(state.n).toBe(2);
    expect(h.undo()).not.toBeNull();
    h.execute(cmd()); // new command clears redo
    expect(h.canRedo()).toBe(false);
  });

  it('respects the limit', () => {
    const h = new History(2);
    const { cmd } = counter();
    h.execute(cmd()); h.execute(cmd()); h.execute(cmd());
    expect(h.undoStack.length).toBe(2);
  });

  it('drops a failing command instead of throwing', () => {
    const h = new History();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.execute({ label: 'bad', do: () => {}, undo: () => { throw new Error('boom'); } });
    expect(h.undo()).toBeNull();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('onChange returns a function that removes the listener, also during an emit', () => {
    const h = new History();
    const fn = vi.fn(), other = vi.fn();
    const off = h.onChange(() => { fn(); off(); });
    h.onChange(other);
    h.execute(counter().cmd());
    h.undo();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    const doc = marpDoc();
    const seen = vi.fn();
    const stop = doc.onChange(seen);
    doc.addStroke('s1', stroke('a'));
    stop();
    doc.addStroke('s1', stroke('b'));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('notifies listeners', () => {
    const h = new History();
    const fn = vi.fn();
    h.onChange(fn);
    h.execute(counter().cmd());
    h.undo();
    h.clear();
    expect(fn).toHaveBeenCalledTimes(3);
    expect(h.undo()).toBeNull();
  });
});

describe('NotesDoc strokes and commands', () => {
  it('creates slide pages on demand and draws', () => {
    const doc = marpDoc();
    expect(doc.getPage('s2')).toBeNull();
    doc.addStroke('s2', stroke('a'));
    expect(ids(doc, 's2')).toEqual(['a']);
    expect(() => doc.addStroke('s9', stroke('b'))).toThrow(/No page/);
  });

  it('undo/redo of draw, erase, move and restyle', () => {
    const doc = marpDoc();
    doc.addStroke('s1', stroke('a'));
    doc.addStroke('s1', stroke('b'));
    doc.removeStrokes('s1', ['a']);
    expect(ids(doc, 's1')).toEqual(['b']);
    doc.undo();
    expect(ids(doc, 's1')).toEqual(['a', 'b']); // z-order restored

    doc.moveStrokes('s1', ['b'], 5, -5);
    expect(doc.strokes('s1')[1].points[0]).toEqual([5, -5, 0.5]);
    doc.restyleStrokes('s1', ['a', 'b'], { color: '#f00', size: s => s.size * 2 });
    expect(doc.strokes('s1').map(s => [s.color, s.size])).toEqual([['#f00', 8], ['#f00', 8]]);
    doc.undo();
    expect(doc.strokes('s1').map(s => s.color)).toEqual(['#000', '#000']);
    doc.undo();
    expect(doc.strokes('s1')[1].points[0]).toEqual([0, 0, 0.5]);
    doc.redo();
    expect(doc.strokes('s1')[1].points[0]).toEqual([5, -5, 0.5]);
  });

  it('returns null for no-op edits', () => {
    const doc = marpDoc();
    doc.addStroke('s1', stroke('a'));
    doc.addStroke('s1', stroke('b'));
    expect(doc.moveStrokes('s1', ['a'], 0, 0)).toBeNull();
    expect(doc.restyleStrokes('s1', ['a'], { color: '#000' })).toBeNull();
    expect(doc.replaceStrokes('s1', doc.strokes('s1').slice())).toBeNull();
    expect(doc.replaceStrokes('s1', doc.strokes('s1').slice().reverse())).toBeNull(); // order only
    expect(doc.clearPage('s3')).toBeNull(); // page never written
  });

  it('clearPage is one undoable step', () => {
    const doc = marpDoc();
    doc.addStroke('s1', stroke('a'));
    doc.addStroke('s1', stroke('b'));
    doc.clearPage('s1');
    expect(ids(doc, 's1')).toEqual([]);
    doc.undo();
    expect(ids(doc, 's1')).toEqual(['a', 'b']);
  });

  it('undo keeps strokes added meanwhile by another window', () => {
    const doc = marpDoc();
    doc.addStroke('s1', stroke('a'));
    doc.applyRemoteStrokes('s1', [...doc.strokes('s1'), stroke('remote')]);
    doc.undo();
    expect(ids(doc, 's1')).toEqual(['remote']);
    doc.redo();
    expect(ids(doc, 's1')).toEqual(['a', 'remote']); // back at its original index
  });

  it('emits change events', () => {
    const doc = marpDoc();
    const fn = vi.fn();
    doc.onChange(fn);
    doc.addStroke('s1', stroke('a'));
    expect(fn).toHaveBeenCalledWith('s1', 'strokes');
    doc.insertBlankPage('s1');
    expect(fn).toHaveBeenLastCalledWith(expect.stringMatching(/^b-/), 'pages');
  });

  it('tracks dirty state', () => {
    const doc = marpDoc();
    expect(doc.isDirty()).toBe(false);
    doc.addStroke('s1', stroke('a'));
    expect(doc.isDirty()).toBe(true);
    doc.markSaved();
    expect(doc.isDirty()).toBe(false);
    doc.undo();
    expect(doc.isDirty()).toBe(true);
    doc.redo();
    expect(doc.isDirty()).toBe(false);
  });
});

describe('NotesDoc blank pages', () => {
  it('inserts in reading order and after other blank pages', () => {
    const doc = marpDoc();
    const b1 = doc.insertBlankPage('s1', 'grid').pageId;
    const b2 = doc.insertBlankPage(b1, 'lined').pageId;
    const b0 = doc.insertBlankPage('s1').pageId; // directly after the slide: before b1
    const c = doc.insertBlankPage('s2').pageId;
    expect(doc.sequence()).toEqual(['s1', b0, b1, b2, 's2', c, 's3']);
    expect(doc.blanksAfter(1)).toEqual([b0, b1, b2]);
    expect(doc.position(b1)).toEqual({ slide: 1, index: 3, count: 4 });
    expect(doc.position('s3')).toEqual({ slide: 3, index: 1, count: 1 });
    expect(doc.neighbor('s1', 1)).toBe(b0);
    expect(doc.neighbor('s2', -1)).toBe(b2);
    expect(doc.neighbor('s3', 1)).toBeNull();
    expect((doc.getPage(b2) as BlankPage).paper).toBe('lined');
  });

  it('undoes insert and delete, keeping position and strokes', () => {
    const doc = marpDoc();
    const b1 = doc.insertBlankPage('s1').pageId;
    const b2 = doc.insertBlankPage(b1).pageId;
    doc.addStroke(b1, stroke('x'));
    doc.deletePage(b1);
    expect(doc.sequence()).toEqual(['s1', b2, 's2', 's3']);
    doc.undo();
    expect(doc.sequence()).toEqual(['s1', b1, b2, 's2', 's3']);
    expect(ids(doc, b1)).toEqual(['x']);
    doc.undo(); // the stroke
    doc.undo(); // insert b2
    doc.undo(); // insert b1
    expect(doc.sequence()).toEqual(['s1', 's2', 's3']);
    doc.redo();
    expect(doc.sequence()).toEqual(['s1', b1, 's2', 's3']);
  });

  it('cannot delete slide pages; rejects bad papers and pages', () => {
    const doc = marpDoc();
    doc.addStroke('s1', stroke('a'));
    expect(doc.deletePage('s1')).toBeNull();
    expect(() => doc.insertBlankPage('s1', 'dots' as never)).toThrow(/paper/);
    expect(() => doc.insertBlankPage('s7')).toThrow(/No page/);
  });

  it('setPaper is undoable and skips no-ops', () => {
    const doc = marpDoc();
    const b = doc.insertBlankPage('s1', 'plain').pageId;
    expect(doc.setPaper(b, 'plain')).toBeNull();
    doc.setPaper(b, 'grid');
    expect((doc.getPage(b) as BlankPage).paper).toBe('grid');
    doc.undo();
    expect((doc.getPage(b) as BlankPage).paper).toBe('plain');
    expect(doc.setPaper('s1', 'grid')).toBeNull();
  });
});

describe('PDF decks', () => {
  it('uses p<n> page ids and per-page sizes', () => {
    const doc = pdfDoc();
    expect(doc.sequence()).toEqual(['p1', 'p2', 'p3']);
    expect(doc.deck.size).toEqual([960, 540]);
    expect(doc.pageSize('p2')).toEqual([595, 842]);
    const b = doc.insertBlankPage('p2').pageId;
    expect(doc.pageSize(b)).toEqual([595, 842]);
    doc.addStroke('p3', stroke('a'));
    expect(ids(doc, 'p3')).toEqual(['a']);
    expect(doc.pageOnDemand('s3')).toBeNull();
  });

  it('falls back to the deck size without pageSizes', () => {
    const doc = new NotesDoc({ source: 'pdf', slides: 2, size: [612, 792] });
    expect(doc.pageSize('p2')).toEqual([612, 792]);
    expect(new NotesDoc({ slides: 1 }).deck.size).toEqual([1280, 720]);
  });
});

describe('serialization', () => {
  it('Marp decks round-trip as version 1', () => {
    const doc = marpDoc();
    doc.addStroke('s2', stroke('a', { points: [[1.23456, 2.34567, 0.123456]] }));
    const b = doc.insertBlankPage('s2', 'lined').pageId;
    doc.addStroke(b, stroke('b'));
    const json = doc.toJSON();
    expect(json.version).toBe(1);
    expect(json.deck).toEqual({ title: 'Deck', slides: 3, size: [1280, 720] });
    expect(json.pages.map(p => p.id)).toEqual(['s2', b]);
    expect(json.pages[0].strokes[0].points).toEqual([[1.23, 2.35, 0.123]]);
    expect(json.pages[1]).toMatchObject({ kind: 'blank', after: 2, paper: 'lined' });

    const copy = marpDoc();
    expect(copy.load(JSON.parse(JSON.stringify(json))).warnings).toEqual([]);
    expect(copy.toJSON()).toEqual(json);
    expect(copy.history.canUndo()).toBe(false);
  });

  it('PDF decks write version 2 with source, sha256 and page sizes', () => {
    const doc = pdfDoc();
    doc.addStroke('p1', stroke('a'));
    const json = doc.toJSON();
    expect(json.version).toBe(2);
    expect(json.deck).toEqual({
      source: 'pdf', title: 'a.pdf', slides: 3, size: [960, 540], sha256: 'abc',
      pageSizes: [[960, 540], [595, 842], [960, 540]],
    });
    expect(json.pages[0]).toMatchObject({ id: 'p1', kind: 'slide', slide: 1 });
  });

  it('load warns and skips bad content', () => {
    const doc = marpDoc(2);
    const { warnings, notices } = doc.load({
      format: 'marp-notes', version: 1,
      deck: { title: 'Other', slides: 3, size: [1024, 768] },
      pages: [
        { id: 's1', kind: 'slide', slide: 1, strokes: [{ id: 'a', tool: 'pen', color: '#000', size: 4, points: [[0, 0]] }, { tool: 'pen', size: -1, points: [] }] },
        { id: 's1', kind: 'slide', slide: 1, strokes: [] },
        { id: 's3', kind: 'slide', slide: 3, strokes: [] },
        { id: 'b-1', kind: 'blank', after: 9, strokes: [] },
        { id: 'b-2', kind: 'blank', after: 1, paper: 'weird', strokes: [{ id: 'a', tool: 'pen', color: '#000', size: 4, points: [[1, 1]] }] },
        { id: 'x', kind: 'note', strokes: [] },
        null,
      ],
    });
    expect(warnings).toEqual([
      'Notes were made for "Other", not "Deck"',
      'Notes deck has 3 slides, this deck has 2',
      'Slide size differs (1024x768 vs 1280x720)',
      expect.stringMatching(/malformed stroke on page s1/),
      'Skipped duplicate page s1',
      'Skipped page x of unknown kind note',
      'Skipped a page without id',
    ]);
    expect(notices).toEqual([
      'Kept notes for slide 3 (deck has 2): saved with the notes, not shown',
      'Kept blank page b-1 after slide 9 (deck has 2): saved with the notes, not shown',
    ]);
    expect(doc.sequence()).toEqual(['s1', 'b-2', 's2']);
    expect((doc.getPage('b-2') as BlankPage).paper).toBe('plain');
    // duplicate stroke id across pages gets a fresh id
    expect(doc.strokes('b-2')[0].id).not.toBe('a');
  });

  it('load replaces all content, clears the history and emits document-wide events', () => {
    const doc = pdfDoc(2);
    doc.addStroke('p1', stroke('old'));
    const b = doc.insertBlankPage('p2', 'grid').pageId;
    const fn = vi.fn();
    doc.onChange(fn);
    const res = doc.load({
      format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'a.pdf', slides: 2, size: [960, 540], sha256: 'abc' },
      pages: [{ id: 'p2', kind: 'slide', slide: 2, strokes: [stroke('new')] }],
    });
    expect(res).toEqual({ warnings: [], notices: [] });
    expect(ids(doc, 'p1')).toEqual([]);
    expect(ids(doc, 'p2')).toEqual(['new']);
    expect(doc.getPage(b)).toBeNull();
    expect(doc.sequence()).toEqual(['p1', 'p2']);
    expect(doc.history.canUndo()).toBe(false);
    expect(doc.isDirty()).toBe(false);
    expect(fn.mock.calls).toEqual([[null, 'strokes'], [null, 'pages']]);
  });

  it('load skips invalid page numbers and blank pages that reuse a source page id', () => {
    const doc = pdfDoc(2);
    const { warnings, notices } = doc.load({
      format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 'a.pdf', slides: 2, size: [960, 540], sha256: 'abc' },
      pages: [
        { id: 'p0', kind: 'slide', slide: 0, strokes: [] },
        { id: 'p1', kind: 'slide', slide: 1.5, strokes: [] },
        { id: 'b-x', kind: 'blank', after: 'one' as never, strokes: [] },
        { id: 'p2', kind: 'blank', after: 1, strokes: [] },
      ],
    });
    expect(warnings).toEqual([
      'Skipped notes for slide 0 (deck has 2)',
      'Skipped notes for slide 1.5 (deck has 2)',
      'Skipped blank page b-x after slide one (deck has 2)',
      'Skipped duplicate page p2',
    ]);
    expect(notices).toEqual([]);
    expect(doc.kept).toEqual([]);
    expect(doc.sequence()).toEqual(['p1', 'p2']);
  });

  it('hasNotes: strokes, blank pages or kept pages', () => {
    const doc = new NotesDoc(deckFromPdf({ title: 'x', pageSizes: [[960, 540], [960, 540]] }));
    expect(doc.hasNotes()).toBe(false);
    doc.insertBlankPage('p1');
    expect(doc.hasNotes()).toBe(true);
    doc.load({ format: 'marp-notes', version: 2, deck: { source: 'pdf' }, pages: [{ id: 'p5', kind: 'slide', slide: 5, strokes: [] }] });
    expect(doc.hasNotes()).toBe(true); // only a kept page
    doc.load({ format: 'marp-notes', version: 2, deck: { source: 'pdf' }, pages: [] });
    expect(doc.hasNotes()).toBe(false);
    doc.addStroke('p2', createStroke({ tool: 'pen', color: '#000', size: 4, points: [[0, 0, 0.5]] }));
    expect(doc.hasNotes()).toBe(true);
  });

  it('keeps notes for pages beyond the PDF and writes them back', () => {
    const big = new NotesDoc(deckFromPdf({ title: 'x', pageSizes: [[960, 540], [960, 540], [960, 540]] }));
    big.addStroke('p3', createStroke({ tool: 'pen', color: '#000', size: 4, points: [[1, 2, 0.5], [3, 4, 0.5]] }));
    big.insertBlankPage('p3');
    const file = big.toJSON();
    const small = new NotesDoc(deckFromPdf({ title: 'x', pageSizes: [[960, 540], [960, 540]] }));
    const { warnings, notices } = small.load(JSON.parse(JSON.stringify(file)));
    expect(notices.filter(w => w.startsWith('Kept'))).toHaveLength(2);
    expect(warnings.some(w => w.startsWith('Kept'))).toBe(false);
    expect(small.sequence()).toEqual(['p1', 'p2']);
    small.addStroke('p1', createStroke({ tool: 'pen', color: '#000', size: 4, points: [[0, 0, 0.5]] }));
    small.blankPrefix = big.blankPrefix; // a new blank id must not reuse the kept one's
    small.insertBlankPage('p2');
    const out = small.toJSON();
    const ids = out.pages.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The PDF gets its pages back: the kept notes show again.
    const again = new NotesDoc(deckFromPdf({ title: 'x', pageSizes: [[960, 540], [960, 540], [960, 540]] }));
    expect(again.load(JSON.parse(JSON.stringify(out))).warnings).toEqual(['Notes deck has 2 slides, this deck has 3']);
    expect(again.strokes('p3')).toHaveLength(1);
    expect(again.sequence()).toHaveLength(5);
  });

  it('checkFormat rejects other files and newer versions', () => {
    expect(() => checkFormat(null)).toThrow(/format mismatch/);
    expect(() => checkFormat({ format: 'x', version: 1 })).toThrow(/format mismatch/);
    expect(() => checkFormat({ format: 'marp-notes', version: 3 })).toThrow(/Unsupported notes version: 3/);
    expect(() => checkFormat({ format: 'marp-notes', version: '2' })).toThrow(/Unsupported notes version/);
    expect(() => checkFormat({ format: 'marp-notes' })).toThrow(/Unsupported notes version/);
    expect(() => checkFormat({ format: 'marp-notes', version: 2 })).not.toThrow();
    expect(() => checkFormat({ format: 'marp-notes', version: 1 })).not.toThrow();
    for (const version of [0, -3, 1.5, NaN]) {
      expect(() => checkFormat({ format: 'marp-notes', version })).toThrow(/Unsupported notes version/);
    }
  });

  it('load skips pages and strokes that are not arrays, and loads the rest', () => {
    const base = { format: 'marp-notes', version: 1, deck: { title: 'Deck', slides: 3, size: [1280, 720] } };
    for (const pages of ['s1', { s1: {} }, 5]) {
      const doc = marpDoc();
      expect(doc.load({ ...base, pages }).warnings).toEqual(['Skipped the pages: not a list']);
      expect(doc.hasNotes()).toBe(false);
    }
    const doc = marpDoc();
    const { warnings } = doc.load({ ...base, pages: [
      { id: 's1', kind: 'slide', slide: 1, strokes: 'abc' },
      { id: 's2', kind: 'slide', slide: 2, strokes: { 0: {} } },
      { id: 's3', kind: 'slide', slide: 3, strokes: [{ id: 'ok', tool: 'pen', color: '#000', size: 4, points: pts }] },
    ] });
    expect(warnings).toEqual(['Skipped the strokes of page s1: not a list', 'Skipped the strokes of page s2: not a list']);
    expect(ids(doc, 's3')).toEqual(['ok']);
  });

  it('deckWarnings survives a size or pageSizes that is not an array', () => {
    const deck = pdfDoc().deck;
    const file = { source: 'pdf' as const, title: 'a.pdf', slides: 3, sha256: 'abc' };
    expect(deckWarnings({ ...file, size: 'big' as unknown as [number, number], pageSizes: deck.pageSizes }, deck))
      .toEqual(['Page size differs ( vs 960x540)']);
    expect(deckWarnings({ ...file, size: [960, 540], pageSizes: 'x' as unknown as [number, number][] }, deck)).toEqual([]);
    expect(deckWarnings({ ...file, size: [960, 540], pageSizes: [[960, 540], 'x', null] as unknown as [number, number][] }, deck))
      .toEqual(['2 more page sizes differ']);
  });

  it('deckWarnings for PDFs: checksum wins over the title', () => {
    const deck = pdfDoc().deck;
    const same = { source: 'pdf' as const, title: 'renamed.pdf', slides: 3, size: [960, 540] as [number, number], sha256: 'abc', pageSizes: deck.pageSizes };
    expect(deckWarnings(same, deck)).toEqual([]);
    expect(deckWarnings({ ...same, sha256: 'zzz' }, deck)).toEqual([
      'Notes were made for a different version of this PDF (checksum differs)',
      'Notes were made for "renamed.pdf", not "a.pdf"',
    ]);
    expect(deckWarnings({ ...same, pageSizes: [[960, 540], [600, 800], [1, 1]] }, deck)).toEqual(['2 more page sizes differ']);
    expect(deckWarnings(undefined, deck)).toEqual(['File has no deck information']);
  });

  it('applyRemoteState replaces content and clears history', () => {
    const doc = marpDoc();
    doc.addStroke('s1', stroke('mine'));
    const peer = marpDoc();
    peer.addStroke('s2', stroke('theirs'));
    const b = peer.insertBlankPage('s2', 'grid').pageId;
    doc.applyRemoteState(peer.toJSON());
    expect(ids(doc, 's1')).toEqual([]);
    expect(ids(doc, 's2')).toEqual(['theirs']);
    expect(doc.sequence()).toContain(b);
    expect(doc.history.canUndo()).toBe(false);
    expect(doc.isDirty()).toBe(true);
  });
});
