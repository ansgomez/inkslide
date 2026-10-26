import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dataHome, devDesktopEntry, devEntryPaths, quoteExecArg } from '../scripts/desktop-entry.mjs';
import { encodeIcns, encodeIco, ICNS_TYPES } from '../scripts/icon-formats.mjs';
import { DEFAULT_LINUX_TARGETS, linuxTargets, missingForRpm } from '../scripts/preflight.mjs';

/**
 * Split an Exec value back into arguments, as a launcher does: undo the
 * string escapes, then the quoting; field codes stay.
 */
function parseExec(value: string): string[] {
  const escapes: Record<string, string> = { s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' };
  const s = value.replace(/\\(.)/g, (_, c: string) => escapes[c] ?? `\\${c}`);
  const args: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      cur ??= '';
      for (i++; i < s.length && s[i] !== '"'; i++) cur += s[i] === '\\' ? s[++i] : s[i];
    } else if (c === ' ') {
      if (cur !== null) args.push(cur);
      cur = null;
    } else {
      cur = (cur ?? '') + c;
    }
  }
  if (cur !== null) args.push(cur);
  return args.map(a => a.replace(/%%/g, '%'));
}

describe('dataHome', () => {
  it('uses an absolute XDG_DATA_HOME, else ~/.local/share', () => {
    expect(dataHome({ XDG_DATA_HOME: '/x/data' }, '/home/u')).toBe('/x/data');
    expect(dataHome({ XDG_DATA_HOME: 'rel/data' }, '/home/u')).toBe(join('/home/u', '.local', 'share'));
    expect(dataHome({}, '/home/u')).toBe(join('/home/u', '.local', 'share'));
  });
});

describe('Exec quoting', () => {
  it('leaves plain paths alone and quotes the rest', () => {
    expect(quoteExecArg('/repo/apps/desktop')).toBe('/repo/apps/desktop');
    expect(quoteExecArg('/my repo/app')).toBe('"/my repo/app"');
    expect(quoteExecArg('/a"b$c`d\\e')).toBe('"/a\\"b\\$c\\`d\\\\e"');
    expect(quoteExecArg('/100%')).toBe('/100%%');
  });

  it('round-trips through a desktop file', () => {
    const electron = '/home/u/My Code/inkslide/apps/desktop/node_modules/electron/dist/electron';
    const appDir = '/home/u/My Code/"ink$lide" 100%\\x/apps/desktop';
    const text = devDesktopEntry({ electron, appDir });
    const exec = text.split('\n').find(l => l.startsWith('Exec='))!.slice(5);
    expect(parseExec(exec)).toEqual(['env', 'INKSLIDE_DESKTOP_NAME=inkslide-dev.desktop', electron, appDir, '%f']);
  });
});

describe('devDesktopEntry', () => {
  const text = devDesktopEntry({ electron: '/r/apps/desktop/node_modules/electron/dist/electron', appDir: '/r/apps/desktop' });
  const keys = Object.fromEntries(text.split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  it('opens one PDF and is offered for PDFs', () => {
    expect(text.startsWith('[Desktop Entry]\n')).toBe(true);
    expect(keys.Exec).toBe('env INKSLIDE_DESKTOP_NAME=inkslide-dev.desktop /r/apps/desktop/node_modules/electron/dist/electron /r/apps/desktop %f');
    expect(keys.MimeType).toBe('application/pdf;');
    expect(keys.Type).toBe('Application');
  });

  it('has its own window app id and icon', () => {
    expect(keys.StartupWMClass).toBe('inkslide-dev');
    expect(keys.Icon).toBe('inkslide-dev');
    expect(keys.Name).toBe('Inkslide (dev)');
  });
});

describe('devEntryPaths', () => {
  it('maps the generated icons into hicolor', () => {
    const { desktopFile, icons } = devEntryPaths('/d', ['/b/icons/16x16.png', '/b/icons/512x512.png', '/b/icon.svg', '/b/icon-symbolic.svg', '/b/icons/notes.txt']);
    expect(desktopFile).toBe(join('/d', 'applications', 'inkslide-dev.desktop'));
    expect(icons).toEqual([
      ['/b/icons/16x16.png', join('/d', 'icons/hicolor/16x16/apps/inkslide-dev.png')],
      ['/b/icons/512x512.png', join('/d', 'icons/hicolor/512x512/apps/inkslide-dev.png')],
      ['/b/icon.svg', join('/d', 'icons/hicolor/scalable/apps/inkslide-dev.svg')],
      ['/b/icon-symbolic.svg', join('/d', 'icons/hicolor/symbolic/apps/inkslide-dev-symbolic.svg')],
    ]);
  });
});

describe('icon formats', () => {
  const fakePng = (n: number) => Buffer.from(`png-${n}`);

  it('writes an .ico with BMP entries and a PNG at 256', () => {
    // One opaque red pixel premultiplied, and a half-transparent one.
    const rgba = new Uint8Array([255, 0, 0, 255, 64, 0, 0, 128]);
    const ico = encodeIco([{ size: 2, png: fakePng(2), rgba: new Uint8Array([...rgba, ...rgba]) }, { size: 256, png: fakePng(256) }]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico[6]).toBe(2);
    expect(ico[6 + 16]).toBe(0); // 256
    const bmpAt = ico.readUInt32LE(6 + 12);
    expect(ico.readUInt32LE(bmpAt)).toBe(40);
    expect(ico.readInt32LE(bmpAt + 8)).toBe(4); // height doubled for the mask
    // Bottom-up BGRA, straight alpha: the second pixel un-premultiplies to 128.
    expect([...ico.subarray(bmpAt + 40, bmpAt + 48)]).toEqual([0, 0, 255, 255, 0, 0, 128, 128]);
    const pngAt = ico.readUInt32LE(6 + 16 + 12);
    expect(ico.subarray(pngAt).toString()).toBe('png-256');
  });

  it('writes an .icns with every type', () => {
    const icns = encodeIcns(fakePng);
    expect(icns.subarray(0, 4).toString()).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const types: string[] = [];
    for (let o = 8; o < icns.length; o += icns.readUInt32BE(o + 4)) types.push(icns.subarray(o, o + 4).toString());
    expect(types).toEqual(ICNS_TYPES.map(([t]) => t));
  });
});

describe('dist preflight', () => {
  it('knows which Linux targets a command line builds', () => {
    const all = ['appimage', 'rpm'];
    expect(linuxTargets([], 'linux')).toEqual(all);
    expect(linuxTargets([], 'darwin')).toEqual([]);
    expect(linuxTargets(['--linux', 'AppImage'], 'linux')).toEqual(['appimage']);
    expect(linuxTargets(['--linux', 'AppImage,rpm:x64', '--x64'], 'linux')).toEqual(['appimage', 'rpm']);
    expect(linuxTargets(['--linux=AppImage'], 'linux')).toEqual(['appimage']);
    expect(linuxTargets(['--linux'], 'darwin')).toEqual(all);
    expect(linuxTargets(['--win', 'zip'], 'linux')).toEqual([]);
    expect(linuxTargets(['--win=nsis'], 'linux')).toEqual([]);
    expect(linuxTargets(['--dir'], 'linux')).toEqual([]);
  });

  it('defaults to the targets of electron-builder.yml', () => {
    const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
    expect(/^linux:\n  target: \[(.*)\]$/m.exec(yml)?.[1].split(/,\s*/)).toEqual(DEFAULT_LINUX_TARGETS);
  });

  it('names what the RPM target is missing', () => {
    const libs = '\tlibcrypt.so.2 (libc6,x86-64) => /lib64/libcrypt.so.2\n';
    expect(missingForRpm({ has: () => false, libs })).toEqual([
      'rpmbuild (package rpm-build)', 'libcrypt.so.1 (package libxcrypt-compat)',
    ]);
    expect(missingForRpm({ has: () => true, libs: `${libs}\tlibcrypt.so.1 (libc6,x86-64) => /lib64/libcrypt.so.1\n` })).toEqual([]);
    expect(missingForRpm({ has: () => true, libs: null })).toEqual([]);
  });
});
