import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotesDoc, createStroke, type PdfFile, type PlatformAdapter } from '@inkslide/annotate';
import { deckFromPdf, parseNotes } from '@inkslide/annotate/io';
import { flushSave, saveState, scheduleSave, setSaveTarget } from '../src/persist';

const pdf: PdfFile = { path: null, name: 'a.pdf', bytes: new Uint8Array() };

function setup() {
  const doc = new NotesDoc(deckFromPdf({ title: 'a', pageSizes: [[960, 540]], sha256: 'abc' }));
  const writes: string[] = [];
  const adapter = {
    writeNotes: vi.fn(async (_p: PdfFile, text: string) => { writes.push(text); }),
  } as unknown as PlatformAdapter;
  setSaveTarget({ doc, adapter, pdf, sha256: 'abc' });
  const draw = () => doc.addStroke('p1', createStroke({ tool: 'pen', color: '#000', size: 4, points: [[0, 0, 0.5], [10, 10, 0.5]] }));
  return { doc, writes, draw };
}

afterEach(() => {
  setSaveTarget(null);
  vi.useRealTimers();
});

describe('persist', () => {
  it('debounces saves by 2 s and marks the document saved', async () => {
    vi.useFakeTimers();
    const { doc, writes, draw } = setup();
    draw();
    scheduleSave();
    await vi.advanceTimersByTimeAsync(1500);
    draw();
    scheduleSave();
    await vi.advanceTimersByTimeAsync(1500);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(writes).toHaveLength(1);
    expect(parseNotes(writes[0]).pages[0].strokes).toHaveLength(2);
    expect(doc.isDirty()).toBe(false);
  });

  it('flushes at once and skips clean documents', async () => {
    const { writes, draw } = setup();
    await flushSave();
    expect(writes).toHaveLength(0);
    draw();
    await flushSave();
    expect(writes).toHaveLength(1);
    await flushSave();
    expect(writes).toHaveLength(1);
  });

  it('reports a failed flush, shows the error once and retries', async () => {
    vi.useFakeTimers();
    const doc = new NotesDoc(deckFromPdf({ title: 'a', pageSizes: [[960, 540]], sha256: 'abc' }));
    let fail = true;
    const writes: string[] = [];
    const adapter = {
      writeNotes: vi.fn(async (_p: PdfFile, text: string) => {
        if (fail) throw new Error('disk full');
        writes.push(text);
      }),
    } as unknown as PlatformAdapter;
    const onError = vi.fn();
    setSaveTarget({ doc, adapter, pdf, sha256: 'abc' }, { onError });
    doc.addStroke('p1', createStroke({ tool: 'pen', color: '#000', size: 4, points: [[0, 0, 0.5], [10, 10, 0.5]] }));
    expect(await flushSave()).toBe(false);
    expect(saveState()).toBe('error');
    await vi.advanceTimersByTimeAsync(1000); // first retry, fails again
    expect(adapter.writeNotes).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveLength(1);
    expect(saveState()).toBe('saved');
    expect(doc.isDirty()).toBe(false);
  });
});
