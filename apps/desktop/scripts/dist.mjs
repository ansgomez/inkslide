// Package the desktop app: report stale icons, bundle main/preload,
// then run electron-builder
// with this script's arguments (e.g. `--linux AppImage`, `--win zip`).
// Expects apps/web/dist (the package scripts build it first).
// --test-build: a test package (it still honors the test environment variables,
// for test/smoke.mjs with INKSLIDE_SMOKE_EXE), named *-TEST*; never a release.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linuxTargets, missingForRpm, RPM_INSTALL, testArtifactOverrides, testBuildOptions } from './preflight.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = testBuildOptions(process.argv.slice(2), process.env);
if (options.error) {
  console.error(options.error);
  process.exit(1);
}
const { testBuild } = options;
const args = testBuild
  ? [...options.args, ...testArtifactOverrides(readFileSync(join(appDir, 'electron-builder.yml'), 'utf8'))]
  : options.args;

const onPath = name => (process.env.PATH || '').split(delimiter).some(d => d && existsSync(join(d, name)));
/** `ldconfig -p` (often outside a user's PATH), or null if it cannot run. */
function linkerLibs() {
  for (const cmd of ['ldconfig', '/sbin/ldconfig', '/usr/sbin/ldconfig']) {
    const r = spawnSync(cmd, ['-p'], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout;
  }
  return null;
}
if (linuxTargets(args, process.platform).includes('rpm')) {
  const missing = missingForRpm({ has: onPath, libs: linkerLibs() });
  if (missing.length) {
    console.error(`The RPM target needs:\n  ${missing.join('\n  ')}\nInstall with:\n  ${RPM_INSTALL}\n`
      + 'or build the AppImage only: pnpm --filter @inkslide/desktop dist:linux');
    process.exit(1);
  }
}
if (!existsSync(join(appDir, '..', 'web', 'dist', 'index.html'))) {
  console.error('apps/web/dist is missing; run: pnpm --filter @inkslide/web build');
  process.exit(1);
}

// build.mjs bakes INKSLIDE_TEST_BUILD in: set for a test build only.
const env = { ...process.env, INKSLIDE_TEST_BUILD: testBuild ? '1' : '' };
const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { cwd: appDir, stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
// Committed icons that differ from a fresh render (a changed source, or another
// resvg version) are reported, not fatal.
spawnSync(process.execPath, [join(appDir, 'scripts', 'icons.mjs'), '--check'], { stdio: 'inherit' });
run(process.execPath, [join(appDir, 'scripts', 'build.mjs')]);
const builder = createRequire(import.meta.url).resolve('electron-builder/cli.js');
run(process.execPath, [builder, '--config', 'electron-builder.yml', ...args]);
