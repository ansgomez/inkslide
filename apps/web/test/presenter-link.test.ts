import { describe, expect, it, vi } from 'vitest';
import {
  audienceUrl, channelName, createAudienceLink, createPresenterLink, idFromHash, isLinkId, newLinkId, parseLinkMessage,
  type LinkPort,
} from '../src/presenter-link';

/** A stand-in BroadcastChannel: messages reach every other port when run() delivers them (in order). */
function bus() {
  const ports: { fn: ((d: unknown) => void) | null }[] = [];
  let queue: { from: object; data: unknown }[] = [];
  return {
    port(): LinkPort {
      const me = { fn: null as ((d: unknown) => void) | null };
      ports.push(me);
      return {
        post: m => { queue.push({ from: me, data: structuredClone(m) }); },
        listen: fn => { me.fn = fn; },
      };
    },
    /** Deliver until no message is left. */
    run() {
      while (queue.length) {
        const run = queue;
        queue = [];
        for (const { from, data } of run) for (const p of ports) if (p !== from && p.fn) p.fn(data);
      }
    },
    /** Post raw data as another window would. */
    inject(data: unknown) { queue.push({ from: {}, data }); },
  };
}

const audienceHandlers = () => ({ message: vi.fn(), connected: vi.fn(), gone: vi.fn(), quit: vi.fn() });

describe('parseLinkMessage', () => {
  it('keeps the known fields of each kind', () => {
    expect(parseLinkMessage({ kind: 'ready', from: 'a1', x: 1 })).toEqual({ kind: 'ready', from: 'a1' });
    expect(parseLinkMessage({ kind: 'hello', from: 'a1', to: null })).toEqual({ kind: 'hello', from: 'a1', to: null });
    expect(parseLinkMessage({ kind: 'hello', from: 'a1', to: 'b-2' })).toEqual({ kind: 'hello', from: 'a1', to: 'b-2' });
    for (const kind of ['bye', 'gone', 'quit']) expect(parseLinkMessage({ kind, from: 'a' })).toEqual({ kind, from: 'a' });
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
    const presenter = createPresenterLink(b.port(), setActive, () => {}, 'p1');
    b.run(); // the presenter's ready: nobody listens yet
    const on = audienceHandlers();
    const audience = createAudienceLink(b.port(), on, 'a1');
    b.run();
    expect(setActive.mock.calls).toEqual([[true]]);
    expect(on.connected).toHaveBeenCalled();
    expect(presenter.connected).toBe(true);
    presenter.send({ type: 'page', page: 'p2' });
    b.run();
    expect(on.message).toHaveBeenCalledWith({ type: 'page', page: 'p2' });
    // The audience reloads: bye, then everything again.
    audience.leave();
    b.run();
    expect(setActive.mock.calls).toEqual([[true], [false]]);
    presenter.send({ type: 'page', page: 'p3' }); // nobody listens: not even posted
    createAudienceLink(b.port(), audienceHandlers(), 'a2');
    b.run();
    expect(setActive.mock.calls).toEqual([[true], [false], [true]]);
    expect(on.message).toHaveBeenCalledTimes(1);
  });

  it('a reloaded presenter tab is followed again; until then the audience waits', () => {
    const b = bus();
    const first = vi.fn();
    const p = createPresenterLink(b.port(), first, () => {}, 'p1');
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, 'a1');
    b.run();
    p.leave();
    b.run();
    expect(on.gone).toHaveBeenCalledTimes(1);
    const again = vi.fn();
    createPresenterLink(b.port(), again, () => {}, 'p1-reloaded'); // the same tab reloaded (a new link id): it announces itself
    b.run();
    expect(again.mock.calls).toEqual([[true]]);
  });

  it('the audience follows one tab: the last one to announce itself', () => {
    const b = bus();
    const one = vi.fn(), two = vi.fn();
    const p1 = createPresenterLink(b.port(), one, () => {}, 'p1');
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, 'a1');
    b.run();
    expect(one.mock.calls).toEqual([[true]]);
    const p2 = createPresenterLink(b.port(), two, () => {}, 'p2');
    b.run();
    expect(two.mock.calls).toEqual([[true]]);
    expect(one.mock.calls).toEqual([[true], [false]]); // it heard the hello to p2
    p1.send('from p1');
    p2.send('from p2');
    b.run();
    expect(on.message.mock.calls).toEqual([['from p2']]);
    // The tab not followed cannot end it or make it wait.
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
    const p = createPresenterLink(b.port(), setActive, changed, 'p1');
    createAudienceLink(b.port(), audienceHandlers(), 'a1');
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
    createPresenterLink(b.port(), setActive, () => {}, 'p1');
    const on = audienceHandlers();
    createAudienceLink(b.port(), on, 'a1');
    b.run();
    b.inject({ kind: 'm', from: '../p1', m: 1 });
    b.inject({ type: 'open' });
    b.inject({ kind: 'bye', from: 'a 1' });
    b.run();
    expect(on.message).not.toHaveBeenCalled();
    expect(setActive.mock.calls).toEqual([[true]]);
  });
});
