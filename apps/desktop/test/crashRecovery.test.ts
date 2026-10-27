import { describe, expect, it } from 'vitest';
import { CRASH_REPEAT_MS, CrashRecovery } from '../src/main/crashRecovery';

describe('CrashRecovery', () => {
  it('does nothing for a normal exit', () => {
    expect(new CrashRecovery().next('clean-exit', 0)).toBe('none');
  });
  it('reloads after the first crash, asks when the reloaded page dies again within 5 minutes', () => {
    const c = new CrashRecovery();
    expect(CRASH_REPEAT_MS).toBe(5 * 60_000);
    expect(c.next('crashed', 1000)).toBe('reload');
    c.saved();
    expect(c.next('crashed', 1000 + CRASH_REPEAT_MS - 1)).toBe('ask');
    expect(c.next('oom', 1000 + CRASH_REPEAT_MS - 1)).toBe('ask'); // asking does not count as a reload
  });
  it('asks when the reloaded page dies before it saved, however late', () => {
    const c = new CrashRecovery();
    expect(c.next('killed', 0)).toBe('reload');
    expect(c.next('crashed', 10 * CRASH_REPEAT_MS)).toBe('ask');
  });
  it('reloads again only after a save and once the last reload is long enough ago', () => {
    const c = new CrashRecovery();
    expect(c.next('killed', 0)).toBe('reload');
    c.saved();
    expect(c.next('crashed', CRASH_REPEAT_MS)).toBe('reload');
    c.saved();
    expect(c.next('crashed', CRASH_REPEAT_MS + 10)).toBe('ask');
  });
  it('counts a reload the user chose', () => {
    const c = new CrashRecovery();
    expect(c.next('crashed', 0)).toBe('reload');
    expect(c.next('crashed', 1000)).toBe('ask');
    c.reloaded(2000); // the user chose Reload
    c.saved();
    expect(c.next('crashed', 2000 + CRASH_REPEAT_MS - 1)).toBe('ask');
    expect(c.next('crashed', 2000 + CRASH_REPEAT_MS)).toBe('reload');
  });
});
