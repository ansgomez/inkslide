# @inkslide/desktop

The Electron shell of Inkslide for Linux, Windows and macOS. It shows the shared front end
(`apps/web`) in one window and gives it file access through a small, checked IPC bridge.
Nothing is rendered in the main process.

## Overview

```sh
pnpm --filter @inkslide/web build && pnpm --filter @inkslide/desktop start   # built front end
pnpm --filter @inkslide/web dev   # in one terminal, then:
pnpm --filter @inkslide/desktop dev                                          # against the dev server
pnpm --filter @inkslide/desktop test     # unit tests (no Electron needed)
pnpm --filter @inkslide/desktop smoke    # launches Electron with a fixture page
```

`scripts/build.mjs` bundles the main process and the preload with esbuild into `out/`
(`@inkslide/annotate` is bundled in). Electron runs natively on Wayland when available
(`ozone-platform-hint=auto`): pen pressure, tilt and the eraser end need it.

| File | Role |
|---|---|
| `src/main/main.ts` | App and window lifecycle, single instance, IPC handlers, save-before-close, smoke mode. |
| `src/main/notes.ts` | Where notes are read and written: sidecar `<pdf>.notes.json`, or `userData/notes/<sha256>.notes.json` when the sidecar cannot be written; reads the newer ([NOTES-FORMAT.md](../../docs/NOTES-FORMAT.md#desktop-electron)). The backup, `userData/notes/<sha256>.notes.backup.json`: copied from the saved notes before a save, swapped back by Revert to Backup; the kept copy of an unreadable notes file (`<sha256>.notes.unreadable.json`); cleanup of backups and copies older than 90 days at startup. |
| `src/main/fsutil.ts` | Atomic writes (temp file, fsync, rename, fsync the folder; on Windows the rename is retried briefly while another program holds the file), writability checks. |
| `src/main/access.ts` | `PathGrants`: the renderer may only read PDFs the user chose. |
| `src/main/crashRecovery.ts` | After the page's renderer dies: reload it (the PDF reopens), or ask when it dies again within 5 minutes or before it saved. |
| `src/main/openRequests.ts` | PDFs to open before the page has loaded: the first through `initialPath()`, the others sent once it has. |
| `src/main/paths.ts` | Front end location (dev, packaged, override) and the `app://inkslide/` URLs it is served under, the test-only environment variables, the PDF in a command line, the app-storage notes path. |
| `src/main/recent.ts`, `windowState.ts`, `preferences.ts`, `jsonStore.ts` | Recent files, window state and preferences (backups on or off) in `userData`. |
| `src/main/print.ts` | Printing: the exported PDF in a hidden window, Chromium's PDF viewer, the system print dialog. |
| `src/main/harden.ts` | Window lockdown shared by both windows: webPreferences, no navigation, permissions (fullscreen only). |
| `src/main/menu.ts` | File and View menus (Revert to Backup…, Keep a Backup of the Notes; Reload only in development builds). |
| `src/preload/preload.ts` | Sandboxed preload: exposes `window.inkslide`. |
| `src/shared/bridge.ts` | `InkslideBridge` type and IPC channel names; imported by the front end as `@inkslide/desktop/bridge`. |

The bridge implements `PlatformAdapter` from `@inkslide/annotate` plus `initialPath`,
`pathForFile`, `onMenuCommand` and `onCloseRequest`. Every handler checks that the call comes
from the app's window and that PDF paths were granted (open dialog, command line, OS open
request, recent files, a dropped `.pdf` file). See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

Environment variables (mostly for tests): `INKSLIDE_DEV_URL` (load a dev server; ignored by packaged builds),
`INKSLIDE_PAGE` (load another HTML file), `INKSLIDE_USER_DATA` (another `userData` folder),
`INKSLIDE_SMOKE` (smoke test mode), `INKSLIDE_PRINT_TO_PDF` (smoke test mode: Print writes
this PDF instead of showing the dialog), `INKSLIDE_DESKTOP_NAME` (development builds: desktop
file id and window app id), `INKSLIDE_SMOKE_EXE` (smoke test only: run it against a packaged
executable such as the AppImage). Packaged builds ignore `INKSLIDE_PAGE`, `INKSLIDE_USER_DATA`,
`INKSLIDE_SMOKE` and `INKSLIDE_PRINT_TO_PDF` unless they were built with `INKSLIDE_TEST_BUILD=1`
(a test build, for the smoke test against a package; never for a release).

## Packaging

`electron-builder.yml` holds the configuration, including the Electron fuses flipped in the
packaged binary: no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`, no extra privileges
for `file://` pages, the app code only from `app.asar`, checked against its hash on macOS and
Windows; the macOS app is then signed ad hoc again (`resetAdHocDarwinSignature`), since the
flip breaks Electron's signature. Check them with `npx @electron/fuses read --app <executable>`,
and the macOS signature with `codesign --verify --deep --strict Inkslide.app`. `dist` builds the web front end,
then `scripts/dist.mjs` checks that the icons are current, bundles main/preload and runs
electron-builder with its arguments. Output goes to `apps/desktop/dist/`.

| Target | Command | Output |
| --- | --- | --- |
| Linux AppImage | `pnpm --filter @inkslide/desktop dist:linux` | `Inkslide-<version>-x86_64.AppImage` |
| Linux AppImage + RPM | `pnpm --filter @inkslide/desktop dist` (on Linux) | also `Inkslide-<version>-x86_64.rpm` |
| Windows installer | `pnpm --filter @inkslide/desktop dist --win` | `Inkslide-Setup-<version>.exe` |
| Windows zip | `pnpm --filter @inkslide/desktop dist --win zip` | `Inkslide-<version>-win-x64.zip` |
| macOS | `pnpm --filter @inkslide/desktop dist --mac` (on a Mac) | `Inkslide-<version>-mac-<arch>.dmg` (arm64 and x64) |

### Prerequisites

- All targets: `pnpm install` (electron-builder downloads its tools on first use).
- **RPM** (Fedora): `rpmbuild` and `libcrypt.so.1`, used by the Ruby inside
  electron-builder's fpm. Install once with

  ```sh
  sudo dnf install rpm-build libxcrypt-compat
  ```

  Without them `dist` stops before building and prints this command; the
  AppImage (`dist:linux`) needs neither.
- **Windows installer (NSIS)** built on Linux needs Wine (`sudo dnf install wine`):
  electron-builder runs the uninstaller stub under Wine. The `zip` and `dir`
  targets need nothing extra; Windows builds on Windows need nothing extra.
- **macOS**: a Mac (DMG creation and signing use macOS tools). Builds are
  unsigned unless a Developer ID certificate is configured, so Gatekeeper asks
  on first open (right-click → Open).

### Install and run

- AppImage: `chmod +x Inkslide-*.AppImage` and run it. A PDF passed on the
  command line, or a second launch while it runs, opens in the running window.
  To get a menu entry, use an integrator such as Gear Lever. To run the smoke
  test against it, build a test package first (release packages ignore the test variables):
  `INKSLIDE_TEST_BUILD=1 pnpm --filter @inkslide/desktop dist:linux`, then
  `INKSLIDE_SMOKE_EXE=dist/Inkslide-<version>-x86_64.AppImage node test/smoke.mjs`.
- RPM: `sudo dnf install ./Inkslide-<version>-x86_64.rpm`; it installs
  `/usr/share/applications/inkslide.desktop` and the hicolor icons.

### License files

Every package carries, next to the executable, `LICENSE.inkslide.txt` and
`THIRD_PARTY_NOTICES.md` (`extraFiles` in `electron-builder.yml`) and
electron-builder's own `LICENSE.electron.txt` and `LICENSES.chromium.html`; the
notices are also in `resources/web/`. Regenerate the notices with `pnpm notices`
after changing dependencies.

### PDF files: "Open with", not the default

Every package offers Inkslide for PDFs without taking over the default viewer:

- Linux: `MimeType=application/pdf` in the desktop entry, no MIME definition.
- Windows: `build/installer.nsh` adds an `Inkslide.pdf` ProgID to
  `.pdf\OpenWithProgids` (electron-builder's `fileAssociations` would set it as
  the `.pdf` default, so it is not used).
- macOS: `CFBundleDocumentTypes` with `LSHandlerRank` Alternate.

The window's Wayland app id / X11 `WM_CLASS` is `inkslide` (`desktopName` in
`package.json`), which matches the packaged `inkslide.desktop`, so GNOME groups
the window under its launcher.

### Icons

One source SVG, `assets/icon/inkslide.svg` at the repo root, plus optional
variants next to it (small sizes, dark, maskable, symbolic). Run

```sh
pnpm icons
```

after changing them: `scripts/icons.mjs` renders the Linux hicolor PNGs
(16-512), the scalable and symbolic SVGs, `icon.ico` (Windows), `icon.icns`
(macOS) and the web/PWA icons in `apps/web/public/icons/`. `dist` warns if
they are out of date (`pnpm icons --check`).
See [`assets/icon/README.md`](../../assets/icon/README.md) for every source and
output.

Rendering uses `@resvg/resvg-js` rather than `rsvg-convert`, ImageMagick or
Inkscape: it is a prebuilt dev dependency, so the icons come out the same on
any machine (including Windows and macOS) without system tools. The `.ico`
and `.icns` containers are written by `scripts/icon-formats.mjs` from images
rendered at each size, so small sizes are drawn, not scaled down.

Dark variants: the web app gets `-dark` favicons and PWA icons. Linux app
grids and Windows have no dark icon switching, so they use the default icon.
macOS 26 and iOS 18 support a dark appearance through an Icon Composer `.icon`
file or an Xcode asset catalog, both built with Xcode on a Mac;
`build/icon-dark-1024.png` is generated for that and not used yet.

### Development desktop entry (Linux)

To launch the development build from the GNOME app grid and from "Open With"
on PDFs:

```sh
pnpm --filter @inkslide/desktop install-dev-entry
pnpm --filter @inkslide/desktop uninstall-dev-entry   # to remove it
```

`install-dev-entry` builds `apps/web/dist` and the main bundle, then writes
`~/.local/share/applications/inkslide-dev.desktop` ("Inkslide (dev)", or under
`$XDG_DATA_HOME`) and its icons as `inkslide-dev` in
`~/.local/share/icons/hicolor`. The entry runs this checkout's Electron on
`apps/desktop` with absolute paths, so it works from any directory; it opens
the PDF it is given (`%f`), is offered for PDFs but not made the default, and
passes `INKSLIDE_DESKTOP_NAME=inkslide-dev.desktop`: a development build then
uses the app id `inkslide-dev` (`StartupWMClass=inkslide-dev`), so GNOME groups
its window under "Inkslide (dev)" even when the RPM is installed too. After
pulling changes, `pnpm build` (or running `install-dev-entry` again) updates
what it launches.
