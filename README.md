<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/icon/inkslide-dark.svg">
  <img src="assets/icon/inkslide.svg" width="128" alt="Inkslide logo">
</picture>

# Inkslide

**A pen-first PDF annotator for lecture slides.**

</div>

![Inkslide: opening a slide deck, highlighting and writing on it with the pen, turning the page and opening the overview](docs/media/demo.gif)

Inkslide shows a PDF one page at a time, fitted to the window, and lets you write on it with
a pen. It is made for teaching from slides: a pressure-sensitive pen with low-latency ink,
palm rejection, blank pages to work things out on, and a compact toolbar you can dock to any
edge of the screen. Your ink is saved automatically in a separate notes file, and you can
export an annotated copy of the PDF. The PDF itself is never modified.

Inkslide runs as a desktop app (Electron; Linux first, Windows and macOS configured) and in
the browser as an installable offline app (PWA), and is being prepared for the iPad and
Android (Tauri 2). Its toolbar and tools come from the annotation mode of the author's Marp
HTML lecture decks ("Marp Notes"), and it reads the notes saved there.

## Features

- **Pen input:** pressure-sensitive pen with low-latency live ink, the pen's eraser end and
  side button, palm rejection (touch never draws once a pen is seen, and is ignored while the
  pen is near).
- **Tools:** pen, highlighter, selector (tap, box or lasso; move and restyle), laser pointer,
  stroke eraser and partial eraser; 8 colors and 4 sizes that scale with the page; undo/redo
  and clear page. Shift draws straight lines.
- **Pages:** page turns by toolbar, keys or two-finger swipe; pinch zoom; fit width for
  portrait pages; blank pages with plain, lined or grid paper anywhere in the document; an
  overview grid of thumbnails; G and a page number to jump.
- **Notes:** saved 2 s after the last change and on every page turn, with crash-safe writes
  and an unsaved / error indicator on the save button. Notes from Marp HTML decks load and are
  scaled onto the PDF. On the desktop, a backup of the notes from a few minutes earlier, with
  File → Revert to Backup….
- **Toolbar:** the Marp Notes bar, dockable on all four edges, with the same keyboard shortcuts.
- **Export and print:** an annotated PDF with vector strokes and the blank pages; the
  original text stays selectable.

The [user guide](docs/USER-GUIDE.md) explains every tool and setting.

## Install

Inkslide is pre-release software (0.1). No release builds are published yet; when they are,
they will be on the [Releases](https://github.com/ansgomez/inkslide/releases) page. Until
then, build the app from source as below.

### Linux (Fedora, Wayland): build the AppImage

Prerequisites: git, [Node.js](https://nodejs.org/) 22 or newer with npm, and pnpm 9 (the
repository pins pnpm 9.15.9). Tested with Node 22.23 and pnpm 9.15.9 on Fedora 44 (GNOME,
Wayland). On Fedora:

```sh
sudo dnf install git nodejs22 nodejs22-npm          # needs root; skip what you already have
npm install -g --prefix ~/.local pnpm@9.15.9        # pnpm without root, into ~/.local/bin
```

(`~/.local/bin` is on the `PATH` in Fedora's default shell setup. With Corepack installed,
`corepack enable` is an alternative way to get the pinned pnpm.) Then:

```sh
git clone https://github.com/ansgomez/inkslide.git
cd inkslide
pnpm install
pnpm --filter @inkslide/desktop dist:linux
```

This builds the web front end and writes `apps/desktop/dist/Inkslide-0.1.0-x86_64.AppImage`
(about 120 MB; the first run downloads Electron's packaging tools). Run it:

```sh
apps/desktop/dist/Inkslide-0.1.0-x86_64.AppImage                 # or with a PDF: ... lecture.pdf
```

A PDF passed on the command line, or opened while Inkslide runs, opens in the running window.
AppImages need FUSE 2 (`libfuse.so.2`); if it is missing, install it with
`sudo dnf install fuse-libs` or start the AppImage with `--appimage-extract-and-run`. To get a
menu entry and "Open With" for PDFs, use an AppImage integrator such as
[Gear Lever](https://flathub.org/apps/it.mijorus.gearlever).

Electron runs natively on Wayland, which pen pressure, tilt and the eraser end need.

**RPM:** `pnpm --filter @inkslide/desktop dist` builds the RPM next to the AppImage. It needs
`rpmbuild` and `libcrypt.so.1`, which are installed as root:
`sudo dnf install rpm-build libxcrypt-compat`. Then
`sudo dnf install ./apps/desktop/dist/Inkslide-0.1.0-x86_64.rpm` adds Inkslide to the app
grid and to "Open With" for PDFs, without making it the default PDF viewer.

### Run from source without packaging

```sh
pnpm install
pnpm --filter @inkslide/web build
pnpm --filter @inkslide/desktop start             # or: ... start path/to/lecture.pdf
```

To add this checkout to the app grid as "Inkslide (dev)", with "Open With" for PDFs, run
`pnpm --filter @inkslide/desktop install-dev-entry` (`uninstall-dev-entry` removes it).

### Browser and PWA

```sh
pnpm install
pnpm --filter @inkslide/web build
pnpm --filter @inkslide/web preview               # http://localhost:4173
```

`apps/web/dist/` is a static site; any web server can host it. Chrome and Edge can install it
as an app (install button in the address bar); on an iPad, use Safari → Share → Add to Home
Screen. Notes are kept in the browser's storage for the site.

### Windows, macOS, iPad, Android

Packaging is configured but has not been built or tested on those systems yet:

- Windows and macOS installers: [apps/desktop/README.md](apps/desktop/README.md#packaging)
  (`dist --win`, `dist --mac`; a DMG has to be built on a Mac).
- iPad and Android (Tauri 2): [apps/mobile/README.md](apps/mobile/README.md). This needs Rust,
  Android Studio (Android) or Xcode on a Mac (iPad), and a device or emulator.

## Usage

Open a PDF with **Open PDF…** (Ctrl/Cmd+O), by dropping it on the window, from the command
line or with "Open With" in the file manager. It opens in annotate mode, ready to write on.

| Key | Action |
|---|---|
| P / H / S / L | Pen / highlighter / select / laser pointer |
| E / Shift+E | Stroke eraser / partial eraser |
| 1 – 4 | Size S, M, L, XL |
| Shift while drawing | Straight line |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo, redo |
| → ↓ PgDn Space / ← ↑ PgUp | Next / previous page |
| Home / End | First / last page |
| G, a number, Enter | Go to that page (G, Enter: overview) |
| W | Fit width / whole page |
| B | Insert a blank page after the current one |
| A | Annotate mode on / off |
| Ctrl/Cmd+S, Ctrl/Cmd+P | Save the notes now, print with the notes |

**Pen:** the eraser end and the side button erase. **Touch:** two fingers pinch to zoom; a
quick two-finger swipe turns the page. **Mouse:** the left button draws, Ctrl + wheel zooms.

On the desktop, notes are saved next to the PDF as `<name>.pdf.notes.json` (or in the app's
own storage if the folder is read-only); keep that file with the PDF. In the browser they are
kept in the site's storage. See the [user guide](docs/USER-GUIDE.md) for details and
[the notes file format](docs/NOTES-FORMAT.md) for the file itself.

## Status

| Platform | Shell | State |
|---|---|---|
| Linux (Fedora, Wayland) | Electron | Main target; works. AppImage built and smoke-tested; RPM configured. |
| Browser (Chromium, Safari) | Web, PWA | Works; installable and offline. |
| Windows, macOS | Electron | Installers configured (NSIS, DMG); not yet built or tested there. |
| iPad | PWA, Tauri 2 | PWA still to be checked on a real iPad; Tauri shell builds, not yet run on a device. |
| Android | Tauri 2 | Shell builds, not yet run on a device. |

What remains to be done is in the [roadmap](docs/ROADMAP.md).

## Development

Prerequisites: Node.js 22.13+ and pnpm 9 (see [Install](#linux-fedora-wayland-build-the-appimage)). The end-to-end tests need a
Playwright Chromium; the Tauri shell needs Rust 1.90+ (see
[apps/mobile/README.md](apps/mobile/README.md)).

```sh
git clone https://github.com/ansgomez/inkslide.git
cd inkslide
pnpm install

pnpm dev                                         # web dev server and the desktop app on it
pnpm --filter @inkslide/web dev                  # web only: http://localhost:5173

pnpm typecheck                                   # all packages
pnpm test                                        # unit tests (Vitest), all packages
pnpm --filter @inkslide/web exec playwright install chromium   # once
pnpm --filter @inkslide/web test:e2e             # end-to-end tests (Playwright)
pnpm --filter @inkslide/desktop smoke            # desktop smoke test (opens Electron windows)
pnpm build                                       # build the apps
```

| Path | What |
|---|---|
| [`packages/annotate`](packages/annotate) | `@inkslide/annotate`: the annotation core (model, tools, input, rendering, toolbar, notes format, autosave). No PDF or file system code. |
| [`packages/export`](packages/export) | `@inkslide/export`: annotated PDF export with pdf-lib. |
| [`apps/web`](apps/web) | `@inkslide/web`: the front end (Vite): PDF viewer, live ink, gestures, overview, platform adapters. Used by the browser, Electron and Tauri. |
| [`apps/desktop`](apps/desktop) | `@inkslide/desktop`: the Electron shell (main process, preload bridge, packaging). |
| [`apps/mobile`](apps/mobile) | `@inkslide/mobile`: the Tauri 2 shell for iPad and Android. |
| [`assets/icon`](assets/icon) | Icon sources; `pnpm icons` renders every app and web icon from them. |
| [`docs/`](docs) | [Architecture](docs/ARCHITECTURE.md), [notes file format](docs/NOTES-FORMAT.md), [user guide](docs/USER-GUIDE.md), [roadmap](docs/ROADMAP.md). |

[CONTRIBUTING.md](CONTRIBUTING.md) describes the code style, the tests and the commit
conventions.

The demo at the top is recorded with `pnpm demo` (needs `ffmpeg` and the Playwright
Chromium): it draws on a generated sample PDF in headless Chromium and writes
`docs/media/demo.gif`.

## License

MIT, © 2026 Andres Gomez. See [LICENSE](LICENSE). Bundled libraries keep their own licenses
(PDF.js: Apache-2.0, its fonts OFL-1.1 and BSD; pdf-lib, perfect-freehand, Electron: MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships with every build.
