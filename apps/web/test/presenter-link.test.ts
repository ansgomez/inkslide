import { describe, expect, it, vi } from 'vitest';
import {
  audienceUrl, BEAT_MS, channelName, createAudienceLink, createPresenterLink, GRACE_MS, idFromHash, isLinkId, newLinkId,
  parseLinkMessage, PROBE_MS, SILENCE_MS,
} from '../src/presenter-link';
import { bus, manualTimers } from './link-bus';

const audienceHandlers = () => ({ message: vi.fn(), connected: vi.fn(), gone: vi.fn(), quit: vi.fn() });

describe('parseLinkMessage', () => {
  it('keeps the known fields of each kind', () => {
    expect(parseLinkMessage({ kind: 'ready', from: 'a1', x: 1 })).toEqual({ kind: 'ready', from: 'a1' });
    expect(parseLinkMessage({ kind: 'hello', from: 'a1', to: null })).toEqual({ kind: 'hello', from: 'a1', to: null });
    expect(parseLinkMessage({ kind: 'hello', from: 'a1', to: 'b-2' })).toEqual({ kind: 'hello', from: 'a1', to: 'b-2' });
    expect(parseLinkMessage({ kind: 'taken', from: 'a', to: 'b' })).toEqual({ kind: 'taken', from: 'a', to: 'b' });
    expect(parseLinkMessage({ kind: 'taken', from: 'a' })).toBeNull();
    expect(parseLinkMessage({ kind: 'ping', from: 'a', to: 'b' })).toEqual({ kind: 'ping', from: 'a', to: 'b' });
    expect(parseLinkMessage({ kind: 'ping', from: 'a', to: null })).toBeNull();
    for (const kind of ['probe', 'bye', 'gone', 'quit', 'beat']) expect(parseLinkMessage({ kind, from: 'a' })).toEqual({ kind, from: 'a' });
    expect(parseLinkMessage({ kind: 'm', from: 'a', m: { type: 'page' } })).toEqual({ kind: 'm', from: 'a', m: { type: 'page' } });
  });

  it('refuses anything else', () => {
    const bad = [null, 'ready', [], { kind: 'ready' }, { kind: 'ready', from: '' }, { kind: 'ready', from: 'a b' },
      { kind: 'ready', from: 'x'.repeat(65) }, { kind: 'hello', from: 'a' }, { kind: 'hello', from: 'a', to: '<' },
      { kind: 'eval', from: 'a' }];
    for (const v of bad) expect(parseLinkMessage(v), JSON.stringify(v)).toBeNull();
  });
});

describe('ids and URLs', () => {
  it('makes ids the link accepts and reads them back from the hash', () => {
    const id = newLinkId();
    expect(isLinkId(id)).toBe(true);
    expect(newLinkId()).not.toBe(id);
    expect(audienceUrl(id)).toBe(`audience.html#${id}`);
    expect(idFromHash(`#${id}`)).toBe(id);
    expect(idFromHash('')).toBeNull();
    expect(idFromHash('#a/b')).toBeNull();
    expect(channelName(id)).toContain(id);
  });
});

describe('presenter and audience links', () => {
  it('an audience that opens gets everything; one that closes stops the sending', () => {
    const b = bus();
    const setActive = vi.fn();
    const presenter = createPresenterLink(b.port(), setActive, () => {}, { id: 'p1' });
    b.run(); // the presenter's ready: nobody listens yet
    const on = audienceHandlers();
    const audiencePort = b.port();
    const audience = createAudienceLink(audiencePort, on, { id: 'a1' });
    b.run();
    expect(setActive.mock.calls).toEqual([[true]]);
    expect(on.connected).toHaveBeenCalled();
    expect(presenter.connected).toBe(true);
    presenter.send({ type: 'page', page: 'p2' });
    b.run();
    expect(on.message).toHaveBeenCalledWith({ type: 'page', page: 'p2' });
    // The audience reloads: bye, then everything again.
    audience.leave();
    audiencePort.close!(); // the page is gone
    b.run();
    expect(setActive.mock.calls).toEqual([[true], [false]]);
    presenter.send({ type: 'page', page: 'p3' }); // nobody listens: not even posted
    createAudienceLink(b.port(), audienceHandlers(), { id: 'a2' });
    b.run();
    expect(setActive.mock.calls).toEqual([[true], [false], [true]]);
    expect(on.message).toHaveBeenCalledTimes(1);
  });

  it('a reloaded presenter tab is followed again; if it does not come back the audience closes', () => {
    const b = bus();
    const clock = manualTimers();
    const p = createPresenterLink(b.port(), vi.fn(), () => {}, { id: 'p1' });
    b.run();
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, { id: 'a1', timers: clock.timers });
    b.run();
    p.leave();
    b.run();
    expect(on.gone).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toContain(GRACE_MS);
    const again = vi.fn();
    createPresenterLink(b.port(), again, () => {}, { id: 'p1-reloaded' }); // the same tab reloaded: a new link id
    b.run();
    expect(again.mock.calls).toEqual([[true]]);
    expect(clock.pending()).not.toContain(GRACE_MS); // back in time: the window stays
    // Gone again, and not back: the window closes itself.
    b.inject({ kind: 'gone', from: 'p1-reloaded' });
    b.run();
    clock.fireMs(GRACE_MS);
    expect(on.quit).toHaveBeenCalledTimes(1);
  });

  it('a presenter that reloads without saying gone is followed again (its new ready is answered)', () => {
    const b = bus();
    createPresenterLink(b.port(), vi.fn(), () => {}, { id: 'p1' });
    b.run();
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, { id: 'a1' });
    b.run();
    const crashed = vi.fn();
    const p = createPresenterLink(b.port(), crashed, () => {}, { id: 'p2' }); // no gone from p1 (crash, tab discarded)
    b.run();
    expect(crashed.mock.calls).toEqual([[true]]);
    expect(p.connected).toBe(true);
    // Its ready again (back from the back/forward cache): answered again, everything again.
    p.announce();
    b.run();
    expect(crashed.mock.calls).toEqual([[true], [true]]);
    expect(on.connected).toHaveBeenCalledTimes(3);
  });

  it('a duplicated tab (same tab id) moves to another id and leaves the original its audience', () => {
    const b = bus();
    const clock = manualTimers();
    const original = vi.fn();
    const p1 = createPresenterLink(b.port(), original, () => {}, { id: 'p1', taken: vi.fn(), timers: clock.timers });
    b.run();
    clock.fireMs(PROBE_MS); // nobody answered its probe: it is ready
    b.run();
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, { id: 'a1' });
    b.run();
    expect(original.mock.calls).toEqual([[true]]);
    // The duplicate probes: the original answers; it moves away before saying ready.
    const taken = vi.fn(), copy = vi.fn();
    const p2 = createPresenterLink(b.port(), copy, () => {}, { id: 'p2', taken, timers: clock.timers });
    b.run();
    expect(taken).toHaveBeenCalledTimes(1);
    clock.fireMs(PROBE_MS);
    b.run();
    p2.send('from the copy');
    p1.send('from the original');
    b.run();
    expect(copy).not.toHaveBeenCalled();
    expect(original.mock.calls).toEqual([[true]]);
    expect(on.message.mock.calls).toEqual([['from the original']]);
    expect(on.connected).toHaveBeenCalledTimes(1);
  });

  it('the audience follows one presenter: the last one to announce itself', () => {
    const b = bus();
    const one = vi.fn(), two = vi.fn();
    const p1 = createPresenterLink(b.port(), one, () => {}, { id: 'p1' });
    b.run();
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, { id: 'a1' });
    b.run();
    expect(one.mock.calls).toEqual([[true]]);
    const p2 = createPresenterLink(b.port(), two, () => {}, { id: 'p2' });
    b.run();
    expect(two.mock.calls).toEqual([[true]]);
    expect(one.mock.calls).toEqual([[true], [false]]); // it heard the hello to p2
    p1.send('from p1');
    p2.send('from p2');
    b.run();
    expect(on.message.mock.calls).toEqual([['from p2']]);
    // The presenter not followed cannot end it or make it wait.
    b.inject({ kind: 'quit', from: 'p1' });
    b.inject({ kind: 'gone', from: 'p1' });
    b.run();
    expect(on.quit).not.toHaveBeenCalled();
    expect(on.gone).not.toHaveBeenCalled();
    p2.quit();
    b.run();
    expect(on.quit).toHaveBeenCalledTimes(1);
  });

  it('drop() stops the sending when the pop-up is seen closed', () => {
    const b = bus();
    const setActive = vi.fn(), changed = vi.fn();
    const p = createPresenterLink(b.port(), setActive, changed, { id: 'p1' });
    b.run();
    createAudienceLink(b.port(), audienceHandlers(), { id: 'a1' });
    b.run();
    p.drop();
    p.drop();
    expect(setActive.mock.calls).toEqual([[true], [false]]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(p.connected).toBe(false);
  });

  it('ignores what is not a link message', () => {
    const b = bus();
    const setActive = vi.fn();
    createPresenterLink(b.port(), setActive, () => {}, { id: 'p1' });
    b.run();
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, { id: 'a1' });
    b.run();
    b.inject({ kind: 'm', from: '../p1', m: 1 });
    b.inject({ type: 'open' });
    b.inject({ kind: 'bye', from: 'a 1' });
    b.inject({ kind: 'taken', from: 'x', to: 'p1' }); // not probing: ignored
    b.run();
    expect(on.message).not.toHaveBeenCalled();
    expect(setActive.mock.calls).toEqual([[true]]);
  });

  it('waits PROBE_MS before ready', () => {
    const b = bus();
    const clock = manualTimers();
    createPresenterLink(b.port(), vi.fn(), () => {}, { id: 'p1', taken: vi.fn(), timers: clock.timers });
    expect(clock.pending()).toEqual([PROBE_MS]);
  });

  it('a busy presenter (silent for a while) is not given up; a dead one (30 s) is, then the window closes', () => {
    const b = bus();
    const clock = manualTimers();
    const on = audienceHandlers();
    const seen: unknown[] = [];
    b.port().listen(d => seen.push(d)); // what the audience posts
    createAudienceLink(b.port(), on, { id: 'a1', timers: clock.timers });
    b.inject({ kind: 'ready', from: 'p1' }); // a presenter that answers nothing after this
    b.run();
    const beats = (n: number) => {
      for (let i = 0; i < n; i++) {
        clock.fireMs(BEAT_MS);
        b.run();
      }
    };
    // Busy for 10 s (an export): pinged, then it answers; nothing ends.
    beats(10_000 / BEAT_MS);
    expect(seen.filter(m => (m as { kind: string }).kind === 'ping')).toHaveLength(10_000 / BEAT_MS);
    b.inject({ kind: 'beat', from: 'p1' });
    b.run();
    clock.fireMs(GRACE_MS);
    expect(on.gone).not.toHaveBeenCalled();
    expect(on.quit).not.toHaveBeenCalled();
    // Silent for SILENCE_MS: counted as gone; still pinged; any word brings it back (hello: everything).
    beats(SILENCE_MS / BEAT_MS);
    expect(on.gone).toHaveBeenCalledTimes(1);
    seen.length = 0;
    b.inject({ kind: 'm', from: 'p1', m: 'late' });
    b.run();
    expect(seen).toContainEqual({ kind: 'hello', from: 'a1', to: 'p1' });
    expect(on.connected).toHaveBeenCalledTimes(2);
    expect(on.message).toHaveBeenCalledWith('late');
    clock.fireMs(GRACE_MS);
    expect(on.quit).not.toHaveBeenCalled();
    // Silent for good: the window closes GRACE_MS after the silence counted.
    beats(SILENCE_MS / BEAT_MS);
    expect(on.gone).toHaveBeenCalledTimes(2);
    clock.fireMs(GRACE_MS);
    expect(on.quit).toHaveBeenCalledTimes(1);
  });

  it('stop() ends the pings (a window that cannot close)', () => {
    const b = bus();
    const clock = manualTimers();
    const seen: unknown[] = [];
    b.port().listen(d => seen.push(d));
    const link = createAudienceLink(b.port(), audienceHandlers(), { id: 'a1', timers: clock.timers });
    b.inject({ kind: 'ready', from: 'p1' });
    b.run();
    link.stop();
    expect(clock.pending()).toEqual([]);
    seen.length = 0;
    clock.fireMs(BEAT_MS);
    b.run();
    expect(seen).toEqual([]);
  });

  it('an audience no presenter ever answers closes after GRACE_MS', () => {
    const b = bus();
    const clock = manualTimers();
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, { id: 'a1', timers: clock.timers });
    b.run();
    expect(clock.pending()).toContain(GRACE_MS);
    clock.fireMs(GRACE_MS);
    expect(on.quit).toHaveBeenCalledTimes(1);
    // One that is answered in time stays.
    const on2 = audienceHandlers();
    createAudienceLink(b.port(), on2, { id: 'a2', timers: clock.timers });
    createPresenterLink(b.port(), vi.fn(), () => {}, { id: 'p1' });
    b.run();
    clock.fireMs(GRACE_MS);
    expect(on2.quit).not.toHaveBeenCalled();
  });
});
