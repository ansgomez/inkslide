import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDroppedPdf, checkPath, checkPdfBytes, checkText, PathGrants } from '../src/main/access';

describe('PathGrants', () => {
  it('allows granted and extra paths only, normalized', () => {
    const g = new PathGrants(p => p === resolve('/recent.pdf'));
    g.grant('/docs/../docs/a.pdf');
    expect(g.allows('/docs/a.pdf')).toBe(true);
    expect(g.allows('/recent.pdf')).toBe(true);
    expect(g.allows('/etc/passwd')).toBe(false);
  });
  it('checkPath rejects non-strings and NUL bytes', () => {
    expect(checkPath('/a.pdf')).toBe('/a.pdf');
    for (const bad of [undefined, null, 42, '', 'a\0b', {}, 'x'.repeat(5000)]) expect(() => checkPath(bad)).toThrow();
  });
  it('checkDroppedPdf takes .pdf paths only', () => {
    expect(checkDroppedPdf('/home/u/Slides.PDF')).toBe('/home/u/Slides.PDF');
    for (const bad of ['/home/u/.ssh/id_ed25519', '/home/u/a.pdf.notes.json', '/etc/passwd', 42]) {
      expect(() => checkDroppedPdf(bad)).toThrow();
    }
  });
  it('checkText limits notes by their UTF-8 bytes, not their length', () => {
    expect(checkText('aé€', 6)).toBe('aé€'); // 1 + 2 + 3 bytes
    expect(() => checkText('aé€x', 6)).toThrow('too large');
    expect(() => checkText('€€€', 8)).toThrow('too large'); // 3 code units, 9 bytes
    expect(() => checkText('x'.repeat(9), 8)).toThrow('too large');
    for (const bad of [undefined, null, 42, {}]) expect(() => checkText(bad)).toThrow('must be a string');
  });
  it('checkPdfBytes takes a Uint8Array up to the limit', () => {
    const b = new Uint8Array(8);
    expect(checkPdfBytes(b, 'print', 8)).toBe(b);
    expect(() => checkPdfBytes(new Uint8Array(9), 'print', 8)).toThrow('print: the PDF is too large');
    for (const bad of [undefined, 'x', [1, 2], new ArrayBuffer(4)]) expect(() => checkPdfBytes(bad, 'export')).toThrow('Uint8Array');
  });
});
