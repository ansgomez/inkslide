import type { Session, WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { confirmLinks, lockNavigation, MAX_LINK_LENGTH, restrictPermissions } from '../src/main/harden';

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
  it('without openLink (audience and print windows) only refuses links', () => {
    let open: ((d: { url: string }) => { action: string }) | undefined;
    const wc = {
      setWindowOpenHandler: (h: typeof open) => { open = h; },
      on: () => {},
    } as unknown as WebContents;
    lockNavigation(wc);
    expect(open!({ url: 'https://example.org/' }).action).toBe('deny');
  });
});

describe('confirmLinks', () => {
  const settle = () => new Promise(r => setTimeout(r, 0));

  it('opens a link only after the user confirms it, showing its host and whole URL', async () => {
    const asked: string[] = [];
    const opened: string[] = [];
    let answer = false;
    const openLink = confirmLinks(async u => { asked.push(`${u.host} ${u.href}`); return answer; }, url => opened.push(url));
    openLink('https://attacker.example/?data=notes');
    await settle();
    expect(asked).toEqual(['attacker.example https://attacker.example/?data=notes']);
    expect(opened).toEqual([]); // declined
    answer = true;
    openLink('https://github.com/ansgomez/inkslide');
    await settle();
    expect(opened).toEqual(['https://github.com/ansgomez/inkslide']);
  });
  it('asks one question at a time and drops links that are not http(s), too long or broken', async () => {
    const asked: string[] = [];
    let reply!: (ok: boolean) => void;
    const openLink = confirmLinks(u => { asked.push(u.href); return new Promise(r => { reply = r; }); }, () => {});
    openLink('https://one.example/');
    openLink('https://two.example/'); // while the first is asked: dropped
    reply(false);
    await settle();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', `https://x.example/${'a'.repeat(MAX_LINK_LENGTH)}`]) openLink(url);
    await settle();
    expect(asked).toEqual(['https://one.example/']);
    openLink('http://three.example/');
    expect(asked).toEqual(['https://one.example/', 'http://three.example/']);
  });
  it('opens nothing when asking fails', async () => {
    const opened: string[] = [];
    const openLink = confirmLinks(() => Promise.reject(new Error('no window')), url => opened.push(url));
    openLink('https://example.org/');
    await settle();
    openLink('https://example.org/');
    await settle();
    expect(opened).toEqual([]);
  });
});
