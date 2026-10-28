import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloseHandshake, REPLY_TIMEOUT_MS } from '../src/main/closeHandshake';

/** A handshake whose actions are logged; `answers` are the user's replies to confirm(). */
function setup(answers: boolean[] = [], busy = () => false) {
  const log: string[] = [];
  const h = new CloseHandshake({
    request: () => log.push('request'),
    close: () => {
      log.push('close');
      if (!h.closing(true)) log.push('close cancelled'); // the window emits 'close' again
    },
    confirm: async reason => {
      log.push(`confirm ${reason}`);
      return answers.shift() ?? false;
    },
    keptOpen: () => log.push('kept open'),
    busy,
  });
  return { h, log };
}

describe('CloseHandshake', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks the page once, and closes when it replies ok', () => {
    const { h, log } = setup();
    expect(h.closing(true)).toBe(false);
    expect(h.asking).toBe(true);
    h.reply(true);
    expect(log).toEqual(['request', 'close']);
    expect(h.closing(true)).toBe(true);
  });

  it('a second close while the page saves is cancelled too (no close before the reply)', () => {
    const { h, log } = setup();
    expect(h.closing(true)).toBe(false);
    expect(h.closing(true)).toBe(false); // double click, Cmd+Q again
    expect(h.closing(true)).toBe(false);
    expect(log).toEqual(['request']);
    h.reply(false); // the page kept it open (its notes could not be saved, the user said keep)
    expect(log).toEqual(['request', 'kept open']);
    expect(h.closing(true)).toBe(false); // a later close asks again
    expect(log).toEqual(['request', 'kept open', 'request']);
  });

  it('closes at once when the page is not loaded (nothing to save, or it died while asked)', () => {
    const { h, log } = setup();
    expect(h.closing(false)).toBe(true);
    expect(h.closing(true)).toBe(false);
    expect(h.closing(false)).toBe(true); // render process gone: main closes it
    expect(log).toEqual(['request']);
  });

  it('a page that does not reply: the user is asked after the timeout, and again after each wait', async () => {
    const { h, log } = setup([false, true]);
    h.closing(true);
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS - 1);
    expect(log).toEqual(['request']);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['request', 'confirm timeout']); // Wait
    expect(h.closing(true)).toBe(false);
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS);
    expect(log).toEqual(['request', 'confirm timeout', 'confirm timeout', 'close']); // Close Anyway
    h.reply(true); // a late reply changes nothing
    expect(log).toEqual(['request', 'confirm timeout', 'confirm timeout', 'close']);
  });

  it('a reply in time stops the timer; one during the question wins', async () => {
    const { h, log } = setup();
    h.closing(true);
    h.reply(true);
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS * 2);
    expect(log).toEqual(['request', 'close']);

    let answer!: (close: boolean) => void;
    const log2: string[] = [];
    const h2 = new CloseHandshake({
      request: () => log2.push('request'), close: () => log2.push('close'), keptOpen: () => log2.push('kept open'),
      confirm: () => new Promise(r => { log2.push('confirm'); answer = r; }),
    });
    h2.closing(true);
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS);
    h2.reply(true); // saved after all, while the user is asked
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log2).toEqual(['request', 'confirm', 'close']);
  });

  it('waits while the page shows its own dialog', async () => {
    let pageDialog = true;
    const { h, log } = setup([true], () => pageDialog);
    h.closing(true);
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS * 3);
    expect(log).toEqual(['request']);
    pageDialog = false;
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS);
    expect(log).toEqual(['request', 'confirm timeout', 'close']);
  });

  it('reset (new window, window gone) forgets the close and stops the timer', async () => {
    const { h, log } = setup([true]);
    h.closing(true);
    h.reset();
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS * 2);
    expect(log).toEqual(['request']);
    expect(h.asking).toBe(false);
  });

  it('a failed close handler asks the user instead of closing (correctness: no silent loss)', async () => {
    const { h, log } = setup([false, true]);
    h.closing(true);
    h.reply('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['request', 'confirm failed', 'kept open']); // Keep Open
    expect(h.asking).toBe(false);
    h.closing(true);
    h.reply('failed');
    expect(h.closing(true)).toBe(false); // while the user is asked
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['request', 'confirm failed', 'kept open', 'request', 'confirm failed', 'close']); // Close Anyway
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS * 2);
    expect(log.filter(l => l === 'confirm timeout')).toEqual([]); // no timeout question after a reply
  });
});
