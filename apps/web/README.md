# @inkslide/web

The Inkslide front end: a PDF viewer with the Marp Notes annotation tools. The same build
runs in a browser (and as the PWA), inside the Electron window of `apps/desktop` and in the
Tauri shell of `apps/mobile`.

```sh
pnpm --filter @inkslide/web dev        # http://localhost:5173, ?pdf=<url> opens a same-site PDF
pnpm --filter @inkslide/web build      # dist/ (relative paths, so Electron can load it from disk)
pnpm --filter @inkslide/web preview    # serve dist/ on http://localhost:4173
pnpm --filter @inkslide/web test       # unit tests (Vitest, happy-dom)
pnpm --filter @inkslide/web test:e2e   # Playwright against the production build
pnpm --filter @inkslide/web demo       # record docs/media/demo.gif (needs ffmpeg)
```

The end-to-end tests need a Playwright browser once
(`pnpm --filter @inkslide/web exec playwright install chromium`).
WebKit runs too with `INKSLIDE_E2E_WEBKIT=1`, if its system libraries are installed (on
hosts Playwright does not support, add `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`); the
check of the browser's print output (`page.pdf()`) is Chromium only. `INKSLIDE_E2E_PORT`
picks another preview port than 4173.

## Source

| File | Role |
|---|---|
| `main.ts` | Entry: page shell, adapter, drag and drop, startup file, save on leave and on window close (Electron). |
| `viewer.ts` | One document session per PDF: `NotesDoc`, `Annotator`, page surfaces, fit page / fit width (W), page navigation and keys, blank pages, open (one at a time, the latest request next), import, export, print, `saveOrAsk()`, the desktop's notes backup (unreadable notes read again, then the backup offered and the unreadable file kept; Revert to Backup), the file toolbar group. |
| `pdf.ts` | PDF.js loading (bundled worker and data files) and a priority render queue. |
| `page-bitmaps.ts`, `bitmap-cache.ts` | Rendered pages of the open PDF: an LRU of `ImageBitmap`s (at most 6) and the renders in flight. |
| `fit.ts` | Fit page / fit width, render scale, pan limits and fit-width page scrolling (pure). |
| `live-ink.ts` | Low-latency live stroke on a desynchronized canvas (replaces the SVG live stroke). |
| `gestures.ts` | Pinch zoom, pan, two-finger swipe, Ctrl + wheel, touch ignored while the pen is near. |
| `overview.ts` | Thumbnail grid and G + number jump. |
| `persist.ts` | One autosave controller per open document (`@inkslide/annotate/autosave`). |
| `export.ts` | Lazy import of `@inkslide/export`. |
| `print.ts` | Browser print: the export rendered to page images (200 dpi), one `@page` size per page. |
| `counter.ts` | Page counter text and PDF-page steps (pure). |
| `banner.ts` | Message banners, optionally with an action button. |
| `dom.ts` | `localStorage` access that survives blocked storage (`isTyping()` is the toolbar's, `@inkslide/annotate/toolbar`). |
| `platform/` | Adapter choice: `window.inkslide` (Electron), `tauri.ts` (Tauri on iPad and Android: plugins, notes in the app data directory) or `web.ts` (open dialog or file input, OPFS / `localStorage`, save picker, share sheet or download); `recent-storage.ts` stores the recent files (IndexedDB, OPFS); `opfs.ts` holds the shared OPFS helpers. |
| `pwa.ts` | Browser build only: service worker registration and "Reload to update", `launchQueue`, the recent files list. |
| `recent.ts`, `recent-list.ts` | Recent files: handles or kept copies, size limit and LRU (pure, over a storage backend); the list on the start screen, fed by the browser's remembered files or the desktop's recent files. |

The page structure and the rendering pipeline are described in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## PWA

The browser build is an installable, offline-capable app (Chromium: install button in the
address bar; iPad Safari 17+: Share → Add to Home Screen).

- `public/manifest.webmanifest` and the icons in `public/icons/` (rendered from
  `assets/icon/` by `pnpm icons`, see [assets/icon/README.md](../../assets/icon/README.md)).
  `index.html` has the favicons (light and dark), the apple-touch-icon and the iPad
  home-screen tags; the status bar is translucent, so the bar (`toolbar.css`), page and
  start screen (`style.css`) stay out of the safe-area insets.
- `plugins/pwa.ts` (Vite, build only) lists every output file and `public/` after the bundle
  is complete, hashes them into a version and emits `sw.js` from `sw/sw.ts` (type-checked
  with its own `sw/tsconfig.json`). The worker precaches everything (about 6 MB, most of it
  PDF.js data) into `inkslide-<version>`, serves it cache first and gives its own
  navigations (also `?pdf=`) the cached `index.html`.
- Updates: a new build has a new `sw.js`; it installs and waits. The page shows "Reload to
  update"; on click the notes are saved (if that fails, the user is asked), the new worker
  takes over and the page reloads. Declined, the offer stays; a newer version replaces it. A
  page the worker does not control (hard reload) is offered updates too. Other open windows
  then show "updated in another window" with a Reload button, since the old build's files
  left the cache. An installed app also checks for an update when it comes back to the front
  (at most hourly).
- `pwa.ts` registers the worker only in a production build over http(s) without
  `window.inkslide`: never in Electron (file://) or the Vite dev server.
- Recent files: Chromium keeps the `FileSystemFileHandle` from the open dialog or
  `launchQueue` in IndexedDB and asks for read permission again on reopening. Elsewhere
  (iPad Safari, Firefox, file input, drag and drop, `?pdf=`) a copy of the PDF is kept: in
  OPFS where the page can write it (`createWritable`), else (Safari 17-18, or when the OPFS
  write fails) as an ArrayBuffer in IndexedDB. At most 12 entries; the copies together at most 250 MB, the least recently
  opened copies are dropped first; a larger PDF is not kept. In Safari, persistent storage is
  requested once, since Safari may otherwise clear a site's data after 7 days without a visit
  (home-screen apps are exempt); not in Firefox, where that would show a prompt.
- Export: the save dialog where there is one (Chromium), else the share sheet on touch
  devices (iPad: Save to Files), else a download. If building the PDF took longer than the
  tap stays valid for the share sheet, a banner asks for one more tap.

E2E: `e2e/pwa.spec.ts` (recent files, offline reload, update banner, no worker under
Electron's bridge). `openPdf()` opens PDFs through the file input (`useFileInput` in `e2e/helpers.ts`):
Playwright's file chooser does not handle `showOpenFilePicker`.

## Notes

- The built page has a Content-Security-Policy (`vite.config.ts`); nothing is loaded from a
  CDN, so it works offline. `connect-src` allows no other sites (the same page runs in
  Electron), so `?pdf=` opens PDFs of the page's own site only.
- PDF.js is the legacy build, because the modern one needs `Map.getOrInsertComputed`, which
  older iPad Safari lacks (Electron 43 has it).
- `window.inkslideViewer` is exposed for tests and debugging.
- `plugins/notices.ts` copies the repository's `THIRD_PARTY_NOTICES.md` into `dist/` and fails
  the build when a bundled npm package is not listed there (`pnpm notices` updates it).
  PDF.js's data files ship with their license files in `dist/pdfjs/`; its scripting sandbox
  (`wasm/quickjs-eval.*`) is left out.
