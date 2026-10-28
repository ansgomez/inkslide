// Checks before electron-builder runs (no I/O of their own; see scripts/dist.mjs).

/** linux.target of electron-builder.yml (a test keeps the two equal). */
export const DEFAULT_LINUX_TARGETS = ['AppImage', 'rpm'];

/**
 * Linux targets an electron-builder command line builds on `platform`,
 * lower-cased and without `:arch`: the names after --linux, the config
 * defaults for a bare --linux or no platform flag on Linux, none when only
 * --win / --mac are given or with --dir (unpacked only).
 */
export function linuxTargets(args, platform) {
  const argv = args.flatMap(a => (/^--?\w+=/.test(a) ? a.split(/=(.*)/s, 2) : [a]));
  if (argv.includes('--dir')) return [];
  const clean = list => list.map(t => t.split(':')[0].toLowerCase());
  const i = argv.findIndex(a => a === '--linux' || a === '-l');
  if (i < 0) {
    const otherPlatform = argv.some(a => ['--win', '-w', '--windows', '--mac', '-m', '--macos', '-o'].includes(a));
    return platform === 'linux' && !otherPlatform ? clean(DEFAULT_LINUX_TARGETS) : [];
  }
  const named = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('-'); k++) named.push(...argv[k].split(','));
  return clean(named.length ? named : DEFAULT_LINUX_TARGETS);
}

/** The dnf command that installs what the RPM target needs. */
export const RPM_INSTALL = 'sudo dnf install rpm-build libxcrypt-compat';

/**
 * What the RPM target is missing: rpmbuild (from rpm-build) and
 * libcrypt.so.1 (libxcrypt-compat, for the Ruby inside electron-builder's fpm).
 * `has(name)` says whether a command is on PATH; `libs` is the output of
 * `ldconfig -p`, or null if that could not run (then libcrypt is not checked).
 * @param {{ has: (name: string) => boolean, libs: string | null }} probe
 */
export function missingForRpm({ has, libs }) {
  const missing = [];
  if (!has('rpmbuild')) missing.push('rpmbuild (package rpm-build)');
  if (libs !== null && !/\blibcrypt\.so\.1\b/.test(libs)) {
    missing.push('libcrypt.so.1 (package libxcrypt-compat)');
  }
  return missing;
}

/**
 * A test build (packaged, but still honoring INKSLIDE_PAGE, INKSLIDE_SMOKE and
 * the other test variables; src/main/paths.ts testEnv) only with the explicit
 * `--test-build` flag. INKSLIDE_TEST_BUILD=1 left in the shell would make a
 * normal-looking package take them, so without the flag it is an error.
 * Returns the electron-builder arguments (the flag removed), whether this is
 * a test build, and an error message or null.
 */
export function testBuildOptions(args, env) {
  const testBuild = args.includes('--test-build');
  const rest = args.filter(a => a !== '--test-build');
  const error = !testBuild && env.INKSLIDE_TEST_BUILD
    ? 'INKSLIDE_TEST_BUILD is set: unset it for a normal package, or pass --test-build for a test build'
    : null;
  return { args: rest, testBuild, error };
}

/**
 * electron-builder overrides that give a test build's packages a "-TEST"
 * suffix: every artifactName of electron-builder.yml (`yml`, its text), with
 * -TEST before the extension.
 */
export function testArtifactOverrides(yml) {
  const out = [];
  let section = '';
  for (const line of yml.split('\n')) {
    const top = /^(\w+):/.exec(line);
    if (top) section = top[1];
    const name = /^ {2}artifactName: (.+)$/.exec(line);
    if (name && section) out.push(`-c.${section}.artifactName=${name[1].trim().replace(/\.\$\{ext\}$/, '-TEST.${ext}')}`);
  }
  return out;
}
