/* Inkslide web - presenter mode in the browser: the link between the two windows
 *
 * The desktop app relays presenter messages through its main process. In the
 * browser (and the installed PWA) there is no such process: the presenter's
 * tab opens audience.html in a pop-up window (F5, or the toolbar's presenter
 * button) and the two talk over a BroadcastChannel.
 *
 * Why a BroadcastChannel and not the pop-up's postMessage: only pages of the
 * same origin can join a channel (the browser enforces it; there is no origin
 * to check by hand and no window to hold on to), and either window can reload
 * and find the other again; a reloaded presenter tab has no reference to the
 * pop-up it opened, but it can still talk on the channel. The channel's name
 * carries an id kept in the presenter tab's sessionStorage (it survives a
 * reload of that tab), passed to the audience in the URL's hash, so each tab
 * has its own audience window and two presenter tabs never mirror into one.
 *
 * On the channel (all checked with parseLinkMessage; presenter messages are
 * checked once more with parsePresenterMessage by the audience):
 *
 *   ready  presenter → audience: I am here (on load, or when an audience asks)
 *   hello  audience → presenter: send me everything (`to`: the presenter tab it
 *          follows; null: asking who is there)
 *   bye    audience → presenter: the audience window closes or reloads
 *   gone   presenter → audience: the presenter tab closes or reloads
 *   quit   presenter → audience: close (presenter mode ends: F5 again)
 *   m      presenter → audience: one presenter message
 *
 * The audience follows the presenter whose `ready` it heard last; a tab that
 * hears a hello to another presenter stops sending to that audience (a tab
 * duplicated by the browser has the same id: the last one to start wins).
 */

/** One message on the channel (see the module comment). */
export type LinkMessage =
  | { kind: 'ready'; from: string }
  | { kind: 'hello'; from: string; to: string | null }
  | { kind: 'bye'; from: string }
  | { kind: 'gone'; from: string }
  | { kind: 'quit'; from: string }
  | { kind: 'm'; from: string; m: unknown };

/** Ids of windows and of a presenter tab's channel: letters, digits and '-', at most 64. */
const ID = /^[A-Za-z0-9-]{1,64}$/;
export const isLinkId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** A new random id (a window, or a presenter tab's channel). */
export function newLinkId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The channel of a presenter tab's id. */
export const channelName = (id: string): string => `inkslide-presenter-${id}`;

/** The audience page for a presenter tab's id (relative to the app's page). */
export const audienceUrl = (id: string): string => `audience.html#${id}`;

/** The presenter tab's id in an audience page's hash ('#id'); null if it has none (or a bad one). */
export function idFromHash(hash: string): string | null {
  const id = hash.replace(/^#/, '');
  return isLinkId(id) ? id : null;
}

/** `value` as a LinkMessage with only its known fields; null if it is not one. */
export function parseLinkMessage(value: unknown): LinkMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isLinkId(v.from)) return null;
  const from = v.from;
  switch (v.kind) {
    case 'ready': case 'bye': case 'gone': case 'quit':
      return { kind: v.kind, from };
    case 'hello':
      if (v.to !== null && !isLinkId(v.to)) return null;
      return { kind: 'hello', from, to: v.to };
    case 'm':
      return { kind: 'm', from, m: v.m };
    default:
      return null;
  }
}

/** The channel as the link uses it (a BroadcastChannel, or a stand-in in tests). */
export interface LinkPort {
  post(message: LinkMessage): void;
  /** `fn` hears every message other windows post. */
  listen(fn: (data: unknown) => void): void;
}

/** A BroadcastChannel as a LinkPort. */
export function broadcastPort(name: string): LinkPort & { close(): void } {
  const channel = new BroadcastChannel(name);
  return {
    post: m => channel.postMessage(m),
    listen: fn => channel.addEventListener('message', e => fn((e as MessageEvent).data)),
    close: () => channel.close(),
  };
}

/** The presenter tab's end of the link. */
export interface PresenterLink {
  /** An audience window listens. */
  readonly connected: boolean;
  /** Send a presenter message to the audience. */
  send(message: unknown): void;
  /** Say this tab is (here) again: on load, and when the page comes back from the back/forward cache. */
  announce(): void;
  /** The tab closes or reloads: the audience waits for it. */
  leave(): void;
  /** End presenter mode: the audience window closes. */
  quit(): void;
  /** The audience window is gone (its window was seen closed): stop sending. */
  drop(): void;
}

/**
 * The presenter's end: `setActive` is the presenter's switch (true: an audience
 * window opened or loaded, send everything; false: none listens any more);
 * `changed` hears when `connected` changes.
 */
export function createPresenterLink(port: LinkPort, setActive: (on: boolean) => void, changed: () => void = () => {}, id = newLinkId()): PresenterLink {
  const audiences = new Set<string>();

  const lose = (audience: string): void => {
    if (!audiences.delete(audience)) return;
    if (!audiences.size) setActive(false);
    changed();
  };

  port.listen(data => {
    const m = parseLinkMessage(data);
    if (!m) return;
    if (m.kind === 'hello') {
      if (m.to === null) port.post({ kind: 'ready', from: id }); // the audience picks whom to follow
      else if (m.to !== id) lose(m.from); // it follows another tab now
      else {
        audiences.add(m.from);
        setActive(true); // everything, to a new or reloaded audience
        changed();
      }
    } else if (m.kind === 'bye') lose(m.from);
  });

  const link: PresenterLink = {
    get connected() { return audiences.size > 0; },
    send(message) {
      if (audiences.size) port.post({ kind: 'm', from: id, m: message });
    },
    announce() { port.post({ kind: 'ready', from: id }); },
    leave() { port.post({ kind: 'gone', from: id }); },
    quit() { port.post({ kind: 'quit', from: id }); },
    drop() {
      if (!audiences.size) return;
      audiences.clear();
      setActive(false);
      changed();
    },
  };
  link.announce(); // a reloaded tab: an audience still open follows it again
  return link;
}

/** What the audience's end of the link reports. */
export interface AudienceHandlers {
  /** A presenter message from the presenter followed (to be checked with parsePresenterMessage). */
  message(m: unknown): void;
  /** A presenter tab was found: everything is on its way. */
  connected(): void;
  /** The presenter tab closed or is reloading. */
  gone(): void;
  /** Presenter mode ended: close the window. */
  quit(): void;
}

/** The audience's end of the link. */
export interface AudienceLink {
  /** Ask for everything again (on load, and back from the back/forward cache). */
  hello(): void;
  /** The audience window closes or reloads. */
  leave(): void;
}

/** The audience's end: follows the presenter tab whose `ready` came last. */
export function createAudienceLink(port: LinkPort, on: AudienceHandlers, id = newLinkId()): AudienceLink {
  let presenter: string | null = null;
  port.listen(data => {
    const m = parseLinkMessage(data);
    if (!m) return;
    if (m.kind === 'ready') {
      // Already following it (its answer to our hello crossed its own announcement): nothing new.
      if (m.from === presenter) return;
      presenter = m.from;
      port.post({ kind: 'hello', from: id, to: presenter });
      on.connected();
    } else if (m.from !== presenter) {
      // Only the presenter followed is heard.
    } else if (m.kind === 'm') on.message(m.m);
    else if (m.kind === 'gone') {
      presenter = null;
      on.gone();
    } else if (m.kind === 'quit') on.quit();
  });
  const link: AudienceLink = {
    hello() { port.post({ kind: 'hello', from: id, to: presenter }); },
    leave() { port.post({ kind: 'bye', from: id }); },
  };
  link.hello();
  return link;
}
