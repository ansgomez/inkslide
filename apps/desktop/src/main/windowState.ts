/* Inkslide desktop - remembered window size, position and maximized state */
import { readJson, writeJson } from './jsonStore';

/** A display work area, in screen px. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What is remembered of the window between runs (userData/window-state.json). */
export interface WindowState {
  width: number;
  height: number;
  /** Position; absent on first start or when it is off every display. */
  x?: number;
  y?: number;
  maximized: boolean;
  fullScreen: boolean;
  /** Native menu bar hidden (Alt shows it on Linux and Windows). */
  menuHidden: boolean;
}

/** State on first start. */
export const DEFAULT_STATE: WindowState = {
  width: 1200, height: 800, maximized: false, fullScreen: false, menuHidden: false,
};
/** Smallest window size. */
export const MIN_SIZE = { width: 480, height: 360 };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

/** A WindowState from untrusted JSON; bad fields get defaults. */
export function parseWindowState(data: unknown): WindowState {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const width = num(d.width), height = num(d.height), x = num(d.x), y = num(d.y);
  const state: WindowState = {
    width: width && width >= MIN_SIZE.width ? width : DEFAULT_STATE.width,
    height: height && height >= MIN_SIZE.height ? height : DEFAULT_STATE.height,
    maximized: d.maximized === true,
    fullScreen: d.fullScreen === true,
    menuHidden: d.menuHidden === true,
  };
  if (x !== undefined && y !== undefined) {
    state.x = x;
    state.y = y;
  }
  return state;
}

/**
 * Keep the window on screen: shrink it to the largest work area and drop the
 * position if less than 64×64 px of its title area would be visible on any
 * display (e.g. a monitor that was unplugged). On Wayland the position is
 * ignored by the compositor anyway.
 */
export function fitToDisplays(state: WindowState, workAreas: readonly Rect[]): WindowState {
  if (!workAreas.length) return state;
  const maxW = Math.max(...workAreas.map(a => a.width));
  const maxH = Math.max(...workAreas.map(a => a.height));
  const out: WindowState = { ...state, width: Math.min(state.width, maxW), height: Math.min(state.height, maxH) };
  if (out.x === undefined || out.y === undefined) return out;
  const { x, y } = out;
  const visible = workAreas.some(a => {
    const w = Math.min(x + out.width, a.x + a.width) - Math.max(x, a.x);
    const h = Math.min(y + 64, a.y + a.height) - Math.max(y, a.y);
    return w >= 64 && h >= 32;
  });
  if (!visible) {
    delete out.x;
    delete out.y;
  }
  return out;
}

/** The saved state, or the defaults if the file is missing or broken. */
export const loadWindowState = (file: string): WindowState => parseWindowState(readJson(file));

/** Save the state (synchronous, safe while quitting). */
export const saveWindowState = (file: string, state: WindowState): void => writeJson(file, state);
