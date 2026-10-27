/* Inkslide web - the recent files on the start screen
 *
 * A list under the "Open PDF…" button: name, page count, pages with notes,
 * size and when it was last opened, and a remove button. A click reopens the
 * PDF, and its notes load with it as with any open; an entry whose file is
 * gone is dropped from the list. The entries come from a RecentSource: the
 * browser's remembered files (../recent.ts) or the desktop's recent files
 * (window.inkslide).
 */
import type { PdfFile } from '@inkslide/annotate';
import { inkedPages } from '@inkslide/annotate/io';
import { banner } from './banner';
import { RecentError, type RecentEntry } from './recent';
import type { InkslideBridge } from './platform';
import type { WebAdapter } from './platform/web';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
export function formatOpened(at: number, now = Date.now()): string {
  const d = now - at;
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return 'yesterday';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return new Date(at).toLocaleDateString();
}

/** "1.2 MB", "340 KB". */
export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** An entry of the list. */
export interface RecentItem {
  id: string;
  name: string;
  /** Page count (PDF pages, without blank pages), if known. */
  pages?: number;
  /** File size in bytes. */
  size: number;
  /** Last opened, ms since the epoch; 0 if unknown. */
  openedAt: number;
  /** PDF pages with ink in the saved notes. */
  annotatedPages?: number;
  /** Blank pages with ink in the saved notes. */
  annotatedBlankPages?: number;
}

const count = (n: number, one: string): string => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

/** "notes on 3 pages", "notes on 2 pages and 1 blank page"; '' without notes. */
function notesLabel(pages = 0, blank = 0): string {
  const parts = [pages && count(pages, 'page'), blank && count(blank, 'blank page')].filter(Boolean);
  return parts.length ? `notes on ${parts.join(' and ')}` : '';
}

/** Second line of an entry: pages · notes · size · last opened. */
export function entryDetails(e: RecentItem, now = Date.now()): string {
  const parts: string[] = [];
  if (e.pages) parts.push(e.pages === 1 ? '1 page' : `${e.pages} pages`);
  const notes = notesLabel(e.annotatedPages, e.annotatedBlankPages);
  if (notes) parts.push(notes);
  parts.push(formatSize(e.size));
  if (e.openedAt > 0) parts.push(`opened ${formatOpened(e.openedAt, now)}`);
  return parts.join(' · ');
}

/** Where the list comes from. */
export interface RecentSource {
  /** Entries, newest first. */
  list(): Promise<RecentItem[]>;
  remove(id: string): Promise<void>;
  /** The PDF of an entry (from a click); rejects with a RecentError 'missing' when it is gone. */
  read(id: string): Promise<PdfFile>;
  /** Call `fn` when the entries change elsewhere (desktop menu, another open). */
  onChange?(fn: () => void): void;
}

/** Browser / PWA: the remembered files, with the pages that have notes in app storage. */
export function webRecentSource(adapter: WebAdapter): RecentSource {
  const { recent } = adapter;
  const withNotes = async (e: RecentEntry): Promise<RecentItem> => {
    const text = await adapter.readNotes({ path: null, name: e.name, bytes: new Uint8Array() }, e.id).catch(() => null);
    const inked = text ? inkedPages(text) : { pages: 0, blank: 0 };
    return { ...e, annotatedPages: inked.pages, annotatedBlankPages: inked.blank };
  };
  return {
    list: async () => Promise.all((await recent.list()).map(withNotes)),
    remove: id => recent.remove(id),
    read: id => adapter.openRecent(id),
  };
}

/** Desktop: the recent files of the main process (the path is the id). */
export function desktopRecentSource(bridge: InkslideBridge): RecentSource {
  return {
    list: async () => (await bridge.recentFiles()).map(f => ({ ...f, id: f.path })),
    remove: path => bridge.removeRecent(path),
    async read(path) {
      const file = await bridge.openRecent(path);
      if (!file) throw new RecentError('missing', 'the file is gone');
      return file;
    },
    onChange: fn => { bridge.onRecentChanged(fn); },
  };
}

/** What the recent files list uses. */
export interface RecentListHost {
  source: RecentSource;
  /** Open the PDF read from an entry. */
  open(file: PdfFile): Promise<void>;
}

/** Add the recent files list to the start screen; resolves once it is shown. */
export async function mountRecentList(empty: HTMLElement, host: RecentListHost): Promise<void> {
  const { source } = host;
  const section = document.createElement('section');
  section.className = 'ink-recent';
  section.hidden = true;
  const title = document.createElement('h2');
  title.textContent = 'Recent';
  const list = document.createElement('ul');
  section.append(title, list);
  empty.appendChild(section);

  async function remove(id: string): Promise<void> {
    await source.remove(id).catch(e => console.warn('Could not remove the recent file', e));
    await refresh();
  }

  async function reopen(e: RecentItem): Promise<void> {
    let file;
    try {
      file = await source.read(e.id);
    } catch (err) {
      if (err instanceof RecentError && err.reason === 'missing') {
        banner(`${e.name} can not be opened again: ${err.message}. Removed from the recent files.`, 'warn');
        await remove(e.id);
      } else {
        banner(`Could not open ${e.name}: ${(err as Error).message || err}`, 'error');
      }
      return;
    }
    await host.open(file);
  }

  function item(e: RecentItem): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'ink-recent-item';
    li.dataset.id = e.id;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ink-recent-open';
    open.title = `Open ${e.name}`;
    const name = document.createElement('span');
    name.className = 'ink-recent-name';
    name.textContent = e.name;
    const details = document.createElement('span');
    details.className = 'ink-recent-details';
    details.textContent = entryDetails(e);
    open.append(name, details);
    open.addEventListener('click', () => void reopen(e));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ink-recent-remove';
    del.setAttribute('aria-label', `Remove ${e.name} from the recent files`);
    del.title = 'Remove from the recent files';
    del.textContent = '×';
    del.addEventListener('click', () => void remove(e.id));
    li.append(open, del);
    return li;
  }

  /** Only the newest refresh shows its entries (an older, slower one would bring back removed ones). */
  let generation = 0;

  async function refresh(): Promise<void> {
    const mine = ++generation;
    let entries: RecentItem[] = [];
    try {
      entries = await source.list();
    } catch (e) {
      console.warn('Could not read the recent files', e); // e.g. IndexedDB blocked
    }
    if (mine !== generation) return;
    list.replaceChildren(...entries.map(item));
    section.hidden = entries.length === 0;
  }

  // Once a PDF is open the start screen is gone for good: no need to keep the list fresh.
  source.onChange?.(() => { if (!empty.hidden) void refresh(); });
  await refresh();
}
