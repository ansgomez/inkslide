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
| `apps/mobile` | `@inkslide/mobile` | Tauri 2 shell for iPad and Android (`src-tauri`): loads `apps/web/dist`, plugins dialog, fs and sharekit (used from Rust only), and its own commands for every file access and sharing (the page has no fs or sharekit permission). No front-end code of its own. |

`packages/annotate/legacy/` holds two original Marp Notes modules for parity tests;
`packages/annotate/PORTING.md` lists what changed in the port.

## The annotation core

- **Model** (`model.ts`): `NotesDoc` holds the deck info and the pages. Source pages are
  `p<n>` (PDF) or `s<n>` (Marp); blank pages sit after a source page. Strokes are immutable;
  every edit replaces a page's stroke array through a `Command` on the `History`, so each
  finished gesture is one undo step. Pages also hold images (snapshots: PNG or JPEG data URLs
  in a rectangle, below all ink) in a second immutable array; `replaceContent` changes strokes
  and images in one command, and limits per image, page and document keep the notes file small.
  `toJSON()` / `load()` are the notes file format (see [NOTES-FORMAT.md](NOTES-FORMAT.md); a
  file with images is version 3). Change events (`strokes`, `pages`, `saved`) drive rendering
  and autosave.
- **Tools** (`tools.ts`): pen, highlighter, selector (tap, box, lasso; move and restyle),
  laser, stroke eraser and partial eraser, snapshot. Each tool handles `down / move / up /
  cancel / hover / leave` with points in page units and edits only through `NotesDoc`. The
  selector and the stroke eraser take images too (the partial eraser leaves them alone). The
  snapshot tool only drags a rectangle and hands it to the app. The render functions are
  injected (`ToolRenderer`), which is how the web app swaps in its canvas live stroke.
- **App** (`app.ts`): `createAnnotator()` ties doc, tools, input, toolbar and keys together:
  current tool, colors and sizes (stored in `localStorage`; a size is a step of the scale
  `SIZES`, stored with the nearest of the four old sizes for earlier versions and the Marp
  decks), selection, undo/redo, the
  `PagesController` and overview supplied by the viewer. The host supplies what needs the PDF
  or the DOM: `captureArea(pageId, rect)` draws a snapshot (the core has no PDF renderer),
  `importImage(blob)` scales an image pasted from another program, and `notify` shows messages.
- **Toolbar** (`toolbar.ts`, `toolbar.css`): the Marp Notes bar, built from registered groups
  (`mode, tools, colors, sizes, history, edit, pages, file`); dockable on four edges. `bindKeys`
  installs the shortcut table on `window` in the capture phase.
- **Clipboard** (`clipboard.ts`): copy and paste of strokes and images. One clip per window, shared by
  the documents opened in it, and written to the system clipboard as JSON text with a format
  marker (`inkslide-strokes`). Ctrl/Cmd+C, X and V are left to the browser, whose copy, cut and
  paste events carry the system clipboard without a permission prompt; where no event follows
  (Electron on macOS has no Edit menu, Safari fires no paste event on a page) the app does it
  itself, reading the system clipboard with `navigator.clipboard.readText` (as does the paste
  button) and falling back to the window's clip where reading is refused. `clipForPaste`
  decides: a clip on the system clipboard wins; other text pastes nothing once the window's
  clip had reached the system clipboard. `placeItems` gives a paste new ids, scales it to the
  target page, offsets it while it would cover equal strokes or an equal image (never onto
  one) and clamps it to the page; the app adds it with one `NotesDoc.addItems` command. A
  snapshot becomes the window's clip: an image at the captured area, also written to the
  system clipboard as a PNG (`ClipboardItem`) next to the clip text where the platform allows
  it (Electron refuses clipboard permissions, see `harden.ts`; the window's clip still works).
  A paste event with no clip of Inkslide's but an image file goes to `importImage`. The keys
  are off while the overview is open.
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
| `exportPdf(bytes, name)` | save dialog, atomic write | save picker, share sheet, else download | iOS: share sheet; Android: save dialog (`save_pdf` command; a local file atomically, a content URI written in place once the PDF is ready) |
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
free path, read only files picked through them, write only in the app's folders or to
the file picked in a save dialog they open themselves, and share only a file they wrote for
sharing (`share_pdf` calls the sharekit plugin from Rust; the page has no sharekit
permission, as its command shares any file URL).
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
- a PDF hash in a notes, backup or revert call must be one main computed itself
  (`HashGrants` in `access.ts`): of a PDF it read, or of the bytes a PDF without a path
  comes with (the preload sends them until main has taken that hash). A hash alone, of a
  PDF never opened, reaches no notes in app storage;
- hashes must be 64 hex characters, text and PDFs have size limits (notes in UTF-8 bytes,
  256 MB; PDFs 2 GB). Main reads a PDF, an imported notes file or a sidecar through one
  handle: only a regular file (no FIFO or device), its size taken from that handle, and the
  read stops at the limit (`fsutil.ts`, `readFileLimited`, `readFileChecked`). PDF bytes
  from the page (export, print) have the PDF limit, and a window prints one PDF at a time
  (`print.ts`, `PrintGate`: another request while its dialog is open is refused);
- an export may not overwrite the open PDF (also not through a link or another letter case);
  that is the PDF the page reported with `opened()`, not one main read that the page then failed
  to load or did not switch to (`CurrentPdf` in `openRequests.ts`),
  and a symlink at the chosen name is replaced by the export, never written through
  (`writeExport`).

Main to renderer messages: `openRequest` (queued in the preload until the front end
subscribes), `menuCommand` (Export, Import notes), `closeRequest`, and for presenter mode
`presenterState` (to the app window) and `audience` (to the audience window). On window close, main
cancels the close, asks the front end to flush its notes, and closes when the reply is `ok`.
If saving fails, the user is asked; if the front end's close handler itself fails, the
preload replies `failed` and main asks whether to close anyway (never closing unasked). Closing again while the front end is asked is cancelled
too, so a double click or a second Cmd+Q does not skip the save. If the page does not reply
within 15 s (a hung renderer), main asks whether to close anyway and lose the unsaved notes,
again after each wait, but not while the page's own question is open (`closeHandshake.ts`). `will-quit` waits for notes writes still running. Open
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
http(s) links to the system browser, and only after the user confirms each in a native dialog
that shows its host and whole URL (`confirmLinks`; one question at a time, links over 2048
characters dropped): the page cannot prove a click, and a compromised page could otherwise
send data out in a URL. The front end has no links of its own today. In the audience and
print windows links are only refused.

## Presenter mode

View → Presenter Mode (F5) opens a second window, the audience window, for a
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
  order, and only the new and changed strokes), `images` (all images of one page, with the
  image data only for images the audience does not have yet), `blanks` (every blank page), `live` (the stroke being written, points from index `from`
  on), `live-end`, `laser` (points), and the previews of an erase or a move while it
  happens: `erasing` (the ids of the strokes the page shows, in order, the pieces cut from
  strokes that the audience does not have yet, the ids of erased images), `moving` (ids and
  offset) and `preview-end`. `parsePresenterMessage` rebuilds a message from its
  known fields and refuses wrong types and oversized ones; main runs it before relaying, the
  audience page again on arrival, and `createStroke` / `createImage` check strokes and images
  once more when they are applied (`applyRemoteStrokes`, `applyRemoteImages`). Images have
  the notes file's limits: at most 32 per page and 24 MB of image data per message.
- **Presenter side** (`apps/web/src/presenter.ts`): the viewer reports the opened PDF and its
  `NotesDoc`, the page shown, the stroke being written (a wrapper around the live ink
  renderer) and the laser (`ToolHost.sync`). When main says the audience page has loaded
  (`presenterState` true; also after a reload of either window), everything is sent. Then a
  finished edit sends its page's changes at the end of the task: all its strokes the first
  time, after that a `delta` (strokes are immutable, so a changed stroke is a new object). A
  page whose images changed sends an `images` message first; images in the notes sent count as
  known, so a moved image goes without its data.
  Blank page changes and page turns go at once; a load (import, revert) sends the notes
  again. A PDF over 256 MB is not mirrored (its bytes cross IPC twice, each time presenter
  mode starts or a window reloads): the audience window says so, as it does when the PDF
  cannot be sent or opened. The stroke being written
  and the laser go at most every 30 ms (`LIVE_MS`), the stroke with only the points that
  changed since the last message (`commonPrefix`). `live-end` follows the finished stroke's
  `strokes`, so the audience never shows neither.
  Erasing and moving are mirrored while they happen: the erasers and the selector report
  their preview through `ToolSync.preview` (`ToolHost.sync`) and its end after their command
  (or on cancel). The presenter sends the latest preview at most every `LIVE_MS`, as ids and
  an offset, with each cut piece only once; at the end the page's real changes go first and
  `preview-end` after them in the same task. An audience that loads mid-gesture gets the
  preview with all its pieces again.
- **Audience side** (`audience.ts`): messages are handled one at a time, in order (opening the
  PDF is async). The PDF is rendered with PDF.js like the viewer's (bitmap cache, the next
  page pre-rendered), always the whole page fitted to the window; notes go into a `NotesDoc`
  through `load`, `applyRemoteStrokes` (which keeps a stroke it already has, so its SVG node
  is not drawn again) and `applyRemoteBlanks`; the live stroke and the laser
  are drawn in the page's SVG (`render.liveStroke`, `render.laser`). A preview is drawn over
  the page (`syncLayer` with the previewed strokes, `translateStrokes` for a move) and
  `preview-end` draws the page as its document has it again. Nothing takes input in the
  desktop app.
- **Ending:** closing the audience window, F5 or View → Presenter Mode again, or Escape in the
  audience window (which has no menu on Linux and Windows; F11 there toggles full screen).
  Closing the app window closes the audience window.

**In the browser and the PWA** (`apps/web/src/presenter-web.ts`, `presenter-link.ts`) there is
no main process. F5 (with a PDF open) or the toolbar's presenter button opens
`audience.html#<id>` with `window.open` (a click or a key: pop-up blockers allow only
those; a blocked pop-up shows a banner). The two windows talk over a `BroadcastChannel` named
after `<id>`, a per-tab id kept in sessionStorage. A channel rather than the pop-up's
`postMessage`: only same-origin pages can join it (the browser enforces it, nothing to check
by hand), and either window can reload and find the other again; a reloaded tab has no
reference to the pop-up it opened. The same presenter (`createPresenter`) sends through it,
and the audience checks every message with `parsePresenterMessage` as on the desktop.

```
 presenter tab                    BroadcastChannel inkslide-presenter-<id>     audience pop-up
 presenter.ts ── PresenterLink ──► m (presenter message) ─────────────────► AudienceLink ── audience.ts
               ◄── hello / bye ──                         ◄── ready / gone / quit ──►
```

The tab id must be the tab's alone, but a tab duplicated by the browser copies
sessionStorage, and so the id. The tab holds a Web Lock named after its id for the page's
life (`navigator.locks`, `ifAvailable`; the browser lets it go when the page closes or
crashes) and joins the channel only once it has it. A tab that cannot get it takes a new id
(its own channel and pop-up name); the id kept from before a reload is tried a few times
first (100 ms apart), as the page before may not have let go yet. Back from the
back/forward cache the tab checks the lock again (`locks.query`, with a lock only this page
holds to find its client id): still its own, or free and taken again, it says `ready`; held
by another tab, it moves to a new id and leaves that tab the audience window. Where there are
no Web Locks, a loading tab `probe`s its channel instead, a tab still open answers `taken`,
and after 400 ms without an answer (`PROBE_MS`) it says `ready`.

The link (`parseLinkMessage` checks it): every window has a link id of its own, new on each
page load. The audience says `hello` when it loads and answers every `ready` with one (also
from the presenter it follows: a tab reloaded without `gone` after a crash or a discard), to
the presenter whose `ready` it heard last, and that presenter sends everything
(`setActive(true)`); it ignores messages from any other. `bye` (the audience window closes,
reloads or goes into the back/forward cache; also the pop-up seen closed, checked every
second) stops the sending. `gone` (the presenter tab closes, reloads or goes into the
back/forward cache) makes the audience wait; so does a presenter that stops answering: the
audience `ping`s it every 2 s (`BEAT_MS`) and counts it gone after two pings without a `beat`
or any other message (about 6 s: crashed, killed, frozen). The audience drives this because
a hidden presenter tab's timers are throttled, its message handlers are not. From its start
until a presenter first answers, and after a presenter is gone, the audience closes itself if
none comes within 10 s (`GRACE_MS`); `quit` (F5 again) closes it. After a reload the tab
finds its audience window again on its channel, so F5 closes that window rather than
opening another; the pop-up's name is the tab id's, so opening again reuses a window of the
same tab rather than piling up windows. While a PDF is open, F5 in a text field does nothing
(a reload would lose the text). The audience page shows a hint to click
(or press F11) for full screen, as a page may only ask for it on a click, and closes on F5 or
Escape out of full screen. `audience.html` is a second Vite entry, so it gets the same CSP
and is in the service worker's precache (it works offline). The Tauri builds have no
presenter mode (no second window on phones and tablets): no button, and F5 is left alone.

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

Each write serializes the whole notes file, the base64 data of every image included (images
are not stored apart). That cost is why images have limits (`model.ts`: 3 MB per image, 32 per
page, 24 MB per document, 4096 px per side): with them a save writes at most about 24 MB.

`apps/web/src/persist.ts` keeps one controller per open document and writes through the
adapter. Notes that exist but cannot be read or parsed are never overwritten without asking
(see Backup for the second read, the backup offer and the kept copy).

A browser does not wait for an asynchronous write when a tab closes or reloads. So in the
browser build (`main.ts`), hiding or leaving the page (`visibilitychange`, `pagehide`,
`beforeunload`) with unsaved notes first calls `viewer.checkpoint()`: the web adapter's
synchronous `checkpointNotes` writes the notes to their `localStorage` key with their time
(`inkslide-notes-time:<sha256>`, see the browser adapter under Backup), and the flush follows.
Notes longer than `CHECKPOINT_MAX_CHARS` (1 M characters; `localStorage` holds about 5 MB) or a
full store skip it, and then `beforeunload` asks the browser to confirm leaving. The next open
reads the checkpoint only if it is newer than the OPFS file, by the time each save began: a
save that began before the checkpoint and ended after it keeps it, one that began after it
removes it, so it never hides notes saved later (another tab, a later session).

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
  `viewer.ts`, like Import; `NotesDoc.load` clears the history, so it is no undo step). From
  the final save until the notes are loaded the page box is `inert` (no pen input), and the
  swap runs under `holdSaves` (`persist.ts`: no autosave write at the same time). If the notes
  changed anyway (a key such as undo), the viewer reverts once more inside the hold, which
  swaps the files back, keeps its notes and says so.
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
- Notes are written to OPFS, else to `localStorage`; the other copy is then removed. Both can
  remain (removing the older OPFS file failed too), so the `localStorage` item
  `inkslide-notes-time:<sha256>` keeps when each copy was saved, `{local, opfs}`, as stamps
  taken when the save began: `readNotes` reads the newer copy, and the OPFS file when the
  `localStorage` copy has no time (older data). A write keeps a copy newer than its own start.
  A stamp (`stampOf`) is `Date.now()` but at least one above the last stamp of that key
  (`seq`, and the copies' own), so it rises strictly even within one millisecond, and stays
  comparable with the plain ms times of older markers and with OPFS `lastModified`.
  `writeOpfsFile` aborts a writable whose write or close failed, so the file is not left locked.
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
   size as viewBox and one `g.ann-layer` with images (`<image>` with a data URL) below
   highlighter strokes below pen strokes and a UI group (selection, marquee, eraser cursor,
   laser). Blank pages get paper under the layer. `syncLayer` and `syncImages` reuse unchanged
   nodes. Surfaces are created per page on demand and kept.
4. **Live ink** (`live-ink.ts`): the stroke being drawn goes to a 2D canvas created with
   `desynchronized: true`, fed straight from pointer events (coalesced and predicted points)
   and redrawn in the event handler. On pen up the tool adds the real stroke to the model,
   which syncs the SVG in the same task, so nothing flickers.

The overview (`overview.ts`) is a grid of small PDF.js renders, made lazily when a tile
scrolls into view, with the page's notes as SVG on top.

A snapshot (`snapshot.ts`) is drawn apart from the screen: PDF.js renders only the area again
(`PdfDoc.renderArea`, a viewport offset) at the page's render scale, at least 2 px per CSS px
and at most 2048 px on the long side; a blank page gets its paper drawn instead. The page's
images, highlighter strokes (opacity 0.35, multiply) and pen strokes follow on a 2D canvas,
as `render.ts` and `toolbar.css` draw them. It is encoded as PNG, or as JPEG (quality 0.9)
when the PNG exceeds the per-image limit, scaled down further if even that does.

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
  until a pen is seen and never pans; two fingers pan (and zoom past an 8 % spread change), or turn the
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
  (`displayMatrix` maps them through the CropBox and `/Rotate`, and a page's `/UserUnit` is
  divided out, as PDF.js scales by it). Pen strokes are the same filled outline as on screen;
  highlighter strokes are stroked centerlines with opacity 0.35 and multiply blend, below the
  pen; images are image XObjects (`embedPng` / `embedJpg`, each distinct image once) below
  all ink;
- leaves the existing content streams alone (only wrapped in `q/Q`), so text stays selectable.

An encrypted PDF (usually an owner password against changes, which PDF.js still displays) is
refused with a plain message: pdf-lib cannot decrypt it.

The web app imports the package lazily on the first export, so pdf-lib stays out of the
startup bundle. The adapter then saves the bytes.

## Tests

- Unit tests (Vitest) in each package's `test/`: geometry, model, io (v1/v2), tools, input,
  autosave, DOM rendering (happy-dom), legacy parity, presenter messages, images and snapshots; export (checked with
  PDF.js); web helpers, the web adapter, the presenter side of presenter mode and its browser link; desktop path
  rules, notes and backup stores, preferences, file helpers, open requests, menu, window
  hardening, audience window placement, packaging config.
- End-to-end tests (Playwright) in `apps/web/e2e` against the production build, with
  synthetic pen and touch events; `backup.spec.ts` uses a stand-in Electron bridge for the
  second read, the backup offer, the kept unreadable copy and Revert to Backup;
  `presenter.spec.ts` passes an app window's presenter messages to the audience page (also
  live erasing and moving), and runs the browser version with a real pop-up: reloads of either
  window, closing, a blocked pop-up and two presenter tabs.
- Desktop smoke test (`apps/desktop/test/smoke.mjs`) launches Electron with a fixture page
  and drives the bridge end to end (also the backup and revert, the unreadable copy, cleanup
  of old copies, switching backups off, printing, a second instance
  and a desktop entry). Its environment variables (`INKSLIDE_PAGE`, `INKSLIDE_SMOKE`,
  `INKSLIDE_USER_DATA`, `INKSLIDE_PRINT_TO_PDF`) are ignored by packaged builds unless they
  were packaged as test builds (`dist.mjs --test-build`, packages named `*-TEST*`), so a
  release cannot be pointed at another page.
- Rust tests of the Tauri shell's commands (`apps/mobile/src-tauri/src/lib.rs`: names and
  keys, payloads, picked-file grants, read limits, sharing, atomic writes); CI runs
  `cargo check` and `cargo test` on Linux (job `rust` in `.github/workflows/ci.yml`).
