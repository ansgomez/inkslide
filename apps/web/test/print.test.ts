import { describe, expect, it } from 'vitest';
import { pageRuleName, pageRules, printDpi, PRINT_DPI, PRINT_PIXEL_BUDGET } from '../src/print';

describe('print page rules', () => {
  it('names a page size in whole points', () => {
    expect(pageRuleName([595.28, 841.89])).toBe('ink-595x842');
  });

  it('writes one @page rule per distinct size, margins zero', () => {
    const css = pageRules([[960, 540], [960, 540], [595, 842]]);
    expect(css.match(/@page ink-960x540 \{ size: 960pt 540pt; margin: 0; \}/g)).toHaveLength(1);
    expect(css).toContain('@page ink-595x842 { size: 595pt 842pt; margin: 0; }');
    expect(css).toContain('@page { margin: 0; }');
  });

  it('prints at PRINT_DPI unless the images would exceed the pixel budget', () => {
    const a4: [number, number] = [595, 842];
    expect(printDpi([a4, a4])).toBe(PRINT_DPI);
    const many = Array.from({ length: 200 }, () => a4);
    const dpi = printDpi(many);
    expect(dpi).toBeLessThan(PRINT_DPI);
    const px = 200 * (595 * dpi / 72) * (842 * dpi / 72);
    expect(px).toBeCloseTo(PRINT_PIXEL_BUDGET, -3);
  });
});
