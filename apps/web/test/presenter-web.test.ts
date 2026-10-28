import { describe, expect, it, vi } from 'vitest';
import { audienceUrl, channelName, createAudienceLink, PROBE_MS, type LinkPort } from '../src/presenter-link';
import {
  createWebPresenter, holdLock, holdsLock, ID_KEY, lockName, POLL_MS, RETAKE_MS, RETAKE_TRIES, type LocksLike, type WebPresenterEnv,
} from '../src/presenter-web';
import { bus, fakeLocks, manualTimers } from './link-bus';

/** One stand-in bus per channel name, shared by every window of a test. */
function channels() {
  const buses = new Map<string, ReturnType<typeof bus>>();
  const of = (name: string) => {
    if (!buses.has(name)) buses.set(name, bus());
    return buses.get(name)!;
  };
  return { of, port: (name: string): LinkPort => of(name).port(), run: () => buses.forEach(b => b.run()) };
}

/** Let promises (lock requests and queries) settle. */
const settled = () => new Promise(r => setTimeout(r, 0));

let tabs = 0;

/**
 * A presenter tab: its env with a stand-in window.open, sessionStorage, locks
 * (null: a browser without them), page events and timers.
 */
async function tab(net: ReturnType<typeof channels>, locks: ReturnType<typeof fakeLocks> | null,
  storage = new Map<string, string>(), query = true) {
  const clientId = `tab${++tabs}`;
  const clock = manualTimers();
  const popups: { url: string; name: string; closed: boolean; close(): void }[] = [];
  const events = new Map<string, (e: PageTransitionEvent) => void>();
  let interval: { fn: () => void; ms: number } | null = null;
  let blocked = false;
  const env: WebPresenterEnv = {
    open: (url, name) => {
      if (blocked) return null;
      const w = { url, name, closed: false, close() { this.closed = true; } };
      popups.push(w);
      return w as unknown as Window;
    },
    port: net.port,
    storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } },
    locks: locks ? locks.client(clientId, query) : null,
    on: (type, fn) => { events.set(type, fn); },
    setInterval: (fn, ms) => { interval = { fn, ms }; return 1; },
    clearInterval: () => { interval = null; },
    timers: clock.timers,
  };
  const changed = vi.fn(), notify = vi.fn();
  const web = createWebPresenter(changed, notify, env)!;
  /** Settle the locks, deliver messages, end a probe (no other tab answered in time). */
  const settle = async () => {
    for (let i = 0; i <= RETAKE_TRIES; i++) {
      await settled();
      clock.fireMs(RETAKE_MS);
    }
    await settled();
    net.run();
    clock.fireMs(PROBE_MS);
    net.run();
  };
  await settle();
  return {
    ...web, popups, changed, notify, storage, settle, clientId,
    id: () => storage.get(ID_KEY)!,
    block: () => { blocked = true; },
    poll: () => interval,
    page: (type: 'pagehide' | 'pageshow', persisted = false) => events.get(type)!({ persisted } as PageTransitionEvent),
  };
}

const handlers = () => ({ message: vi.fn(), connected: vi.fn(), gone: vi.fn(), quit: vi.fn() });

describe('holdLock and holdsLock', () => {
  it('take a free lock for good, see it is taken, and tell whose it is', async () => {
    const locks = fakeLocks();
    const a = locks.client('a'), b = locks.client('b');
    expect(await holdLock(a, 'self-a')).toBe('held');
    expect(await holdLock(a, 'x')).toBe('held');
    expect(await holdLock(b, 'x')).toBe('taken');
    expect(await holdsLock(a, 'x', 'self-a')).toBe(true);
    expect(await holdsLock(b, 'x', 'self-b')).toBeNull(); // b has no self lock: cannot tell
    await holdLock(b, 'self-b');
    expect(await holdsLock(b, 'x', 'self-b')).toBe(false);
    const broken: LocksLike = { request: () => Promise.reject(new Error('SecurityError')) };
    expect(await holdLock(broken, 'x')).toBe('error');
  });
});

for (const withLocks of [true, false]) {
  describe(`createWebPresenter (${withLocks ? 'Web Locks' : 'no Web Locks: the probe'})`, () => {
    const locksFor = () => (withLocks ? fakeLocks() : null);

    it('opens the audience pop-up for its tab id, and closes it on the second toggle', async () => {
      const net = channels();
      const t = await tab(net, locksFor());
      expect(t.mode.on).toBe(false);
      t.mode.toggle();
      expect(t.popups).toEqual([expect.objectContaining({ url: audienceUrl(t.id()), name: `inkslide-audience-${t.id()}` })]);
      expect(t.mode.on).toBe(true);
      // The audience page loads: it is sent everything.
      const on = handlers();
      createAudienceLink(net.port(channelName(t.id())), on);
      net.run();
      expect(on.message.mock.calls.map(([m]) => (m as { type: string }).type)).toEqual(['close']); // no PDF open here
      t.mode.toggle();
      net.run();
      expect(t.popups[0].closed).toBe(true);
      expect(on.quit).toHaveBeenCalled();
      expect(t.mode.on).toBe(false);
      expect(t.poll()).toBeNull();
    });

    it('says so when the pop-up is blocked', async () => {
      const t = await tab(channels(), locksFor());
      t.block();
      t.mode.toggle();
      expect(t.notify).toHaveBeenCalledWith(expect.stringContaining('blocked the audience window'));
      expect(t.mode.on).toBe(false);
    });

    it('notices the pop-up closed (checked every POLL_MS)', async () => {
      const net = channels();
      const t = await tab(net, locksFor());
      t.mode.toggle();
      createAudienceLink(net.port(channelName(t.id())), handlers());
      net.run();
      expect(t.presenter.active).toBe(true);
      expect(t.poll()!.ms).toBe(POLL_MS);
      t.poll()!.fn();
      expect(t.presenter.active).toBe(true);
      t.popups[0].closed = true;
      t.poll()!.fn();
      expect(t.presenter.active).toBe(false);
      expect(t.mode.on).toBe(false);
      expect(t.poll()).toBeNull();
    });

    it('after a reload of the tab, finds its audience again; F5 then closes it instead of opening another', async () => {
      const net = channels();
      const locks = locksFor();
      const storage = new Map<string, string>();
      const before = await tab(net, locks, storage);
      before.mode.toggle();
      const on = handlers();
      createAudienceLink(net.port(channelName(before.id())), on);
      net.run();
      before.page('pagehide');
      locks?.release(before.clientId); // the page is gone, and its locks with it
      net.run();
      expect(on.gone).toHaveBeenCalled();
      const after = await tab(net, locks, storage); // the same tab, reloaded: same sessionStorage
      expect(after.id()).toBe(before.id());
      expect(after.presenter.active).toBe(true);
      expect(after.mode.on).toBe(true);
      after.mode.toggle();
      net.run();
      expect(after.popups).toEqual([]);
      expect(on.quit).toHaveBeenCalled();
    });

    it('a duplicated tab moves to a new id: its own channel and pop-up name', async () => {
      const net = channels();
      const locks = locksFor();
      const storage = new Map<string, string>();
      const original = await tab(net, locks, storage);
      original.mode.toggle();
      const on = handlers();
      createAudienceLink(net.port(channelName(original.id())), on);
      net.run();
      const copy = await tab(net, locks, new Map(storage)); // a duplicate copies sessionStorage
      expect(copy.id()).not.toBe(original.id());
      expect(original.presenter.active).toBe(true);
      expect(copy.mode.on).toBe(false);
      copy.mode.toggle();
      expect(copy.popups[0].name).toBe(`inkslide-audience-${copy.id()}`);
      expect(on.connected).toHaveBeenCalledTimes(1); // the original's audience never heard of the copy
    });

    it('into the back/forward cache: the audience waits (gone); back: ready again', async () => {
      const net = channels();
      const t = await tab(net, locksFor());
      const on = handlers();
      createAudienceLink(net.port(channelName(t.id())), on);
      net.run();
      expect(on.connected).toHaveBeenCalledTimes(1);
      t.page('pagehide', true);
      net.run();
      expect(on.gone).toHaveBeenCalledTimes(1);
      t.page('pageshow', true);
      await t.settle();
      expect(on.connected).toHaveBeenCalledTimes(2);
    });
  });
}

describe('createWebPresenter: Web Locks', () => {
  it('a duplicate is told apart by the lock even when its original is too busy to answer', async () => {
    const net = channels();
    const locks = fakeLocks();
    const storage = new Map<string, string>();
    const original = await tab(net, locks, storage);
    // No message reaches the original (busy, hung): only the lock speaks for it.
    const busy = channels();
    const copy = await tab(busy, locks, new Map(storage));
    expect(copy.id()).not.toBe(original.id());
    expect(locks.held.get(lockName(original.id()))).toBe(original.clientId);
    expect(locks.held.get(lockName(copy.id()))).toBe(copy.clientId);
  });

  it('back from the cache with its locks let go: takes them again if free, else moves to a new id', async () => {
    const net = channels();
    const locks = fakeLocks();
    const storage = new Map<string, string>();
    const t = await tab(net, locks, storage);
    const first = t.id();
    // Cached; the browser lets its locks go; nobody else wants the id: taken again.
    t.page('pagehide', true);
    locks.release(t.clientId);
    t.page('pageshow', true);
    await t.settle();
    expect(locks.held.get(lockName(first))).toBe(t.clientId);
    // Cached again; meanwhile a duplicate took the id with its lock.
    t.mode.toggle();
    expect(t.mode.on).toBe(true);
    t.page('pagehide', true);
    locks.release(t.clientId);
    const copy = await tab(net, locks, new Map(storage));
    expect(copy.id()).toBe(first);
    t.page('pageshow', true);
    await t.settle();
    await t.settle();
    expect(t.id()).not.toBe(first);
    expect(t.mode.on).toBe(false); // its old pop-up is the duplicate's now
    expect(locks.held.get(lockName(t.id()))).toBe(t.clientId);
  });

  it('a reload whose page before still holds the lock for a moment keeps its id', async () => {
    const net = channels();
    const locks = fakeLocks();
    const storage = new Map<string, string>();
    const before = await tab(net, locks, storage);
    const id = before.id();
    before.page('pagehide');
    const pending = tab(net, locks, storage); // loads while the page before has not let go yet
    await settled();
    locks.release(before.clientId);
    const after = await pending;
    expect(after.id()).toBe(id);
    expect(locks.held.get(lockName(id))).toBe(after.clientId);
  });

  it('back from the cache where its locks cannot be queried: moves to a new id rather than guess', async () => {
    const net = channels();
    const locks = fakeLocks();
    const t = await tab(net, locks, new Map(), false);
    const id = t.id();
    const on = handlers();
    createAudienceLink(net.port(channelName(id)), on);
    net.run();
    t.page('pagehide', true);
    t.page('pageshow', true);
    await t.settle();
    await t.settle();
    expect(t.id()).not.toBe(id);
    expect(locks.held.get(lockName(t.id()))).toBe(t.clientId);
    expect(on.connected).toHaveBeenCalledTimes(1); // no ready on the old id
  });

  it('back from the cache still holding its lock: just ready again', async () => {
    const net = channels();
    const locks = fakeLocks();
    const t = await tab(net, locks);
    const id = t.id();
    t.page('pagehide', true);
    t.page('pageshow', true);
    await t.settle();
    expect(t.id()).toBe(id);
  });
});
