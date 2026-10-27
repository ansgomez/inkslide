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
 * the user to move to the projector.
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
