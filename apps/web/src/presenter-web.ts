/* Inkslide web - presenter mode in the browser: the presenter tab's side
 *
 * The browser build has no View menu: F5 (with a PDF open) or the toolbar's
 * presenter button opens the audience window, a pop-up with audience.html, and
 * closes it again. The presenter (presenter.ts) sends through the link
 * (presenter-link.ts) instead of the desktop bridge; everything it sends is
 * the same.
 *
 * - The pop-up must be opened by a click or a key (the browser blocks it
 *   otherwise, and may block it anyway): the user is told how to allow it.
 * - The audience window closing (its 'bye', or the pop-up seen closed) stops
 *   the sending; a reload of it asks for everything again.
 * - This tab closing, reloading or going into the back/forward cache tells the
 *   audience to wait (`gone`); the reloaded or restored tab finds it again
 *   (same tab id: sessionStorage). While an audience window listens, F5
 *   closes it, also one this tab opened before a reload (it has no reference
 *   to it any more). The pop-up's name is the tab id's, so opening again
 *   reuses a window of this tab left behind rather than piling up windows.
 *
 * The tab id must be this tab's alone: a tab duplicated by the browser copies
 * sessionStorage, and so the id. The tab holds a Web Lock named after its id
 * for as long as the page lives (the browser releases it when the page closes
 * or crashes); a tab that cannot get the lock takes a new id until it gets
 * one. Only then does it join the channel. Back from the back/forward cache
 * it checks the lock again (the browser may have let it go while the page was
 * cached): still its own, or free and taken again, it says ready; held by
 * another tab, this tab moves to a new id and leaves that tab its window.
 * Where there are no Web Locks, the link's probe finds duplicates instead.
 * Until the id is settled (a few ms after load) F5 does nothing.
 *
 * Not used in the desktop app (its bridge and menu do this) nor on Tauri
 * (phones and tablets have no second window): main.ts decides.
 */
import { createPresenter, type Presenter } from './presenter';
import {
  audienceUrl, broadcastPort, channelName, createPresenterLink, isLinkId, newLinkId, type LinkPort, type LinkTimers, type PresenterLink,
} from './presenter-link';

/** The switch of presenter mode the toolbar and F5 use. */
export interface PresenterSwitch {
  /** The audience window is open. */
  readonly on: boolean;
  /** Open the audience window, or close it. Call from a click or a key (pop-ups need one). */
  toggle(): void;
}

/** Key of the tab's id in sessionStorage (one id per tab; a reload keeps it). */
export const ID_KEY = 'inkslide:presenter-id';
/** How often an open pop-up is checked for having been closed, ms. */
export const POLL_MS = 1000;
/** Ids tried for a lock before giving up on locks (and using the probe). */
const LOCK_TRIES = 8;
/** Waits for the kept id's lock (a reload: the page before lets it go), and how long each, ms. */
export const RETAKE_TRIES = 3;
export const RETAKE_MS = 100;

/** The part of navigator.locks used here (a stand-in in tests). */
export interface LocksLike {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => unknown): Promise<unknown>;
  query?(): Promise<{ held?: { name?: string; clientId?: string }[] }>;
}

/** What the browser gives presenter mode; injectable for tests. */
export interface WebPresenterEnv {
  open(url: string, name: string, features: string): Window | null;
  port(name: string): LinkPort;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** navigator.locks; null where the browser has none. */
  locks: LocksLike | null;
  on(type: 'pagehide' | 'pageshow', fn: (e: PageTransitionEvent) => void): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  timers?: LinkTimers;
}

function browserEnv(): WebPresenterEnv {
  let storage: Storage | null = null;
  try {
    storage = sessionStorage;
  } catch { /* blocked: a reload loses the audience window */ }
  const locks = typeof navigator !== 'undefined' && navigator.locks ? navigator.locks as unknown as LocksLike : null;
  return {
    open: (url, name, features) => window.open(url, name, features),
    port: broadcastPort,
    storage,
    locks,
    on: (type, fn) => window.addEventListener(type, fn),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id as ReturnType<typeof setInterval>),
  };
}

/** The tab's id: kept in sessionStorage, else new (`fresh`: always new, and kept). */
function tabId(storage: WebPresenterEnv['storage'], fresh = false): string {
  try {
    const kept = fresh || !storage ? null : storage.getItem(ID_KEY);
    if (isLinkId(kept)) return kept;
    const id = newLinkId();
    if (storage) storage.setItem(ID_KEY, id);
    return id;
  } catch {
    return newLinkId();
  }
}

/** The lock that makes tab id `id` this tab's. */
export const lockName = (id: string): string => `inkslide-presenter-${id}`;

/**
 * Take lock `name` if it is free and hold it for the page's life: 'held', or
 * 'taken' (another page holds it), or 'error' (locks do not work here).
 */
export function holdLock(locks: LocksLike, name: string): Promise<'held' | 'taken' | 'error'> {
  return new Promise(resolve => {
    let answered = false;
    locks.request(name, { ifAvailable: true }, lock => {
      answered = true;
      resolve(lock ? 'held' : 'taken');
      return lock ? new Promise(() => {}) : undefined; // never released: the page's life
    }).catch(() => { if (!answered) resolve('error'); });
  });
}

/**
 * Whether this page still holds lock `name`: true, false, or null if it cannot
 * tell (no query). `self` is a lock only this page holds, to find its client id.
 */
export async function holdsLock(locks: LocksLike, name: string, self: string): Promise<boolean | null> {
  if (!locks.query) return null;
  try {
    const held = (await locks.query()).held || [];
    const me = held.find(l => l.name === self)?.clientId;
    if (!me) return null;
    return held.some(l => l.name === name && l.clientId === me);
  } catch {
    return null;
  }
}

/**
 * Presenter mode over a BroadcastChannel; null where the browser has none.
 * `changed`: the switch turned (refresh the toolbar); `notify`: tell the user.
 */
export function createWebPresenter(changed: () => void, notify: (text: string) => void,
  env: WebPresenterEnv | null = typeof BroadcastChannel === 'function' ? browserEnv() : null): { presenter: Presenter; mode: PresenterSwitch } | null {
  if (!env) return null;
  const e = env;
  let id = tabId(e.storage);
  /** The link; null until the tab id is settled. */
  let link: PresenterLink | null = null;
  const presenter: Presenter = createPresenter(m => link?.send(m));
  let popup: Window | null = null;
  let poll: unknown = null;
  /** A lock only this page holds: tells which held locks are this page's (holdsLock). */
  const self = `inkslide-presenter-page-${newLinkId()}`;

  /** The link on the channel of tab id `id`; `probe`: find duplicates by asking (no locks). */
  const connect = (probe: boolean): void => {
    link = createPresenterLink(e.port(channelName(id)), on => presenter.setActive(on), changed, {
      timers: e.timers,
      taken: probe ? () => {
        id = tabId(e.storage, true);
        connect(true);
      } : undefined,
    });
  };

  /** Make a tab id this tab's (its lock), then join its channel. */
  async function claim(): Promise<void> {
    if (!e.locks) return connect(true);
    // The id kept from before a reload is tried a few times: the page before may not have let
    // its lock go yet. A duplicate's original holds it for good.
    let waits = RETAKE_TRIES;
    for (let i = 0; i < LOCK_TRIES; i++) {
      const got = await holdLock(e.locks, lockName(id));
      if (got === 'held') return connect(false);
      if (got === 'error') return connect(true);
      if (waits-- > 0) {
        await new Promise<void>(r => (e.timers ? e.timers.setTimeout(r, RETAKE_MS) : setTimeout(r, RETAKE_MS)));
        continue;
      }
      waits = 0;
      id = tabId(e.storage, true); // a duplicated tab: its original holds the id
    }
    connect(true);
  }

  if (e.locks) void holdLock(e.locks, self);
  void claim();

  const stopPoll = (): void => {
    if (poll !== null) e.clearInterval(poll);
    poll = null;
  };
  const popupOpen = (): boolean => !!popup && !popup.closed;

  /**
   * Back from the back/forward cache: say ready if the id is still this tab's,
   * else (another tab owns it, or it cannot be told) move to a new one.
   * Chromium keeps pages that hold Web Locks out of the cache, as far as we know
   * (not verified against its source), so there this rarely runs; other
   * browsers may cache the page and let its locks go meanwhile.
   */
  async function restored(): Promise<void> {
    const l = link;
    if (!l) return;
    if (!e.locks) return l.announce(); // the probe's check was made on load
    let mine = await holdsLock(e.locks, lockName(id), self);
    if (mine === null) {
      // This page's own lock went too (or query failed): take it again and ask again.
      await holdLock(e.locks, self);
      mine = await holdsLock(e.locks, lockName(id), self);
    }
    if (mine === false && (await holdLock(e.locks, lockName(id))) === 'held') mine = true;
    if (link !== l) return;
    if (mine) return l.announce();
    // Not this tab's id any more. Its pop-up is not closed: it is the window of the tab
    // that owns the id now (or of nobody, and it closes itself).
    l.close();
    popup = null;
    stopPoll();
    id = tabId(e.storage, true);
    link = null;
    changed();
    return claim();
  }

  // Leaving (closed, reloading, or into the back/forward cache): the audience waits.
  // Unloading for good also leaves the channel at once.
  e.on('pagehide', ev => {
    if (!link) return;
    link.leave();
    if (!ev.persisted) link.close();
  });
  e.on('pageshow', ev => { if (ev.persisted) void restored(); });

  const mode: PresenterSwitch = {
    get on() { return !!link && (link.connected || popupOpen()); },
    toggle() {
      const l = link;
      if (!l) return; // the tab id is not settled yet (just loaded)
      if (mode.on) {
        l.quit(); // also an audience this tab no longer holds (opened before a reload)
        if (popupOpen()) popup!.close();
        popup = null;
        stopPoll();
        l.drop();
        changed();
        return;
      }
      popup = e.open(audienceUrl(id), `inkslide-audience-${id}`, 'popup,width=1024,height=640');
      if (!popup) {
        notify('The browser blocked the audience window. Allow pop-ups for this site, then press F5 again.');
        return;
      }
      stopPoll();
      poll = e.setInterval(() => {
        if (popupOpen()) return;
        popup = null;
        stopPoll();
        link?.drop();
        changed();
      }, POLL_MS);
      changed();
    },
  };
  return { presenter, mode };
}
