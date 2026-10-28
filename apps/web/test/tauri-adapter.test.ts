// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { PdfFile } from '@inkslide/annotate';
import { MAX_FILE_BYTES, base64, createTauriAdapter, fileArgs, fileUrl, mobileOs, nameFromPath, notesFile, notesKey, shareName } from '../src/platform/tauri';

const SHA = 'a'.repeat(64);
const pdf: PdfFile = { path: null, name: 'a.pdf', bytes: new Uint8Array() };

type Reply = unknown | ((args: Record<string, unknown>) => unknown);

/**
 * Names for write_share_file: what shareName makes of each input, and inputs
 * that write_share_file must refuse as they are. The Rust tests of
 * apps/mobile/src-tauri/src/lib.rs check the same list.
 */
const SHARE_NAMES = JSON.parse(readFileSync(join(__dirname, '../../mobile/test/share-names.json'), 'utf8')) as
  { input: string; output: string; bad?: boolean }[];

/**
 * A fake Tauri backend behind mockIPC: the app's commands
 * (apps/mobile/src-tauri/src/lib.rs, with their checks) on an in-memory file
 * system, and canned picker / share replies (an Error rejects). The page has
 * no fs plugin permission, so the fake has no fs plugin. invoke's headers
 * reach it, unlike mockIPC's handler.
 */
function fakeBackend() {
  const files = new Map<string, Uint8Array>();
  /** The share folder of write_share_file: iOS tmp/, Android cache/share/. */
  const share = { dir: '/tmp' };
  /** The file save_pdf's own dialog picks; null: cancelled. */
  const save: { target: string | null } = { target: null };
  /** What pick_file's picker returns (null: cancelled); picked files are the only ones read_picked reads. */
  const picker: { next: string | null } = { next: null };
  const picked = new Set<string>();
  /** read_picked answers with a number array, as where the IPC has no raw responses. */
  const numberArrays = { on: false };
  /** How each file payload came: raw (body and name header) or base64 (Android JSON). */
  const forms: string[] = [];
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const replies = new Map<string, Reply>();
  /** Commands that fail, with Tauri's plain message. */
  const failing = new Map<string, string>();

  const shareName = (name: string): string => {
    if (!/^[^./\\: ][^/\\:\0-\x1f\x7f-\x9f]*\.pdf$/.test(name)) throw `invalid file name: ${name}`;
    return name;
  };
  const notesKey = (key: string): string => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(key)) throw `invalid notes key: ${key}`;
    return key;
  };
  /** The file bytes and name of a request, in either form (see payload() in lib.rs). */
  function payload(args: unknown, headers?: Record<string, string>): { bytes: Uint8Array; name: string } {
    if (args instanceof Uint8Array) {
      forms.push('raw');
      return { bytes: args, name: decodeURIComponent(headers!.name) };
    }
    const { name, data } = args as { name: string; data: string };
    forms.push('base64');
    return { bytes: Uint8Array.from(atob(data), c => c.charCodeAt(0)), name };
  }

  function handle(cmd: string, args: Record<string, unknown>, headers?: Record<string, string>): unknown {
    calls.push({ cmd, args });
    if (failing.has(cmd)) throw failing.get(cmd);
    switch (cmd) {
      case 'pick_file': {
        if (!['pdf', 'notes'].includes(args.kind as string)) throw `unknown kind of file: ${args.kind as string}`;
        if (picker.next) picked.add(picker.next);
        return picker.next;
      }
      case 'read_picked': {
        const id = args.id as string;
        if (!picked.has(id)) throw 'not a file picked in this session';
        const data = files.get(id);
        if (!data) throw `failed to open file: ${id}`;
        return numberArrays.on ? Array.from(data) : data.slice().buffer;
      }
      case 'read_notes': {
        const data = files.get(`/data/notes/${notesKey(args.key as string)}.notes.json`);
        return data ? new TextDecoder().decode(data) : null;
      }
      case 'write_notes':
        files.set(`/data/notes/${notesKey(args.key as string)}.notes.json`, new TextEncoder().encode(args.text as string));
        return null;
      case 'write_share_file': {
        const { bytes, name } = payload(args, headers);
        const path = `${share.dir}/${shareName(name)}`;
        files.set(path, bytes);
        return path;
      }
      case 'remove_share_file': files.delete(`${share.dir}/${shareName(args.name as string)}`); return null;
      case 'save_pdf': {
        const { bytes } = payload(args, headers);
        if (!save.target) return false;
        files.set(save.target, bytes);
        return true;
      }
    }
    if (!replies.has(cmd)) throw new Error(`unexpected command ${cmd}`);
    const reply = replies.get(cmd);
    const value = typeof reply === 'function' ? (reply as (a: Record<string, unknown>) => unknown)(args) : reply;
    if (value instanceof Error) throw value.message; // Tauri rejects with the plain message
    return value;
  }

  mockIPC(() => undefined);
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  internals.invoke = async (cmd: string, args: Record<string, unknown>, options?: { headers?: Record<string, string> }) =>
    handle(cmd, args, options?.headers);
  const text = (path: string): string | undefined => {
    const data = files.get(path);
    return data && new TextDecoder().decode(data);
  };
  return {
    files, calls, replies, failing, share, save, picker, numberArrays, forms, text, commands: () => calls.map(c => c.cmd),
  };
}

let backend: ReturnType<typeof fakeBackend>;
beforeEach(() => { backend = fakeBackend(); });
afterEach(() => clearMocks());

describe('helpers', () => {
  it('tells iOS (also iPadOS posing as a Mac) and Android from the desktop', () => {
    expect(mobileOs('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36', 5)).toBe('android');
    expect(mobileOs('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 5)).toBe('ios');
    expect(mobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5)).toBe('ios');
    expect(mobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0)).toBeNull();
    expect(mobileOs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15', 10)).toBeNull();
  });

  it('names picked files from paths, file URLs and content URIs', () => {
    expect(nameFromPath('/home/me/Lecture 1.pdf', 'x.pdf')).toBe('Lecture 1.pdf');
    expect(nameFromPath('file:///private/var/Inbox/Lecture%201.pdf', 'x.pdf')).toBe('Lecture 1.pdf');
    expect(nameFromPath('content://com.android.externalstorage.documents/document/primary%3ADownload%2Fslides.pdf', 'x.pdf')).toBe('slides.pdf');
    expect(nameFromPath('content://com.android.providers.downloads.documents/document/msf%3A1000000123', 'x.pdf')).toBe('x.pdf');
    expect(nameFromPath('content://media/document/%E0%A4%A', 'x.pdf')).toBe('x.pdf');
    // ':' is a separator in content URIs only.
    expect(nameFromPath('/home/me/Lecture 3: Graphs.pdf', 'x.pdf')).toBe('Lecture 3: Graphs.pdf');
    expect(nameFromPath('file:///private/var/Inbox/Lecture%203%3A%20Graphs.pdf', 'x.pdf')).toBe('Lecture 3: Graphs.pdf');
  });

  it('keys notes by hash, else by a safe form of the name', () => {
    expect(notesFile(pdf, SHA)).toBe(`notes/${SHA}.notes.json`);
    expect(notesFile({ name: '../x.pdf' })).toBe('notes/name-___x_pdf.notes.json');
    expect(notesFile({ name: 'a.pdf' }, '../../etc')).toBe('notes/name-a_pdf.notes.json');
    // Keys are what write_notes accepts: [A-Za-z0-9_-] only.
    for (const name of ['../x.pdf', 'a b/c:d.pdf', '講義.pdf', '']) expect(notesKey({ name })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('names shared files safely, always as a PDF', () => {
    expect(shareName('My deck-notes.pdf')).toBe('My deck-notes.pdf');
    expect(shareName('a/b:c.PDF')).toBe('a_b_c.pdf');
    expect(shareName('..\\x\n.pdf')).toBe('_x_.pdf');
    expect(shareName('notes.json')).toBe('notes.json.pdf');
    expect(shareName('...')).toBe('document.pdf');
    expect(shareName('')).toBe('document.pdf');
    expect(shareName(`${'x'.repeat(300)}.pdf`)).toBe(`${'x'.repeat(200)}.pdf`);
    // At most 200 UTF-8 bytes, whole characters only.
    expect(shareName(`${'講'.repeat(100)}.pdf`)).toBe(`${'講'.repeat(66)}.pdf`);
    expect(shareName(`${'x'.repeat(199)}😀.pdf`)).toBe(`${'x'.repeat(199)}.pdf`);
    expect(shareName('a\uD800b.pdf')).toBe('a_b.pdf');
    // C1 controls too, as Rust's char::is_control (write_share_file).
    expect(shareName('a\u0085b\u009f.pdf')).toBe('a_b_.pdf');
  });

  it('makes names write_share_file accepts (the cases its Rust tests check too)', () => {
    expect(SHARE_NAMES.length).toBeGreaterThan(10);
    for (const { input, output } of SHARE_NAMES) expect(shareName(input), JSON.stringify(input)).toBe(output);
  });

  it('sends file bytes raw with the name in a header, on Android as base64 JSON', () => {
    const bytes = new Uint8Array([0, 37, 255, 128]);
    expect(fileArgs('ios', bytes, 'Deck #1.pdf')).toEqual([bytes, { headers: { name: 'Deck%20%231.pdf' } }]);
    expect(fileArgs(null, bytes, 'a.pdf')[0]).toBe(bytes);
    expect(fileArgs('android', bytes, 'Deck #1.pdf')).toEqual([{ name: 'Deck #1.pdf', data: 'ACX/gA==' }, undefined]);
    // Large files in chunks (String.fromCharCode has an argument limit).
    const big = Uint8Array.from({ length: 3 * 0x8000 + 7 }, (_, i) => (i * 7) % 256);
    expect(Buffer.from(base64(big), 'base64').equals(Buffer.from(big))).toBe(true);
    expect(base64(big)).toBe(Buffer.from(big).toString('base64'));
    expect(base64(new Uint8Array())).toBe('');
  });

  it('refuses a file over the limit of the app commands before encoding it', async () => {
    const lib = readFileSync(join(__dirname, '../../mobile/src-tauri/src/lib.rs'), 'utf8');
    expect(lib).toMatch(/const MAX_FILE_BYTES: usize = 256 << 20;/);
    expect(MAX_FILE_BYTES).toBe(256 << 20);
    // A view: length over the limit without allocating it.
    const huge = { length: MAX_FILE_BYTES + 1 } as Uint8Array;
    for (const os of ['android', 'ios', null] as const) expect(() => fileArgs(os, huge, 'a.pdf')).toThrow(/too large .*257 MB; at most 256 MB/);
    backend.save.target = '/home/me/a.pdf';
    await expect(createTauriAdapter('android').exportPdf(huge, 'a.pdf')).rejects.toThrow(/too large/);
    await expect(createTauriAdapter('ios').exportPdf(huge, 'a.pdf')).rejects.toThrow(/too large/);
    expect(backend.commands()).toEqual([]);
  });

  it('percent-encodes file URLs per segment', () => {
    expect(fileUrl('/tmp/My notes #1.pdf')).toBe('file:///tmp/My%20notes%20%231.pdf');
  });
});

describe('notes', () => {
  it('reads nothing before the first write, then what was written', async () => {
    const a = createTauriAdapter(null);
    expect(await a.readNotes(pdf, SHA)).toBeNull();
    await a.writeNotes(pdf, '{"v":1}', SHA);
    await a.writeNotes(pdf, '{"v":2}', SHA);
    expect(backend.text(`/data/notes/${SHA}.notes.json`)).toBe('{"v":2}');
    expect([...backend.files.keys()]).toEqual([`/data/notes/${SHA}.notes.json`]); // no temp file left
    expect(await a.readNotes(pdf, SHA)).toBe('{"v":2}');
  });

  it('writes through the write_notes command with a key, never a path, and no fs plugin write', async () => {
    const a = createTauriAdapter(null);
    await a.writeNotes(pdf, 'x', SHA);
    await a.writeNotes({ ...pdf, name: '../../x.pdf' }, 'y');
    expect(backend.calls.filter(c => c.cmd === 'write_notes').map(c => c.args)).toEqual([
      { key: SHA, text: 'x' }, { key: 'name-______x_pdf', text: 'y' },
    ]);
    expect(backend.commands().filter(c => c.startsWith('plugin:fs|'))).toEqual([]);
  });

  it('passes a failed write on', async () => {
    const a = createTauriAdapter(null);
    await a.writeNotes(pdf, 'old', SHA);
    backend.failing.set('write_notes', 'Permission denied');
    await expect(a.writeNotes(pdf, 'new', SHA)).rejects.toBe('Permission denied');
    expect(backend.text(`/data/notes/${SHA}.notes.json`)).toBe('old');
  });

  it('reads through read_notes with a key, never a path', async () => {
    backend.files.set(`/data/notes/${SHA}.notes.json`, new TextEncoder().encode('{"v":1}'));
    expect(await createTauriAdapter(null).readNotes(pdf, SHA)).toBe('{"v":1}');
    expect(backend.calls).toEqual([{ cmd: 'read_notes', args: { key: SHA } }]);
  });

  it('counts an empty notes file as none', async () => {
    backend.files.set(`/data/notes/${SHA}.notes.json`, new Uint8Array());
    expect(await createTauriAdapter(null).readNotes(pdf, SHA)).toBeNull();
  });
});

describe('files', () => {
  it('opens the PDF picked with pick_file through read_picked', async () => {
    backend.files.set('file:///private/var/Inbox/Deck%201.pdf', new Uint8Array([37, 80]));
    backend.picker.next = 'file:///private/var/Inbox/Deck%201.pdf';
    const file = await createTauriAdapter('ios').openPdf();
    expect(file).toEqual({ path: null, name: 'Deck 1.pdf', bytes: new Uint8Array([37, 80]) });
    expect(backend.calls).toEqual([
      { cmd: 'pick_file', args: { kind: 'pdf' } },
      { cmd: 'read_picked', args: { id: 'file:///private/var/Inbox/Deck%201.pdf' } },
    ]);
  });

  it('reads a number array too (where the IPC has no raw responses)', async () => {
    backend.numberArrays.on = true;
    backend.files.set('content://x/document/7', new Uint8Array([1, 2, 255]));
    backend.picker.next = 'content://x/document/7';
    expect((await createTauriAdapter('android').openPdf())!.bytes).toEqual(new Uint8Array([1, 2, 255]));
  });

  it('can not read a file that was not picked in this session', async () => {
    backend.files.set('/home/me/secret.pdf', new Uint8Array([1]));
    await expect(createTauriAdapter('android').openPdf('/home/me/secret.pdf')).rejects.toBe('not a file picked in this session');
  });

  it('returns null when the picker is cancelled; other errors are passed on', async () => {
    expect(await createTauriAdapter('ios').openPdf()).toBeNull();
    expect(await createTauriAdapter('android').importNotes!()).toBeNull();
    backend.failing.set('pick_file', 'File picker cancelled');
    expect(await createTauriAdapter('android').openPdf()).toBeNull();
    backend.failing.set('pick_file', 'no activity');
    await expect(createTauriAdapter('android').openPdf()).rejects.toBe('no activity');
  });

  it('imports a picked notes file', async () => {
    backend.files.set('content://x/document/primary%3Anotes.json', new TextEncoder().encode('{"format":"marp-notes"}'));
    backend.picker.next = 'content://x/document/primary%3Anotes.json';
    expect(await createTauriAdapter('android').importNotes!()).toEqual({ name: 'notes.json', text: '{"format":"marp-notes"}' });
    expect(backend.calls[0]).toEqual({ cmd: 'pick_file', args: { kind: 'notes' } });
  });

  it('asks through the native dialog', async () => {
    backend.replies.set('plugin:dialog|message', (args: Record<string, unknown>) => (args.message === 'Replace?' ? 'Ok' : 'Cancel'));
    const a = createTauriAdapter('android');
    expect(await a.confirm!('Replace?')).toBe(true);
    expect(await a.confirm!('Other?')).toBe(false);
  });
});

describe('export and print', () => {
  const pdfBytes = new Uint8Array([1, 2, 3]);

  it('Android: saves through save_pdf, which opens the save dialog itself', async () => {
    backend.save.target = 'content://downloads/document/42';
    const a = createTauriAdapter('android');
    expect(await a.exportPdf(pdfBytes, 'Lecture 3: Graphs-notes.pdf')).toBe(true);
    expect(backend.files.get('content://downloads/document/42')).toEqual(pdfBytes);
    expect(backend.commands()).toEqual(['save_pdf']); // no dialog or fs plugin call from the page
    // Android's IPC has no raw bodies: the bytes go as base64 JSON.
    expect(backend.forms).toEqual(['base64']);
    expect(backend.calls[0]!.args).toEqual({ name: 'Lecture 3: Graphs-notes.pdf', data: 'AQID' });
  });

  it('desktop: saves through save_pdf with a raw body', async () => {
    backend.save.target = '/home/me/a.pdf';
    expect(await createTauriAdapter(null).exportPdf(pdfBytes, 'a.pdf')).toBe(true);
    expect(backend.forms).toEqual(['raw']);
    expect(backend.files.get('/home/me/a.pdf')).toEqual(pdfBytes);
  });

  it('Android: a cancelled save dialog is no export; other errors are passed on', async () => {
    expect(await createTauriAdapter('android').exportPdf(pdfBytes, 'a.pdf')).toBe(false);
    backend.failing.set('save_pdf', 'File picker cancelled');
    expect(await createTauriAdapter(null).exportPdf(pdfBytes, 'a.pdf')).toBe(false);
    backend.failing.set('save_pdf', 'No space left on device');
    await expect(createTauriAdapter(null).exportPdf(pdfBytes, 'a.pdf')).rejects.toBe('No space left on device');
  });

  it('iOS: shares tmp/<name>, the file the share plugin would copy it to', async () => {
    backend.replies.set('plugin:sharekit|share_file', null);
    const a = createTauriAdapter('ios');
    let shared: Uint8Array | undefined;
    backend.replies.set('plugin:sharekit|share_file', () => { shared = backend.files.get('/tmp/My deck-notes.pdf'); return null; });
    expect(await a.exportPdf(pdfBytes, 'My deck-notes.pdf')).toBe(true);
    expect(shared).toEqual(pdfBytes);
    expect(backend.calls.find(c => c.cmd === 'plugin:sharekit|share_file')!.args).toMatchObject({
      url: 'file:///tmp/My%20deck-notes.pdf', mimeType: 'application/pdf', title: 'My deck-notes.pdf',
    });
    expect([...backend.files.keys()]).toEqual(['/tmp/My deck-notes.pdf']); // kept until the next share
    expect(backend.commands()).toEqual(['write_share_file', 'plugin:sharekit|share_file']);
  });

  it('Android: prints through the share sheet from a cache subdirectory', async () => {
    backend.share.dir = '/cache/share';
    backend.replies.set('plugin:sharekit|share_file', null);
    const a = createTauriAdapter('android');
    let shared: Uint8Array | undefined;
    backend.replies.set('plugin:sharekit|share_file', () => { shared = backend.files.get('/cache/share/a_b_c.pdf'); return null; });
    expect(await a.print!(pdfBytes, 'a/b:c.pdf')).toBe(true);
    expect(shared).toEqual(pdfBytes);
    expect(backend.files.size).toBe(0);
    expect(backend.calls.find(c => c.cmd === 'plugin:sharekit|share_file')!.args).toMatchObject({ url: 'file:///cache/share/a_b_c.pdf' });
    expect(backend.calls.find(c => c.cmd === 'remove_share_file')!.args).toEqual({ name: 'a_b_c.pdf' });
    expect(backend.forms).toEqual(['base64']);
  });

  it('a dismissed share sheet is no export; other share errors are passed on', async () => {
    backend.replies.set('plugin:sharekit|share_file', new Error('Share cancelled'));
    expect(await createTauriAdapter('ios').exportPdf(pdfBytes, 'a.pdf')).toBe(false);
    backend.files.clear();
    backend.replies.set('plugin:sharekit|share_file', new Error('Invalid file URL'));
    await expect(createTauriAdapter('android').print!(pdfBytes, 'a.pdf')).rejects.toBe('Invalid file URL');
    expect(backend.files.size).toBe(0); // Android: removed in both cases
  });

  it('iOS: keeps the shared file until the next share (an activity may still read it)', async () => {
    backend.replies.set('plugin:sharekit|share_file', null);
    const a = createTauriAdapter('ios');
    await a.exportPdf(pdfBytes, 'one.pdf');
    expect([...backend.files.keys()]).toEqual(['/tmp/one.pdf']);
    await a.print!(pdfBytes, 'two.pdf');
    expect([...backend.files.keys()]).toEqual(['/tmp/two.pdf']);
  });

  it('sends the shared file name percent-encoded in a header, with the bytes as the body', async () => {
    backend.replies.set('plugin:sharekit|share_file', null);
    await createTauriAdapter('ios').exportPdf(pdfBytes, '講義 #1.pdf');
    expect(backend.files.get('/tmp/講義 #1.pdf')).toEqual(pdfBytes);
    expect(backend.forms).toEqual(['raw']);
    expect(backend.calls.find(c => c.cmd === 'plugin:sharekit|share_file')!.args).toMatchObject({
      url: `file:///tmp/${encodeURIComponent('講義 #1.pdf')}`,
    });
  });

  it('leaves printing to the front end on the desktop', () => {
    expect(createTauriAdapter(null).print).toBeUndefined();
    expect(createTauriAdapter('ios').print).toBeTypeOf('function');
  });
});
