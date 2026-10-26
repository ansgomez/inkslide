/* Inkslide web - the installable app (PWA) side of the browser build
 *
 * - Service worker (sw/sw.ts): registered only in the built page served
 *   over http(s), never in Electron (file://, window.inkslide) or the Vite
 *   dev server. A new version waits until the user clicks "Reload to
 *   update" in the banner; the notes are saved first.
 * - launchQueue: PDFs the OS opens with the installed app (manifest
 *   file_handlers, Chromium).
 * - Recent files on the start screen (recent-list.ts).
 * - iPad: no page pinch zoom outside the page (Safari's gesture events).
 */
import { banner } from './banner';
import type { WebAdapter } from './platform/web';
import { mountRecentList } from './recent-list';
import type { Viewer } from './viewer';

/** Look for a new version when the app comes back to the front, at most this often. */
const UPDATE_CHECK_MS = 60 * 60_000;

/** Where the page runs, for swAllowed(). */
export interface SwEnvironment {
  protocol: string;
  /** Electron's preload bridge is there. */
  electron: boolean;
  /** A production build (not the dev server). */
  production: boolean;
  serviceWorker: boolean;
}

/** Whether the page may register the service worker. */
export function swAllowed(env: SwEnvironment): boolean {
  return env.serviceWorker && env.production && !env.electron && (env.protocol === 'https:' || env.protocol === 'http:');
}

/**
 * Register the service worker and offer updates. `mayReload` saves the
 * notes and, if that fails, asks whether to reload anyway.
 */
export async function registerServiceWorker(
  mayReload: () => Promise<boolean>, sw = navigator.serviceWorker, reload = (): void => location.reload(),
): Promise<void> {
  const reg = await sw.register('./sw.js', { scope: './' });
  // A worker that is already active (this page may still be uncontrolled after a hard
  // reload) makes the next one an update, not the first install.
  const updating = (): boolean => !!(sw.controller || reg.active);

  let reloading = false;
  let dismiss: (() => void) | null = null;
  let controlled = updating();
  sw.addEventListener('controllerchange', () => {
    if (reloading) return reload();
    if (!controlled) { controlled = true; return; } // the first install claimed the page
    // Updated from another window: this page's files are gone from the cache.
    if (dismiss) dismiss();
    banner('Inkslide was updated in another window.', 'warn', 0, {
      action: { label: 'Reload', run: () => mayReload().then(ok => { if (ok) reload(); return ok; }) },
    });
  });

  let offered: ServiceWorker | null = null;
  const offer = (worker: ServiceWorker): void => {
    if (offered === worker) return;
    offered = worker;
    if (dismiss) dismiss(); // a newer version replaces the one offered before
    dismiss = banner('A new version of Inkslide is ready.', 'info', 0, {
      action: {
        label: 'Reload to update',
        run: () => mayReload().then(ok => { // declined: the notes and the offer stay
          if (ok) {
            reloading = true;
            worker.postMessage('skip-waiting');
          }
          return ok;
        }),
      },
    });
  };
  /** Offer a worker once it is installed (only an update, not the first install). */
  const track = (worker: ServiceWorker | null): void => {
    if (!worker) return;
    if (worker.state === 'installed') {
      if (updating()) offer(worker);
      return;
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && updating()) offer(worker);
    });
  };
  track(reg.waiting);
  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));

  // An app on the home screen may stay open for days.
  let checked = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - checked < UPDATE_CHECK_MS) return;
    checked = Date.now();
    reg.update().catch(() => { /* offline */ });
  });
}

interface LaunchParams { files: readonly FileSystemHandle[] }
type LaunchQueue = { setConsumer(consumer: (params: LaunchParams) => void): void };

/** Set up the PWA parts of the browser build (call once, web adapter only). */
export function setupPwa(viewer: Viewer, adapter: WebAdapter, empty: HTMLElement): void {
  if (swAllowed({
    protocol: location.protocol,
    electron: !!window.inkslide,
    production: import.meta.env.PROD,
    serviceWorker: 'serviceWorker' in navigator,
  })) {
    // After the page has loaded: the first install downloads the whole precache (~6 MB).
    const register = (): void => {
      const mayReload = (): Promise<boolean> => viewer.saveOrAsk('The notes could not be saved. Reload anyway and lose the unsaved notes?');
      registerServiceWorker(mayReload).catch(e => console.warn('Service worker registration failed', e));
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  if (queue) {
    queue.setConsumer(({ files }) => {
      const handle = files.find((f): f is FileSystemFileHandle => f.kind === 'file');
      if (!handle) return;
      adapter.fromHandle(handle).then(file => viewer.open(file),
        e => banner(`Could not open ${handle.name}: ${(e as Error).message || e}`, 'error'));
    });
  }

  void mountRecentList(empty, { adapter, open: file => viewer.open(file) });

  // iPad Safari: pinching the toolbar or the start screen would zoom the whole app.
  document.addEventListener('gesturestart', e => e.preventDefault());
}
