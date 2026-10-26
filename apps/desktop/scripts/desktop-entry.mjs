// Desktop entry of the development build (no I/O): file contents, Exec
// quoting and install paths. Used by scripts/dev-entry.mjs and the tests.
import { basename, isAbsolute, join } from 'node:path';

/**
 * Desktop file id, icon name and window app id of the dev entry (the packages
 * use "inkslide"): the entry passes INKSLIDE_DESKTOP_NAME, which the main
 * process of a development build applies, so GNOME tells the two apart.
 */
export const DEV_ID = 'inkslide-dev';

/** File names of the dev entry's icons in hicolor/<size>/apps. */
export const DEV_ICON_NAMES = [`${DEV_ID}.png`, `${DEV_ID}.svg`, `${DEV_ID}-symbolic.svg`];

/** $XDG_DATA_HOME, or ~/.local/share (a relative XDG_DATA_HOME is ignored, per the spec). */
export function dataHome(env, home) {
  const x = env.XDG_DATA_HOME;
  return x && isAbsolute(x) ? x : join(home, '.local', 'share');
}

/** One argument of an Exec key, quoted if needed (Desktop Entry spec, "The Exec key"). */
export function quoteExecArg(arg) {
  const escaped = arg.replace(/%/g, '%%');
  if (!/[\s"'\\><~|&;$*?#()`]/.test(escaped)) return escaped;
  return `"${escaped.replace(/["`$\\]/g, c => `\\${c}`)}"`;
}

/** A string value of a desktop file (escape \, newlines, tabs). */
export function escapeValue(s) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

/**
 * The dev entry: runs Electron on apps/desktop (which loads apps/web/dist).
 * MimeType lists it under "Open With" for PDFs without making it the
 * default; %f passes one local file.
 */
export function devDesktopEntry({ electron, appDir, icon = DEV_ID }) {
  const exec = ['env', `INKSLIDE_DESKTOP_NAME=${DEV_ID}.desktop`, electron, appDir].map(quoteExecArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.5',
    'Name=Inkslide (dev)',
    'GenericName=PDF Annotator',
    `Comment=${escapeValue(`Annotate PDFs with a pen (development build in ${appDir})`)}`,
    `Exec=${escapeValue(exec)} %f`,
    `TryExec=${escapeValue(electron)}`,
    `Icon=${escapeValue(icon)}`,
    'Terminal=false',
    'Categories=Office;Viewer;',
    'Keywords=pdf;annotate;pen;ink;slides;',
    'MimeType=application/pdf;',
    `StartupWMClass=${DEV_ID}`,
    'StartupNotify=true',
    '',
  ].join('\n');
}

/**
 * Where the dev entry installs its files, for icons in `iconFiles`
 * (build/icons/NxN.png, build/icon.svg, build/icon-symbolic.svg).
 * Returns [source, target] pairs, the desktop file path and the hicolor folder.
 */
export function devEntryPaths(data, iconFiles) {
  const hicolor = join(data, 'icons', 'hicolor');
  const [png, svg, symbolic] = DEV_ICON_NAMES;
  const icons = [];
  for (const src of iconFiles) {
    const name = basename(src);
    const size = /^(\d+)x\1\.png$/.exec(name)?.[1];
    if (size) icons.push([src, join(hicolor, `${size}x${size}`, 'apps', png)]);
    else if (name === 'icon.svg') icons.push([src, join(hicolor, 'scalable', 'apps', svg)]);
    else if (name === 'icon-symbolic.svg') icons.push([src, join(hicolor, 'symbolic', 'apps', symbolic)]);
  }
  return { desktopFile: join(data, 'applications', `${DEV_ID}.desktop`), icons, hicolor };
}
