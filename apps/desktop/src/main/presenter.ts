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
 * the user to move to the projector (audienceAutoFullScreen then makes it
 * full screen there when it can tell).
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

/** What a page's `window.screen` says about the display it is on (CSS pixels, like display bounds). */
export interface ScreenReport {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
}

/**
 * The display a page's `window.screen` describes: the one whose work area
 * starts there (or, failing that, whose bounds hold that corner); null if none.
 */
export function screenDisplay(displays: readonly DisplayInfo[], s: ScreenReport | null): number | null {
  if (!s || !Number.isFinite(s.availLeft) || !Number.isFinite(s.availTop)) return null;
  const exact = displays.find(d => d.workArea.x === s.availLeft && d.workArea.y === s.availTop
    && d.workArea.width === s.availWidth && d.workArea.height === s.availHeight)
    ?? displays.find(d => d.workArea.x === s.availLeft && d.workArea.y === s.availTop);
  if (exact) return exact.id;
  const b = displays.find(d => s.availLeft >= d.bounds.x && s.availLeft < d.bounds.x + d.bounds.width
    && s.availTop >= d.bounds.y && s.availTop < d.bounds.y + d.bounds.height);
  return b ? b.id : null;
}

/**
 * Where the audience and app windows were last seen (Wayland): the pair being
 * confirmed and how often it was seen in a row, and the pair last acted on.
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
 * Wayland: whether the audience window should go full screen now. On Wayland
 * Electron does not report where a window is, so main asks both pages for
 * their `window.screen` (screenDisplay) every so often and passes the display
 * ids here (null: not known).
 *
 * Once the two windows are seen on the same pair of displays a few times in a
 * row (`settle`), and that pair is new, the audience window goes full screen if
 * it is on a display other than the app window's and not full screen already.
 * The same pair never does it again, so leaving full screen (F11) sticks until
 * the window is moved to another display or presenter mode starts again. On
 * the app window's display, or when either display is not known, never.
 */
export function audienceAutoFullScreen(
  state: AutoFullScreenState,
  seen: { audience: number | null; app: number | null; fullScreen: boolean },
  settle = AUTO_FULL_SCREEN_SETTLE,
): { state: AutoFullScreenState; fullScreen: boolean } {
  if (seen.audience === null || seen.app === null) return { state: { ...state, pending: null, count: 0 }, fullScreen: false };
  const pair = `${seen.audience}:${seen.app}`;
  const count = pair === state.pending ? state.count + 1 : 1;
  if (count < settle || pair === state.settled) return { state: { ...state, pending: pair, count }, fullScreen: false };
  return {
    state: { pending: pair, count, settled: pair },
    fullScreen: seen.audience !== seen.app && !seen.fullScreen,
  };
}
