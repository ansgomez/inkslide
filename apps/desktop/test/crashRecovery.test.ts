import { describe, expect, it } from 'vitest';
import { CRASH_REPEAT_MS, CrashRecovery } from '../src/main/crashRecovery';

describe('CrashRecovery', () => {
  it('does nothing for a normal exit', () => {
    expect(new CrashRecovery().next('clean-exit', 0)).toBe('none');
  });
  it('reloads after a crash, asks when the reloaded page dies again soon', () => {
    const c = new CrashRecovery();
    expect(c.next('crashed', 1000)).toBe('reload');
    expect(c.next('crashed', 1000 + CRASH_REPEAT_MS - 1)).toBe('ask');
    expect(c.next('oom', 1000 + CRASH_REPEAT_MS - 1)).toBe('ask'); // asking does not count as a reload
  });
  it('reloads again once the last reload is long enough ago', () => {
    const c = new CrashRecovery();
    expect(c.next('killed', 0)).toBe('reload');
    expect(c.next('crashed', CRASH_REPEAT_MS)).toBe('reload');
    expect(c.next('crashed', CRASH_REPEAT_MS + 10)).toBe('ask');
  });
});
