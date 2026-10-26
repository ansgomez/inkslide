# Installing Inkslide

Inkslide is pre-release software (0.1). No release builds are published yet; when they are,
they will be on the [Releases](https://github.com/ansgomez/inkslide/releases) page. Until
then, build it from source as below.

## Prerequisites

git, [Node.js](https://nodejs.org/) 22.13 or newer with npm, and pnpm 9 (the repository pins
pnpm 9.15.9). Tested with Node 22.23 and pnpm 9.15.9 on Fedora 44 (GNOME, Wayland). On Fedora:

```sh
sudo dnf install git nodejs22 nodejs22-npm          # needs root; skip what you already have
npm install -g --prefix ~/.local pnpm@9.15.9        # pnpm without root, into ~/.local/bin
```

`~/.local/bin` is on the `PATH` in Fedora's default shell setup. With Corepack installed,
`corepack enable` is an alternative way to get the pinned pnpm.

## Linux: AppImage

```sh
git clone https://github.com/ansgomez/inkslide.git
cd inkslide
pnpm install
pnpm --filter @inkslide/desktop dist:linux
apps/desktop/dist/Inkslide-0.1.0-x86_64.AppImage    # optionally with a PDF
```

The build writes `apps/desktop/dist/Inkslide-0.1.0-x86_64.AppImage` (about 120 MB; the first
run downloads Electron's packaging tools). A PDF passed on the command line, or opened while
Inkslide runs, opens in the running window. Electron runs natively on Wayland, which pen
pressure, tilt and the eraser end need.

- **FUSE:** AppImages need FUSE 2 (`libfuse.so.2`). If it is missing, install it with
  `sudo dnf install fuse-libs`, or start the AppImage with `--appimage-extract-and-run`.
- **Menu entry:** to get a menu entry and "Open With" for PDFs, use an AppImage integrator
  such as [Gear Lever](https://flathub.org/apps/it.mijorus.gearlever).

## Linux: RPM

`pnpm --filter @inkslide/desktop dist` builds the RPM next to the AppImage. It needs
`rpmbuild` and `libcrypt.so.1`:

```sh
sudo dnf install rpm-build libxcrypt-compat
pnpm --filter @inkslide/desktop dist
sudo dnf install ./apps/desktop/dist/Inkslide-0.1.0-x86_64.rpm
```

The RPM adds Inkslide to the app grid and to "Open With" for PDFs, without making it the
default PDF viewer.

## Run from source

```sh
pnpm install
pnpm --filter @inkslide/web build
pnpm --filter @inkslide/desktop start             # or: ... start path/to/lecture.pdf
```

`pnpm --filter @inkslide/desktop install-dev-entry` adds this checkout to the app grid as
"Inkslide (dev)", with "Open With" for PDFs; `uninstall-dev-entry` removes it.

## Browser and PWA

```sh
pnpm install
pnpm --filter @inkslide/web build
pnpm --filter @inkslide/web preview               # http://localhost:4173
```

`apps/web/dist/` is a static site; any web server can host it. Chrome and Edge can install it
as an app (install button in the address bar); on an iPad, use Safari → Share → Add to Home
Screen. Notes are kept in the browser's storage for the site.

## Windows, macOS, iPad, Android

Packaging is configured but has not been built or tested on those systems yet:

- **Windows and macOS:** see [apps/desktop/README.md](../apps/desktop/README.md#packaging)
  (`dist --win`, `dist --mac`; a DMG has to be built on a Mac).
- **iPad and Android (Tauri 2):** see [apps/mobile/README.md](../apps/mobile/README.md). This
  needs Rust, Android Studio (Android) or Xcode on a Mac (iPad), and a device or emulator.
