# Inkslide icon sources

The SVGs here are the only icon sources. `pnpm icons` (repo root) renders every
icon the desktop packages and the web app use from them; the outputs are
committed. `pnpm --filter @inkslide/desktop dist` warns if they are out of date
(`pnpm icons --check`).

To change the icon, replace `inkslide.svg` (and the variants you keep) and run
`pnpm icons`.

| Source | Used for | If missing |
| --- | --- | --- |
| `inkslide.svg` | everything at 32 px and up | required |
| `inkslide-small.svg` | 16-24 px (thicker stroke, no text lines, so the squiggle stays visible) | `inkslide.svg` |
| `inkslide-dark.svg` | dark web favicons and PWA icons, macOS/iOS dark appearance | `inkslide.svg` |
| `inkslide-dark-small.svg` | dark favicons at 16-24 px | `inkslide-dark.svg` |
| `inkslide-maskable.svg` | PWA maskable icon and apple-touch-icon (full bleed) | `inkslide.svg` drawn on a square of its tile colour (read at the top centre of the tile) |
| `inkslide-dark-maskable.svg` | dark PWA maskable icon | `inkslide-dark.svg` on its tile colour |
| `inkslide-symbolic.svg` | GNOME symbolic icon (one colour, 16 px grid, fills only) | not generated |

The page of `inkslide.svg` lies inside the maskable safe zone (a centred
circle of 80 % of the width), so the derived maskable and apple-touch icons
lose only the rounded tile corners.

## Generated files

Desktop (`apps/desktop/build/`, read by electron-builder and the dev entry):

- `icons/{16,22,24,32,48,64,128,256,512}x….png`: Linux hicolor sizes (512 is also
  the window icon of the development build)
- `icon.svg`, `icon-symbolic.svg`: scalable and symbolic (dev desktop entry)
- `icon.ico` (16-256): Windows; `icon.icns` (16-1024): macOS
- `icon-dark-1024.png`: dark appearance for macOS 26 / iOS 18, not wired yet

Web (`apps/web/public/icons/`, served as `icons/…` next to `index.html`):

| File | Size | Use |
| --- | --- | --- |
| `icon-192.png`, `icon-512.png` | 192, 512 | manifest `icons` (purpose `any`) |
| `maskable-512.png` | 512 | manifest `icons` (purpose `maskable`) |
| `apple-touch-icon.png` | 180 | `<link rel="apple-touch-icon">` (full bleed; iOS rounds it) |
| `favicon.svg`, `favicon.ico` | any, 16/32/48 | `<link rel="icon">` |
| `favicon-dark.svg`, `favicon-dark.ico` | any, 16/32/48 | `<link rel="icon" media="(prefers-color-scheme: dark)">` |
| `icon-192-dark.png`, `icon-512-dark.png`, `maskable-512-dark.png` | | dark counterparts (no standard manifest field yet) |
