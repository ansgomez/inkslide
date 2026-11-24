// Keep the iPad build signed (macOS): a launchd agent that rebuilds and
// reinstalls Inkslide on the iPad before its provisioning profile expires.
//   node scripts/ios-refresh.mjs install [--device <id>] | uninstall | run [--force] | status
// A free Apple ID signs for 7 days. `run` reads the expiry of the build last
// installed (state.json, else the IPA in gen/apple/build/arm64); with more than
// RENEW_BEFORE_MS left it does nothing. Otherwise, when the iPad is reachable
// (USB or Wi-Fi) and no `tauri ios dev` runs, it builds this working tree
// (`tauri ios build --export-method debugging`, which renews the profile),
// installs it with devicectl and records the new expiry. Reinstalling keeps
// the app's data (notes). The agent runs every 4 h and at login, at background
// priority with CARGO_BUILD_JOBS=2; it notifies on failure and when the app
// expires within a day while the iPad cannot be reached.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'io.github.ansgomez.inkslide.ios-refresh';
/** Rebuild once the installed build expires within this time. */
export const RENEW_BEFORE_MS = 2 * 24 * 3600e3;
/** Warn (notification) when it expires within this time and the iPad is unreachable. */
export const WARN_BEFORE_MS = 24 * 3600e3;
/** How often launchd runs the check, in seconds. */
export const INTERVAL_S = 4 * 3600;

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(appDir, 'src-tauri', 'gen', 'apple', 'build');
/** The IPA `tauri ios build` exports: build/<arch>/Inkslide.ipa (build/Inkslide.ipa in older Tauri CLIs). */
const ipaPath = () => [join(buildDir, 'arm64', 'Inkslide.ipa'), join(buildDir, 'Inkslide.ipa')].find(existsSync)
  ?? join(buildDir, 'arm64', 'Inkslide.ipa');

/** Paths of the agent's files under a home directory. */
export const paths = (home = homedir()) => ({
  plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  stateDir: join(home, 'Library', 'Application Support', 'inkslide-ios-refresh'),
  state: join(home, 'Library', 'Application Support', 'inkslide-ios-refresh', 'state.json'),
  lock: join(home, 'Library', 'Application Support', 'inkslide-ios-refresh', 'run.lock'),
  log: join(home, 'Library', 'Logs', 'inkslide-ios-refresh.log'),
});

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The launchd agent: `node <script> run` every INTERVAL_S and at load, at background priority. */
export function agentPlist({ node, script, pathEnv, log }) {
  const str = (s) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key>
  <array>${str(node)}${str(script)}${str('run')}</array>
  <key>StartInterval</key><integer>${INTERVAL_S}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key>${str('Background')}
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${str(pathEnv)}
    <key>CARGO_BUILD_JOBS</key>${str('2')}
  </dict>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
</dict>
</plist>
`;
}

/** Whether a build that expires at `expires` (ms) needs renewing at `now`; unknown expiry: yes. */
export const needsRenewal = (expires, now, before = RENEW_BEFORE_MS) =>
  !Number.isFinite(expires) || expires - now <= before;

/** Whether `devicectl list devices --json-output` reports the device paired and reachable. */
export function deviceReachable(json, id) {
  const d = json?.result?.devices?.find((x) => x.identifier === id || x.hardwareProperties?.udid === id);
  const c = d?.connectionProperties;
  return !!c && c.pairingState === 'paired' && !!c.tunnelState && c.tunnelState !== 'unavailable';
}

/** The paired iPads (and iPhones) in `devicectl list devices --json-output`. */
export const pairedDevices = (json) => (json?.result?.devices ?? [])
  .filter((x) => x.hardwareProperties?.platform === 'iOS' && x.connectionProperties?.pairingState === 'paired')
  .map((x) => ({ id: x.identifier, name: x.deviceProperties?.name ?? '?', model: x.hardwareProperties?.marketingName ?? '' }));

/** Whether a `ps -axo command` listing contains a running `tauri ios dev`. */
export const devServerRunning = (psOutput) => /\btauri(\.js)? ios dev\b/.test(psOutput);

// ---------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r;
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
}

function notify(msg) {
  sh('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "Inkslide iPad build"`]);
}

function listDevices() {
  const dir = mkdtempSync(join(tmpdir(), 'inkslide-devices-'));
  try {
    const out = join(dir, 'devices.json');
    const r = sh('xcrun', ['devicectl', 'list', 'devices', '--json-output', out]);
    if (r.status !== 0 || !existsSync(out)) throw new Error(`devicectl list devices failed: ${r.stderr.trim()}`);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Expiry (ms) of the provisioning profile embedded in an unpacked .app. */
function profileExpiry(appPath) {
  const cms = sh('security', ['cms', '-D', '-i', join(appPath, 'embedded.mobileprovision')]);
  if (cms.status !== 0) throw new Error('could not read the provisioning profile');
  const r = sh('plutil', ['-extract', 'ExpirationDate', 'raw', '-'], { input: cms.stdout });
  const t = Date.parse(r.stdout.trim());
  if (r.status !== 0 || !Number.isFinite(t)) throw new Error('no ExpirationDate in the provisioning profile');
  return t;
}

/** Unpacks the IPA into a temp dir; returns the .app path and a cleanup function. */
function unpackIpa(ipa) {
  const dir = mkdtempSync(join(tmpdir(), 'inkslide-ipa-'));
  const r = sh('ditto', ['-x', '-k', ipa, dir]);
  if (r.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`could not unpack ${ipa}`); }
  const app = readdirSync(join(dir, 'Payload')).find((n) => n.endsWith('.app'));
  if (!app) { rmSync(dir, { recursive: true, force: true }); throw new Error('no .app in the IPA'); }
  return { app: join(dir, 'Payload', app), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const readState = (p) => { try { return JSON.parse(readFileSync(p.state, 'utf8')); } catch { return {}; } };
const writeState = (p, s) => { mkdirSync(p.stateDir, { recursive: true }); writeFileSync(p.state, JSON.stringify(s, null, 2) + '\n'); };

/** Expiry of the installed build: recorded by the last run, else that of the IPA last built. */
function installedExpiry(state) {
  if (Number.isFinite(Date.parse(state.expires))) return Date.parse(state.expires);
  if (!existsSync(ipaPath())) return NaN;
  const { app, cleanup } = unpackIpa(ipaPath());
  try { return profileExpiry(app); } finally { cleanup(); }
}

/** A lock file holding our pid; a lock of a process that is gone is taken over. */
function lock(p) {
  mkdirSync(p.stateDir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(p.lock, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); return true; } catch {
      const pid = Number(readFileSync(p.lock, 'utf8'));
      try { process.kill(pid, 0); return false; } catch { rmSync(p.lock, { force: true }); }
    }
  }
  return false;
}

function run(force) {
  const p = paths();
  if (!lock(p)) { log('another run is in progress'); return 0; }
  try {
    const state = readState(p);
    if (!state.device) { log('no device recorded; run "install" first'); return 1; }
    const expires = installedExpiry(state);
    const now = Date.now();
    const left = Number.isFinite(expires) ? `${((expires - now) / 3600e3).toFixed(1)} h left` : 'expiry unknown';
    if (!force && !needsRenewal(expires, now)) { log(`fresh (${left})`); return 0; }
    if (devServerRunning(sh('ps', ['-axo', 'command']).stdout)) { log(`tauri ios dev is running; skipped (${left})`); return 0; }
    if (!deviceReachable(listDevices(), state.device)) {
      log(`iPad not reachable (${left})`);
      const key = Number.isFinite(expires) ? new Date(expires).toISOString() : null;
      if (key && expires - now <= WARN_BEFORE_MS && state.warned !== key) {
        notify(`The app expires ${expires > now ? 'within a day' : 'now'}: unlock the iPad on the Mac's Wi-Fi or plug it in.`);
        writeState(p, { ...state, warned: key });
      }
      return 0;
    }
    log(`building (${left})`);
    const b = sh('pnpm', ['tauri', 'ios', 'build', '--export-method', 'debugging', '--ci'], { cwd: appDir, stdio: 'inherit' });
    if (b.status !== 0) { notify('The build failed; see ~/Library/Logs/inkslide-ios-refresh.log.'); log('build failed'); return 1; }
    const { app, cleanup } = unpackIpa(ipaPath());
    try {
      const i = sh('xcrun', ['devicectl', 'device', 'install', 'app', '--device', state.device, app], { stdio: 'inherit' });
      if (i.status !== 0) { notify('Installing on the iPad failed; see the log.'); log('install failed'); return 1; }
      const next = new Date(profileExpiry(app)).toISOString();
      writeState(p, { device: state.device, expires: next, installed: new Date().toISOString() });
      log(`installed; signed until ${next}`);
      return 0;
    } finally { cleanup(); }
  } catch (e) {
    log(`error: ${e.message}`);
    notify(`Refresh failed: ${e.message}`);
    return 1;
  } finally { rmSync(p.lock, { force: true }); }
}

function which(cmd) {
  const r = sh('/usr/bin/which', [cmd]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function install(deviceArg) {
  const p = paths();
  let device = deviceArg;
  if (!device) {
    const list = pairedDevices(listDevices());
    if (list.length !== 1) {
      console.error(list.length ? `several devices; pick one with --device:\n${list.map((d) => `  ${d.id}  ${d.name} ${d.model}`).join('\n')}`
        : 'no paired iPad; connect it once over USB and trust this Mac');
      return 1;
    }
    device = list[0].id;
  }
  const tools = ['pnpm', 'cargo', 'xcrun'].map((c) => [c, which(c)]);
  const missing = tools.filter(([, w]) => !w).map(([c]) => c);
  if (missing.length) { console.error(`not on the PATH: ${missing.join(', ')}`); return 1; }
  const dirs = [dirname(process.execPath), ...tools.map(([, w]) => dirname(w)), '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const pathEnv = [...new Set(dirs)].join(':');
  writeState(p, { ...readState(p), device });
  mkdirSync(dirname(p.plist), { recursive: true });
  mkdirSync(dirname(p.log), { recursive: true });
  writeFileSync(p.plist, agentPlist({ node: process.execPath, script: fileURLToPath(import.meta.url), pathEnv, log: p.log }));
  const domain = `gui/${process.getuid()}`;
  sh('launchctl', ['bootout', `${domain}/${LABEL}`]);
  const r = sh('launchctl', ['bootstrap', domain, p.plist]);
  if (r.status !== 0) { console.error(`launchctl bootstrap failed: ${r.stderr.trim()}`); return 1; }
  console.log(`installed ${p.plist}\ndevice ${device}; checks every ${INTERVAL_S / 3600} h; log ${p.log}`);
  return 0;
}

function uninstall() {
  const p = paths();
  sh('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
  rmSync(p.plist, { force: true });
  console.log(`removed ${p.plist} (state kept in ${p.stateDir})`);
  return 0;
}

function status() {
  const p = paths();
  const state = readState(p);
  const loaded = sh('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]).status === 0;
  let expires = NaN;
  try { expires = installedExpiry(state); } catch { /* shown as unknown */ }
  console.log([
    `agent: ${loaded ? 'loaded' : 'not loaded'} (${p.plist})`,
    `device: ${state.device ?? 'none'}`,
    `signed until: ${Number.isFinite(expires) ? new Date(expires).toISOString() : 'unknown'}`,
    `last install: ${state.installed ?? 'none by this agent'}`,
    `log: ${p.log}`,
  ].join('\n'));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') { console.error('ios-refresh runs on macOS only'); process.exit(1); }
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const code = cmd === 'install' ? install(opt('--device'))
    : cmd === 'uninstall' ? uninstall()
    : cmd === 'run' ? run(rest.includes('--force'))
    : cmd === 'status' ? status()
    : (console.error('usage: ios-refresh.mjs install [--device <id>] | uninstall | run [--force] | status'), 1);
  process.exit(code);
}
