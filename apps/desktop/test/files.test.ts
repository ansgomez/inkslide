import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canWriteIn, MAX_TEXT_BYTES, readFileChecked, readFileLimited, RefusedLinkError, renameRetrying, sameFile, writeExport, writeFileAtomic } from '../src/main/fsutil';
import {
  backupBeforeSave, BACKUP_MIN_AGE_MS, hasBackup, isUsableNotes, notesWritePath, readBackupFor, readNotesFor, removeAllBackups, removeLegacyBackup,
  cleanupNotesStore, keepUnreadableFor, OLD_COPIES_MAX_AGE_DAYS,
  revertToBackupFor, sha256OfBytes, writeNotesFor,
} from '../src/main/notes';
import { tempDir } from './helpers';

const isRoot = !!process.getuid && process.getuid() === 0;
const pdfBytes = new TextEncoder().encode('%PDF-1.4 test');
const sha = sha256OfBytes(pdfBytes);

function pdfIn(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'deck.pdf');
  writeFileSync(p, pdfBytes);
  return p;
}

describe('writeFileAtomic', () => {
  it('writes and replaces, leaving no temp files', async () => {
    const dir = tempDir();
    const f = join(dir, 'a.json');
    await writeFileAtomic(f, 'one');
    await writeFileAtomic(f, new TextEncoder().encode('two'));
    expect(readFileSync(f, 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
  it('fails without touching the target when the folder is missing', async () => {
    const f = join(tempDir(), 'nope', 'a.json');
    await expect(writeFileAtomic(f, 'x')).rejects.toThrow();
    expect(existsSync(f)).toBe(false);
  });
  it('writes a name that is near the length limit (the temp name is shorter)', async () => {
    const dir = tempDir();
    const f = join(dir, `${'n'.repeat(240)}.pdf.notes.json`);
    await writeFileAtomic(f, 'long');
    expect(readFileSync(f, 'utf8')).toBe('long');
    expect(readdirSync(dir)).toHaveLength(1);
  });
  it.skipIf(process.platform === 'win32')('keeps the permissions of the file it replaces', async () => {
    const f = join(tempDir(), 'shared.json');
    writeFileSync(f, 'old');
    chmodSync(f, 0o660);
    await writeFileAtomic(f, 'new');
    expect(statSync(f).mode & 0o777).toBe(0o660);
  });
  it.skipIf(process.platform === 'win32')('writes through a symlink, keeping the link', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'synced'));
    const target = join(dir, 'synced', 'deck.pdf.notes.json');
    writeFileSync(target, 'old');
    const link = join(dir, 'deck.pdf.notes.json');
    symlinkSync(target, link);
    await writeFileAtomic(link, 'new');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });
  it.skipIf(isRoot)('keeps the old content when the write fails', async () => {
    const dir = tempDir();
    const f = join(dir, 'a.json');
    writeFileSync(f, 'old');
    chmodSync(dir, 0o555);
    try {
      await expect(writeFileAtomic(f, 'new')).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readFileSync(f, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
});

describe('renameRetrying', () => {
  const failing = (codes: string[]) => {
    const tries: string[] = [];
    const rename = async (from: string, to: string) => {
      tries.push(`${from}>${to}`);
      const code = codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
    };
    return { tries, rename };
  };
  it('tries again on Windows while the target is busy (antivirus, OneDrive)', async () => {
    const r = failing(['EPERM', 'EBUSY', 'EACCES']);
    await renameRetrying('a', 'b', 'win32', r.rename);
    expect(r.tries).toHaveLength(4);
  });
  it('gives up on Windows after a few tries, and at once on other errors', async () => {
    const busy = failing(Array(10).fill('EBUSY'));
    await expect(renameRetrying('a', 'b', 'win32', busy.rename)).rejects.toThrow('EBUSY');
    expect(busy.tries).toHaveLength(6);
    const missing = failing(['ENOENT']);
    await expect(renameRetrying('a', 'b', 'win32', missing.rename)).rejects.toThrow('ENOENT');
    expect(missing.tries).toHaveLength(1);
  });
  it('tries once elsewhere', async () => {
    const r = failing(['EPERM']);
    await expect(renameRetrying('a', 'b', 'linux', r.rename)).rejects.toThrow('EPERM');
    expect(r.tries).toHaveLength(1);
  });
});

describe('readFileChecked', () => {
  it('reads files and allowed links, null when missing, refuses other links', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.json'), 'A');
    expect((await readFileChecked(join(dir, 'a.json')))?.toString()).toBe('A');
    expect(await readFileChecked(join(dir, 'none.json'))).toBeNull();
    if (process.platform === 'win32') return;
    symlinkSync('a.json', join(dir, 'link.json'));
    expect((await readFileChecked(join(dir, 'link.json'), () => true))?.toString()).toBe('A');
    await expect(readFileChecked(join(dir, 'link.json'), () => false)).rejects.toThrow(RefusedLinkError);
    symlinkSync('gone.json', join(dir, 'dangling.json'));
    expect(await readFileChecked(join(dir, 'dangling.json'), () => false)).toBeNull();
  });
  it.skipIf(process.platform === 'win32')('does not read a file swapped in after the link was checked', async () => {
    const dir = tempDir();
    const target = join(dir, 'deck.pdf.notes.json');
    writeFileSync(target, 'checked');
    symlinkSync(target, join(dir, 'side.json'));
    // Between the check and the open: the checked file is replaced by another one.
    const swapFile = () => { rmSync(target); writeFileSync(target, 'swapped'); return true; };
    await expect(readFileChecked(join(dir, 'side.json'), swapFile)).rejects.toThrow(/changed while it was read/);
    // ... or by a link to a secret: not followed (O_NOFOLLOW).
    writeFileSync(join(dir, 'secret'), 'secret');
    const swapLink = () => { rmSync(target); symlinkSync(join(dir, 'secret'), target); return true; };
    const r = await readFileChecked(join(dir, 'side.json'), swapLink).then(b => b?.toString(), (e: Error) => e.message);
    expect(r).not.toBe('secret');
  });
  it('reads at most maxBytes (MAX_TEXT_BYTES by default)', async () => {
    const f = join(tempDir(), 'deck.pdf.notes.json');
    writeFileSync(f, '12345678');
    expect((await readFileChecked(f, undefined, 8))?.toString()).toBe('12345678');
    await expect(readFileChecked(f, undefined, 7)).rejects.toThrow(/too large/);
    // Sparse: large on disk without taking space; refused before anything is read.
    const big = join(tempDir(), 'big.pdf.notes.json');
    writeFileSync(big, '');
    truncateSync(big, MAX_TEXT_BYTES + 1);
    await expect(readFileChecked(big)).rejects.toThrow(/too large/);
  });
  it.skipIf(process.platform === 'win32')('reads regular files only: no device through a link, no FIFO (without waiting for a writer)', async () => {
    const dir = tempDir();
    symlinkSync('/dev/zero', join(dir, 'zero.json'));
    await expect(readFileChecked(join(dir, 'zero.json'), () => true)).rejects.toThrow(/not a file/);
    const fifo = join(dir, 'fifo.json');
    if (spawnSync('mkfifo', [fifo]).status !== 0) return; // no mkfifo
    await expect(readFileChecked(fifo)).rejects.toThrow(/not a file/);
    symlinkSync(fifo, join(dir, 'to-fifo.json'));
    await expect(readFileChecked(join(dir, 'to-fifo.json'), () => true)).rejects.toThrow(/not a file/);
  });
});

describe('readFileLimited', () => {
  it('reads a regular file with its size and time, through one handle', async () => {
    const f = join(tempDir(), 'deck.pdf');
    writeFileSync(f, pdfBytes);
    const r = await readFileLimited(f, 100);
    expect(r.bytes.toString()).toBe('%PDF-1.4 test');
    expect({ size: r.size, mtimeMs: r.mtimeMs }).toEqual({ size: statSync(f).size, mtimeMs: statSync(f).mtimeMs });
    // Its own memory: a view of a shared pool would send that pool over IPC.
    expect(r.bytes.buffer.byteLength).toBe(pdfBytes.length);
  });
  it('refuses a file over the limit before reading it, and anything but a regular file', async () => {
    const dir = tempDir();
    const f = join(dir, 'big.pdf');
    writeFileSync(f, '');
    truncateSync(f, 1025);
    await expect(readFileLimited(f, 1024)).rejects.toThrow(/too large/);
    if (process.platform === 'win32') return;
    await expect(readFileLimited(dir, 1024)).rejects.toThrow(/not a file/);
    await expect(readFileLimited('/dev/zero', 1024)).rejects.toThrow(/not a file/);
    const fifo = join(dir, 'fifo.pdf');
    if (spawnSync('mkfifo', [fifo]).status !== 0) return; // no mkfifo
    await expect(readFileLimited(fifo, 1024)).rejects.toThrow(/not a file/); // without waiting for a writer
  });
});

describe('writeExport', () => {
  it('never replaces the open PDF, also not through a link', async () => {
    const dir = tempDir();
    const pdf = pdfIn(dir);
    await expect(writeExport(pdf, new Uint8Array([1]), pdf)).rejects.toThrow(/cannot replace the PDF that is open/);
    if (process.platform !== 'win32') {
      symlinkSync(pdf, join(dir, 'link.pdf'));
      await expect(writeExport(join(dir, 'link.pdf'), new Uint8Array([1]), pdf)).rejects.toThrow(/open/);
    }
    expect(readFileSync(pdf)).toEqual(Buffer.from(pdfBytes));
    await writeExport(join(dir, 'out.pdf'), new Uint8Array([1, 2]), pdf);
    expect([...readFileSync(join(dir, 'out.pdf'))]).toEqual([1, 2]);
  });
  it.skipIf(process.platform === 'win32')('replaces a link at the destination instead of writing to its target', async () => {
    const dir = tempDir();
    const important = join(dir, 'important-document.docx');
    writeFileSync(important, 'keep me');
    const dest = join(dir, 'deck-notes.pdf');
    symlinkSync(important, dest);
    await writeExport(dest, new TextEncoder().encode('%PDF-export'), null);
    expect(readFileSync(important, 'utf8')).toBe('keep me');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('%PDF-export');
  });
});

describe('sameFile', () => {
  it('sees one file through links and other spellings', async () => {
    const dir = tempDir();
    const pdf = pdfIn(dir);
    expect(await sameFile(pdf, join(dir, '.', 'deck.pdf'))).toBe(true);
    linkSync(pdf, join(dir, 'hard.pdf'));
    expect(await sameFile(join(dir, 'hard.pdf'), pdf)).toBe(true);
    if (process.platform !== 'win32') {
      symlinkSync(pdf, join(dir, 'soft.pdf'));
      expect(await sameFile(join(dir, 'soft.pdf'), pdf)).toBe(true);
    }
    writeFileSync(join(dir, 'other.pdf'), pdfBytes);
    expect(await sameFile(join(dir, 'other.pdf'), pdf)).toBe(false);
    expect(await sameFile(join(dir, 'missing.pdf'), pdf)).toBe(false);
  });
});

describe('notes location', () => {
  it('uses the sidecar when the folder is writable', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(join(dir, 'lectures'));
    expect(await canWriteIn(join(dir, 'lectures'))).toBe(true);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBeNull();
    const written = await writeNotesFor({ path: pdf, sha256: sha }, '{"a":1}', ud);
    expect(written).toBe(`${pdf}.notes.json`);
    expect(await readNotesFor({ path: pdf }, ud)).toBe('{"a":1}');
    expect(existsSync(join(ud, 'notes'))).toBe(false);
  });

  it.skipIf(isRoot)('falls back to userData/notes/<sha256> when the folder is read-only', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(join(dir, 'ro'));
    chmodSync(join(dir, 'ro'), 0o555);
    try {
      expect(await notesWritePath({ path: pdf }, ud)).toBe(join(ud, 'notes', `${sha}.notes.json`));
      await writeNotesFor({ path: pdf }, 'fallback', ud); // hash computed from the file
      expect(await readNotesFor({ path: pdf }, ud)).toBe('fallback');
      expect(existsSync(`${pdf}.notes.json`)).toBe(false);
    } finally {
      chmodSync(join(dir, 'ro'), 0o755);
    }
  });

  it.skipIf(isRoot)('falls back when the sidecar itself is read-only', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    writeFileSync(`${pdf}.notes.json`, 'old');
    chmodSync(`${pdf}.notes.json`, 0o444);
    expect(await notesWritePath({ path: pdf, sha256: sha }, ud)).toBe(join(ud, 'notes', `${sha}.notes.json`));
    // The notes written to app storage are the ones read back, not the old sidecar.
    utimesSync(`${pdf}.notes.json`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await writeNotesFor({ path: pdf, sha256: sha }, 'new', ud);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('new');
    expect(readFileSync(`${pdf}.notes.json`, 'utf8')).toBe('old');
  });

  it('reads app storage when it is newer than the sidecar (folder was read-only for a while)', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    writeFileSync(`${pdf}.notes.json`, 'stale');
    const past = new Date(Date.now() - 60_000);
    utimesSync(`${pdf}.notes.json`, past, past);
    await writeNotesFor({ path: null, sha256: sha }, 'newer', ud);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('newer');
    // The next write goes to the (writable) sidecar, which is then the newest.
    await writeNotesFor({ path: pdf, sha256: sha }, 'latest', ud);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('latest');
  });

  it('falls back to app storage when writing the sidecar fails', async () => {
    // A sidecar path that passes the access probe but cannot be replaced (also
    // what Windows ACLs do, which fs.access ignores).
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    mkdirSync(`${pdf}.notes.json`);
    expect(await writeNotesFor({ path: pdf, sha256: sha }, 'saved', ud)).toBe(join(ud, 'notes', `${sha}.notes.json`));
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('saved');
  });

  it('reads a sidecar that changed after app storage was written, even with an older time', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    const sidecar = `${pdf}.notes.json`;
    const past = new Date(Date.now() - 3600_000);
    // The sidecar cannot be written for a while: notes go to app storage.
    mkdirSync(sidecar);
    await writeNotesFor({ path: pdf, sha256: sha }, 'while-blocked', ud);
    rmSync(sidecar, { recursive: true });
    // A sidecar restored from a backup (older time) is what the user wants back.
    writeFileSync(sidecar, 'restored');
    utimesSync(sidecar, past, past);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('restored');
    // A later sidecar write wins over the app-storage copy whatever its time:
    // the copy it replaces goes, with its record.
    await writeNotesFor({ path: pdf, sha256: sha }, 'latest', ud);
    utimesSync(sidecar, past, past);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('latest');
    expect(readdirSync(join(ud, 'notes'))).toEqual([]);
    // A broken record: the newer file wins, as without one.
    await writeNotesFor({ path: null, sha256: sha }, 'pathless', ud);
    writeFileSync(join(ud, 'notes', `${sha}.sidecar.json`), '{ broken');
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('pathless');
  });

  it.skipIf(isRoot || process.platform === 'win32')('reads the sidecar after it is written again with the text the record has (revert after a fallback)', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    const sidecar = `${pdf}.notes.json`;
    const notes = (id: string) => JSON.stringify({ format: 'marp-notes', version: 2, deck: { source: 'pdf', sha256: sha },
      pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: [{ id, tool: 'pen', color: '#000', size: 3, points: [[1, 1, 0.5], [9, 9, 0.5]] }] }] });
    writeFileSync(sidecar, notes('S0'));
    // The sidecar is read-only for a while: S1 goes to app storage, the record has S0's hash.
    chmodSync(sidecar, 0o444);
    await writeNotesFor({ path: pdf, sha256: sha }, notes('S1'), ud);
    chmodSync(sidecar, 0o644);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe(notes('S1'));
    // Backup S0, then revert to it: the sidecar is writable again and gets S0.
    writeFileSync(join(ud, 'notes', `${sha}.notes.backup.json`), notes('S0'));
    expect(await revertToBackupFor({ path: pdf, sha256: sha }, ud)).toBe(notes('S0'));
    expect(readFileSync(sidecar, 'utf8')).toBe(notes('S0'));
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe(notes('S0'));
    expect(readFileSync(join(ud, 'notes', `${sha}.notes.backup.json`), 'utf8')).toBe(notes('S1')); // S1 kept as the backup
  });

  it.skipIf(isRoot)('keeps reading app storage while the sidecar stays as it was', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    const sidecar = `${pdf}.notes.json`;
    writeFileSync(sidecar, 'old');
    chmodSync(sidecar, 0o444);
    await writeNotesFor({ path: pdf, sha256: sha }, 'one', ud);
    await writeNotesFor({ path: pdf, sha256: sha }, 'two', ud);
    // Even if the sidecar looks newer (clock, copy), it has not changed since.
    const future = new Date(Date.now() + 3600_000);
    utimesSync(sidecar, future, future);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('two');
  });

  it('stores notes of a PDF without a path by hash (given or computed)', async () => {
    const ud = tempDir();
    await writeNotesFor({ path: null, bytes: pdfBytes }, 'mem', ud);
    expect(readFileSync(join(ud, 'notes', `${sha}.notes.json`), 'utf8')).toBe('mem');
    expect(await readNotesFor({ path: null, sha256: sha }, ud)).toBe('mem');
    expect(await readNotesFor({ path: null }, ud)).toBeNull();
    await expect(writeNotesFor({ path: null }, 'x', ud)).rejects.toThrow(/sha256/);
    await expect(writeNotesFor({ path: null, sha256: '../x' }, 'x', ud)).rejects.toThrow(/sha256/);
  });

  it('prefers the sidecar over app storage when reading, unless app storage is newer', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    await writeNotesFor({ path: null, sha256: sha }, 'stored', ud);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('stored');
    writeFileSync(`${pdf}.notes.json`, 'sidecar');
    // Same modification time: the sidecar wins.
    const t = new Date();
    utimesSync(`${pdf}.notes.json`, t, t);
    utimesSync(join(ud, 'notes', `${sha}.notes.json`), t, t);
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('sidecar');
  });
});

describe.skipIf(process.platform === 'win32')('a sidecar that is a symlink', () => {
  /** deck.pdf in `dir`, its sidecar a link to `target` (relative, as an archive would hold it). */
  function linkedSidecar(dir: string, target: string): { pdf: string; sidecar: string } {
    const pdf = pdfIn(dir);
    const sidecar = `${pdf}.notes.json`;
    symlinkSync(target, sidecar);
    return { pdf, sidecar };
  }

  it('is followed to another notes file', async () => {
    const dir = tempDir(), ud = tempDir();
    mkdirSync(join(dir, 'synced'));
    writeFileSync(join(dir, 'synced', 'deck.pdf.notes.json'), 'old');
    const { pdf, sidecar } = linkedSidecar(join(dir, 'lectures'), '../synced/deck.pdf.notes.json');
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBe('old');
    expect(await writeNotesFor({ path: pdf, sha256: sha }, 'new', ud)).toBe(sidecar);
    expect(lstatSync(sidecar).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, 'synced', 'deck.pdf.notes.json'), 'utf8')).toBe('new');
  });

  it('to any other file is never read, copied or written through; a save replaces the link', async () => {
    const dir = tempDir(), ud = tempDir();
    const secret = join(dir, '.bashrc');
    writeFileSync(secret, 'export SECRET=1');
    chmodSync(secret, 0o600);
    const { pdf, sidecar } = linkedSidecar(join(dir, 'a', 'b'), '../../.bashrc');
    const t = { path: pdf, sha256: sha };
    await expect(readNotesFor(t, ud)).rejects.toThrow(/link to .*\.bashrc/);
    expect(await keepUnreadableFor(t, ud)).toBeNull();
    expect(await backupBeforeSave(t, ud)).toBe(false);
    expect(await notesWritePath(t, ud)).toBe(sidecar);
    expect(await writeNotesFor(t, '{"a":1}', ud, true)).toBe(sidecar);
    expect(readFileSync(secret, 'utf8')).toBe('export SECRET=1');
    expect(lstatSync(sidecar).isSymbolicLink()).toBe(false);
    expect(readFileSync(sidecar, 'utf8')).toBe('{"a":1}');
    expect(await readNotesFor(t, ud)).toBe('{"a":1}');
    expect(existsSync(join(ud, 'notes'))).toBe(false); // nothing of .bashrc in app storage
  });

  it.skipIf(isRoot)('to a file that cannot be written is still replaced, not written to', async () => {
    const dir = tempDir(), ud = tempDir();
    const target = join(dir, 'readonly.txt');
    writeFileSync(target, 'keep');
    chmodSync(target, 0o444);
    const { pdf, sidecar } = linkedSidecar(join(dir, 'p'), target);
    expect(await writeNotesFor({ path: pdf, sha256: sha }, 'x', ud)).toBe(sidecar);
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(readFileSync(sidecar, 'utf8')).toBe('x');
  });

  /** Notes text recording the PDF hash `pdfSha`. */
  const recording = (pdfSha: string, mark: string) => JSON.stringify({ format: 'marp-notes', version: 2, deck: { source: 'pdf', sha256: pdfSha }, pages: [], mark });

  it('is not followed to the notes of another PDF; a save replaces the link, not those notes', async () => {
    const dir = tempDir(), ud = tempDir();
    mkdirSync(join(dir, 'thesis'));
    const thesis = join(dir, 'thesis', 'thesis.pdf.notes.json');
    const otherSha = 'f'.repeat(64);
    writeFileSync(thesis, recording(otherSha, 'thesis'));
    // Another name, as in the review: "deck.pdf.notes.json -> ../../thesis/thesis.pdf.notes.json".
    const a = linkedSidecar(join(dir, 'a', 'b'), '../../thesis/thesis.pdf.notes.json');
    const t = { path: a.pdf, sha256: sha };
    await expect(readNotesFor(t, ud)).rejects.toThrow(RefusedLinkError);
    await writeNotesFor(t, '{"a":1}', ud, true);
    expect(lstatSync(a.sidecar).isSymbolicLink()).toBe(false);
    expect(readFileSync(thesis, 'utf8')).toContain('"mark":"thesis"');
    // The same name, but recorded for another PDF.
    mkdirSync(join(dir, 'other'));
    const same = join(dir, 'other', 'deck.pdf.notes.json');
    writeFileSync(same, recording(otherSha, 'other deck'));
    const b = linkedSidecar(join(dir, 'c'), '../other/deck.pdf.notes.json');
    await expect(readNotesFor({ path: b.pdf, sha256: sha }, ud)).rejects.toThrow(RefusedLinkError);
    expect(await keepUnreadableFor({ path: b.pdf, sha256: sha }, ud)).toBeNull();
    await writeNotesFor({ path: b.pdf, sha256: sha }, '{"b":1}', ud);
    expect(readFileSync(same, 'utf8')).toContain('"mark":"other deck"');
    expect(readFileSync(b.sidecar, 'utf8')).toBe('{"b":1}');
  });

  it('is followed to a file of the same name (or its backup name) with this PDF\'s notes', async () => {
    const dir = tempDir(), ud = tempDir();
    mkdirSync(join(dir, 'synced'));
    const target = join(dir, 'synced', 'deck.pdf.notes.backup.json');
    writeFileSync(target, recording(sha, 'mine'));
    const { pdf, sidecar } = linkedSidecar(join(dir, 'p'), '../synced/deck.pdf.notes.backup.json');
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toContain('"mark":"mine"');
    await writeNotesFor({ path: pdf, sha256: sha }, recording(sha, 'saved'), ud);
    expect(lstatSync(sidecar).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('"mark":"saved"');
  });

  it('is never followed into userData (app storage of any PDF)', async () => {
    const dir = tempDir(), ud = tempDir();
    const inStore = join(ud, 'notes', 'deck.pdf.notes.json'); // even with the right name and hash
    mkdirSync(dirname(inStore), { recursive: true });
    writeFileSync(inStore, recording(sha, 'store'));
    const { pdf, sidecar } = linkedSidecar(join(dir, 'p'), inStore);
    await expect(readNotesFor({ path: pdf, sha256: sha }, ud)).rejects.toThrow(RefusedLinkError);
    await writeNotesFor({ path: pdf, sha256: sha }, 'x', ud);
    expect(readFileSync(inStore, 'utf8')).toContain('"mark":"store"');
    expect(readFileSync(sidecar, 'utf8')).toBe('x');
  });

  it('that is dangling counts as missing, and a save replaces it', async () => {
    const dir = tempDir(), ud = tempDir();
    const { pdf, sidecar } = linkedSidecar(dir, '../nowhere/.profile');
    expect(await readNotesFor({ path: pdf, sha256: sha }, ud)).toBeNull();
    await writeNotesFor({ path: pdf, sha256: sha }, 'x', ud);
    expect(lstatSync(sidecar).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dir, '..', 'nowhere'))).toBe(false);
  });
});

describe('notes backup', () => {
  /** A notes file with `n` strokes on page 1. */
  const notes = (n: number): string => JSON.stringify({
    format: 'marp-notes', version: 2, deck: { source: 'pdf', sha256: sha },
    pages: [{ id: 'p1', kind: 'slide', slide: 1, strokes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, tool: 'pen', color: '#000', size: 3, points: [[i, 0, 0.5], [i, 9, 0.5]] })) }],
  });
  const backupFile = (ud: string) => join(ud, 'notes', `${sha}.notes.backup.json`);
  const age = (file: string, ms: number) => utimesSync(file, new Date(Date.now() - ms), new Date(Date.now() - ms));

  it('knows usable notes: valid and not empty', () => {
    expect(isUsableNotes(notes(1))).toBe(true);
    expect(isUsableNotes(notes(0))).toBe(false);
    expect(isUsableNotes(JSON.stringify({ format: 'marp-notes', version: 2, deck: {}, pages: [{ id: 'b-1', kind: 'blank', after: 1, strokes: [] }] }))).toBe(true);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    expect(isUsableNotes(JSON.stringify({ format: 'marp-notes', version: 3, deck: {}, pages: [
      { id: 'p1', kind: 'slide', slide: 1, strokes: [], images: [{ id: 'i', x: 0, y: 0, w: 1, h: 1, src: png }] }] }))).toBe(true);
    expect(isUsableNotes('{ broken')).toBe(false);
    expect(isUsableNotes(JSON.stringify({ format: 'marp-notes', version: 99, deck: {}, pages: [] }))).toBe(false);
  });

  it('a save copies the saved notes to app storage first, at most every 2 minutes', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    const t = { path: pdf, sha256: sha };
    await writeNotesFor(t, notes(1), ud, true); // nothing saved yet: no backup
    expect(existsSync(backupFile(ud))).toBe(false);
    await writeNotesFor(t, notes(2), ud, true);
    expect(readFileSync(backupFile(ud), 'utf8')).toBe(notes(1));
    expect(readFileSync(`${pdf}.notes.json`, 'utf8')).toBe(notes(2));
    await writeNotesFor(t, notes(3), ud, true); // backup is fresh: kept
    expect(readFileSync(backupFile(ud), 'utf8')).toBe(notes(1));
    age(backupFile(ud), BACKUP_MIN_AGE_MS + 1000);
    await writeNotesFor(t, notes(4), ud, true);
    expect(readFileSync(backupFile(ud), 'utf8')).toBe(notes(3));
    expect(readdirSync(dir).sort()).toEqual(['deck.pdf', 'deck.pdf.notes.json']); // never next to the PDF
    const b = await readBackupFor(t, ud);
    expect(b?.text).toBe(notes(3));
    expect(Math.abs(b!.time - statSync(backupFile(ud)).mtimeMs)).toBeLessThan(1);
  });

  it('never copies unreadable, invalid or empty notes, and not with backups off', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    const t = { path: pdf, sha256: sha };
    for (const bad of ['{ broken', notes(0), JSON.stringify({ format: 'marp-notes', version: 99, deck: {}, pages: [] })]) {
      writeFileSync(`${pdf}.notes.json`, bad);
      await writeNotesFor(t, notes(1), ud, true);
      expect(existsSync(backupFile(ud))).toBe(false);
    }
    await writeNotesFor(t, notes(2), ud, false);
    expect(existsSync(backupFile(ud))).toBe(false);
    expect(await backupBeforeSave(t, ud)).toBe(true);
    // An old valid backup is not replaced by a broken notes file.
    age(backupFile(ud), BACKUP_MIN_AGE_MS + 1000);
    writeFileSync(`${pdf}.notes.json`, '{ broken');
    await writeNotesFor(t, notes(3), ud, true);
    expect(readFileSync(backupFile(ud), 'utf8')).toBe(notes(2));
  });

  it('a failed backup does not stop the save', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    writeFileSync(`${pdf}.notes.json`, notes(1));
    mkdirSync(backupFile(ud), { recursive: true }); // a folder where the backup should be
    age(backupFile(ud), BACKUP_MIN_AGE_MS + 1000);
    await writeNotesFor({ path: pdf, sha256: sha }, notes(2), ud, true);
    expect(readFileSync(`${pdf}.notes.json`, 'utf8')).toBe(notes(2));
  });

  it.skipIf(isRoot)('backs up notes kept in app storage (read-only folder) under the same key', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(join(dir, 'ro'));
    chmodSync(join(dir, 'ro'), 0o555);
    try {
      await writeNotesFor({ path: pdf }, notes(1), ud, true);
      await writeNotesFor({ path: pdf }, notes(2), ud, true);
      expect(readFileSync(backupFile(ud), 'utf8')).toBe(notes(1));
    } finally {
      chmodSync(join(dir, 'ro'), 0o755);
    }
  });

  it('revert swaps the notes and the backup; a second revert undoes the first', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    const t = { path: pdf, sha256: sha };
    await expect(revertToBackupFor(t, ud)).rejects.toThrow(/no usable backup/);
    await writeNotesFor(t, notes(1), ud, true);
    await writeNotesFor(t, notes(2), ud, true);
    expect(await hasBackup(t, ud)).toBe(true);
    expect(await revertToBackupFor(t, ud)).toBe(notes(1));
    expect(await readNotesFor(t, ud)).toBe(notes(1));
    expect((await readBackupFor(t, ud))?.text).toBe(notes(2));
    // The swapped backup is fresh: the next save keeps it, so revert can be undone.
    await writeNotesFor(t, notes(1), ud, true);
    expect((await readBackupFor(t, ud))?.text).toBe(notes(2));
    await revertToBackupFor(t, ud);
    expect(await readNotesFor(t, ud)).toBe(notes(2));
    expect((await readBackupFor(t, ud))?.text).toBe(notes(1));
  });

  it.skipIf(isRoot)('a revert whose notes write fails leaves notes and backup as they were', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    const t = { path: pdf, sha256: sha };
    writeFileSync(`${pdf}.notes.json`, notes(2));
    mkdirSync(join(ud, 'notes'), { recursive: true });
    writeFileSync(backupFile(ud), notes(1));
    chmodSync(`${pdf}.notes.json`, 0o444); // the sidecar cannot be written...
    const blocker = join(ud, 'notes', `${sha}.notes.json`);
    mkdirSync(join(blocker, 'x'), { recursive: true }); // ...nor app storage
    age(blocker, 60_000);
    await expect(revertToBackupFor(t, ud)).rejects.toThrow();
    expect(readFileSync(`${pdf}.notes.json`, 'utf8')).toBe(notes(2));
    expect(readFileSync(backupFile(ud), 'utf8')).toBe(notes(1));
  });

  it('switching backups off removes every backup, but not the unreadable copies or the notes', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    await writeNotesFor({ path: pdf, sha256: sha }, notes(1), ud);
    await backupBeforeSave({ path: pdf, sha256: sha }, ud);
    const other = 'b'.repeat(64);
    for (const f of [`${other}.notes.backup.json`, `${other}.notes.unreadable.json`, `${other}.notes.json`, 'notes.backup.json', `${other}.notes.backup.json.bak`]) {
      writeFileSync(join(ud, 'notes', f), 'x');
    }
    expect((await removeAllBackups(ud)).length).toBe(2);
    expect(readdirSync(join(ud, 'notes')).sort()).toEqual(
      [`${other}.notes.backup.json.bak`, `${other}.notes.json`, `${other}.notes.unreadable.json`, 'notes.backup.json'].sort());
    expect(await removeAllBackups(tempDir())).toEqual([]); // no notes folder: fine
    expect(await readBackupFor({ path: pdf, sha256: sha }, ud)).toBeNull();
    expect(await hasBackup({ path: pdf, sha256: sha }, ud)).toBe(false);
    writeFileSync(`${pdf}.notes.backup.json`, notes(1));
    writeFileSync(`${pdf}.notes.backup-20260101-000000.json`, 'other');
    await removeLegacyBackup(pdf);
    await removeLegacyBackup(pdf); // none: fine
    expect(readdirSync(dir).sort()).toEqual(['deck.pdf', 'deck.pdf.notes.backup-20260101-000000.json', 'deck.pdf.notes.json']);
  });

  it('keeps an unreadable notes file as it is, the latest one only', async () => {
    const dir = tempDir(), ud = tempDir();
    const pdf = pdfIn(dir);
    const t = { path: pdf, sha256: sha };
    expect(await keepUnreadableFor(t, ud)).toBeNull(); // no notes file
    const bad = Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x20]); // not even UTF-8
    writeFileSync(`${pdf}.notes.json`, bad);
    const copy = await keepUnreadableFor(t, ud);
    expect(copy).toBe(join(ud, 'notes', `${sha}.notes.unreadable.json`));
    expect(readFileSync(copy!)).toEqual(bad);
    writeFileSync(`${pdf}.notes.json`, '{ newer broken');
    await keepUnreadableFor(t, ud);
    expect(readFileSync(copy!, 'utf8')).toBe('{ newer broken');
    // The next save replaces the notes; the copy stays, and is never backed up.
    await writeNotesFor(t, notes(1), ud, true);
    expect(readFileSync(copy!, 'utf8')).toBe('{ newer broken');
    expect(existsSync(backupFile(ud))).toBe(false);
  });

  it(`deletes backups and unreadable copies older than ${OLD_COPIES_MAX_AGE_DAYS} days at startup`, async () => {
    const ud = tempDir();
    mkdirSync(join(ud, 'notes'));
    const day = 24 * 60 * 60_000, now = Date.now();
    const files = {
      [`${'a'.repeat(64)}.notes.backup.json`]: 100,
      [`${'b'.repeat(64)}.notes.backup.json`]: 10,
      [`${'c'.repeat(64)}.notes.unreadable.json`]: 91,
      [`${'d'.repeat(64)}.notes.unreadable.json`]: 89,
      [`${'e'.repeat(64)}.notes.json`]: 400, // notes are never cleaned up
      ['other.notes.backup.json']: 400,
    };
    for (const [name, days] of Object.entries(files)) {
      const f = join(ud, 'notes', name);
      writeFileSync(f, 'x');
      utimesSync(f, new Date(now - days * day), new Date(now - days * day));
    }
    const removed = await cleanupNotesStore(ud, now);
    expect(removed.map(f => f.slice(-30)).sort()).toEqual(
      [`${'a'.repeat(64)}.notes.backup.json`, `${'c'.repeat(64)}.notes.unreadable.json`].map(f => join(ud, 'notes', f).slice(-30)).sort());
    expect(readdirSync(join(ud, 'notes')).length).toBe(4);
    expect(await cleanupNotesStore(tempDir())).toEqual([]);
  });
});
