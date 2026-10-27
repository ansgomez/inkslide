# Architecture

Inkslide is one web front end that runs in a browser (also installed as a PWA), inside an
Electron window on the desktop and inside a Tauri 2 web view on the iPad and Android. All
annotation logic lives in a shared package. The shells only provide file
access.

```
                    ┌──────────────────────── apps/web (Vite) ──────────────────────────┐
                    │ main.ts ── viewer.ts ── pdf.ts (PDF.js) ── bitmap-cache.ts        │
                    │              │   live-ink.ts   gestures.ts   overview.ts          │
                    │              │   persist.ts ── export.ts   presenter.ts           │
                    │              │                   │                                │
                    │      platform/index.ts           │   audience.ts (presenter mode) │
                    │        ├─ web.ts (OPFS / localStorage, file input, download)     │
                    │        ├─ tauri.ts (Tauri plugins, loaded on first use)          │
                    │        └─ window.inkslide (Electron preload bridge)               │
                    └──────────────┬───────────────────┼────────────────────────────────┘
                                   │ uses              │ lazy import
              ┌────────────────────▼─────┐   ┌─────────▼──────────┐
              │ packages/annotate        │◄──│ packages/export    │
              │ model, io, autosave,     │   │ pdf-lib: strokes   │
              │ tools, input, render,    │   │ as vectors, blank  │
              │ toolbar, pages, geometry │   │ pages              │
              └────────────────────▲─────┘   └────────────────────┘
                                   │ notes path rules (io.notesPathFor)
              ┌────────────────────┴──────────────────────────────────────────────┐
              │ apps/desktop (Electron 43)                                         │
              │ preload.ts ── IPC ── main.ts: dialogs, notes.ts, fsutil.ts,        │
              │      access.ts, openRequests.ts, print.ts, harden.ts, recent.ts,   │
              │      windowState.ts, preferences.ts, menu.ts, presenter.ts         │
              └────────────────────────────────────────────────────────────────────┘
```

## Packages and apps

| Path | Package | Role |
|---|---|---|
| `packages/annotate` | `@inkslide/annotate` | The annotation core, ported from Marp Notes: geometry, the notes model and undo history, tools, pointer input, SVG rendering, toolbar and keys, the notes file format, the `PlatformAdapter` interface and the autosave controller. No PDF code, no file system. Shipped as TypeScript source; every module is also a subpath export (`@inkslide/annotate/model`, …). |
| `packages/export` | `@inkslide/export` | Annotated PDF export with pdf-lib. Depends only on `@inkslide/annotate` (model, io, geometry, and the paper look `PAPER_STYLE` from render). |
| `apps/web` | `@inkslide/web` | The front end: PDF viewer, live ink, gestures, overview, autosave wiring, the web adapter. Built by Vite with `base: './'`, so Electron can load `dist/index.html` from disk. |
| `apps/desktop` | `@inkslide/desktop` | Electron shell: main process and sandboxed preload, bundled by esbuild into `out/`. Exports only the bridge types (`@inkslide/desktop/bridge`). |
| `apps/mobile` | `@inkslide/mobile` | Tauri 2 shell for iPad and Android (`src-tauri`): loads `apps/web/dist`, plugins dialog, fs and sharekit, and its own commands for every file access (the page has no fs permission). No front-end code of its own. |

`packages/annotate/legacy/` holds two original Marp Notes modules for parity tests;
`packages/annotate/PORTING.md` lists what changed in the port.

## The annotation core

- **Model** (`model.ts`): `NotesDoc` holds the deck info and the pages. Source pages are
  `p<n>` (PDF) or `s<n>` (Marp); blank pages sit after a source page. Strokes are immutable;
  every edit replaces a page's stroke array through a `Command` on the `History`, so each
  finished gesture is one undo step. `toJSON()` / `load()` are the notes file format (see
  [NOTES-FORMAT.md](NOTES-FORMAT.md)). Change events (`strokes`, `pages`, `saved`) drive
  rendering and autosave.
- **Tools** (`tools.ts`): pen, highlighter, selector (tap, box, lasso; move and restyle),
  laser, stroke eraser and partial eraser. Each tool handles `down / move / up / cancel /
  hover / leave` with points in page units and edits only through `NotesDoc`. The render
  functions are injected (`ToolRenderer`), which is how the web app swaps in its canvas live
  stroke.
- **App** (`app.ts`): `createAnnotator()` ties doc, tools, input, toolbar and keys together:
  current tool, colors and sizes (stored in `localStorage`; a size is a step of the scale
  `SIZES`, stored with the nearest of the four old sizes for earlier versions and the Marp
  decks), selection, undo/redo, the
  `PagesController` and overview supplied by the viewer.
- **Toolbar** (`toolbar.ts`, `toolbar.css`): the Marp Notes bar, built from registered groups
  (`mode, tools, colors, sizes, history, edit, pages, file`); dockable on four edges. `bindKeys`
  installs the shortcut table on `window` in the capture phase.
- **Clipboard** (`clipboard.ts`): copy and paste of strokes. One clip per window, shared by
  the documents opened in it, and written to the system clipboard as JSON text with a format
  marker (`inkslide-strokes`). Ctrl/Cmd+C, X and V are left to the browser, whose copy, cut and
  paste events carry the system clipboard without a permission prompt; where no event follows
  (Electron on macOS has no Edit menu, Safari fires no paste event on a page) the app does it
  itself, reading the system clipboard with `navigator.clipboard.readText` (as does the paste
  button) and falling back to the window's clip where reading is refused. `clipForPaste`
  decides: a clip on the system clipboard wins; other text pastes nothing once the window's
  clip had reached the system clipboard. `placeClip` gives a paste new ids, scales it to the
  target page, offsets it while it would cover equal strokes (never onto one) and clamps it to
  the page; the app adds it with one `NotesDoc.addStrokes` command. The keys are off while the
  overview is open.
- **Geometry** (`geometry.ts`): pure math: smoothing, pressure width, stroke outlines (classic
  Marp outline or perfect-freehand), bounding boxes, hit tests, partial erase, lasso.

## Platform adapter and the Electron bridge

The front end never touches files itself. It talks to a `PlatformAdapter`
(`packages/annotate/src/io.ts`):

| Method | Desktop | Web | Tauri (iPad, Android) |
|---|---|---|---|
| `openPdf(path?)` | open dialog, or a granted path | file input, or a same-site URL (`?pdf=`) | system picker (`pick_file`, `read_picked` commands) |
| `readNotes(pdf, sha256)` | sidecar or app storage, the newer one | OPFS, else `localStorage` | app data `notes/<sha256>.notes.json` (`read_notes` command) |
| `writeNotes(pdf, text, sha256)` | atomic write, sidecar or app storage | OPFS, else `localStorage` | `write_notes` command: temp file, then rename |
| `exportPdf(bytes, name)` | save dialog, atomic write | save picker, share sheet, else download | iOS: share sheet; Android: save dialog (`save_pdf` command) |
| `print(bytes, name)` | the PDF itself in a hidden window, system dialog | – (page images, `window.print()`) | share sheet |
| `importNotes()`, `confirm()` | native dialogs | file input, `window.confirm` | native dialogs |
| `onOpenRequest(fn)` | second instance, macOS `open-file`, recent files | – | – |
| `opened(pdf, info)` | tracks the open PDF (Revert to Backup); hash and page count for the recent files | recent files | – |
| `recentFiles()`, `removeRecent(path)` | recent files on the start screen (existing files, size, pages with notes) | – (`recent` in the web adapter) | – |
| `readBackup`, `revertToBackup`, `keepUnreadableNotes` | backup in app storage, made by `writeNotes`; copy of an unreadable notes file; off in the File menu | backup and unreadable copy in OPFS; no switch | – |
| `onPresenter`, `presenterSend`, `onAudience` (bridge only) | presenter mode: messages to the audience window, relayed and checked by main | – | – |

`apps/web/src/platform/index.ts` picks the adapter: `window.inkslide` if the preload put it
there, `createTauriAdapter()` when `window.__TAURI_INTERNALS__` exists, else
`createWebAdapter()`. The Tauri adapter imports its Tauri packages on first use, so they stay
out of the main bundle. On mobile there are no sidecars: picked files are security-scoped
copies (iPadOS) or content URIs (Android), so notes live in the app data directory keyed by
hash. The page has no fs plugin permission (on mobile it reads and writes file and content
URLs without a scope check): every file access is one of the shell's commands
(`apps/mobile/src-tauri/src/lib.rs`), which take a notes key or a checked file name, never a
free path, read only files picked through them, and write only in the app's folders or to
the file picked in a save dialog they open themselves.
Both the page's CSP and the shell's must allow Tauri's IPC (`ipc:`,
`http://ipc.localhost`); the page adds them only in the Tauri build
(`pnpm --filter @inkslide/web build:tauri`, the shell's `beforeBuildCommand`),
so the browser and Electron builds cannot reach it; see [apps/mobile/README.md](../apps/mobile/README.md).

**Electron bridge.** `apps/desktop/src/shared/bridge.ts` declares `InkslideBridge` (the
adapter plus `initialPath`, `pathForFile`, `onMenuCommand`, `onCloseRequest` and the
presenter mode calls `onPresenter`, `presenterSend`, `onAudience`) and the IPC channel names. The preload (`contextIsolation`, `sandbox: true`, no Node in the page) exposes
it with `contextBridge`; each method is an `ipcRenderer.invoke` to a handler in `main.ts`.

Main checks every call:

- the sender must be the app's window;
- a PDF path must have been chosen by the user (`PathGrants` in `access.ts`): open dialog,
  command line, OS open request, recent files, or a dropped file granted through
  `pathForFile` (`webUtils.getPathForFile`, synchronous IPC so the grant is in place before
  the following `openPdf`). Main cannot tell a real drop from a renderer that names a path, so
  only `.pdf` files are granted that way; others open from their bytes;
- hashes must be 64 hex characters, text and PDFs have size limits;
- an export may not overwrite the open PDF (also not through a link or another letter case).

Main to renderer messages: `openRequest` (queued in the preload until the front end
subscribes), `menuCommand` (Export, Import notes), `closeRequest`, and for presenter mode
`presenterState` (to the app window) and `audience` (to the audience window). On window close, main
cancels the close, asks the front end to flush its notes, and closes when the reply is `ok`.
If saving fails, the user is asked. `will-quit` waits for notes writes still running. Open
requests that come before the page has loaded wait in `OpenRequests` (the first one is
`initialPath()`); a reloaded page gets the PDF it showed. Reload is in the menu of development
builds only, since it skips the save before closing. If the page's renderer process dies
(crash, killed for memory), main reloads the page and it reopens the PDF; open requests that
come meanwhile are queued. If it dies again within 5 minutes of a reload, or before the
reloaded page saved its notes, the user chooses: reload, reload
without the PDF, or close the window (`crashRecovery.ts`). During the close handshake the
window simply closes.

All windows (the app, the audience window of presenter mode and the hidden print window) are
locked down by `harden.ts`: context isolation, sandbox, no Node; no navigation, no new windows;
every permission request and check is refused except fullscreen. Only the app window hands
http(s) links to the system browser; in the audience and print windows they are only refused.

## Presenter mode

View → Presenter Mode (F5, desktop only) opens a second window, the audience window, for a
projector: full screen on a display other than the app window's, else a 960×540 window
(`apps/desktop/src/main/presenter.ts`, `audiencePlacement`). On Wayland it is always the
window: the compositor ignores positions, so a full-screen window could cover the app window
on its own display. It loads `audience.html` of the
same front end build, as `app://inkslide/audience.html` like the app window's page (a second Vite entry, `apps/web/src/audience.ts`) with the same
webPreferences and preload. Main answers none of its bridge calls (every handler checks that
the sender is the app window), so it reads no files; it only receives.

```
 app window                         main                          audience window
 viewer.ts ── presenter.ts ──presenterSend──► parsePresenterMessage ──audience──► audience.ts
   (ViewerMirror hooks)      ◄─presenterState── (audience loaded / closed)          NotesDoc (never saved)
```

- **Messages** (`packages/annotate/src/presenter.ts`): `open` (the PDF bytes and title),
  `notes` (the notes file text), `close` (with a reason when the PDF is too large or could
  not be sent), `page`, `strokes` (all strokes of one page), `delta` (a page's stroke ids in
  order, and only the new and changed strokes), `blanks` (every blank page), `live` (the stroke being written, points from index `from`
  on), `live-end` and `laser` (points). `parsePresenterMessage` rebuilds a message from its
  known fields and refuses wrong types and oversized ones; main runs it before relaying, the
  audience page again on arrival, and `createStroke` checks strokes once more when they are
  applied.
- **Presenter side** (`apps/web/src/presenter.ts`): the viewer reports the opened PDF and its
  `NotesDoc`, the page shown, the stroke being written (a wrapper around the live ink
  renderer) and the laser (`ToolHost.sync`). When main says the audience page has loaded
  (`presenterState` true; also after a reload of either window), everything is sent. Then a
  finished edit sends its page's changes at the end of the task: all its strokes the first
  time, after that a `delta` (strokes are immutable, so a changed stroke is a new object).
  Blank page changes and page turns go at once; a load (import, revert) sends the notes
  again. A PDF over 256 MB is not mirrored (its bytes cross IPC twice, each time presenter
  mode starts or a window reloads): the audience window says so, as it does when the PDF
  cannot be sent or opened. The stroke being written
  and the laser go at most every 30 ms (`LIVE_MS`), the stroke with only the points that
  changed since the last message (`commonPrefix`). `live-end` follows the finished stroke's
  `strokes`, so the audience never shows neither.
- **Audience side** (`audience.ts`): messages are handled one at a time, in order (opening the
  PDF is async). The PDF is rendered with PDF.js like the viewer's (bitmap cache, the next
  page pre-rendered), always the whole page fitted to the window; notes go into a `NotesDoc`
  through `load`, `applyRemoteStrokes` (which keeps a stroke it already has, so its SVG node
  is not drawn again) and `applyRemoteBlanks`; the live stroke and the laser
  are drawn in the page's SVG (`render.liveStroke`, `render.laser`). Nothing takes input.
- **Ending:** closing the audience window, F5 or View → Presenter Mode again, or Escape in the
  audience window (which has no menu on Linux and Windows; F11 there toggles full screen).
  Closing the app window closes the audience window.

Erasing and moving strokes are mirrored when they are done, not while they happen. The
browser, PWA and Tauri builds have no presenter mode: the presenter and audience modules are
transport independent, so a `BroadcastChannel` and `window.open` could carry the same
messages there.

**userData** (`~/.config/Inkslide` on Linux): `notes/` (notes that cannot go next to the PDF,
backups, kept unreadable copies), `recent-files.v2.json` (older builds: `recent-files.json`), `window-state.json`,
`preferences.json`, and `Crashpad/`: `crashReporter.start({ uploadToServer: false })` in
`main.ts` keeps a minidump of each native crash (main, GPU or renderer process) there; nothing
is uploaded.

The front end is not loaded from `file://`: a `file://` page counts every local file as its
own origin, so its CSP `'self'` and `fetch` would reach any file (a PDF.js exploit could read
`~/.ssh`). Main registers the privileged scheme `app` (standard, secure, fetch) and serves
`resources/web` (in development `apps/web/dist`) as `app://inkslide/`; the handler maps a URL to
a file of that folder only (`webFileFor` in `paths.ts`: no `..`, encoded slashes or other
hosts). The built page's CSP (`apps/web/vite.config.ts`) then limits scripts, workers, fetch and
wasm to that origin. The print window still loads its temp PDF with `loadFile`, which the fuses
below do not affect. Packaged builds flip Electron fuses (`electronFuses` in
`electron-builder.yml`): no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`, no extra
`file://` privileges, app code only from `app.asar`, with its integrity checked on macOS and
Windows.

## Autosave

`createAutosave()` (`packages/annotate/src/autosave.ts`) is pure and shell independent:

- every model change marks the notes dirty; the write follows 2 s after the last change;
- a page turn, Ctrl/Cmd+S, opening another PDF, hiding the page and closing the window write
  at once (`flush()`);
- writes never overlap: a request during a write waits and then writes the newest state once;
- a failed write is retried with exponential backoff (1 s, doubling, at most 30 s); edits
  keep being collected meanwhile;
- the state (`saved`, `dirty`, `saving`, `error`) colors the save button.

`apps/web/src/persist.ts` keeps one controller per open document and writes through the
adapter. Notes that exist but cannot be read or parsed are never overwritten without asking
(see Backup for the second read, the backup offer and the kept copy).

### Backup

Desktop only, and all in the main process (`apps/desktop/src/main/notes.ts`): the backup is a
copy of the saved notes from before a save, `userData/notes/<sha256>.notes.backup.json`.

- `writeNotesFor(…, backup)` (the `writeNotes` handler passes the preference) first runs
  `backupBeforeSave`: if the backup is missing or older than 2 minutes (mtime) and the saved
  notes (what `readNotesFor` returns) parse and are not empty, they are copied there
  atomically. Then the new notes are written. A failed copy is logged and never stops the save;
  an unreadable or invalid notes file is never copied.
- `revertToBackupFor` (File → Revert to Backup…, IPC `revertToBackup`) writes the backup as the
  notes and the saved notes as the backup (the backup first: if the notes write then fails,
  both are put back), so a second revert undoes the first; the fresh
  backup time keeps the next saves from replacing it for 2 minutes. The front end saves first,
  asks with `confirm`, then loads the notes the revert returns into the document (`replaceNotes` in
  `viewer.ts`, like Import; `NotesDoc.load` clears the history, so it is no undo step).
- Main tracks the open PDF (the bridge's `opened`, called once a PDF has opened) and enables
  Revert to Backup when backups are on and that PDF has a backup. Turning backups off
  (`preferences.ts`) deletes every backup in `userData/notes` (`removeAllBackups`).
- Open (`viewer.ts`): notes that cannot be read or loaded are read again after
  `NOTES_RETRY_MS` (1 s). If they still fail and `readBackup` loads into a fresh document, the
  user is asked whether to open it instead; no (or no backup) leads to the "open anyway?"
  question. Before the session starts either way, `keepUnreadableNotes` (`keepUnreadableFor`)
  copies the file as it is to `userData/notes/<sha256>.notes.unreadable.json`, and a banner
  says where.
- Startup: `cleanupNotesStore` deletes backups and unreadable copies older than
  `OLD_COPIES_MAX_AGE_DAYS` (90) in the background, logging failures.
- A legacy `<pdf>.notes.backup.json` next to the PDF (development builds) is deleted on open.

The browser adapter (`apps/web/src/platform/web.ts`) keeps a backup with the same rules
(`isUsableNotes`, `BACKUP_MIN_AGE_MS`, `UNREADABLE_SUFFIX` and `OLD_COPIES_MAX_AGE_DAYS` are
shared from `@inkslide/annotate/io`), as the OPFS file
`notes/inkslide-notes_<sha256>.notes.backup.json`; its time is the file's `lastModified`
(a save looks at that and the size only, never reads the backup). Where the page cannot write
OPFS (Safari 17-18) there is none: a `localStorage` copy would halve the room the notes
themselves fall back to.

- `writeNotes` reads the notes it is about to replace if a backup is due, writes the new
  notes, and only then the backup, so near the quota the backup never takes the room the
  notes need. A failed backup read or write is logged and never fails the save.
- An OPFS notes file that exists but cannot be read rejects (only `NotFoundError` means "no
  notes"), so `readNotes` reports it and `revertToBackup` stops without changing anything;
  but if `localStorage` holds the key (where a failed OPFS write put the newer notes), that
  copy is read.
  If writing the reverted notes fails and putting the backup back fails too, the error says so.
- `keepUnreadableNotes` copies the text as it is to `….notes.unreadable.json` and returns
  where; it rejects if it cannot (the viewer then asks).
- The adapter wraps the recent files' storage so that a PDF dropped from them (evicted or
  removed) loses its backup, not its unreadable copy (maybe the only copy of real notes);
  `cleanupNotesStore`, run when the adapter is made, deletes backups and unreadable copies
  older than 90 days, reading each file's time again just before deleting it.
- The viewer shows a Revert to Backup button in the toolbar's File group (hidden while there
  is none, via the item's `hidden()`) for adapters with `revertToBackup` that are not
  Electron, which has the menu. It asks `readBackup` when a PDF opens, after each save until
  there is one, and when the tab becomes visible again; a click that finds none hides it.

The Tauri adapter has no backup yet (see [NOTES-FORMAT.md](NOTES-FORMAT.md#where-the-file-lives)).

## Rendering pipeline

One page is shown at a time (`apps/web/src/viewer.ts`):

```
 .ink-stage
  └ .ink-page          fitted page box; pinch zoom = CSS transform on this box
     ├ canvas.ink-pdf  PDF.js render of the page, drawn from an ImageBitmap
     ├ svg.ann-page    annotation surface, viewBox = page size in points
     └ canvas.ink-live stroke being drawn (desynchronized 2D canvas)
```

1. **PDF.js** (`pdf.ts`) renders pages in its worker through one priority queue: the page on
   screen first, then neighbours, then overview thumbnails. Data files (CMaps, fonts, wasm)
   are bundled; nothing comes from a CDN. The legacy build is used for older iPad Safari
   (Electron 43 would run the modern one).
2. **Bitmap cache** (`bitmap-cache.ts`): an LRU of at most 6 `ImageBitmap`s keyed by page and
   scale. The current page renders at `fit scale × devicePixelRatio × zoom`; the previous and
   next page are pre-rendered at fit size, so a page turn only draws a bitmap. While the exact
   bitmap renders, any cached scale of the same page stands in. The fit is "page" (whole
   page) or "width" (`fit.ts` `fitWidth`, W key): a page taller than the stage scrolls, and
   the scroll is the view's `ty`, so zoom, pan and scroll are one transform of `.ink-page`.
   The view's zoom is a factor of the fit (1 = fitted, at most 6). The − and + next to the
   page counter (and Ctrl/Cmd+= / Ctrl/Cmd+−) step through `fit.ts` `ZOOM_STEPS` around the
   middle of the view (`zoomAround`), through the same `setView` as the pinch.
3. **SVG annotation surface** (`render.ts`, `createPageSurface`): an `<svg>` with the page's
   size as viewBox and one `g.ann-layer` with highlighter strokes below pen strokes and a UI
   group (selection, marquee, eraser cursor, laser). Blank pages get paper under the layer.
   `syncLayer` reuses unchanged path nodes. Surfaces are created per page on demand and kept.
4. **Live ink** (`live-ink.ts`): the stroke being drawn goes to a 2D canvas created with
   `desynchronized: true`, fed straight from pointer events (coalesced and predicted points)
   and redrawn in the event handler. On pen up the tool adds the real stroke to the model,
   which syncs the SVG in the same task, so nothing flickers.

The overview (`overview.ts`) is a grid of small PDF.js renders, made lazily when a tile
scrolls into view, with the page's notes as SVG on top.

## Input and palm rejection

- `input.ts` routes pointer events on a surface to the active tool, mapping client to page
  coordinates with the SVG's screen matrix and using coalesced events. Pressure is used only
  for `pointerType === 'pen'`.
- Pen buttons: the eraser end (button mask 32) uses the stroke eraser; the side button (mask 2
  in Electron, 4 in Chromium) uses the side-button tool, by default also the stroke eraser.
- Once a pen has been seen (touching or hovering), touch never draws. A pen that comes down
  or starts hovering while a finger draws discards the finger's stroke (a palm), and so does
  a second finger. `input.ts`'s own two-finger swipe (for hosts without `gestures.ts`) is
  ignored while a gesture runs and for 500 ms after a pen event.
- `gestures.ts` runs in the capture phase on the stage, before `input.ts`: one finger draws
  until a pen is seen, then pans a zoomed page; two fingers pinch-zoom and pan, or turn the
  page with a quick sideways swipe; Ctrl + wheel zooms (the − and + buttons and Ctrl/Cmd+= and
  Ctrl/Cmd+− are the viewer's). While the pen touches or hovers, and
  500 ms after, touch is ignored, and a pinch or pan already running is ended.
- Keys: the overview's G + number handler, then the viewer's page keys, then the toolbar's
  keymap, all on `window` in the capture phase. See [USER-GUIDE.md](USER-GUIDE.md).

## Export

`@inkslide/export` (`exportAnnotatedPdfWithReport`) loads a copy of the original bytes with
pdf-lib and reads the notes through `NotesDoc` and `io.loadNotes`, so v1 notes are scaled
and bad pages are reported as warnings. For each page in reading order it:

- inserts blank pages at their place, with white paper and the rules or grid as filled
  rectangles;
- appends one content stream with the strokes as vector paths in display coordinates
  (`displayMatrix` maps them through the CropBox and `/Rotate`). Pen strokes are the same
  filled outline as on screen; highlighter strokes are stroked centerlines with opacity 0.35
  and multiply blend, below the pen;
- leaves the existing content streams alone (only wrapped in `q/Q`), so text stays selectable.

An encrypted PDF (usually an owner password against changes, which PDF.js still displays) is
refused with a plain message: pdf-lib cannot decrypt it.

The web app imports the package lazily on the first export, so pdf-lib stays out of the
startup bundle. The adapter then saves the bytes.

## Tests

- Unit tests (Vitest) in each package's `test/`: geometry, model, io (v1/v2), tools, input,
  autosave, DOM rendering (happy-dom), legacy parity, presenter messages; export (checked with
  PDF.js); web helpers, the web adapter and the presenter side of presenter mode; desktop path
  rules, notes and backup stores, preferences, file helpers, open requests, menu, window
  hardening, audience window placement, packaging config.
- End-to-end tests (Playwright) in `apps/web/e2e` against the production build, with
  synthetic pen and touch events; `backup.spec.ts` uses a stand-in Electron bridge for the
  second read, the backup offer, the kept unreadable copy and Revert to Backup;
  `presenter.spec.ts` passes an app window's presenter messages to the audience page.
- Desktop smoke test (`apps/desktop/test/smoke.mjs`) launches Electron with a fixture page
  and drives the bridge end to end (also the backup and revert, the unreadable copy, cleanup
  of old copies, switching backups off, printing, a second instance
  and a desktop entry). Its environment variables (`INKSLIDE_PAGE`, `INKSLIDE_SMOKE`,
  `INKSLIDE_USER_DATA`, `INKSLIDE_PRINT_TO_PDF`) are ignored by packaged builds unless they
  were packaged as test builds (`dist.mjs --test-build`, packages named `*-TEST*`), so a
  release cannot be pointed at another page.
