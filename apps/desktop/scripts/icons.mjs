// Icon pipeline: assets/icon/*.svg → every icon the desktop packages and the
// web app (PWA) need. Run with `pnpm icons` (repo root) after changing a source.
//
// Sources (assets/icon/, only inkslide.svg is required; the others fall back):
//   inkslide.svg            the icon
//   inkslide-small.svg      drawn for 16-24 px (thicker stroke, no text lines)
//   inkslide-dark.svg       dark appearance (web favicons/PWA, macOS/iOS dark, later)
//   inkslide-dark-small.svg dark, 16-24 px
//   inkslide-maskable.svg   full-bleed PWA maskable / apple-touch icon; default:
//                           inkslide.svg on a square of its tile colour
//   inkslide-dark-maskable.svg  the same for the dark maskable icon
//   inkslide-symbolic.svg   one-colour GNOME symbolic icon (16 px grid)
//
// `pnpm icons --check` (run by dist) only reports outputs that are out of date.
// Rendering uses @resvg/resvg-js (prebuilt, no system tools, same bytes on
// every OS); .ico and .icns are written by scripts/icon-formats.mjs.
import { Resvg } from '@resvg/resvg-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeIcns, encodeIco } from './icon-formats.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(appDir, '..', '..');
const srcDir = join(repo, 'assets', 'icon');
const buildDir = join(appDir, 'build');
const webDir = join(repo, 'apps', 'web', 'public', 'icons');

/** hicolor sizes of the Linux packages and the dev desktop entry. */
const LINUX_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const FAVICON_SIZES = [16, 32, 48];
/** Below this size the -small source is used. */
const SMALL_BELOW = 32;

const read = name => {
  const p = join(srcDir, `${name}.svg`);
  return existsSync(p) ? readFileSync(p) : null;
};

const main = read('inkslide');
if (!main) throw new Error(`missing icon source ${join(srcDir, 'inkslide.svg')}`);
const darkSvg = read('inkslide-dark') ?? main;
const light = { svg: main, small: read('inkslide-small') ?? main, maskable: read('inkslide-maskable') };
const dark = { svg: darkSvg, small: read('inkslide-dark-small') ?? darkSvg, maskable: read('inkslide-dark-maskable') };

const renders = new Map();
/** Render `svg` at size×size (premultiplied RGBA + PNG), once per svg, size and background. */
function render(svg, size, background = '') {
  let byKey = renders.get(svg);
  if (!byKey) renders.set(svg, (byKey = new Map()));
  const key = `${size}${background}`;
  if (!byKey.has(key)) {
    const img = new Resvg(svg, {
      fitTo: { mode: 'width', value: size },
      font: { loadSystemFonts: false },
      ...(background ? { background } : {}),
    }).render();
    byKey.set(key, { size, png: img.asPng(), rgba: img.pixels });
  }
  return byKey.get(key);
}

/** The variant's drawing for `size` (the small one below SMALL_BELOW). */
const pick = (v, size) => render(size < SMALL_BELOW ? v.small : v.svg, size);

/**
 * Full-bleed square (PWA maskable, apple-touch): the variant's maskable
 * source, or its icon on its tile colour, read at the top centre of the tile.
 * The page of inkslide.svg lies within the maskable safe zone (a circle of 80 %).
 */
function fullBleed(v, size) {
  if (v.maskable) return render(v.maskable, size);
  const i = (8 * 100 + 50) * 4;
  const [r, g, b, a] = render(v.svg, 100).rgba.slice(i, i + 4);
  const hex = a === 255 ? `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}` : '#ffffff';
  return render(v.svg, size, hex);
}

// --check: report outputs that differ from the sources instead of writing.
const check = process.argv.includes('--check');
const done = [];
function write(path, data) {
  if (check) {
    if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(data))) done.push(relative(repo, path));
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  done.push(relative(repo, path));
}

// ── Desktop (electron-builder: linux.icon = build/icons, win/mac below) ──
for (const s of LINUX_SIZES) write(join(buildDir, 'icons', `${s}x${s}.png`), pick(light, s).png);
write(join(buildDir, 'icon.svg'), main);
const symbolic = read('inkslide-symbolic');
if (symbolic) write(join(buildDir, 'icon-symbolic.svg'), symbolic);
write(join(buildDir, 'icon.ico'), encodeIco(ICO_SIZES.map(s => pick(light, s))));
write(join(buildDir, 'icon.icns'), encodeIcns(s => pick(light, s).png));
// macOS 26 / iOS 18 dark appearance: not wired yet (needs an Icon Composer
// .icon or an Xcode asset catalog, built on a Mac); see README.
write(join(buildDir, 'icon-dark-1024.png'), render(dark.svg, 1024).png);

// ── Web app (apps/web/public/icons; the manifest and <link>s are wired there) ──
for (const [suffix, v] of [['', light], ['-dark', dark]]) {
  write(join(webDir, `icon-192${suffix}.png`), render(v.svg, 192).png);
  write(join(webDir, `icon-512${suffix}.png`), render(v.svg, 512).png);
  write(join(webDir, `maskable-512${suffix}.png`), fullBleed(v, 512).png);
  write(join(webDir, `favicon${suffix}.svg`), v.small);
  write(join(webDir, `favicon${suffix}.ico`), encodeIco(FAVICON_SIZES.map(s => pick(v, s))));
}
// iOS ignores media queries on apple-touch-icon and rounds the corners itself.
write(join(webDir, 'apple-touch-icon.png'), fullBleed(light, 180).png);

if (check && done.length) {
  console.error(`icons: out of date, run \`pnpm icons\`:\n  ${done.join('\n  ')}`);
  process.exit(1);
}
console.log(check ? 'icons: up to date' : `icons: wrote ${done.length} files\n  ${done.join('\n  ')}`);
