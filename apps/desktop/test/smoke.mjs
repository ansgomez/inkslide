// Desktop smoke test: launches Electron with the fixture page and checks the
// bridge end to end (open from the command line, notes sidecar, app-storage
// fallback for a read-only folder, notes backups (app storage, legacy file
// removed, turned off), second instance forwarding its file,
// notes written before the window closes, printing a PDF, and on Linux the
// same through a desktop entry launched by gio: %f with a file, a second
// launch forwarding).
// Run after `node scripts/build.mjs`; a window may flash briefly.
// INKSLIDE_SMOKE_EXE=/path/to/Inkslide.AppImage (or another packaged
// executable) runs the checks against that build instead of the dev one; it
// must be a test build (INKSLIDE_TEST_BUILD=1 when packaging), as release
// builds ignore INKSLIDE_PAGE, INKSLIDE_SMOKE and the other test variables.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { devDesktopEntry, escapeValue, quoteExecArg } from '../scripts/desktop-entry.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(appDir, 'test', 'fixture-page', 'index.html');
const tmp = mkdtempSync(join(tmpdir(), 'inkslide-smoke-'));
const exe = process.env.INKSLIDE_SMOKE_EXE ? resolve(process.env.INKSLIDE_SMOKE_EXE) : null;

const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

/** Two pages of different sizes, text on the first (for the print check). */
const PRINT_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >> endobj
4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] >> endobj
5 0 obj << /Length 51 >> stream
BT /F1 24 Tf 72 700 Td (Inkslide print smoke) Tj ET
endstream endobj
6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

function makePdf(dir, name = 'deck.pdf', content = PDF) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const sha = createHash('sha256').update(PDF).digest('hex');

/** Start Electron; resolves with { code, out } when it exits. */
function launch(args, env, opts) {
  return run(exe ?? electron, exe ? args : [appDir, ...args], env, opts);
}

/**
 * Run a command; resolves with { code, out } once its output closes, so
 * also after the app that `gio launch` starts (it inherits the pipes).
 */
function run(cmd, args, env, { onLine, timeoutMs = 45000 } = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(cmd, args, {
      env: { ...process.env, INKSLIDE_PAGE: page, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let code = null;
    const timer = setTimeout(() => {
      out += '\n[smoke] timeout, killing\n';
      if (code === null) process.kill(child.pid, 'SIGKILL');
      // gio has exited already; kill the app it started, which holds the pipes.
      else if (env.INKSLIDE_USER_DATA) killByEnv(`INKSLIDE_USER_DATA=${env.INKSLIDE_USER_DATA}`);
      resolvePromise({ code, out });
    }, timeoutMs);
    let partial = '';
    child.stdout.on('data', d => {
      out += d;
      const lines = (partial + d).split('\n');
      partial = lines.pop();
      if (onLine) lines.forEach(l => l && onLine(l));
    });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', c => { code = c; });
    child.on('close', () => {
      clearTimeout(timer);
      resolvePromise({ code, out });
    });
  });
}

/** Kill (by PID) the processes whose environment has `entry` (Linux /proc). */
function killByEnv(entry) {
  for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(entry)) process.kill(Number(pid), 'SIGKILL');
    } catch (_) {
      // gone, or not ours
    }
  }
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `\n${detail}`}`);
}
const smokeLine = out => out.split('\n').find(l => /^SMOKE (OK|FAIL)/.test(l)) ?? '(no SMOKE line)';

try {
  // 1. Writable folder: sidecar next to the PDF.
  {
    const pdf = makePdf(join(tmp, 'rw'));
    writeFileSync(`${pdf}.notes.backup.json`, '{}'); // written by older development builds
    const userData = join(tmp, 'ud1');
    // Backups and unreadable copies of other PDFs: older than 90 days go at startup.
    const old = join(userData, 'notes', `${'a'.repeat(64)}.notes.backup.json`);
    const oldCopy = join(userData, 'notes', `${'a'.repeat(64)}.notes.unreadable.json`);
    const fresh = join(userData, 'notes', `${'b'.repeat(64)}.notes.backup.json`);
    mkdirSync(dirname(old), { recursive: true });
    for (const f of [old, oldCopy, fresh]) writeFileSync(f, '{}');
    const longAgo = new Date(Date.now() - 91 * 24 * 60 * 60_000);
    for (const f of [old, oldCopy]) utimesSync(f, longAgo, longAgo);
    const r = await launch([pdf], { INKSLIDE_SMOKE: 'basic', INKSLIDE_USER_DATA: userData });
    console.log(`[1] ${smokeLine(r.out)}`);
    check('basic run exits 0 with SMOKE OK', r.code === 0 && r.out.includes('SMOKE OK'), r.out);
    const sidecar = `${pdf}.notes.json`;
    check('sidecar written next to the PDF', existsSync(sidecar) && readFileSync(sidecar, 'utf8').includes('"p1"'));
    check('pathless notes in userData/notes/<sha256>', existsSync(join(userData, 'notes', `${sha}.notes.json`)));
    const backup = join(userData, 'notes', `${sha}.notes.backup.json`);
    check('backup in userData/notes/<sha256>.notes.backup.json', existsSync(backup) && readFileSync(backup, 'utf8').includes('"second"'));
    const kept = join(userData, 'notes', `${sha}.notes.unreadable.json`);
    check('unreadable notes kept as they were', existsSync(kept) && readFileSync(kept, 'utf8') === '{ unreadable');
    check('backups and unreadable copies older than 90 days removed at startup, newer kept',
      !existsSync(old) && !existsSync(oldCopy) && existsSync(fresh));
    check('nothing but the PDF and its notes in its folder (legacy backup removed)',
      readdirSync(dirname(pdf)).sort().join(',') === 'deck.pdf,deck.pdf.notes.json', readdirSync(dirname(pdf)).join(','));
    check('recent files list has the PDF',
      existsSync(join(userData, 'recent-files.json')) && readFileSync(join(userData, 'recent-files.json'), 'utf8').includes('deck.pdf'));
  }

  // 2. Read-only folder: notes fall back to app storage.
  if (process.getuid && process.getuid() !== 0) {
    const dir = join(tmp, 'ro');
    const pdf = makePdf(dir);
    chmodSync(dir, 0o555);
    const userData = join(tmp, 'ud2');
    const r = await launch([pdf], { INKSLIDE_SMOKE: 'basic', INKSLIDE_USER_DATA: userData });
    chmodSync(dir, 0o755);
    console.log(`[2] ${smokeLine(r.out)}`);
    check('read-only run exits 0 with SMOKE OK', r.code === 0 && r.out.includes('SMOKE OK'), r.out);
    check('no sidecar in the read-only folder', !existsSync(`${pdf}.notes.json`));
    const fb = join(userData, 'notes', `${sha}.notes.json`);
    check('fallback notes written', existsSync(fb) && readFileSync(fb, 'utf8').includes(sha));
    check('no backup in the read-only folder', !existsSync(`${pdf}.notes.backup.json`));
    const fbBackup = join(userData, 'notes', `${sha}.notes.backup.json`);
    check('backup of app-storage notes in userData/notes/<sha256>.notes.backup.json', existsSync(fbBackup) && readFileSync(fbBackup, 'utf8').includes('"second"'));
  }

  // 2a. Switching backups off (as the menu does) deletes every PDF's backup, not the unreadable copies.
  {
    const pdf = makePdf(join(tmp, 'off'));
    const userData = join(tmp, 'ud2a');
    const other = join(userData, 'notes', `${'c'.repeat(64)}.notes.backup.json`);
    const otherCopy = join(userData, 'notes', `${'c'.repeat(64)}.notes.unreadable.json`);
    mkdirSync(dirname(other), { recursive: true });
    for (const f of [other, otherCopy]) writeFileSync(f, '{}');
    const r = await launch([pdf], { INKSLIDE_SMOKE: 'backupsoff', INKSLIDE_USER_DATA: userData });
    console.log(`[2a] ${smokeLine(r.out)}`);
    check('backups switched off: run exits 0 with SMOKE OK', r.code === 0 && r.out.includes('SMOKE OK'), r.out);
    const left = readdirSync(join(userData, 'notes'));
    check('backups switched off: every backup deleted, unreadable copies kept',
      !left.some(n => n.endsWith('.notes.backup.json')) && left.includes(`${'c'.repeat(64)}.notes.unreadable.json`) && left.includes(`${sha}.notes.unreadable.json`),
      left.join(','));
    check('backups switched off: remembered', readFileSync(join(userData, 'preferences.json'), 'utf8').includes('"backups": false'));
  }

  // 2b. Backups turned off in the preferences: nothing is written.
  {
    const pdf = makePdf(join(tmp, 'nobackup'));
    const userData = join(tmp, 'ud2b');
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, 'preferences.json'), JSON.stringify({ backups: false }));
    const r = await launch([pdf], { INKSLIDE_SMOKE: 'nobackup', INKSLIDE_USER_DATA: userData });
    console.log(`[2b] ${smokeLine(r.out)}`);
    check('backups off: run exits 0 with SMOKE OK', r.code === 0 && r.out.includes('SMOKE OK'), r.out);
    check('backups off: no backup file', !existsSync(`${pdf}.notes.backup.json`) && !existsSync(join(userData, 'notes')));
  }

  // 3. Second instance forwards its file to the running window.
  {
    const pdf = makePdf(join(tmp, 'fw'), 'second.pdf');
    const env = { INKSLIDE_USER_DATA: join(tmp, 'ud3') };
    let second;
    const first = launch([], { ...env, INKSLIDE_SMOKE: 'forward' }, {
      onLine: l => {
        if (l === 'SMOKE READY' && !second) second = launch([pdf], env);
      },
    });
    const r1 = await first;
    const r2 = second ? await second : { code: null, out: '(second instance not started)' };
    console.log(`[3] ${smokeLine(r1.out)}`);
    check('first instance got the forwarded file', r1.code === 0 && r1.out.includes('"forwarded":"second.pdf"'), r1.out);
    check('second instance quit at once', r2.code === 0, r2.out);
  }

  // 4. Closing the window waits for the page to write its notes.
  {
    const pdf = makePdf(join(tmp, 'close'));
    const userData = join(tmp, 'ud4');
    const r = await launch([pdf], { INKSLIDE_SMOKE: 'close', INKSLIDE_USER_DATA: userData });
    console.log(`[4] ${smokeLine(r.out)}`);
    check('close run exits 0 with SMOKE OK', r.code === 0 && r.out.includes('SMOKE OK'), r.out);
    const sidecar = `${pdf}.notes.json`;
    check('notes saved on close', existsSync(sidecar) && readFileSync(sidecar, 'utf8').includes('saved-on-close'));
    const fb = join(userData, 'notes', `${sha}.notes.json`);
    check('a write still running at quit completes', existsSync(fb) && readFileSync(fb, 'utf8').includes('written-while-quitting'));
  }

  // 5. Desktop entry (Linux): gio expands %f like the file manager's
  //    "Open With"; a second launch reaches the running window. With
  //    INKSLIDE_SMOKE_EXE, an entry like the AppImage's (%U: file:// URLs).
  const gio = process.platform === 'linux' && spawnSync('gio', ['version']).status === 0;
  if (gio) {
    const entry = join(tmp, 'inkslide-smoke.desktop');
    writeFileSync(entry, exe
      ? `[Desktop Entry]\nType=Application\nName=Inkslide\nExec=${escapeValue(quoteExecArg(exe))} %U\n`
      : devDesktopEntry({ electron, appDir }));
    {
      const pdf = makePdf(join(tmp, 'entry dir'), 'my deck.pdf');
      const r = await run('gio', ['launch', entry, pdf], { INKSLIDE_SMOKE: 'basic', INKSLIDE_USER_DATA: join(tmp, 'ud5') });
      console.log(`[5] ${smokeLine(r.out)}`);
      check('desktop entry opens a path with spaces', r.out.includes('SMOKE OK {"name":"my deck.pdf"'), r.out);
    }
    {
      const pdf = makePdf(join(tmp, 'entry2'), 'second.pdf');
      const env = { INKSLIDE_USER_DATA: join(tmp, 'ud6') };
      let second;
      const r1 = await run('gio', ['launch', entry], { ...env, INKSLIDE_SMOKE: 'forward' }, {
        onLine: l => {
          if (l === 'SMOKE READY' && !second) second = run('gio', ['launch', entry, pdf], env);
        },
      });
      const r2 = second ? await second : { code: null, out: '(second launch not started)' };
      console.log(`[6] ${smokeLine(r1.out)}`);
      check('second desktop-entry launch reaches the running window', r1.out.includes('"forwarded":"second.pdf"'), r1.out);
      check('second desktop-entry launch quits', r2.code === 0 && !r2.out.includes('timeout'), r2.out);
    }
  }

  // 7. Print: the PDF itself goes to the printer (here: to a file instead of the dialog).
  {
    const pdf = makePdf(join(tmp, 'print'), 'print.pdf', PRINT_PDF);
    const out = join(tmp, 'printed.pdf');
    const r = await launch([pdf], { INKSLIDE_SMOKE: 'print', INKSLIDE_USER_DATA: join(tmp, 'ud7'), INKSLIDE_PRINT_TO_PDF: out });
    console.log(`[7] ${smokeLine(r.out)}`);
    check('print run exits 0 with SMOKE OK', r.code === 0 && r.out.includes('SMOKE OK'), r.out);
    const printed = existsSync(out) ? readFileSync(out, 'latin1') : '';
    const sizes = [...printed.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map(m => `${Math.round(m[1])}x${Math.round(m[2])}`);
    check('printed both pages at their own size', sizes.join(',') === '595x842,960x540', `MediaBoxes: ${sizes.join(',') || '(none)'}`);
    const text = spawnSync('pdftotext', [out, '-'], { encoding: 'utf8' });
    if (text.error) console.log('skip printed text check (no pdftotext)');
    else check('printed text is vector text', text.stdout.includes('Inkslide print smoke'), text.stdout);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok).length;
console.log(failed ? `SMOKE: ${failed} of ${results.length} checks failed` : `SMOKE: all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
