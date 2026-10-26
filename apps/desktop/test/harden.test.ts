import type { Session, WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { lockNavigation, restrictPermissions } from '../src/main/harden';

describe('restrictPermissions', () => {
  it('grants fullscreen only, to requests and to checks', () => {
    let request: ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | undefined;
    let check: ((wc: unknown, p: string) => boolean) | undefined;
    restrictPermissions({
      setPermissionRequestHandler: (h: typeof request) => { request = h; },
      setPermissionCheckHandler: (h: typeof check) => { check = h; },
    } as unknown as Session);
    const asked: boolean[] = [];
    for (const p of ['fullscreen', 'media', 'clipboard-read']) request!(null, p, ok => asked.push(ok));
    expect(asked).toEqual([true, false, false]);
    expect(['fullscreen', 'clipboard-read', 'geolocation'].map(p => check!(null, p))).toEqual([true, false, false]);
  });
});

describe('lockNavigation', () => {
  it('denies new windows and navigation, passing http(s) links on', () => {
    let open: ((d: { url: string }) => { action: string }) | undefined;
    let navigate: ((e: { preventDefault(): void }) => void) | undefined;
    const wc = {
      setWindowOpenHandler: (h: typeof open) => { open = h; },
      on: (ev: string, h: typeof navigate) => { if (ev === 'will-navigate') navigate = h; },
    } as unknown as WebContents;
    const links: string[] = [];
    lockNavigation(wc, url => links.push(url));
    expect(open!({ url: 'https://example.org/' }).action).toBe('deny');
    expect(open!({ url: 'file:///etc/passwd' }).action).toBe('deny');
    expect(links).toEqual(['https://example.org/']);
    let prevented = false;
    navigate!({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  });
});
