import { describe, expect, it } from 'vitest';
import type { Point, Stroke } from '@inkslide/annotate/geometry';
import { deckFromPdf } from '@inkslide/annotate/io';
import { createStroke, NotesDoc } from '@inkslide/annotate/model';
import { parsePresenterMessage, type PresenterMessage } from '@inkslide/annotate/presenter';
import { createPresenter, LIVE_MS, type PresenterTimers } from '../src/presenter';

/** Timers run by hand: microtasks with flush(), timeouts with tick(). */
function manualTimers() {
  let micro: (() => void)[] = [];
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: PresenterTimers = {
    setTimeout(fn, ms) { timeouts.set(next, { fn, ms }); return next++; },
    clearTimeout(id) { timeouts.delete(id as number); },
    queueMicrotask(fn) { micro.push(fn); },
  };
  return {
    timers,
    flush() { const run = micro; micro = []; run.forEach(f => f()); },
    tick() { const run = [...timeouts.values()]; timeouts.clear(); run.forEach(t => t.fn()); },
    pendingTimeouts: () => [...timeouts.values()].map(t => t.ms),
  };
}

function setup() {
  const sent: PresenterMessage[] = [];
  const clock = manualTimers();
  // Every message must pass the check main and the audience make.
  const presenter = createPresenter(m => { sent.push(parsePresenterMessage(m)); }, clock.timers);
  const doc = new NotesDoc(deckFromPdf({ title: 'Deck', pageSizes: [[960, 540], [960, 540]] }));
  const file = { path: '/x/deck.pdf', name: 'deck.pdf', bytes: new Uint8Array([37, 80, 68, 70]) };
  const types = (): string[] => sent.map(m => m.type);
  const take = (): PresenterMessage[] => sent.splice(0);
  return { sent, clock, presenter, doc, file, types, take };
}

const pt = (x: number): Point => [x, x, 0.5];
const pen = (points: Point[]): Stroke => ({ id: 'live', tool: 'pen', color: '#be1e3c', size: 4, points });
const inner = () => ({ updates: 0, removed: false, update() { this.updates++; }, remove() { this.removed = true; } });

describe('createPresenter', () => {
  it('sends nothing until the audience window is there, then everything', () => {
    const { presenter, doc, file, types, take } = setup();
    presenter.opened(file, doc);
    presenter.shown('p1');
    doc.addStroke('p1', createStroke({ tool: 'pen', color: '#000', size: 4, points: [pt(1), pt(2)] }));
    presenter.laser('p1', pt(3));
    expect(types()).toEqual([]);
    presenter.setActive(true);
    const [open, notes, page] = take();
    expect(open).toMatchObject({ type: 'open', title: 'Deck', pdf: file.bytes });
    expect(notes.type === 'notes' && JSON.parse(notes.notes).pages[0].strokes).toHaveLength(1);
    expect(page).toEqual({ type: 'page', page: 'p1' });
  });

  it('tells an audience without a document so', () => {
    const { presenter, take } = setup();
    presenter.setActive(true);
    expect(take()).toEqual([{ type: 'close' }]);
  });

  it('sends the strokes of a changed page once per task, and page turns at once', () => {
    const { presenter, doc, file, clock, take } = setup();
    presenter.opened(file, doc);
    presenter.setActive(true);
    take();
    const s = createStroke({ tool: 'pen', color: '#000', size: 4, points: [pt(1), pt(2)] });
    doc.addStroke('p1', s);
    doc.moveStrokes('p1', [s.id], 5, 5);
    presenter.shown('p2');
    presenter.shown('p2'); // the same page again: nothing
    expect(take()).toEqual([{ type: 'page', page: 'p2' }]);
    clock.flush();
    const [m] = take();
    expect(m.type === 'strokes' && m.page === 'p1' && m.strokes.map(x => x.points[0])).toEqual([[6, 6, 0.5]]);
  });

  it('sends the blank pages at once and their strokes after', () => {
    const { presenter, doc, file, clock, types, take } = setup();
    presenter.opened(file, doc);
    presenter.setActive(true);
    take();
    const { pageId } = doc.insertBlankPage('p1', 'grid');
    expect(take()).toEqual([{ type: 'blanks', blanks: [{ id: pageId, after: 1, paper: 'grid' }] }]);
    clock.flush();
    expect(take()).toEqual([{ type: 'strokes', page: pageId, strokes: [] }]);
    doc.deletePage(pageId);
    clock.flush();
    expect(types()).toEqual(['blanks']);
  });

  it('sends all notes after a load (import, revert)', () => {
    const { presenter, doc, file, take } = setup();
    presenter.opened(file, doc);
    presenter.setActive(true);
    take();
    doc.load({ format: 'marp-notes', version: 2, deck: doc.toJSON().deck, pages: [] });
    expect(take().map(m => m.type)).toContain('notes');
  });

  it('mirrors the stroke being written with only the points that changed, at most every LIVE_MS', () => {
    const { presenter, doc, file, clock, take } = setup();
    presenter.opened(file, doc);
    presenter.setActive(true);
    take();
    const here = inner();
    const live = presenter.liveStroke('p1', 'pen', here);
    live.update(pen([pt(1)]));
    expect(here.updates).toBe(1);
    expect(take()).toEqual([{ type: 'live', page: 'p1', tool: 'pen', color: '#be1e3c', size: 4, from: 0, points: [pt(1)] }]);
    expect(clock.pendingTimeouts()).toEqual([LIVE_MS]);
    live.update(pen([pt(1), pt(2)]));
    live.update(pen([pt(1), pt(2), pt(3)]));
    expect(take()).toEqual([]); // waits for the timer
    clock.tick();
    expect(take()).toEqual([{ type: 'live', page: 'p1', tool: 'pen', color: '#be1e3c', size: 4, from: 1, points: [pt(2), pt(3)] }]);
    clock.tick();
    // Shift: a straight line keeps only the first and the last point.
    live.update(pen([pt(1), pt(9)]));
    expect(take()).toMatchObject([{ type: 'live', from: 1, points: [pt(9)] }]);
    // Pen up: the stroke is added right after the live one is removed; the audience gets it first.
    live.remove();
    expect(here.removed).toBe(true);
    doc.addStroke('p1', createStroke({ tool: 'pen', color: '#be1e3c', size: 4, points: [pt(1), pt(9)] }));
    clock.flush();
    expect(take().map(m => m.type)).toEqual(['strokes', 'live-end']);
    clock.tick();
    expect(take()).toEqual([]);
  });

  it('collects laser points and sends them together', () => {
    const { presenter, doc, file, clock, take } = setup();
    presenter.opened(file, doc);
    presenter.setActive(true);
    take();
    presenter.laser('p1', pt(1));
    presenter.laser('p1', pt(2));
    presenter.laser('p1', pt(3));
    expect(take()).toEqual([{ type: 'laser', page: 'p1', points: [[1, 1]] }]);
    clock.tick();
    expect(take()).toEqual([{ type: 'laser', page: 'p1', points: [[2, 2], [3, 3]] }]);
  });

  it('stops when the audience window closes', () => {
    const { presenter, doc, file, clock, take } = setup();
    presenter.opened(file, doc);
    presenter.setActive(true);
    presenter.setActive(false);
    take();
    presenter.shown('p2');
    presenter.laser('p2', pt(1));
    doc.addStroke('p2', createStroke({ tool: 'pen', color: '#000', size: 4, points: [pt(1)] }));
    clock.flush();
    clock.tick();
    expect(take()).toEqual([]);
    expect(presenter.active).toBe(false);
  });
});
