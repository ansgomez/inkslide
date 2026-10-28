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
 *   tab finds it again (same id: sessionStorage).
 *
 * Not used in the desktop app (its bridge and menu do this) nor on Tauri
 * (phones and tablets have no second window): main.ts decides.
 */
import { createPresenter, type Presenter } from './presenter';
import { audienceUrl, broadcastPort, channelName, createPresenterLink, isLinkId, newLinkId } from './presenter-link';

/** The switch of presenter mode the toolbar and F5 use. */
export interface PresenterSwitch {
  /** The audience window is open. */
  readonly on: boolean;
  /** Open the audience window, or close it. Call from a click or a key (pop-ups need one). */
  toggle(): void;
}

/** Key of the tab's link id in sessionStorage (one id per tab; a reload keeps it). */
const ID_KEY = 'inkslide:presenter-id';
/** How often an open pop-up is checked for having been closed, ms. */
const POLL_MS = 1000;

function tabId(): string {
  try {
    const kept = sessionStorage.getItem(ID_KEY);
    if (isLinkId(kept)) return kept;
    const id = newLinkId();
    sessionStorage.setItem(ID_KEY, id);
    return id;
  } catch {
    return newLinkId(); // storage blocked: a reload loses the audience window
  }
}

/**
 * Presenter mode over a BroadcastChannel; null where the browser has none.
 * `changed`: the switch turned (refresh the toolbar); `notify`: tell the user.
 */
export function createWebPresenter(changed: () => void, notify: (text: string) => void): { presenter: Presenter; mode: PresenterSwitch } | null {
  if (typeof BroadcastChannel !== 'function') return null;
  const id = tabId();
  const port = broadcastPort(channelName(id));
  const presenter: Presenter = createPresenter(m => link.send(m));
  const link = createPresenterLink(port, on => presenter.setActive(on), changed);
  let popup: Window | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const stopPoll = (): void => {
    if (poll !== null) clearInterval(poll);
    poll = null;
  };
  const popupOpen = (): boolean => !!popup && !popup.closed;

  window.addEventListener('pagehide', e => { if (!e.persisted) link.leave(); });
  window.addEventListener('pageshow', e => { if (e.persisted) link.announce(); });

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
      popup = window.open(audienceUrl(id), `inkslide-audience-${id}`, 'popup,width=1024,height=640');
      if (!popup) {
        notify('The browser blocked the audience window. Allow pop-ups for this site, then press F5 again.');
        return;
      }
      stopPoll();
      poll = setInterval(() => {
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
