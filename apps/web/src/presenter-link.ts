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
 * carries the tab's id, kept in its sessionStorage (it survives a reload of
 * the tab) and passed to the audience in the URL's hash, so each tab has its
 * own audience window and two presenter tabs never mirror into one.
 *
 * Every window also has a link id of its own, new on each page load (`from`):
 * the audience tells the presenter's loads apart by it.
 *
 * On the channel (all checked with parseLinkMessage; presenter messages are
 * checked once more with parsePresenterMessage by the audience):
 *
 *   probe  presenter → presenters: is this tab id taken? (on load, before ready)
 *   taken  presenter → presenter `to`: yes, by me (the prober is a duplicated tab)
 *   ready  presenter → audience: I am here (on load, or when an audience asks)
 *   hello  audience → presenter: send me everything (`to`: the presenter it
 *          follows; null: asking who is there)
 *   bye    audience → presenter: the audience window closes or reloads
 *   gone   presenter → audience: the presenter tab closes or reloads
 *   quit   presenter → audience: close (presenter mode ends: F5 again)
 *   m      presenter → audience: one presenter message
 *
 * A tab duplicated by the browser copies sessionStorage, so it starts with the
 * same tab id as a tab still open: its probe is answered with `taken`, and it
 * moves to a new id (a channel and a pop-up name of its own) before it ever
 * says ready. A reloaded tab's earlier page is gone, so nobody answers its
 * probe and it keeps its id and its audience window. Should two presenters
 * still share a channel, the audience follows the one whose `ready` it heard
 * last and ignores the other; that one hears the hello to the other and stops.
 *
 * The audience answers every `ready` with a hello, also from the presenter it
 * follows (a tab reloaded without `gone`: crashed, discarded, restored), and
 * closes itself when, after `gone`, no presenter comes back within GRACE_MS.
 */

/** One message on the channel (see the module comment). */
export type LinkMessage =
  | { kind: 'probe'; from: string }
  | { kind: 'taken'; from: string; to: string }
  | { kind: 'ready'; from: string }
  | { kind: 'hello'; from: string; to: string | null }
  | { kind: 'bye'; from: string }
  | { kind: 'gone'; from: string }
  | { kind: 'quit'; from: string }
  | { kind: 'm'; from: string; m: unknown };

/** How long a loading presenter waits for `taken`, ms (a tab still open answers at once). */
export const PROBE_MS = 400;
/** How long the audience waits for its presenter tab to come back after `gone`, ms; then it closes. */
export const GRACE_MS = 10_000;

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
    case 'probe': case 'ready': case 'bye': case 'gone': case 'quit':
      return { kind: v.kind, from };
    case 'taken':
      return isLinkId(v.to) ? { kind: 'taken', from, to: v.to } : null;
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
  /** Leave the channel (nothing more is heard or posted). */
  close?(): void;
}

/** A BroadcastChannel as a LinkPort. */
export function broadcastPort(name: string): LinkPort {
  const channel = new BroadcastChannel(name);
  return {
    post: m => channel.postMessage(m),
    listen: fn => channel.addEventListener('message', e => fn((e as MessageEvent).data)),
    close: () => channel.close(),
  };
}

/** Timers, injectable for tests. */
export interface LinkTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const defaultTimers: LinkTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** The presenter tab's end of the link. */
export interface PresenterLink {
  /** An audience window listens. */
  readonly connected: boolean;
  /** Send a presenter message to the audience. */
  send(message: unknown): void;
  /** Say this tab is (here) again: back from the back/forward cache. */
  announce(): void;
  /** The tab closes or reloads: the audience waits for it. */
  leave(): void;
  /** End presenter mode: the audience window closes. */
  quit(): void;
  /** The audience window is gone (its window was seen closed): stop sending. */
  drop(): void;
  /** Leave the channel for good (the tab moves to another id). */
  close(): void;
}

/** Options of createPresenterLink. */
export interface PresenterLinkOptions {
  /** This page load's link id. */
  id?: string;
  /**
   * The tab id is taken by another open tab (this one is a duplicate): the
   * caller moves to a new id. Without it, there is no probe: ready goes at once.
   */
  taken?: () => void;
  timers?: LinkTimers;
}

/**
 * The presenter's end: `setActive` is the presenter's switch (true: an audience
 * window opened or loaded, send everything; false: none listens any more);
 * `changed` hears when `connected` changes.
 */
export function createPresenterLink(port: LinkPort, setActive: (on: boolean) => void, changed: () => void = () => {},
  options: PresenterLinkOptions = {}): PresenterLink {
  const id = options.id ?? newLinkId();
  const timers = options.timers ?? defaultTimers;
  const audiences = new Set<string>();
  /** Probing: not yet ready (a duplicated tab must not take its original's audience). */
  let probing = !!options.taken;
  let closed = false;

  const lose = (audience: string): void => {
    if (!audiences.delete(audience)) return;
    if (!audiences.size) setActive(false);
    changed();
  };

  port.listen(data => {
    const m = parseLinkMessage(data);
    if (!m || closed) return;
    if (m.kind === 'probe') {
      if (!probing) port.post({ kind: 'taken', from: id, to: m.from });
    } else if (m.kind === 'taken') {
      if (m.to === id && probing) {
        probing = false;
        link.close();
        options.taken!();
      }
    } else if (probing) {
      // Not on the channel yet.
    } else if (m.kind === 'hello') {
      if (m.to === null) port.post({ kind: 'ready', from: id }); // the audience picks whom to follow
      else if (m.to !== id) lose(m.from); // it follows another presenter now
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
      if (audiences.size && !closed) port.post({ kind: 'm', from: id, m: message });
    },
    announce() { if (!probing && !closed) port.post({ kind: 'ready', from: id }); },
    leave() { if (!probing && !closed) port.post({ kind: 'gone', from: id }); },
    quit() { if (!closed) port.post({ kind: 'quit', from: id }); },
    drop() {
      if (!audiences.size) return;
      audiences.clear();
      setActive(false);
      changed();
    },
    close() {
      if (closed) return;
      link.drop();
      closed = true;
      if (port.close) port.close();
    },
  };
  if (probing) {
    port.post({ kind: 'probe', from: id });
    timers.setTimeout(() => {
      if (!probing || closed) return;
      probing = false;
      link.announce(); // a reloaded tab: an audience still open follows it again
    }, PROBE_MS);
  } else link.announce();
  return link;
}

/** What the audience's end of the link reports. */
export interface AudienceHandlers {
  /** A presenter message from the presenter followed (to be checked with parsePresenterMessage). */
  message(m: unknown): void;
  /** A presenter (again): everything is on its way. */
  connected(): void;
  /** The presenter tab closed or is reloading. */
  gone(): void;
  /** Presenter mode ended (quit), or the presenter did not come back within GRACE_MS: close the window. */
  quit(): void;
}

/** The audience's end of the link. */
export interface AudienceLink {
  /** Ask for everything again (back from the back/forward cache). */
  hello(): void;
  /** The audience window closes or reloads. */
  leave(): void;
}

/** The audience's end: follows the presenter whose `ready` came last. */
export function createAudienceLink(port: LinkPort, on: AudienceHandlers, options: { id?: string; timers?: LinkTimers } = {}): AudienceLink {
  const id = options.id ?? newLinkId();
  const timers = options.timers ?? defaultTimers;
  let presenter: string | null = null;
  let grace: unknown = null;
  const stopGrace = (): void => {
    if (grace !== null) timers.clearTimeout(grace);
    grace = null;
  };
  port.listen(data => {
    const m = parseLinkMessage(data);
    if (!m) return;
    if (m.kind === 'ready') {
      // Also from the presenter followed: it may have reloaded without saying gone.
      stopGrace();
      presenter = m.from;
      port.post({ kind: 'hello', from: id, to: presenter });
      on.connected();
    } else if (m.from !== presenter) {
      // Only the presenter followed is heard.
    } else if (m.kind === 'm') on.message(m.m);
    else if (m.kind === 'gone') {
      presenter = null;
      on.gone();
      stopGrace();
      grace = timers.setTimeout(() => { grace = null; on.quit(); }, GRACE_MS);
    } else if (m.kind === 'quit') on.quit();
  });
  const link: AudienceLink = {
    hello() { port.post({ kind: 'hello', from: id, to: presenter }); },
    leave() { port.post({ kind: 'bye', from: id }); },
  };
  link.hello();
  return link;
}
