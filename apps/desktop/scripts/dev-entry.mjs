// Install or remove the desktop entry of the development build:
//   node scripts/dev-entry.mjs install | uninstall
// Writes $XDG_DATA_HOME/applications/inkslide-dev.desktop (default
// ~/.local/share) and the icons under $XDG_DATA_HOME/icons/hicolor. The entry
// runs this checkout's Electron on apps/desktop, which loads apps/web/dist;
// rebuild those (pnpm build) to update what it launches.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataHome, DEV_ICON_NAMES, devDesktopEntry, devEntryPaths } from './desktop-entry.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(appDir, 'build');
/**
 * The Electron binary the entry runs. Since Electron 42 the package downloads it
 * on the first require, not at install, so require it once. The entry uses the
 * path through node_modules/electron, a stable link, not the store path that
 * require returns: that changes with every Electron update.
 */
function electronBinary() {
  const real = createRequire(import.meta.url)('electron');
  return join(appDir, 'node_modules', 'electron', 'dist', basename(real));
}

const cmd = process.argv[2];
if (cmd !== 'install' && cmd !== 'uninstall') {
  console.error('usage: dev-entry.mjs install|uninstall');
  process.exit(2);
}
if (process.platform !== 'linux') {
  console.error('The dev desktop entry is for Linux only.');
  process.exit(1);
}

const data = dataHome(process.env, process.env.HOME || homedir());
const { hicolor } = devEntryPaths(data, []);

/** Refresh the caches GNOME reads; missing tools are fine. */
function refreshCaches() {
  spawnSync('update-desktop-database', [join(data, 'applications')], { stdio: 'ignore' });
  // Only update a cache that exists: a stale one hides new icons, none is fine.
  if (existsSync(join(hicolor, 'icon-theme.cache'))) {
    spawnSync('gtk-update-icon-cache', ['-f', '-t', hicolor], { stdio: 'ignore' });
  }
}

if (cmd === 'install') {
  let electron;
  try {
    electron = electronBinary();
  } catch (err) {
    console.error(`${err.message}\n  run: pnpm --filter @inkslide/desktop exec install-electron`);
    process.exit(1);
  }
  const missing = [
    [join(appDir, 'out', 'main.js'), 'pnpm --filter @inkslide/desktop build'],
    [join(appDir, '..', 'web', 'dist', 'index.html'), 'pnpm --filter @inkslide/web build'],
    [electron, 'pnpm --filter @inkslide/desktop exec install-electron'],
  ].filter(([p]) => !existsSync(p));
  for (const [p, fix] of missing) console.error(`missing ${p}\n  run: ${fix}`);
  if (missing.length) process.exit(1);

  const iconFiles = [
    ...readdirSync(join(buildDir, 'icons')).map(n => join(buildDir, 'icons', n)),
    join(buildDir, 'icon.svg'),
    join(buildDir, 'icon-symbolic.svg'),
  ].filter(p => existsSync(p));
  const { desktopFile, icons } = devEntryPaths(data, iconFiles);
  for (const [src, dst] of icons) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  mkdirSync(dirname(desktopFile), { recursive: true });
  writeFileSync(desktopFile, devDesktopEntry({ electron, appDir }));
  refreshCaches();
  console.log(`installed ${desktopFile}\n  and ${icons.length} icons in ${hicolor}`);
} else {
  // Every inkslide-dev icon in hicolor, whatever sizes were installed.
  const { desktopFile } = devEntryPaths(data, []);
  const icons = existsSync(hicolor)
    ? readdirSync(hicolor).flatMap(d => DEV_ICON_NAMES.map(n => join(hicolor, d, 'apps', n)))
    : [];
  for (const p of [desktopFile, ...icons]) rmSync(p, { force: true });
  refreshCaches();
  console.log(`removed ${desktopFile} and its icons`);
}
