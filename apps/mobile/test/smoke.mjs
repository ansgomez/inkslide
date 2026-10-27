// Smoke test of the Tauri shell on the desktop (Linux, WebKitGTK): builds
// src-tauri with the web build plus a test script as its frontend, runs it
// with a temporary XDG_DATA_HOME and checks, through the real plugins, the
// app's commands, the capabilities and the CSP, that read_picked reads a
// picked file (handed over with --features smoke, as the picker needs a
// person) and refuses others, and that the Tauri adapter reads and writes
// notes in the app data directory. Dialogs, export, share and print need a
// person (and the mobile ones a device), so they are not covered. Run after
// `pnpm --filter @inkslide/web build:tauri`; a window may flash briefly. The first run compiles for a few minutes.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(appDir, 'src-tauri');
const webDist = join(appDir, '..', 'web', 'dist');
const fixture = join(appDir, 'test', 'fixture-dist');
const targetDir = join(tauriDir, 'target', 'smoke');
const IDENTIFIER = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8')).identifier;
const TIMEOUT_MS = 60_000;

const pdf = box => `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${box}] >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;
const PDF1 = pdf('960 540'), PDF2 = pdf('595 842');
const sha = text => createHash('sha256').update(text).digest('hex');

/** Notes of PDF1 with one stroke, as if written by an earlier session. */
const SEEDED = {
  format: 'marp-notes', version: 2,
  deck: { source: 'pdf', title: 'deck', slides: 1, size: [960, 540], sha256: sha(PDF1), pageSizes: [[960, 540]] },
  pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [
    { id: 's-1', tool: 'pen', color: '#be1e3c', size: 3, points: [[100, 100, 0.5], [200, 120, 0.5]] },
  ] }],
};

// In the web view: read PDF1 through read_picked (the app was started with it
// as the picked file: built with --features smoke, INKSLIDE_SMOKE_PICK) and
// check that another path is refused, open PDF1 (its seeded notes must load:
// readNotes), then PDF2, import notes with a blank page and save them (writeNotes).
const pageScript = picked => `
// A failure is written to notes/smoke-error.notes.json (through write_notes:
// the page has no fs write permission), also when a step hangs (e.g. on a dialog).
const report = msg => window.__TAURI_INTERNALS__.invoke('write_notes', { key: 'smoke-error', text: msg });
let step = 'start';
const watchdog = setTimeout(() => void report('hangs at: ' + step + '\\n' + document.body.innerText.slice(0, 500)), 30000);
const wait = async (ok, what) => {
  for (let i = 0; i < 200; i++) { if (ok()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('timed out waiting for ' + what);
};
const bytes = s => new TextEncoder().encode(s);
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
// WebKitGTK: IPC calls made before the load event can hang (and every later one with them).
if (document.readyState !== 'complete') await new Promise(r => window.addEventListener('load', r, { once: true }));
try {
  await wait(() => window.inkslideViewer, 'the viewer');
  const v = window.inkslideViewer;
  if (document.body.dataset.platform !== 'tauri') throw new Error('not the Tauri adapter');
  step = 'read_picked';
  const raw = await invoke('read_picked', { id: ${JSON.stringify(picked)} });
  const pdf1 = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  if (new TextDecoder().decode(pdf1) !== ${JSON.stringify(PDF1)}) throw new Error('read_picked returned other bytes');
  const refused = await invoke('read_picked', { id: ${JSON.stringify(`${picked}.other`)} }).then(() => false, () => true);
  if (!refused) throw new Error('read_picked read a file that was not picked');
  step = 'open PDF1';
  await v.open({ path: null, name: 'deck.pdf', bytes: pdf1 });
  await wait(() => v.session, 'PDF1');
  if (!v.session.doc.hasNotes()) throw new Error('the seeded notes were not read');
  const first = v.session;
  step = 'open PDF2';
  await v.open({ path: null, name: 'portrait.pdf', bytes: bytes(${JSON.stringify(PDF2)}) });
  await wait(() => v.session && v.session !== first, 'PDF2');
  step = 'import and save';
  const notes = v.session.doc.toJSON();
  notes.pages.push({ id: 'b-smoke-1', kind: 'blank', after: 1, paper: 'grid', strokes: [] });
  await v.importNotes({ name: 'smoke.json', text: JSON.stringify(notes) });
  await v.save();
} catch (e) {
  await report(step + ': ' + String(e && e.message || e) + '\\n' + (e && e.stack || ''));
} finally {
  clearTimeout(watchdog);
}
`;

function buildFixture(picked) {
  if (!existsSync(join(webDist, 'index.html'))) throw new Error('no web build: run `pnpm --filter @inkslide/web build:tauri` first');
  rmSync(fixture, { recursive: true, force: true });
  cpSync(webDist, fixture, { recursive: true });
  writeFileSync(join(fixture, 'smoke.js'), pageScript(picked));
  const index = join(fixture, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace('</body>', '<script type="module" src="./smoke.js"></script></body>'));
}

function cargoBuild() {
  const r = spawnSync('cargo', ['build', '--features', 'tauri/custom-protocol,smoke'], {
    cwd: tauriDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      CARGO_TARGET_DIR: targetDir,
      TAURI_CONFIG: JSON.stringify({ build: { frontendDist: fixture, beforeBuildCommand: '' } }),
    },
  });
  if (r.status !== 0) throw new Error(`cargo build failed (${r.status ?? r.error})`);
}

/** Run the app until `done()` holds; kills it (by PID) either way. */
function runUntil(env, done) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(targetDir, 'debug', 'inkslide'), [], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const started = Date.now();
    const timer = setInterval(() => {
      if (done()) finish(null);
      else if (Date.now() - started > TIMEOUT_MS) finish(new Error(`timed out; app output:\n${out}`));
    }, 200);
    child.on('exit', code => finish(done() ? null : new Error(`the app exited (${code}); output:\n${out}`)));
    function finish(err) {
      clearInterval(timer);
      if (child.exitCode === null) child.kill('SIGTERM');
      err ? reject(err) : resolve();
    }
  });
}

if (process.platform !== 'linux') {
  console.log('smoke: Linux only (WebKitGTK), skipped');
  process.exit(0);
}
const data = mkdtempSync(join(tmpdir(), 'inkslide-tauri-smoke-'));
try {
  const picked = join(data, 'picked', 'deck.pdf');
  mkdirSync(dirname(picked), { recursive: true });
  writeFileSync(picked, PDF1);
  writeFileSync(`${picked}.other`, PDF2);
  buildFixture(picked);
  cargoBuild();
  const notesDir = join(data, IDENTIFIER, 'notes');
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(join(notesDir, `${sha(PDF1)}.notes.json`), JSON.stringify(SEEDED));
  const written = join(notesDir, `${sha(PDF2)}.notes.json`);
  const error = join(notesDir, 'smoke-error.notes.json');
  await runUntil({ XDG_DATA_HOME: data, INKSLIDE_SMOKE_PICK: picked }, () => existsSync(written) || existsSync(error));
  if (existsSync(error)) throw new Error(`in the page: ${readFileSync(error, 'utf8')}`);
  const notes = JSON.parse(readFileSync(written, 'utf8'));
  if (notes.deck.sha256 !== sha(PDF2) || !notes.pages.some(p => p.id === 'b-smoke-1')) throw new Error(`unexpected notes: ${JSON.stringify(notes)}`);
  const left = readdirSync(notesDir).filter(f => f.endsWith('.tmp'));
  if (left.length) throw new Error(`temp files left: ${left.join(', ')}`);
  console.log('smoke: ok (picked file read, other file refused; notes read from and written to the app data directory)');
} finally {
  rmSync(data, { recursive: true, force: true });
}
