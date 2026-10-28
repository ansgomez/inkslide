import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_READ_EVERY, AUDIENCE_SIZE, AUTO_FULL_SCREEN_START, audienceAutoFullScreen, audienceEntry, audienceFollower, audienceKey,
  audiencePlacement, oneAtATime, readingWithin, screenDisplay, type AudienceFollowerDeps, type AutoFullScreenState, type DisplayInfo,
  type ScreenReport,
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

// Wayland auto full screen. Display numbers are DIPs, as Electron and window.screen give them:
// a 2560×1600 laptop panel at 125 %, a 1280×720 projector at 100 %, a second 100 % monitor and a 4K one at 200 %.
const hiLaptop: DisplayInfo = { id: 11, bounds: { x: 0, y: 0, width: 2048, height: 1280 }, workArea: { x: 0, y: 32, width: 2048, height: 1248 }, scaleFactor: 1.25 };
const beamer: DisplayInfo = { id: 12, bounds: { x: 2048, y: 0, width: 1280, height: 720 }, workArea: { x: 2048, y: 0, width: 1280, height: 720 }, scaleFactor: 1 };
const monitor: DisplayInfo = { id: 13, bounds: { x: 3328, y: 0, width: 1920, height: 1080 }, workArea: { x: 3328, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const fourK: DisplayInfo = { id: 14, bounds: { x: 5248, y: 0, width: 1920, height: 1080 }, workArea: { x: 5248, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };
const all = [hiLaptop, beamer, monitor, fourK];
const at = (r: { x: number; y: number; width: number; height: number }): ScreenReport => ({ availLeft: r.x, availTop: r.y, availWidth: r.width, availHeight: r.height });

describe('screenDisplay', () => {
  it('finds the display a page\'s window.screen describes, at any scale (both in DIPs)', () => {
    expect(screenDisplay(all, at(hiLaptop.workArea))).toBe(hiLaptop);
    expect(screenDisplay(all, at(beamer.workArea))).toBe(beamer);
    expect(screenDisplay(all, at(fourK.workArea))).toBe(fourK);
    expect(screenDisplay([laptop, projector], at(projector.workArea))).toBe(projector);
    // a page that reports the whole display as available
    expect(screenDisplay(all, at(hiLaptop.bounds))).toBe(hiLaptop);
  });
  it('is null rather than a guess', () => {
    expect(screenDisplay(all, null)).toBe(null);
    // device pixels, or a zoomed page: no exact match
    expect(screenDisplay(all, at({ x: 0, y: 40, width: 2560, height: 1560 }))).toBe(null);
    expect(screenDisplay(all, at({ x: 2048, y: 0, width: 640, height: 360 }))).toBe(null);
    expect(screenDisplay(all, { availLeft: Number.NaN, availTop: 0, availWidth: 10, availHeight: 10 })).toBe(null);
  });
});

describe('audienceAutoFullScreen', () => {
  /** Feed observations [audience, app, fullScreen?]; return when it went full screen. */
  function run(seen: Array<[DisplayInfo | null, DisplayInfo | null, boolean?]>, start: AutoFullScreenState = AUTO_FULL_SCREEN_START): boolean[] {
    let state = start;
    return seen.map(([audience, app, fullScreen = false]) => {
      const step = audienceAutoFullScreen(state, { audience, app, fullScreen });
      state = step.state;
      return step.fullScreen;
    });
  }
  const L = hiLaptop, P = beamer, M = monitor, K = fourK;
  it('goes full screen once the window has settled on a display of another scale than the app window\'s', () => {
    expect(run([[L, L], [L, L], [L, L], [P, L], [P, L], [P, L]])).toEqual([false, false, false, false, true, false]);
  });
  it('also when the compositor opened it on the other display', () => {
    expect(run([[P, L], [P, L]])).toEqual([false, true]);
  });
  it('waits while the window is passing over a display (mid-drag)', () => {
    expect(run([[L, L], [P, L], [L, L], [P, L], [L, L]])).toEqual([false, false, false, false, false]);
  });
  it('never on the app window\'s display, nor when either display is not known', () => {
    expect(run([[L, L], [L, L], [P, P], [P, P], [null, L], [null, L], [P, null], [P, null]])).toEqual(Array(8).fill(false));
  });
  it('never between displays of the same scale, where readings go stale', () => {
    // The audience page loaded on the monitor and was dragged onto the projector, where the
    // app window is: both scale 1, so it still names the monitor. Full screen would cover the presenter.
    expect(run([[M, P], [M, P], [M, P], [M, P]])).toEqual([false, false, false, false]);
    expect(run([[{ ...M, scaleFactor: undefined }, P], [{ ...M, scaleFactor: undefined }, P]])).toEqual([false, false]);
    expect(run([[laptop, projector], [laptop, projector]])).toEqual([false, false]);
  });
  it('does not force it again after the user left full screen, until the window moves to another display', () => {
    // full screen on P, then F11 leaves it (a window on P again): stays a window
    expect(run([[P, L], [P, L], [P, L, true], [P, L], [P, L], [P, L]])).toEqual([false, true, false, false, false, false]);
    // back to the app window's display and out again: full screen again
    expect(run([[P, L], [P, L], [P, L], [L, L], [L, L], [P, L], [P, L]])).toEqual([false, true, false, false, false, false, true]);
    // on to a third display of yet another scale: full screen there
    expect(run([[P, L], [P, L], [K, L], [K, L]])).toEqual([false, true, false, true]);
  });
  it('leaves a window the user already made full screen alone', () => {
    expect(run([[P, L, true], [P, L, true], [P, L], [P, L]])).toEqual([false, false, false, false]);
  });
  it('does not count an unknown reading in between as a move', () => {
    expect(run([[P, L], [P, L], [null, null], [P, L], [P, L]])).toEqual([false, true, false, false, false]);
  });
});

describe('readingWithin', () => {
  it('passes a reading on, and gives null for one that fails or hangs', async () => {
    expect(await readingWithin(Promise.resolve(3), 10)).toBe(3);
    expect(await readingWithin(Promise.reject(new Error('gone')), 10)).toBe(null);
    expect(await readingWithin(new Promise(() => {}), 10)).toBe(null);
  });
});

describe('oneAtATime', () => {
  it('reuses the call still running, and calls again once it has settled', async () => {
    let calls = 0;
    const settle: Array<(v: number) => void> = [];
    const fail: Array<(e: Error) => void> = [];
    const read = oneAtATime(() => { calls++; return new Promise<number>((res, rej) => { settle.push(res); fail.push(rej); }); });
    const a = read(), b = read();
    expect(b).toBe(a);
    expect(calls).toBe(1);
    settle[0]!(1);
    expect(await a).toBe(1);
    const c = read();
    expect(calls).toBe(2);
    fail[1]!(new Error('gone'));
    await expect(c).rejects.toThrow('gone');
    void read();
    expect(calls).toBe(3);
  });
});

describe('audienceFollower', () => {
  function harness(readAudience: () => Promise<ScreenReport | null>, readApp: () => Promise<ScreenReport | null> = async () => at(hiLaptop.workArea)) {
    const calls = { audience: 0, app: 0, fullScreen: 0 };
    let fullScreen = false;
    let alive = true;
    const deps: AudienceFollowerDeps = {
      readAudience: () => { calls.audience++; return readAudience(); },
      readApp: () => { calls.app++; return readApp(); },
      displays: () => all,
      alive: () => alive,
      isFullScreen: () => fullScreen,
      setFullScreen: () => { calls.fullScreen++; fullScreen = true; },
    };
    return { calls, follower: audienceFollower(deps, 10), close: () => { alive = false; } };
  }
  const onBeamer = async (): Promise<ScreenReport> => at(beamer.workArea);

  it('makes the audience window full screen once it has settled on the projector', async () => {
    const h = harness(onBeamer);
    for (let i = 0; i < 4; i++) await h.follower.tick();
    expect(h.calls.fullScreen).toBe(1);
  });
  it('keeps checking after a reading that hangs or fails, without piling up calls to a hung page', async () => {
    let n = 0;
    let release: (r: ScreenReport) => void = () => {};
    const h = harness(() => (++n === 1 ? new Promise<ScreenReport>(r => { release = r; }) : n === 2 ? Promise.reject(new Error('reload')) : onBeamer()));
    // hung: each check gives up after the timeout, and asks the page nothing new
    for (let i = 0; i < 3; i++) await h.follower.tick();
    expect(h.calls.audience).toBe(1);
    expect(h.calls.fullScreen).toBe(0);
    release(at(hiLaptop.workArea)); // it answers at last: the next check asks again
    await new Promise(r => setTimeout(r, 0));
    await h.follower.tick();
    expect(h.calls.audience).toBe(2);
    await h.follower.tick();
    await h.follower.tick();
    expect(h.calls.fullScreen).toBe(1);
  });
  it('does not pile up calls to a hung app page either', async () => {
    let n = 0;
    const h = harness(async () => at((++n % 2 ? hiLaptop : beamer).workArea), () => new Promise<ScreenReport>(() => {}));
    for (let i = 0; i < 4; i++) await h.follower.tick();
    expect(h.calls.app).toBe(1);
  });
  it('does not overlap checks', async () => {
    let release: (r: ScreenReport) => void = () => {};
    const h = harness(() => new Promise<ScreenReport>(r => { release = r; }));
    const first = h.follower.tick();
    await h.follower.tick();
    expect(h.calls.audience).toBe(1);
    release(at(beamer.workArea));
    await first;
  });
  it('does nothing once the window is gone or hidden', async () => {
    const h = harness(onBeamer);
    await h.follower.tick();
    h.close();
    await h.follower.tick();
    await h.follower.tick();
    expect(h.calls).toEqual({ audience: 1, app: 1, fullScreen: 0 });
    // gone while a reading was on its way
    let n = 0;
    let release: (r: ScreenReport) => void = () => {};
    const h2 = harness(() => (++n === 1 ? onBeamer() : new Promise<ScreenReport>(r => { release = r; })), undefined);
    await h2.follower.tick();
    const late = h2.follower.tick();
    h2.close();
    release(at(beamer.workArea));
    await late;
    expect(h2.calls.fullScreen).toBe(0);
  });
  it('reads the app window only when the audience reading changes, or now and then', async () => {
    const still = harness(async () => at(hiLaptop.workArea));
    for (let i = 0; i < 2 * APP_READ_EVERY; i++) await still.follower.tick();
    expect(still.calls.app).toBe(2);
    let n = 0;
    const moving = harness(async () => at((++n % 2 ? hiLaptop : beamer).workArea));
    for (let i = 0; i < 4; i++) await moving.follower.tick();
    expect(moving.calls.app).toBe(4);
  });
});
