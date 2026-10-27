// Checks that the Tauri config matches the web app it wraps: paths, dev
// server port and the Content-Security-Policy (both the page's and Tauri's
// apply, so both must let the IPC through).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tauriDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const webDir = join(tauriDir, '..', '..', 'web');
const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
const viteConfig = readFileSync(join(webDir, 'vite.config.ts'), 'utf8');

/** The page CSP of the Tauri build (vite.config.ts, --mode tauri) as { directive: sources }. */
function pageCsp() {
  const list = viteConfig.match(/const CSP = \[([\s\S]*?)\]\.join/);
  const ipc = viteConfig.match(/const TAURI_IPC = '([^']+)'/);
  assert.ok(list && ipc, 'CSP list or TAURI_IPC not found in vite.config.ts');
  const csp = Object.fromEntries([...list[1].matchAll(/"([^"]+)"/g)].map(([, d]) => {
    const [name, ...sources] = d.split(' ');
    return [name, sources.join(' ')];
  }));
  csp['connect-src'] += ` ${ipc[1]}`;
  return csp;
}

test('identity and frontend', () => {
  assert.equal(conf.identifier, 'io.github.ansgomez.inkslide');
  assert.equal(conf.productName, 'Inkslide');
  assert.equal(resolve(tauriDir, conf.build.frontendDist), join(webDir, 'dist'));
  const port = viteConfig.match(/server: \{ port: (\d+)/);
  assert.equal(new URL(conf.build.devUrl).port, port && port[1]);
  assert.match(conf.build.beforeBuildCommand, /build:tauri/); // the page CSP with the IPC sources
});

test('drops reach the page (HTML5 drag and drop, as in the browser and Electron)', () => {
  assert.equal(conf.app.windows[0].dragDropEnabled, false);
});

test('icons exist', () => {
  for (const icon of conf.bundle.icon) assert.ok(existsSync(join(tauriDir, icon)), `${icon} is missing (run \`pnpm icons\`)`);
});

test('both CSPs allow the IPC and otherwise agree', () => {
  const page = pageCsp();
  const shell = conf.app.security.csp;
  for (const csp of [page, shell]) {
    assert.match(csp['connect-src'], /(^| )ipc:( |$)/);
    assert.match(csp['connect-src'], /(^| )http:\/\/ipc\.localhost( |$)/);
  }
  for (const [name, sources] of Object.entries(shell)) assert.equal(sources, page[name], name);
});

/** The app's own commands: build.rs (their permissions) and the handler in src/lib.rs. */
function appCommands() {
  const build = readFileSync(join(tauriDir, 'build.rs'), 'utf8').match(/const COMMANDS: &\[&str\] = &\[([^\]]*)\]/);
  const handler = readFileSync(join(tauriDir, 'src', 'lib.rs'), 'utf8').match(/generate_handler!\[([^\]]*)\]/);
  assert.ok(build && handler, 'COMMANDS (build.rs) or generate_handler! (lib.rs) not found');
  return { build: [...build[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1]), handler: handler[1].split(',').map(c => c.trim()).filter(Boolean) };
}

/**
 * The web view's only file access: these commands, which take a notes key or a
 * checked file name, never a free path (read_picked: only files pick_file picked).
 */
const FILE_COMMANDS = ['pick_file', 'read_picked', 'read_notes', 'write_notes', 'save_pdf', 'write_share_file', 'remove_share_file'];

test('capabilities: least privilege', () => {
  const capDir = join(tauriDir, 'capabilities');
  const caps = readdirSync(capDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(capDir, f), 'utf8')));
  const ids = cap => cap.permissions.map(p => (typeof p === 'string' ? p : p.identifier));
  for (const cap of caps) {
    assert.deepEqual(cap.windows, ['main'], cap.identifier);
    for (const id of ids(cap)) {
      // No fs plugin permission at all (on mobile it reads and writes file and content URLs without
      // a scope check), no open or save dialog command (they add the chosen file to the fs scope),
      // no shell or http: files only through the app's commands.
      assert.ok(/^(core:default|dialog:allow-message|sharekit:allow-share-file|allow-(pick-file|read-picked|read-notes|write-notes|save-pdf|write-share-file|remove-share-file))$/.test(id), `${cap.identifier}: ${id}`);
      assert.ok(!/^fs:/.test(id), `${cap.identifier}: ${id}: no fs plugin permission`);
      assert.ok(!/^dialog:(allow-(open|save)|default)$/.test(id), `${cap.identifier}: ${id}`);
    }
    // No inline scopes either.
    for (const p of cap.permissions) assert.equal(typeof p, 'string', `${cap.identifier}: ${JSON.stringify(p)}`);
  }
  const byId = Object.fromEntries(caps.map(c => [c.identifier, c]));
  // Sharing only on the platforms that share.
  assert.deepEqual(byId['share-ios'].platforms, ['iOS']);
  assert.deepEqual(byId['share-android'].platforms, ['android']);
  for (const id of ['share-ios', 'share-android']) {
    assert.deepEqual(ids(byId[id]).sort(), ['allow-remove-share-file', 'allow-write-share-file', 'sharekit:allow-share-file'], id);
  }
  assert.deepEqual(ids(byId.default).filter(i => /^allow-/.test(i)).sort(),
    ['allow-pick-file', 'allow-read-notes', 'allow-read-picked', 'allow-save-pdf', 'allow-write-notes']);
});

test('app commands: each has a permission (build.rs) and a handler', () => {
  const { build, handler } = appCommands();
  assert.deepEqual([...build].sort(), [...FILE_COMMANDS].sort());
  assert.deepEqual([...handler].sort(), [...FILE_COMMANDS].sort());
});

test('share names: the shared cases of the Rust and front-end tests are well-formed', () => {
  const cases = JSON.parse(readFileSync(join(tauriDir, '..', 'test', 'share-names.json'), 'utf8'));
  assert.ok(cases.length > 10);
  for (const c of cases) {
    assert.equal(typeof c.input, 'string');
    assert.match(c.output, /\.pdf$/);
  }
  // C1 controls are in the list (Rust's char::is_control rejects them).
  assert.ok(cases.some(c => /[\x80-\x9f]/.test(c.input) && c.bad));
});
