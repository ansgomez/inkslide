# Roadmap

Inkslide opens a PDF one page at a time and lets you write on it with a pen, using the
annotation toolbar of Marp Notes. This page lists what works, what is still open and why the
desktop app uses Electron.

## Status

| Area | State |
|---|---|
| Viewer: fit to window or width, page turns, overview | Done |
| Ink: pen, highlighter, erasers, selector, laser, undo/redo | Done |
| Pages: blank pages with plain, lined or grid paper | Done |
| Notes: sidecar file, autosave, backup on the desktop and in the browser | Done |
| Export to an annotated PDF, print | Done |
| Presenter mode: page, ink and laser mirrored in a second window (desktop) | Done, not yet tried with a projector |
| Desktop on Linux (AppImage) | Done |
| Web app and PWA (installable, offline) | Done |
| Desktop on Windows and macOS | Configured, not yet built or tested there |
| iPad and Android (Tauri 2) | Builds, not yet run on a device |

## Open work

- **Devices:** check the PWA on a real iPad (install from Safari, safe areas, Pencil and palm
  rejection, export through the share sheet, storage kept over time). Run the Tauri shells on
  iPad and Android (`apps/mobile/README.md`).
- **Packages:** build the RPM once on Fedora (needs `rpm-build` and `libxcrypt-compat`). Build
  and test the NSIS installer on Windows and the DMG on a Mac; sign the macOS app and wire its
  dark icon.
- **Licenses for store builds:** bundle the full license texts of the Rust crates (for example
  with `cargo about generate`); `THIRD_PARTY_NOTICES.md` only counts them per license.
- **Export checks:** open an export in Acrobat (Poppler and MuPDF are checked automatically) and
  print through a real printer dialog on Linux, Windows and macOS.
- **Stroke look:** choose between perfect-freehand and the classic Marp Notes outline and tune
  `FREEHAND_OPTIONS`.
- **Backup in the Tauri apps:** the browser and PWA keep a notes backup like the desktop
  (OPFS); the iPad and Android apps still keep none. Revisit after the device tests (the
  backup could sit next to the notes in the app data directory, with a toolbar button as in
  the browser).
- **Presenter mode:** try it with a real projector on Linux, Windows and macOS. On Wayland the
  compositor places windows itself, so the audience window opens as a window for the user to
  drag to the projector. It then goes full screen by itself, but only when the two displays
  use different scales: Electron reports no window position or display on Wayland, and a
  page's `window.screen` follows the display only when the scale changes (checked with KWin
  and Electron 43). With equal scales the user still presses F11. A Wayland protocol for this
  (or Chromium passing on which output a window is on) would close that gap. Mirror erasing
  and moving while they happen; a browser and PWA version (`BroadcastChannel` and
  `window.open`).
- **Later:** opening Marp HTML decks directly.

## Why Electron on the desktop

Before building the app, the same pen test page ran in several web views on a Linux tablet
with a pen (Fedora 44, Wayland):

| | Tauri 2 (WebKitGTK 4.1) | GNOME Web (WebKitGTK 6) | Chromium browser (Wayland) | Tauri 3 + CEF (X11) | Electron (Wayland; measured with Electron 39) |
|---|---|---|---|---|---|
| Pen reported as pen | no (mouse) | no | yes | yes | yes |
| Pressure levels | 1 (fixed 0.5) | 1 | 661 | 674 | 433 |
| Pen hover as pen | no | no | yes | yes | yes |
| Eraser (button mask 32) | no | no | yes | **no** | yes |
| Side button mask | – | – | 4 (5 while writing) | 4 (5) | 2 (3 while writing) |
| Tilt | no | no | yes | **no** | yes |
| Frame interval | 32 ms (30 fps) | 32 ms | 16.7 ms | 16.7 ms | 16.7 ms |
| Event delay avg | 1.3 ms (12 ms max) | 13.6 ms (45 ms max) | 1.1 ms | 1.9 ms (6.1 ms max) | 1.4 ms |

- WebKitGTK, the Linux web view of Tauri, does not report pens or pressure, so Tauri 2 is not
  usable for ink on Linux.
- Tauri with the Chromium (CEF) runtime forces X11, so it runs through XWayland, which drops
  the eraser end and tilt. Chromium and Electron run natively on Wayland and get both.
- So the desktop app (Linux, Windows, macOS) uses **Electron**, and iPad and Android use
  **Tauri 2** with the system web view. The front end is shared; only a thin platform adapter
  differs. Tauri with CEF is worth another look once it supports Wayland natively.
- The pen's eraser end is button mask 32. The side button is mask 4 in Chromium and mask 2 in
  Electron; Inkslide treats both as the side button (temporary eraser by default).
