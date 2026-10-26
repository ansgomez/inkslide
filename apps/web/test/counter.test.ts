import { describe, expect, it } from 'vitest';
import { NotesDoc } from '@inkslide/annotate';
import { deckFromPdf } from '@inkslide/annotate/io';
import { pageCounter, pdfPageNumber, sourceStep } from '../src/counter';

const T = '\u2009'; // formatLabel uses thin spaces around the slash
const pdfDoc = (pages: number): NotesDoc =>
  new NotesDoc(deckFromPdf({ title: 't', pageSizes: Array.from({ length: pages }, () => [960, 540] as [number, number]) }));

describe('pageCounter', () => {
  it('shows page / total, blank pages as in pages.js', () => {
    const doc = pdfDoc(37);
    expect(pageCounter(doc, 'p3')).toBe(`3${T}/${T}37`);
    const b1 = doc.insertBlankPage('p3').pageId;
    const b2 = doc.insertBlankPage(b1).pageId;
    expect(pageCounter(doc, 'p3')).toBe(`3${T}/${T}37 · +2 blank`);
    expect(pageCounter(doc, b1)).toBe(`3${T}/${T}37 · blank 1/2`);
    expect(pageCounter(doc, b2)).toBe(`3${T}/${T}37 · blank 2/2`);
  });

  it('has a placeholder without a document', () => {
    expect(pageCounter(null, null)).toBe('–\u2009/\u2009–');
  });
});

describe('page helpers', () => {
  it('parses PDF page ids', () => {
    expect(pdfPageNumber('p12')).toBe(12);
    expect(pdfPageNumber('b-x-1')).toBeNull();
    expect(pdfPageNumber('s3')).toBeNull();
  });

  it('steps PDF pages, skipping blank pages (Alt+PgUp/PgDn)', () => {
    const doc = pdfDoc(3);
    const b = doc.insertBlankPage('p2').pageId;
    expect(sourceStep(doc, 'p2', 1)).toBe('p3');
    expect(sourceStep(doc, b, 1)).toBe('p3');
    expect(sourceStep(doc, b, -1)).toBe('p2');
    expect(sourceStep(doc, 'p2', -1)).toBe('p1');
    expect(sourceStep(doc, 'p1', -1)).toBeNull();
    expect(sourceStep(doc, 'p3', 1)).toBeNull();
  });
});
