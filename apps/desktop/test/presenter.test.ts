import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIENCE_SIZE, AUTO_FULL_SCREEN_START, audienceAutoFullScreen, audienceEntry, audienceKey, audiencePlacement, screenDisplay,
  type AutoFullScreenState, type DisplayInfo,
} from '../src/main/presenter';

const laptop: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 }, workArea: { x: 0, y: 32, width: 1920, height: 1168 } };
const projector: DisplayInfo = { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, workArea: { x: 1920, y: 0, width: 1280, height: 720 } };

describe('audiencePlacement', () => {
  it('fills a display other than the app window\'s', () => {
    expect(audiencePlacement([laptop, projector], 1)).toEqual({ bounds: projector.bounds, fullScreen: true });
    expect(audiencePlacement([laptop, projector], 2)).toEqual({ bounds: laptop.bounds, fullScreen: true });
  });
  it('opens a window, never full screen, where windows cannot be placed (Wayland)', () => {
    expect(audiencePlacement([laptop, projector], 1, false)).toEqual({
      bounds: { x: 480, y: 32 + 314, ...AUDIENCE_SIZE }, fullScreen: false,
    });
  });
  it('opens a window in the middle of the only display', () => {
    expect(audiencePlacement([laptop], 1)).toEqual({
      bounds: { x: 480, y: 32 + 314, ...AUDIENCE_SIZE }, fullScreen: false,
    });
  });
  it('fits a small display, and copes with no display at all', () => {
    const small: DisplayInfo = { id: 3, bounds: { x: 0, y: 0, width: 800, height: 500 }, workArea: { x: 0, y: 0, width: 800, height: 500 } };
    expect(audiencePlacement([small], 3).bounds).toEqual({ x: 0, y: 0, width: 800, height: 500 });
    expect(audiencePlacement([], 1)).toEqual({ bounds: { x: 0, y: 0, ...AUDIENCE_SIZE }, fullScreen: false });
  });
});

describe('audienceEntry', () => {
  it('is audience.html next to index.html, or on the dev server', () => {
    const file = resolve('/repo/apps/web/dist/index.html');
    expect(audienceEntry({ kind: 'file', file })).toEqual({ kind: 'file', file: join(resolve('/repo/apps/web/dist'), 'audience.html') });
    expect(audienceEntry({ kind: 'url', url: 'http://localhost:5173/' })).toEqual({ kind: 'url', url: 'http://localhost:5173/audience.html' });
  });
});

describe('audienceKey', () => {
  it('ends presenter mode on Escape or F5, toggles full screen on F11, without modifiers', () => {
    expect(audienceKey({ type: 'keyDown', key: 'Escape' })).toBe('exit');
    expect(audienceKey({ type: 'keyDown', key: 'F5' })).toBe('exit');
    expect(audienceKey({ type: 'keyDown', key: 'F11' })).toBe('fullscreen');
    expect(audienceKey({ type: 'keyUp', key: 'Escape' })).toBe(null);
    expect(audienceKey({ type: 'keyDown', key: 'F5', control: true })).toBe(null);
    expect(audienceKey({ type: 'keyDown', key: 'a' })).toBe(null);
  });
});

describe('screenDisplay', () => {
  const at = (r: { x: number; y: number; width: number; height: number }) => ({ availLeft: r.x, availTop: r.y, availWidth: r.width, availHeight: r.height });
  it('finds the display a page\'s window.screen describes', () => {
    expect(screenDisplay([laptop, projector], at(laptop.workArea))).toBe(1);
    expect(screenDisplay([laptop, projector], at(projector.workArea))).toBe(2);
    // a work area that changed since: the display whose bounds hold its corner
    expect(screenDisplay([laptop, projector], { availLeft: 1920, availTop: 40, availWidth: 1280, availHeight: 680 })).toBe(2);
  });
  it('is null when it does not know', () => {
    expect(screenDisplay([laptop, projector], null)).toBe(null);
    expect(screenDisplay([laptop, projector], { availLeft: 5000, availTop: 0, availWidth: 10, availHeight: 10 })).toBe(null);
    expect(screenDisplay([laptop], { availLeft: Number.NaN, availTop: 0, availWidth: 10, availHeight: 10 })).toBe(null);
  });
});

describe('audienceAutoFullScreen', () => {
  /** Feed observations [audience, app, fullScreen?]; return when it went full screen. */
  function run(seen: Array<[number | null, number | null, boolean?]>, start: AutoFullScreenState = AUTO_FULL_SCREEN_START): boolean[] {
    let state = start;
    return seen.map(([audience, app, fullScreen = false]) => {
      const step = audienceAutoFullScreen(state, { audience, app, fullScreen });
      state = step.state;
      return step.fullScreen;
    });
  }
  it('goes full screen once the window has settled on a display other than the app window\'s', () => {
    expect(run([[1, 1], [1, 1], [1, 1], [2, 1], [2, 1], [2, 1]])).toEqual([false, false, false, false, true, false]);
  });
  it('also when the compositor opened it on the other display', () => {
    expect(run([[2, 1], [2, 1]])).toEqual([false, true]);
  });
  it('waits while the window is passing over a display (mid-drag)', () => {
    expect(run([[1, 1], [2, 1], [1, 1], [2, 1], [1, 1]])).toEqual([false, false, false, false, false]);
  });
  it('never on the app window\'s display, nor when either display is not known', () => {
    expect(run([[1, 1], [1, 1], [2, 2], [2, 2], [null, 1], [null, 1], [2, null], [2, null]])).toEqual(Array(8).fill(false));
  });
  it('does not force it again after the user left full screen, until the window moves to another display', () => {
    // full screen on 2, then F11 leaves it (a window on 2 again): stays a window
    expect(run([[2, 1], [2, 1], [2, 1, true], [2, 1], [2, 1], [2, 1]])).toEqual([false, true, false, false, false, false]);
    // back to the app window's display and out again: full screen again
    expect(run([[2, 1], [2, 1], [2, 1], [1, 1], [1, 1], [2, 1], [2, 1]])).toEqual([false, true, false, false, false, false, true]);
    // on to a third display: full screen there
    expect(run([[2, 1], [2, 1], [3, 1], [3, 1]])).toEqual([false, true, false, true]);
  });
  it('leaves a window the user already made full screen alone', () => {
    expect(run([[2, 1, true], [2, 1, true], [2, 1], [2, 1]])).toEqual([false, false, false, false]);
  });
  it('does not count an unknown reading in between as a move', () => {
    expect(run([[2, 1], [2, 1], [null, null], [2, 1], [2, 1]])).toEqual([false, true, false, false, false]);
  });
});
