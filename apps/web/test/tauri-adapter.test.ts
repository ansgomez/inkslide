// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { PdfFile } from '@inkslide/annotate';
import { createTauriAdapter, fileUrl, mobileOs, nameFromPath, notesFile, shareName } from '../src/platform/tauri';

const SHA = 'a'.repeat(64);
const pdf: PdfFile = { path: null, name: 'a.pdf', bytes: new Uint8Array() };
/** BaseDirectory values of @tauri-apps/api/path. */
const DIRS: Record<number, string> = { 12: '/tmp', 14: '/data', 16: '/cache' };

type Reply = unknown | ((args: Record<string, unknown>) => unknown);

/**
 * A fake Tauri backend behind mockIPC: an in-memory file system for the fs
 * plugin, path resolution, and canned dialog / share replies (an Error
 * rejects). invoke's headers (fs writes) reach it, unlike mockIPC's handler.
 */
function fakeBackend() {
  const files = new Map<string, Uint8Array>();
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const replies = new Map<string, Reply>();
  /** Commands that fail (also the fs ones the fake implements), with Tauri's plain message. */
  const failing = new Map<string, string>();
  const resolve = (path: string, options?: { baseDir?: number }): string =>
    options?.baseDir !== undefined ? `${DIRS[options.baseDir]}/${path}` : path;
  const bytes = (data: unknown): Uint8Array => (data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));

  function handle(cmd: string, args: Record<string, unknown>, headers?: Record<string, string>): unknown {
    calls.push({ cmd, args });
    if (failing.has(cmd)) throw failing.get(cmd);
    const opts = args?.options as { baseDir?: number } | undefined;
    switch (cmd) {
      case 'plugin:fs|exists': return files.has(resolve(args.path as string, opts));
      case 'plugin:fs|read_file':
      case 'plugin:fs|read_text_file': {
        const data = files.get(resolve(args.path as string, opts));
        if (!data) throw `failed to open file at path: ${args.path as string}`;
        return Array.from(data);
      }
      case 'plugin:fs|write_file':
      case 'plugin:fs|write_text_file': {
        const options = JSON.parse(headers!.options || '{}') as { baseDir?: number };
        files.set(resolve(decodeURIComponent(headers!.path), options), bytes(args));
        return null;
      }
      case 'plugin:fs|rename': {
        const o = args.options as { oldPathBaseDir?: number; newPathBaseDir?: number };
        const from = resolve(args.oldPath as string, { baseDir: o.oldPathBaseDir });
        files.set(resolve(args.newPath as string, { baseDir: o.newPathBaseDir }), files.get(from)!);
        files.delete(from);
        return null;
      }
      case 'plugin:fs|remove': files.delete(resolve(args.path as string, opts)); return null;
      case 'plugin:fs|mkdir': return null;
      case 'plugin:path|resolve_directory': return DIRS[args.directory as number];
      case 'plugin:path|join': return (args.paths as string[]).join('/');
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
  return { files, calls, replies, failing, text, commands: () => calls.map(c => c.cmd) };
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

  it('writes through a temp file and creates the directory once', async () => {
    const a = createTauriAdapter(null);
    await a.writeNotes(pdf, 'x', SHA);
    await a.writeNotes(pdf, 'y', SHA);
    expect(backend.commands().filter(c => c.startsWith('plugin:fs|'))).toEqual([
      'plugin:fs|mkdir', 'plugin:fs|write_text_file', 'plugin:fs|rename', 'plugin:fs|write_text_file', 'plugin:fs|rename',
    ]);
    const renames = backend.calls.filter(c => c.cmd === 'plugin:fs|rename').map(c => c.args);
    expect(renames[0]).toMatchObject({ newPath: `notes/${SHA}.notes.json` });
    expect(renames[0]!.oldPath).toMatch(new RegExp(`^notes/${SHA}\\.notes\\.json\\.[a-z0-9]+\\.tmp$`));
    expect(renames[1]!.oldPath).not.toBe(renames[0]!.oldPath); // overlapping writes do not share a temp file
  });

  it('removes the temp file when the rename fails', async () => {
    const a = createTauriAdapter(null);
    await a.writeNotes(pdf, 'old', SHA);
    backend.failing.set('plugin:fs|rename', 'Permission denied');
    await expect(a.writeNotes(pdf, 'new', SHA)).rejects.toBe('Permission denied');
    expect([...backend.files.keys()]).toEqual([`/data/notes/${SHA}.notes.json`]);
    expect(backend.text(`/data/notes/${SHA}.notes.json`)).toBe('old');
  });

  it('counts an empty notes file as none', async () => {
    backend.files.set(`/data/notes/${SHA}.notes.json`, new Uint8Array());
    expect(await createTauriAdapter(null).readNotes(pdf, SHA)).toBeNull();
  });
});

describe('files', () => {
  it('opens the picked PDF', async () => {
    backend.files.set('file:///private/var/Inbox/Deck%201.pdf', new Uint8Array([37, 80]));
    backend.replies.set('plugin:dialog|open', 'file:///private/var/Inbox/Deck%201.pdf');
    const file = await createTauriAdapter('ios').openPdf();
    expect(file).toEqual({ path: null, name: 'Deck 1.pdf', bytes: new Uint8Array([37, 80]) });
    expect(backend.calls[0]!.args).toMatchObject({ options: { filters: [{ extensions: ['pdf'] }], multiple: false } });
  });

  it('returns null when the picker is cancelled (iOS: null, Android: a rejection)', async () => {
    backend.replies.set('plugin:dialog|open', null);
    expect(await createTauriAdapter('ios').openPdf()).toBeNull();
    backend.replies.set('plugin:dialog|open', new Error('File picker cancelled'));
    expect(await createTauriAdapter('android').openPdf()).toBeNull();
    expect(await createTauriAdapter('android').importNotes!()).toBeNull();
  });

  it('passes other picker errors on', async () => {
    backend.replies.set('plugin:dialog|open', new Error('no activity'));
    await expect(createTauriAdapter('android').openPdf()).rejects.toBe('no activity');
  });

  it('imports a picked notes file', async () => {
    backend.files.set('content://x/document/primary%3Anotes.json', new TextEncoder().encode('{"format":"marp-notes"}'));
    backend.replies.set('plugin:dialog|open', 'content://x/document/primary%3Anotes.json');
    expect(await createTauriAdapter('android').importNotes!()).toEqual({ name: 'notes.json', text: '{"format":"marp-notes"}' });
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

  it('Android: saves through the save dialog', async () => {
    backend.replies.set('plugin:dialog|save', 'content://downloads/document/42');
    const a = createTauriAdapter('android');
    expect(await a.exportPdf(pdfBytes, 'deck-notes.pdf')).toBe(true);
    expect(backend.files.get('content://downloads/document/42')).toEqual(pdfBytes);
    expect(backend.calls.find(c => c.cmd === 'plugin:dialog|save')!.args).toMatchObject({ options: { defaultPath: 'deck-notes.pdf' } });
  });

  it('Android: a cancelled save dialog is no export', async () => {
    backend.replies.set('plugin:dialog|save', new Error('File picker cancelled'));
    expect(await createTauriAdapter('android').exportPdf(pdfBytes, 'a.pdf')).toBe(false);
    backend.replies.set('plugin:dialog|save', null);
    expect(await createTauriAdapter(null).exportPdf(pdfBytes, 'a.pdf')).toBe(false);
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
  });

  it('Android: prints through the share sheet from a cache subdirectory', async () => {
    backend.replies.set('plugin:sharekit|share_file', null);
    const a = createTauriAdapter('android');
    let shared: Uint8Array | undefined;
    backend.replies.set('plugin:sharekit|share_file', () => { shared = backend.files.get('/cache/share/a_b_c.pdf'); return null; });
    expect(await a.print!(pdfBytes, 'a/b:c.pdf')).toBe(true);
    expect(shared).toEqual(pdfBytes);
    expect(backend.files.size).toBe(0);
    expect(backend.calls.find(c => c.cmd === 'plugin:sharekit|share_file')!.args).toMatchObject({ url: 'file:///cache/share/a_b_c.pdf' });
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

  it('Android: creates the share folder for every share (the cache may have been cleared)', async () => {
    backend.replies.set('plugin:sharekit|share_file', null);
    const a = createTauriAdapter('android');
    await a.print!(pdfBytes, 'a.pdf');
    await a.print!(pdfBytes, 'a.pdf');
    expect(backend.calls.filter(c => c.cmd === 'plugin:fs|mkdir')).toHaveLength(2);
  });

  it('leaves printing to the front end on the desktop', () => {
    expect(createTauriAdapter(null).print).toBeUndefined();
    expect(createTauriAdapter('ios').print).toBeTypeOf('function');
  });
});
