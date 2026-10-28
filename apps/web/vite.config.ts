/* Vite config of the Inkslide front end.
 *
 * base './' keeps every asset path relative, so Electron can serve
 * dist/ from its app://inkslide/ origin. PDF.js's data files (CMaps, standard fonts, wasm
 * decoders, ICC profiles) are served from node_modules in dev and copied
 * to dist/pdfjs/ on build: everything works offline, no CDN.
 *
 * The browser build is also a PWA: public/ holds the manifest and icons,
 * plugins/pwa.ts emits the service worker with the precache list.
 * plugins/notices.ts copies the repository's THIRD_PARTY_NOTICES.md into
 * the build and fails it when a bundled package is not listed there.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { notices } from './plugins/notices';
import { PDFJS_DIRS, PDFJS_SKIP } from './plugins/pdfjs-files.mjs';
import { pwa, urlPath, walk } from './plugins/pwa';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));

/** Serve / emit the PDF.js data directories under pdfjs/. */
function pdfjsAssets(): Plugin {
  return {
    name: 'inkslide-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const path = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
        const file = join(PDFJS_ROOT, path);
        if (!PDFJS_DIRS.includes(path.split('/')[0]) || !file.startsWith(PDFJS_ROOT + sep) || !existsSync(file)) return next();
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const d of PDFJS_DIRS) {
        const dir = join(PDFJS_ROOT, d);
        if (!existsSync(dir)) continue;
        for (const file of walk(dir)) {
          const path = urlPath(PDFJS_ROOT, file);
          if (PDFJS_SKIP.test(path)) continue;
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${path}`,
            source: readFileSync(file),
          });
        }
      }
    },
  };
}

/**
 * Content-Security-Policy of the built page (not the dev server, whose HMR
 * client it would block). wasm-unsafe-eval: PDF.js's image decoders (PDF.js 6
 * compiles nothing with eval, so no 'unsafe-eval'). Electron serves the
 * page from app://inkslide/, so 'self' there is that origin, not every
 * file:// URL as it would be for a page loaded from a file.
 * connect-src has no https: (other sites): the same page runs in Electron,
 * where a compromised renderer could send data out with it; ?pdf= links
 * open same-site PDFs only (platform/web.ts). The Tauri build (`--mode tauri`,
 * apps/mobile) adds ipc: and http://ipc.localhost, Tauri's IPC, which the
 * shell's own CSP cannot widen (both policies apply); the browser and
 * Electron builds leave them out.
 * The service worker (sw.js) and the manifest are same-origin ('self').
 */
const TAURI_IPC = 'ipc: http://ipc.localhost';
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "manifest-src 'self'",
].join('; ');

/** The page CSP; `tauri` adds Tauri's IPC sources to connect-src. */
export function pageCsp(tauri: boolean): string {
  return tauri ? CSP.replace("connect-src 'self' blob: data:", `connect-src 'self' blob: data: ${TAURI_IPC}`) : CSP;
}

function csp(tauri: boolean): Plugin {
  const content = pageCsp(tauri);
  return {
    name: 'inkslide-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    pdfjsAssets(),
    csp(mode === 'tauri'),
    notices(fileURLToPath(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url))),
    pwa(fileURLToPath(new URL('./sw/sw.ts', import.meta.url))),
  ],
  // `tauri android|ios dev` sets TAURI_DEV_HOST so a device can reach the dev server.
  server: { port: 5173, strictPort: true, host: process.env.TAURI_DEV_HOST || undefined },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    // audience.html: the audience window of presenter mode (desktop), src/audience.ts.
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        audience: fileURLToPath(new URL('./audience.html', import.meta.url)),
      },
    },
  },
  worker: { format: 'es' },
}));
