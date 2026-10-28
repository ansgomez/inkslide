// Fixture page for the desktop smoke test: drives window.inkslide.
// Mode comes from the hash (#smoke=basic | forward | close | print | nobackup | backupsoff (basic,
// then main switches backups off)); without one the
// page is a small manual test (open, drop, menu commands).
'use strict';

const bridge = window.inkslide;
const log = msg => { document.getElementById('log').textContent += `${msg}\n`; };

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function basic() {
  assert(bridge && bridge.platform === 'electron', 'bridge present');
  for (const k of ['openPdf', 'readNotes', 'writeNotes', 'readBackup', 'revertToBackup', 'opened', 'keepUnreadableNotes', 'exportPdf', 'print', 'importNotes', 'confirm',
    'onOpenRequest', 'initialPath', 'pathForFile', 'onMenuCommand', 'onCloseRequest']) {
    assert(typeof bridge[k] === 'function', `bridge.${k}`);
  }
  assert(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'no node in page');
  // Main grants no permission but fullscreen, also to permission checks.
  for (const name of ['clipboard-read', 'geolocation', 'notifications']) {
    const { state } = await navigator.permissions.query({ name });
    assert(state === 'denied', `permission ${name} is ${state}`);
  }

  const path = await bridge.initialPath();
  assert(typeof path === 'string', 'initial path from the command line');
  assert((await bridge.initialPath()) === null, 'initial path is handed out once');

  const pdf = await bridge.openPdf(path);
  assert(pdf.bytes instanceof Uint8Array, 'bytes are a Uint8Array');
  assert(new TextDecoder().decode(pdf.bytes.subarray(0, 5)) === '%PDF-', 'PDF header');
  const sha = await sha256Hex(pdf.bytes);

  assert((await bridge.readNotes(pdf, sha)) === null, 'no notes yet');
  const text = JSON.stringify({ format: 'marp-notes', version: 2, deck: { source: 'pdf', sha256: sha }, pages: [] });
  await bridge.writeNotes(pdf, text, sha);
  assert((await bridge.readNotes(pdf, sha)) === text, 'notes read back');
  const text2 = text.replace('"pages":[]', '"pages":[{"id":"p1","kind":"slide","slide":1,"strokes":[]}]');
  await bridge.writeNotes(pdf, text2, sha);
  assert((await bridge.readNotes(pdf, sha)) === text2, 'notes overwritten');
  // Without the hash, main computes it (path known).
  assert((await bridge.readNotes(pdf)) === text2, 'notes read back without sha256');

  // Backup: empty notes are not backed up; a save copies the saved notes first; revert swaps.
  assert((await bridge.readBackup(pdf, sha)) === null, 'no backup of empty notes');
  const inked = marker => text2.replace('"strokes":[]', `"strokes":[{"id":"${marker}","tool":"pen","color":"#000","size":3,"points":[[1,1,0.5],[9,9,0.5]]}]`);
  await bridge.writeNotes(pdf, inked('first'), sha);
  await bridge.writeNotes(pdf, inked('second'), sha);
  const found = await bridge.readBackup(pdf, sha);
  assert(found && found.text === inked('first') && Math.abs(found.time - Date.now()) < 60_000, 'backup of the saved notes, with its time');
  await bridge.opened(pdf, { sha256: sha, pages: 1 });
  assert((await bridge.revertToBackup(pdf, sha)) === inked('first'), 'revert returns the notes');
  assert((await bridge.readNotes(pdf, sha)) === inked('first'), 'revert: the backup is the notes');
  assert((await bridge.readBackup(pdf, sha)).text === inked('second'), 'revert: the notes are the backup');
  // An unreadable notes file is kept as it is before it is replaced.
  await bridge.writeNotes(pdf, '{ unreadable', sha);
  const kept = await bridge.keepUnreadableNotes(pdf, sha);
  assert(typeof kept === 'string' && kept.endsWith(`${sha}.notes.unreadable.json`), `unreadable copy kept: ${kept}`);
  await bridge.writeNotes(pdf, inked('first'), sha);

  let rejected = false;
  try {
    await bridge.openPdf('/etc/passwd');
  } catch (_) {
    rejected = true;
  }
  assert(rejected, 'openPdf refuses paths the user did not choose');
  rejected = false;
  try {
    await bridge.writeNotes({ path: '/tmp/not-opened.pdf', name: 'x', bytes: new Uint8Array() }, '{}');
  } catch (_) {
    rejected = true;
  }
  assert(rejected, 'writeNotes refuses PDFs that were not opened');

  // A File built in the page has no path.
  assert(bridge.pathForFile(new File(['x'], 'x.pdf')) === '', 'pathForFile of a page-made File');

  // No path: notes go to app storage by hash.
  const memPdf = { path: null, name: 'mem.pdf', bytes: pdf.bytes };
  await bridge.writeNotes(memPdf, text, undefined);
  assert((await bridge.readNotes(memPdf, sha)) === text, 'pathless notes by hash');

  return { name: pdf.name, size: pdf.bytes.length, sha256: sha };
}

async function forward() {
  const path = await new Promise((resolve, reject) => {
    const off = bridge.onOpenRequest(p => { off(); resolve(p); });
    setTimeout(() => reject(new Error('no open request from the second instance')), 20000);
  });
  const pdf = await bridge.openPdf(path);
  return { forwarded: pdf.name, size: pdf.bytes.length };
}

/** Notes are written when main asks before closing: one write awaited (after a delay), one not. */
async function close() {
  const pdf = await bridge.openPdf(await bridge.initialPath());
  const sha = await sha256Hex(pdf.bytes);
  const text = marker => JSON.stringify({ format: 'marp-notes', version: 2, deck: { source: 'pdf', sha256: sha }, pages: [], marker });
  bridge.onCloseRequest(async () => {
    await new Promise(r => setTimeout(r, 300));
    await bridge.writeNotes(pdf, text('saved-on-close'), sha);
    void bridge.writeNotes({ path: null, name: 'mem.pdf', bytes: pdf.bytes }, text('written-while-quitting'), sha);
    return true;
  });
  return { name: pdf.name };
}

/** Print the PDF from the command line (main writes it to INKSLIDE_PRINT_TO_PDF instead of the dialog). */
async function print() {
  const pdf = await bridge.openPdf(await bridge.initialPath());
  // A second print while one runs is refused (one at a time per window).
  const first = bridge.print(pdf.bytes, pdf.name);
  let refused = '';
  await bridge.print(pdf.bytes, pdf.name).catch(e => { refused = String(e.message || e); });
  assert(/already in progress/.test(refused), `second print refused: ${refused}`);
  const printed = await first;
  assert(printed === true, 'print resolved true');
  return { printed: pdf.name };
}

/** Backups turned off (preferences.json): saves copy nothing, revert is refused. */
async function nobackup() {
  const pdf = await bridge.openPdf(await bridge.initialPath());
  const sha = await sha256Hex(pdf.bytes);
  const notes = id => JSON.stringify({ format: 'marp-notes', version: 2, deck: { source: 'pdf', sha256: sha },
    pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [{ id, tool: 'pen', color: '#000', size: 3, points: [[1, 1, 0.5], [9, 9, 0.5]] }] }] });
  await bridge.writeNotes(pdf, notes('a'), sha);
  await bridge.writeNotes(pdf, notes('b'), sha);
  assert((await bridge.readBackup(pdf, sha)) === null, 'no backup written');
  let rejected = false;
  await bridge.revertToBackup(pdf, sha).catch(() => { rejected = true; });
  assert(rejected, 'revert refused');
  return { name: pdf.name, backups: false };
}

const mode = new URLSearchParams(location.hash.slice(1)).get('smoke');
const modes = { forward, close, print, nobackup };
window.inkslideSmoke = () => (modes[mode] || basic)();

if (!mode && bridge) {
  const show = async pdf => {
    if (!pdf) return log('cancelled');
    log(`opened ${pdf.name} (${pdf.bytes.length} bytes) ${pdf.path ?? ''}`);
    log(`notes: ${(await bridge.readNotes(pdf)) ?? 'none'}`);
  };
  bridge.initialPath().then(p => p && bridge.openPdf(p).then(show));
  bridge.onOpenRequest(p => bridge.openPdf(p).then(show, e => log(String(e))));
  bridge.onMenuCommand(c => log(`menu command: ${c}`));
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    const p = f && bridge.pathForFile(f);
    log(`dropped ${f && f.name} -> ${p || '(no path)'}`);
    if (p) bridge.openPdf(p).then(show, err => log(String(err)));
  });
}
