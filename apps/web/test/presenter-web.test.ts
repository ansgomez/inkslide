import { describe, expect, it, vi } from 'vitest';
import { audienceUrl, channelName, createAudienceLink, type LinkPort } from '../src/presenter-link';
import { createWebPresenter, ID_KEY, POLL_MS, type WebPresenterEnv } from '../src/presenter-web';
import { bus, manualTimers } from './link-bus';

/** One stand-in bus per channel name, shared by every window of a test. */
function channels() {
  const buses = new Map<string, ReturnType<typeof bus>>();
  const of = (name: string) => {
    if (!buses.has(name)) buses.set(name, bus());
    return buses.get(name)!;
  };
  return { of, port: (name: string): LinkPort => of(name).port(), run: () => buses.forEach(b => b.run()) };
}

/** A presenter tab: its env with a stand-in window.open, sessionStorage, page events and timers. */
function tab(net: ReturnType<typeof channels>, storage = new Map<string, string>()) {
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
    on: (type, fn) => { events.set(type, fn); },
    setInterval: (fn, ms) => { interval = { fn, ms }; return 1; },
    clearInterval: () => { interval = null; },
    timers: clock.timers,
  };
  const changed = vi.fn(), notify = vi.fn();
  const web = createWebPresenter(changed, notify, env)!;
  /** Deliver messages and end the probe (no other tab answered in time). */
  const settle = () => {
    net.run();
    clock.fire();
    net.run();
  };
  settle();
  return {
    ...web, popups, changed, notify, storage, settle,
    id: () => storage.get(ID_KEY)!,
    block: () => { blocked = true; },
    poll: () => interval,
    page: (type: 'pagehide' | 'pageshow', persisted = false) => events.get(type)!({ persisted } as PageTransitionEvent),
  };
}

const handlers = () => ({ message: vi.fn(), connected: vi.fn(), gone: vi.fn(), quit: vi.fn() });

describe('createWebPresenter', () => {
  it('opens the audience pop-up for its tab id, and closes it on the second toggle', () => {
    const net = channels();
    const t = tab(net);
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

  it('says so when the pop-up is blocked', () => {
    const t = tab(channels());
    t.block();
    t.mode.toggle();
    expect(t.notify).toHaveBeenCalledWith(expect.stringContaining('blocked the audience window'));
    expect(t.mode.on).toBe(false);
  });

  it('notices the pop-up closed (checked every POLL_MS)', () => {
    const net = channels();
    const t = tab(net);
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

  it('after a reload of the tab, finds its audience again; F5 then closes it instead of opening another', () => {
    const net = channels();
    const storage = new Map<string, string>();
    const before = tab(net, storage);
    before.mode.toggle();
    const on = handlers();
    createAudienceLink(net.port(channelName(before.id())), on);
    net.run();
    before.page('pagehide');
    net.run();
    expect(on.gone).toHaveBeenCalled();
    const after = tab(net, storage); // the same tab, reloaded: same sessionStorage
    expect(after.id()).toBe(before.id());
    expect(after.presenter.active).toBe(true);
    expect(after.mode.on).toBe(true);
    after.mode.toggle();
    net.run();
    expect(after.popups).toEqual([]);
    expect(on.quit).toHaveBeenCalled();
  });

  it('a duplicated tab moves to a new id: its own channel and pop-up name', () => {
    const net = channels();
    const storage = new Map<string, string>();
    const original = tab(net, storage);
    original.mode.toggle();
    const on = handlers();
    createAudienceLink(net.port(channelName(original.id())), on);
    net.run();
    const copy = tab(net, new Map(storage)); // a duplicate copies sessionStorage
    expect(copy.id()).not.toBe(original.id());
    expect(original.presenter.active).toBe(true);
    expect(copy.mode.on).toBe(false);
    copy.mode.toggle();
    expect(copy.popups[0].name).toBe(`inkslide-audience-${copy.id()}`);
    expect(on.connected).toHaveBeenCalledTimes(1); // the original's audience never heard of the copy
  });

  it('says ready again when the page comes back from the back/forward cache', () => {
    const net = channels();
    const t = tab(net);
    const on = handlers();
    createAudienceLink(net.port(channelName(t.id())), on);
    net.run();
    expect(on.connected).toHaveBeenCalledTimes(1);
    t.page('pagehide', true); // kept in the cache: no gone
    t.page('pageshow', true);
    net.run();
    expect(on.gone).not.toHaveBeenCalled();
    expect(on.connected).toHaveBeenCalledTimes(2);
  });
});
