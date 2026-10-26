import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDroppedPdf, checkPath, PathGrants } from '../src/main/access';

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
});
