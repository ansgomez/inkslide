/* Inkslide web - tests of the third-party notices plugin and the notices file */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { missingNotices, packageOf } from '../plugins/notices';

const require = createRequire(import.meta.url);
const NOTICES = fileURLToPath(new URL('../../../THIRD_PARTY_NOTICES.md', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../../scripts/notices.mjs', import.meta.url));

describe('packageOf', () => {
  it('names the package of a module in node_modules, scoped or not, with a query', () => {
    const pdfjs = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const version = (require('pdfjs-dist/package.json') as { version: string }).version;
    expect(packageOf(pdfjs)).toEqual({ name: 'pdfjs-dist', version });
    expect(packageOf(`${pdfjs}?url`)).toEqual({ name: 'pdfjs-dist', version });
    const api = require.resolve('@tauri-apps/api/core');
    expect(packageOf(api)?.name).toBe('@tauri-apps/api');
  });

  it('reads Rollup ids with forward slashes and Windows paths alike', () => {
    const pdfjs = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    expect(packageOf(pdfjs.replace(/\\/g, '/'))?.name).toBe('pdfjs-dist');
    expect(packageOf('C:\\nowhere\\node_modules\\x\\index.js')).toBeNull(); // no package.json there
  });

  it('returns null for first-party code and virtual modules', () => {
    expect(packageOf(fileURLToPath(new URL('../src/main.ts', import.meta.url)))).toBeNull();
    expect(packageOf('\0vite/preload-helper.js')).toBeNull();
  });
});

describe('missingNotices', () => {
  const text = '# Notices\n\n### pdf-lib 1.17.1\n\nLicense: MIT\n\n### @tauri-apps/api 2.12.4\n';
  it('accepts listed packages and reports unlisted names and versions once', () => {
    expect(missingNotices([{ name: 'pdf-lib', version: '1.17.1' }, { name: '@tauri-apps/api', version: '2.12.4' }], text)).toEqual([]);
    expect(missingNotices([
      { name: 'pdf-lib', version: '1.18.0' },
      { name: 'pako', version: '1.0.11' },
      { name: 'pako', version: '1.0.11' },
    ], text)).toEqual(['pako@1.0.11', 'pdf-lib@1.18.0']);
  });
});

describe('THIRD_PARTY_NOTICES.md', () => {
  it('is up to date with the installed packages (pnpm notices)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('lists the fonts and decoders PDF.js ships with their licenses', () => {
    const text = readFileSync(NOTICES, 'utf8');
    for (const s of ['LiberationSans-*.ttf', 'OFL-1.1', 'Foxit*.pfb', 'LICENSE_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_QCMS', 'CC0-1.0', '### electron ']) {
      expect(text).toContain(s);
    }
  });
});
