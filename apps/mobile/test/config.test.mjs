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

test('capabilities: least privilege', () => {
  const capDir = join(tauriDir, 'capabilities');
  const caps = readdirSync(capDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(capDir, f), 'utf8')));
  const scopes = cap => cap.permissions.filter(p => p.identifier === 'fs:scope').flatMap(p => p.allow.map(a => a.path));
  const ids = cap => cap.permissions.map(p => (typeof p === 'string' ? p : p.identifier));
  for (const cap of caps) {
    assert.deepEqual(cap.windows, ['main'], cap.identifier);
    for (const id of ids(cap)) {
      // No blanket fs permission sets (fs:default, fs:read-all, fs:allow-*-recursive …), no shell or http.
      assert.ok(/^(core:default|fs:scope|fs:allow-[a-z-]+|dialog:allow-(open|save|message)|sharekit:allow-share-file)$/.test(id), `${cap.identifier}: ${id}`);
      assert.ok(!/recursive|-all$/.test(id), `${cap.identifier}: ${id}`);
    }
    for (const path of scopes(cap)) assert.match(path, /^\$(APPDATA\/notes|APPCACHE\/share|TEMP\/\*\.pdf)/, `${cap.identifier}: ${path}`);
  }
  const byId = Object.fromEntries(caps.map(c => [c.identifier, c]));
  // The temp and cache share folders only on the platform that shares from them.
  assert.deepEqual(byId['share-ios'].platforms, ['iOS']);
  assert.deepEqual(scopes(byId['share-ios']), ['$TEMP/*.pdf']);
  assert.deepEqual(byId['share-android'].platforms, ['android']);
  assert.ok(!ids(byId.default).includes('sharekit:allow-share-file'));
  assert.deepEqual(scopes(byId.default), ['$APPDATA/notes', '$APPDATA/notes/*']);
});
