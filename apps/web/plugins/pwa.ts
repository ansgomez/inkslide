/* Inkslide web - build-time half of the PWA: the service worker and its precache list
 *
 * After the bundle is complete (index.html, hashed JS/CSS, the PDF.js
 * worker and data files), the plugin lists every output file plus the
 * files of public/ (manifest, icons), hashes their contents into a
 * version, and emits sw.js: sw/sw.ts compiled by esbuild with
 * `const PRECACHE = { version, urls }` in front. Any change to any file
 * changes the version, so the browser sees a new sw.js and the update
 * flow starts (src/pwa.ts). Nothing of this runs in the dev server.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { transformWithEsbuild, type Plugin } from 'vite';

export const SW_FILE = 'sw.js';

export interface PrecacheFile {
  /** Path relative to the page, '/' separated. */
  name: string;
  source: string | Uint8Array;
}

export interface Precache {
  /** Content hash of all files: the cache name's suffix. */
  version: string;
  /** Files to cache, relative to the service worker's scope, sorted. */
  urls: string[];
}

/** Files that never go into the precache: the worker itself, source maps, dotfiles (.DS_Store). */
const skip = (name: string): boolean => name === SW_FILE || name.endsWith('.map') || /(^|\/)\./.test(name);

/**
 * The precache list of a build: every file except the service worker and
 * source maps, and a version that changes when any file's name or
 * content does.
 */
export function precacheList(files: readonly PrecacheFile[]): Precache {
  const kept = files.filter(f => !skip(f.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash('sha256');
  for (const f of kept) hash.update(f.name).update('\0').update(f.source).update('\0');
  return { version: hash.digest('hex').slice(0, 16), urls: kept.map(f => f.name) };
}

/** Every file below `dir`, recursively. */
export function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** `file` relative to `root`, '/' separated (a URL path). */
export const urlPath = (root: string, file: string): string => relative(root, file).split(sep).join('/');

/** Emit sw.js with the precache list of the build. */
export function pwa(swSource: string): Plugin {
  let publicDir = '';
  return {
    name: 'inkslide-pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const files: PrecacheFile[] = Object.values(bundle).map(out => ({
          name: out.fileName,
          source: out.type === 'chunk' ? out.code : out.source,
        }));
        if (publicDir && existsSync(publicDir)) {
          for (const file of walk(publicDir)) {
            files.push({ name: urlPath(publicDir, file), source: readFileSync(file) });
          }
        }
        if (!files.some(f => f.name === 'index.html')) this.error('index.html is not in the bundle yet');
        const precache = precacheList(files);
        const { code } = await transformWithEsbuild(readFileSync(swSource, 'utf8'), swSource, {
          loader: 'ts', format: 'esm', target: 'es2020', minify: true,
        });
        this.emitFile({ type: 'asset', fileName: SW_FILE, source: `const PRECACHE=${JSON.stringify(precache)};\n${code}` });
      },
    },
  };
}
