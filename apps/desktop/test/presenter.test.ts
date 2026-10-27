import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIENCE_SIZE, audienceEntry, audienceKey, audiencePlacement, type DisplayInfo } from '../src/main/presenter';

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
