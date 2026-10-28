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
 * - This tab closing or reloading tells the audience to wait; the reloaded
 *   tab finds it again (same tab id: sessionStorage). While an audience
 *   window listens, F5 closes it, also one this tab opened before a reload
 *   (it has no reference to it any more). The pop-up's name is the tab id's,
 *   so opening again reuses a window of this tab left behind rather than
 *   piling up windows.
 * - A tab duplicated by the browser starts with its original's tab id; the
 *   link finds out (presenter-link.ts) and this tab moves to a new id.
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

/** What the browser gives presenter mode; injectable for tests. */
export interface WebPresenterEnv {
  open(url: string, name: string, features: string): Window | null;
  port(name: string): LinkPort;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
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
  return {
    open: (url, name, features) => window.open(url, name, features),
    port: broadcastPort,
    storage,
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

/**
 * Presenter mode over a BroadcastChannel; null where the browser has none.
 * `changed`: the switch turned (refresh the toolbar); `notify`: tell the user.
 */
export function createWebPresenter(changed: () => void, notify: (text: string) => void,
  env: WebPresenterEnv | null = typeof BroadcastChannel === 'function' ? browserEnv() : null): { presenter: Presenter; mode: PresenterSwitch } | null {
  if (!env) return null;
  const e = env;
  let id = tabId(e.storage);
  let link: PresenterLink;
  const presenter: Presenter = createPresenter(m => link.send(m));
  let popup: Window | null = null;
  let poll: unknown = null;

  /** The link on the channel of tab id `id`; a duplicated tab moves to a new id. */
  const connect = (): void => {
    link = createPresenterLink(e.port(channelName(id)), on => presenter.setActive(on), changed, {
      timers: e.timers,
      taken: () => {
        id = tabId(e.storage, true);
        connect();
      },
    });
  };
  connect();

  const stopPoll = (): void => {
    if (poll !== null) e.clearInterval(poll);
    poll = null;
  };
  const popupOpen = (): boolean => !!popup && !popup.closed;

  // Unloading (closed or reloading): say so, and leave the channel at once.
  e.on('pagehide', ev => {
    if (ev.persisted) return;
    link.leave();
    link.close();
  });
  e.on('pageshow', ev => { if (ev.persisted) link.announce(); });

  const mode: PresenterSwitch = {
    get on() { return link.connected || popupOpen(); },
    toggle() {
      if (mode.on) {
        link.quit(); // also an audience this tab no longer holds (opened before a reload)
        if (popupOpen()) popup!.close();
        popup = null;
        stopPoll();
        link.drop();
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
        link.drop();
        changed();
      }, POLL_MS);
      changed();
    },
  };
  return { presenter, mode };
}
