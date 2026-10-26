import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, type AutosaveState } from '../src/autosave';
import { NotesDoc, createStroke } from '../src/model';
import { serializeNotes } from '../src/io';

/** A write whose calls can be resolved or failed by hand. */
function manualWrite() {
  const calls: { text: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  let active = 0, maxActive = 0;
  const write = vi.fn((text: string) => new Promise<void>((resolve, reject) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const done = (fn: () => void) => () => { active--; fn(); };
    calls.push({ text, resolve: done(resolve), reject: e => { active--; reject(e); } });
  }));
  return { write, calls, maxActive: () => maxActive };
}

const tick = () => vi.advanceTimersByTimeAsync(0);

describe('createAutosave', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('saves once, delayMs after the last change', async () => {
    const write = vi.fn(async (_: string) => {});
    let n = 0;
    const states: AutosaveState[] = [];
    const a = createAutosave({ serialize: () => `v${++n}`, write, onState: s => states.push(s) });
    a.markDirty();
    expect(a.state).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1500);
    a.markDirty();
    await vi.advanceTimersByTimeAsync(1999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('v1');
    expect(a.state).toBe('saved');
    expect(states).toEqual(['dirty', 'saving', 'saved']);
    await vi.advanceTimersByTimeAsync(10000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does nothing without changes', async () => {
    const write = vi.fn(async () => {});
    const a = createAutosave({ serialize: () => '', write });
    await a.flush();
    await a.pageTurned();
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).not.toHaveBeenCalled();
    expect(a.state).toBe('saved');
  });

  it('saves at once on page turn and on flush', async () => {
    const write = vi.fn(async (_: string) => {});
    const a = createAutosave({ serialize: () => 'x', write, delayMs: 2000 });
    a.markDirty();
    await a.pageTurned();
    expect(write).toHaveBeenCalledTimes(1);
    a.markDirty();
    await a.flush();
    expect(write).toHaveBeenCalledTimes(2);
    // The debounce timer was cancelled by the immediate saves.
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('never writes twice at once and coalesces requests during a write', async () => {
    const m = manualWrite();
    let n = 0;
    const a = createAutosave({ serialize: () => `v${++n}`, write: m.write, delayMs: 100 });
    a.markDirty();
    await vi.advanceTimersByTimeAsync(100);
    expect(m.calls.length).toBe(1);
    expect(a.state).toBe('saving');
    // More changes and save requests while the first write runs.
    a.markDirty();
    const f1 = a.flush();
    a.markDirty();
    const f2 = a.flush();
    void a.pageTurned();
    await vi.advanceTimersByTimeAsync(500);
    expect(m.calls.length).toBe(1);
    m.calls[0].resolve();
    await tick();
    expect(m.calls.length).toBe(2);         // one write for all queued requests
    expect(m.calls[1].text).toBe('v2');     // with the newest state
    m.calls[1].resolve();
    await Promise.all([f1, f2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.calls.length).toBe(2);
    expect(m.maxActive()).toBe(1);
    expect(a.state).toBe('saved');
  });

  it('a change during a write is saved after its own debounce', async () => {
    const m = manualWrite();
    const a = createAutosave({ serialize: () => 'x', write: m.write, delayMs: 100 });
    a.markDirty();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(50);
    a.markDirty();                          // debounce restarts at t = 150
    m.calls[0].resolve();
    await tick();
    expect(a.state).toBe('dirty');
    expect(m.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(m.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.calls.length).toBe(2);
    m.calls[1].resolve();
    await tick();
    expect(a.state).toBe('saved');
  });

  it('retries failed writes with backoff and recovers', async () => {
    const m = manualWrite();
    const errors: unknown[] = [];
    const states: AutosaveState[] = [];
    const a = createAutosave({
      serialize: () => 'x', write: m.write, delayMs: 100, retryMs: 1000, maxRetryMs: 3000,
      onState: s => states.push(s), onError: e => errors.push(e),
    });
    a.markDirty();
    await vi.advanceTimersByTimeAsync(100);
    m.calls[0].reject(new Error('disk full'));
    await tick();
    expect(a.state).toBe('error');
    expect(a.failures).toBe(1);
    expect(errors).toHaveLength(1);
    // A change while the retry is pending keeps the backoff.
    a.markDirty();
    await vi.advanceTimersByTimeAsync(999);
    expect(m.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.calls.length).toBe(2);         // retry after 1 s
    m.calls[1].reject(new Error('disk full'));
    await tick();
    await vi.advanceTimersByTimeAsync(1999);
    expect(m.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.calls.length).toBe(3);         // then 2 s
    m.calls[2].reject(new Error('disk full'));
    await tick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.calls.length).toBe(4);         // capped at 3 s (not 4 s)
    m.calls[3].resolve();
    await tick();
    expect(a.state).toBe('saved');
    expect(a.failures).toBe(0);
    expect(states).toEqual(['dirty', 'saving', 'error', 'saving', 'error', 'saving', 'error', 'saving', 'saved']);
  });

  it('flush rejects when the write fails and saves at once when retried', async () => {
    let fail = true;
    const write = vi.fn(async () => { if (fail) throw new Error('read-only'); });
    const a = createAutosave({ serialize: () => 'x', write, retryMs: 60000 });
    a.markDirty();
    await expect(a.flush()).rejects.toThrow('read-only');
    expect(a.state).toBe('error');
    fail = false;
    await a.flush();                        // no waiting for the 60 s backoff
    expect(a.state).toBe('saved');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('page turn never rejects', async () => {
    const write = vi.fn(async () => { throw new Error('nope'); });
    const a = createAutosave({ serialize: () => 'x', write });
    a.markDirty();
    await expect(a.pageTurned()).resolves.toBeUndefined();
    expect(a.state).toBe('error');
    a.dispose();
  });

  it('dispose stops timers and ignores changes', async () => {
    const write = vi.fn(async () => {});
    const a = createAutosave({ serialize: () => 'x', write });
    a.markDirty();
    a.dispose();
    a.markDirty();
    await vi.advanceTimersByTimeAsync(10000);
    await a.flush();
    expect(write).not.toHaveBeenCalled();
  });

  it('follows NotesDoc changes and marks the doc saved', async () => {
    const doc = new NotesDoc({ source: 'pdf', title: 't.pdf', slides: 2, pageSizes: [[600, 400], [600, 400]] });
    const texts: string[] = [];
    const a = createAutosave({ doc, serialize: () => serializeNotes(doc), write: async t => { texts.push(t); } });
    doc.addStroke('p1', createStroke({ tool: 'pen', color: '#000', size: 2, points: [[1, 1, 0.5], [5, 5, 0.5]] }));
    expect(doc.isDirty()).toBe(true);
    expect(a.state).toBe('dirty');
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts).toHaveLength(1);
    expect(JSON.parse(texts[0]).pages[0].id).toBe('p1');
    expect(doc.isDirty()).toBe(false);
    expect(a.state).toBe('saved');          // markSaved's 'saved' event is not a change
    doc.insertBlankPage('p2', 'grid');
    await a.pageTurned();
    expect(texts).toHaveLength(2);
    expect(JSON.parse(texts[1]).pages.some((p: { kind: string }) => p.kind === 'blank')).toBe(true);
  });

  it('does not mark the doc saved when it changed during the write', async () => {
    const doc = new NotesDoc({ source: 'pdf', title: 't.pdf', slides: 1, pageSizes: [[600, 400]] });
    const m = manualWrite();
    const a = createAutosave({ doc, serialize: () => serializeNotes(doc), write: m.write, delayMs: 100 });
    const stroke = () => createStroke({ tool: 'pen', color: '#000', size: 2, points: [[1, 1, 0.5]] });
    doc.addStroke('p1', stroke());
    await vi.advanceTimersByTimeAsync(100);
    doc.addStroke('p1', stroke());
    m.calls[0].resolve();
    await tick();
    expect(doc.isDirty()).toBe(true);
    expect(a.state).toBe('dirty');
    await vi.advanceTimersByTimeAsync(100);
    m.calls[1].resolve();
    await tick();
    expect(JSON.parse(m.calls[1].text).pages[0].strokes).toHaveLength(2);
    expect(doc.isDirty()).toBe(false);
  });

  it('notes loaded after it is created count as a change (an import is saved)', async () => {
    const doc = new NotesDoc({ source: 'pdf', title: 't.pdf', slides: 1, pageSizes: [[600, 400]] });
    const texts: string[] = [];
    const a = createAutosave({ doc, serialize: () => serializeNotes(doc), write: async t => { texts.push(t); }, delayMs: 100 });
    doc.load({
      format: 'marp-notes', version: 2, deck: { source: 'pdf', title: 't.pdf', slides: 1, size: [600, 400] },
      pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [{ id: 'a', tool: 'pen', color: '#000', size: 2, points: [[1, 1, 0.5]] }] }],
    });
    expect(a.state).toBe('dirty');
    await vi.advanceTimersByTimeAsync(100);
    expect(texts).toHaveLength(1);
    expect(JSON.parse(texts[0]).pages[0].strokes[0].id).toBe('a');
  });

  it('a disposed controller neither writes nor marks the doc saved', async () => {
    const doc = new NotesDoc({ source: 'pdf', title: 't.pdf', slides: 1, pageSizes: [[600, 400]] });
    const write = vi.fn(async () => {});
    const a = createAutosave({ doc, serialize: () => serializeNotes(doc), write, delayMs: 100 });
    a.dispose();
    doc.addStroke('p1', createStroke({ tool: 'pen', color: '#000', size: 2, points: [[1, 1, 0.5]] }));
    await vi.advanceTimersByTimeAsync(1000);
    await a.flush();
    expect(write).not.toHaveBeenCalled();
    expect(a.state).toBe('saved');
    expect(doc.isDirty()).toBe(true);
  });
});
