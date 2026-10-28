/* Inkslide desktop - presenter mode: where the audience window goes, what it loads (no Electron)
 *
 * The audience window (View → Presenter Mode) mirrors the app window for a
 * projector. main.ts opens it, relays the presenter messages to it (checked
 * with parsePresenterMessage from @inkslide/annotate/presenter) and closes it
 * with the app window. It loads audience.html of the same front end build,
 * with the same locked-down webPreferences and preload; main answers none of
 * its bridge calls (they must come from the app window).
 */
import { dirname, join } from 'node:path';
import type { WebEntry } from './paths';
import type { Rect } from './windowState';

/** A display as Electron's screen module reports it (the fields used here). */
export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
  /** Device pixels per DIP (1 when not given). */
  scaleFactor?: number;
}

/** Where the audience window opens, and whether it fills that display. */
export interface AudiencePlacement {
  bounds: Rect;
  fullScreen: boolean;
}

/** Size of the audience window when there is no other display. */
export const AUDIENCE_SIZE = { width: 960, height: 540 };

/**
 * The audience window's place: full screen on a display other than the app
 * window's (the first one listed, usually the projector); with a single
 * display, a 960×540 window in the middle of its work area (to be moved and
 * made full screen by the user, F11).
 *
 * `canPlace` false (Wayland): the compositor ignores window positions and the
 * app window's display is not known reliably, so a full-screen window could
 * cover the app window on its own display. Then it is always the window, for
 * the user to move to the projector (audienceFollower then makes it full
 * screen there when it can tell).
 */
export function audiencePlacement(displays: readonly DisplayInfo[], appDisplayId: number, canPlace = true): AudiencePlacement {
  const other = canPlace ? displays.find(d => d.id !== appDisplayId) : undefined;
  if (other) return { bounds: { ...other.bounds }, fullScreen: true };
  const area = (displays.find(d => d.id === appDisplayId) || displays[0])?.workArea ?? { x: 0, y: 0, ...AUDIENCE_SIZE };
  const width = Math.min(AUDIENCE_SIZE.width, area.width), height = Math.min(AUDIENCE_SIZE.height, area.height);
  return {
    bounds: {
      x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height,
    },
    fullScreen: false,
  };
}

/** The audience page: audience.html next to the front end's index.html (or on the dev server). */
export function audienceEntry(entry: WebEntry): WebEntry {
  return entry.kind === 'url'
    ? { kind: 'url', url: new URL('audience.html', entry.url).href }
    : { kind: 'file', file: join(dirname(entry.file), 'audience.html') };
}

/**
 * What a key does in the audience window, which has no menu on Linux and
 * Windows: Escape or F5 ends presenter mode, F11 toggles full screen.
 */
export function audienceKey(input: { type: string; key: string; alt?: boolean; control?: boolean; meta?: boolean }): 'exit' | 'fullscreen' | null {
  if (input.type !== 'keyDown' || input.alt || input.control || input.meta) return null;
  if (input.key === 'Escape' || input.key === 'F5') return 'exit';
  return input.key === 'F11' ? 'fullscreen' : null;
}

// ── Wayland: full screen once moved to another display ─────────

/** What a page's `window.screen` says about the display it is on. */
export interface ScreenReport {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
}

/**
 * The display a page's `window.screen` describes, or null.
 *
 * Both sides are the same numbers: Chromium fills `window.screen` from the
 * display list Electron's screen module reports (bounds and work area in
 * DIPs, at any scale; seen at scale 2 with KWin), and CSS pixels are DIPs at
 * page zoom 1 (Inkslide's windows have no zoom). Only an exact match counts,
 * so a zoomed page or a display list that changed in between gives null,
 * never a wrong display.
 */
export function screenDisplay(displays: readonly DisplayInfo[], s: ScreenReport | null): DisplayInfo | null {
  if (!s) return null;
  const same = (r: Rect): boolean => r.x === s.availLeft && r.y === s.availTop && r.width === s.availWidth && r.height === s.availHeight;
  return displays.find(d => same(d.workArea)) ?? displays.find(d => same(d.bounds)) ?? null;
}

/**
 * Where the audience and app windows were last seen: the pair being confirmed
 * and how often it was seen in a row, and the pair last acted on.
 */
export interface AutoFullScreenState {
  pending: string | null;
  count: number;
  settled: string | null;
}

export const AUTO_FULL_SCREEN_START: AutoFullScreenState = { pending: null, count: 0, settled: null };

/** How many checks in a row must agree before the audience window counts as moved (it may be mid-drag). */
export const AUTO_FULL_SCREEN_SETTLE = 2;

/**
 * Wayland: whether the audience window should go full screen now, from the
 * displays the two pages' `window.screen` describe (null: not known).
 *
 * Chromium updates `window.screen` only when the window's scale changes (seen
 * with KWin and Electron 43): moved between two displays of the same scale, a
 * page keeps naming the display it was on before. So the readings count only
 * when the two displays have different scales, as then each page would have
 * noticed moving onto the other's display. With equal scales, never: the
 * audience window could be on the app window's display while still naming
 * the other one, and full screen there would cover the presenter. Both on
 * the same display is a place too (moving out from there counts as a move)
 * but never goes full screen.
 *
 * Once the two windows are seen on the same pair of displays a few times in a
 * row (`settle`), and that pair is new, the audience window goes full screen
 * if it is not already. The same pair never does it again, so leaving full
 * screen (F11) sticks until the window is moved to another display or
 * presenter mode starts again.
 */
export function audienceAutoFullScreen(
  state: AutoFullScreenState,
  seen: { audience: DisplayInfo | null; app: DisplayInfo | null; fullScreen: boolean },
  settle = AUTO_FULL_SCREEN_SETTLE,
): { state: AutoFullScreenState; fullScreen: boolean } {
  const { audience, app } = seen;
  const same = !!audience && !!app && audience.id === app.id;
  if (!audience || !app || (!same && (audience.scaleFactor ?? 1) === (app.scaleFactor ?? 1))) {
    return { state: { ...state, pending: null, count: 0 }, fullScreen: false };
  }
  const pair = `${audience.id}:${app.id}`;
  const count = pair === state.pending ? state.count + 1 : 1;
  if (count < settle || pair === state.settled) return { state: { ...state, pending: pair, count }, fullScreen: false };
  // On the app window's display it settles (so moving out again counts) but never acts.
  return { state: { pending: pair, count, settled: pair }, fullScreen: !same && !seen.fullScreen };
}

/** How often main checks where the audience window is (Wayland), and how long one reading may take. */
export const AUDIENCE_POLL_MS = 700;
export const AUDIENCE_READ_TIMEOUT_MS = 500;
/** The app window is read again when the audience reading changes, else every this many checks. */
export const APP_READ_EVERY = 5;

/** What the audience follower needs from Electron (main.ts). */
export interface AudienceFollowerDeps {
  readAudience(): Promise<ScreenReport | null>;
  readApp(): Promise<ScreenReport | null>;
  displays(): readonly DisplayInfo[];
  /** The audience window still exists and is shown. */
  alive(): boolean;
  isFullScreen(): boolean;
  setFullScreen(): void;
}

/** A reading, or null if it fails or takes longer than `ms` (a page that is loading may never answer). */
export function readingWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([p.catch(() => null), late]).finally(() => clearTimeout(timer));
}

/**
 * `read`, but while one call is still running (a hung page: readingWithin
 * gives up waiting but cannot cancel it) later calls get that same call
 * instead of starting another, so calls cannot pile up.
 */
export function oneAtATime<T>(read: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    if (!running) {
      const p = read();
      running = p;
      const done = (): void => { if (running === p) running = null; };
      p.then(done, done);
    }
    return running;
  };
}

/**
 * The Wayland audience follower: main calls tick() every AUDIENCE_POLL_MS. It
 * reads the audience page, the app page only when the audience reading
 * changed (or every APP_READ_EVERY checks), and makes the audience window
 * full screen when audienceAutoFullScreen says so. A tick still running is
 * not overlapped; a reading that hangs counts as unknown after `timeoutMs`,
 * and no new one is asked of that page until it answers (oneAtATime).
 */
export function audienceFollower(deps: AudienceFollowerDeps, timeoutMs = AUDIENCE_READ_TIMEOUT_MS): { tick(): Promise<void> } {
  let state = AUTO_FULL_SCREEN_START;
  let busy = false;
  let ticks = 0;
  let app: ScreenReport | null = null;
  let lastAudience = '';
  const readAudience = oneAtATime(() => deps.readAudience());
  const readApp = oneAtATime(() => deps.readApp());
  return {
    async tick() {
      if (busy || !deps.alive()) return;
      busy = true;
      try {
        const audience = await readingWithin(readAudience(), timeoutMs);
        const key = JSON.stringify(audience);
        if (!app || key !== lastAudience || ticks % APP_READ_EVERY === 0) app = await readingWithin(readApp(), timeoutMs);
        lastAudience = key;
        ticks++;
        if (!deps.alive()) return;
        const displays = deps.displays();
        const step = audienceAutoFullScreen(state, {
          audience: screenDisplay(displays, audience), app: screenDisplay(displays, app), fullScreen: deps.isFullScreen(),
        });
        state = step.state;
        if (step.fullScreen) deps.setFullScreen();
      } finally {
        busy = false;
      }
    },
  };
}
