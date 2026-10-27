/* Inkslide web - the service worker (built into dist/sw.js by plugins/pwa.ts)
 *
 * Precaches the whole app shell of one build (index.html, JS, CSS, the
 * PDF.js worker, CMaps, standard fonts, wasm decoders, manifest, icons)
 * in a cache named after the build's content hash, and serves it cache
 * first, so the app starts and renders PDFs with the network off.
 * Navigations (also `?pdf=…` links) get the cached index.html.
 *
 * Updates: a new build means a new sw.js. It installs next to the old one
 * and waits; the page shows "Reload to update" and posts 'skip-waiting'
 * when the user agrees (src/pwa.ts). On activation the caches of older
 * builds go, except the one before this: windows still running it (told to
 * reload, src/pwa.ts) load files lazily (the PDF.js worker, CMaps, fonts,
 * wasm, the export chunk) that the new build does not have. A request this
 * build's cache does not have is looked up in that one.
 */
/// <reference lib="webworker" />

const sw = self as unknown as ServiceWorkerGlobalScope;
/** Injected by the build: { version, urls }. */
declare const PRECACHE: { version: string; urls: string[] };

const PREFIX = 'inkslide-';
const CACHE = PREFIX + PRECACHE.version;
const SHELL = 'index.html';

const url = (path: string): string => new URL(path, sw.registration.scope).href;

sw.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 'reload': skip the HTTP cache, which may still hold the previous build's files.
    await cache.addAll(PRECACHE.urls.map(path => new Request(url(path), { cache: 'reload' })));
  })());
});

sw.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // keys() lists the caches oldest first: keep the newest other one (the build before).
    const older = (await caches.keys()).filter(name => name.startsWith(PREFIX) && name !== CACHE);
    for (const name of older.slice(0, -1)) await caches.delete(name);
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', event => {
  if (event.data === 'skip-waiting') void sw.skipWaiting();
});

/** The app's own page, with any query (`?pdf=…`); other navigations (e.g. to a PDF) are not ours. */
function isShell(req: Request): boolean {
  if (req.mode !== 'navigate') return false;
  const u = new URL(req.url);
  u.search = u.hash = '';
  return u.href === sw.registration.scope || u.href === url(SHELL);
}

sw.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(sw.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreVary: the precache requests had no Origin header; module scripts (crossorigin) do.
    const key = isShell(req) ? url(SHELL) : req;
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    // A file of the build before (a window not yet reloaded), else the network.
    for (const name of await caches.keys()) {
      if (name === CACHE || !name.startsWith(PREFIX) || isShell(req)) continue;
      const old = await (await caches.open(name)).match(key, { ignoreVary: true });
      if (old) return old;
    }
    return fetch(req);
  })());
});
