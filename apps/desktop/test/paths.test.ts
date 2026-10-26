import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fallbackBackupPath, fallbackNotesPath, isSha256, pdfFromArgv, resolveWebEntry } from '../src/main/paths';

const local = (path: string) => ({ path: resolve(path) });

const base = { isPackaged: false, appPath: '/repo/apps/desktop', resourcesPath: '/opt/Inkslide/resources' };

describe('resolveWebEntry', () => {
  it('loads apps/web/dist in development', () => {
    expect(resolveWebEntry(base)).toEqual({ kind: 'file', file: resolve('/repo/apps/web/dist/index.html') });
  });
  it('loads resources/web when packaged', () => {
    expect(resolveWebEntry({ ...base, isPackaged: true, appPath: '/opt/Inkslide/resources/app.asar' }))
      .toEqual({ kind: 'file', file: resolve('/opt/Inkslide/resources/web/index.html') });
  });
  it('prefers the dev URL, then the page override', () => {
    expect(resolveWebEntry({ ...base, devUrl: 'http://localhost:5173', pageOverride: '/x.html' }))
      .toEqual({ kind: 'url', url: 'http://localhost:5173/' });
    expect(resolveWebEntry({ ...base, pageOverride: '/t/page.html' })).toEqual({ kind: 'file', file: resolve('/t/page.html') });
  });
  it('ignores the dev URL when packaged', () => {
    expect(resolveWebEntry({ ...base, isPackaged: true, devUrl: 'https://example.com/' }))
      .toEqual({ kind: 'file', file: resolve('/opt/Inkslide/resources/web/index.html') });
  });
  it('rejects bad dev URLs', () => {
    expect(() => resolveWebEntry({ ...base, devUrl: 'localhost:5173' })).toThrow(/http/);
    expect(() => resolveWebEntry({ ...base, devUrl: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => resolveWebEntry({ ...base, devUrl: 'not a url' })).toThrow(/not a URL/);
  });
});

describe('pdfFromArgv', () => {
  it('finds the PDF in dev and packaged command lines', () => {
    expect(pdfFromArgv(['/usr/bin/electron', '.', 'slides.pdf'], '/home/u')).toEqual(local('/home/u/slides.pdf'));
    expect(pdfFromArgv(['/opt/Inkslide/inkslide', '/data/A.PDF'], '/')).toEqual(local('/data/A.PDF'));
  });
  it('skips switches and non-PDF arguments, takes the last PDF', () => {
    expect(pdfFromArgv(['inkslide', '--ozone-platform-hint=auto', 'a.pdf', '--x', 'b.pdf', 'readme.txt'], '/d'))
      .toEqual(local('/d/b.pdf'));
    expect(pdfFromArgv(['inkslide', '--flag', 'notes.json'], '/d')).toBeNull();
    expect(pdfFromArgv(['inkslide.pdf'], '/d')).toBeNull(); // argv[0] is the executable
  });
  it('accepts file:// URLs', () => {
    expect(pdfFromArgv(['inkslide', 'file:///tmp/my%20deck.pdf'], '/')).toEqual(local('/tmp/my deck.pdf'));
  });
  it('reports other URIs as remote instead of making a path of them', () => {
    for (const uri of ['sftp://host/home/u/deck.pdf', 'smb://nas/share/My%20Deck.PDF', 'https://example.org/a.pdf?x=1']) {
      expect(pdfFromArgv(['inkslide', uri], '/d')).toEqual({ remote: uri });
    }
    if (process.platform !== 'win32') {
      expect(pdfFromArgv(['inkslide', 'file://otherhost/a.pdf'], '/d')).toEqual({ remote: 'file://otherhost/a.pdf' });
    }
    expect(pdfFromArgv(['inkslide', 'sftp://host/notes.txt'], '/d')).toBeNull();
    expect(pdfFromArgv(['inkslide', 'sftp://h/%E0%A4.pdf'], '/d')).toEqual({ remote: 'sftp://h/%E0%A4.pdf' }); // malformed escape
    expect(pdfFromArgv(['inkslide', 'local.pdf', 'sftp://host/b.pdf'], '/d')).toEqual({ remote: 'sftp://host/b.pdf' });
  });
  it('a Windows drive letter is a path, not a URI scheme', () => {
    expect(pdfFromArgv(['inkslide', 'C://x/a.pdf'], '/d')).toEqual({ path: resolve('/d', 'C://x/a.pdf') });
  });
});

describe('fallbackNotesPath', () => {
  const sha = 'a'.repeat(64);
  it('keys notes by sha256 in userData/notes', () => {
    expect(fallbackNotesPath('/ud', sha)).toBe(join('/ud', 'notes', `${sha}.notes.json`));
    expect(fallbackBackupPath('/ud', sha)).toBe(join('/ud', 'notes', `${sha}.notes.backup.json`));
  });
  it('refuses anything that is not a hex sha256', () => {
    expect(isSha256(sha)).toBe(true);
    expect(isSha256('A'.repeat(64))).toBe(false);
    expect(() => fallbackNotesPath('/ud', '../../etc/passwd')).toThrow();
    expect(() => fallbackBackupPath('/ud', '../../etc/passwd')).toThrow();
  });
});
