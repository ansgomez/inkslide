/* Inkslide web - the recent files on the start screen (browser / PWA)
 *
 * A list under the "Open PDF…" button: name, page count, size and when it
 * was last opened, and a remove button. A click reopens the PDF (the
 * browser may ask for permission to read a file on disk again); an entry
 * whose file is gone is dropped from the list.
 */
import type { PdfFile } from '@inkslide/annotate';
import { banner } from './banner';
import { RecentError, type RecentEntry } from './recent';
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

/** Second line of an entry: pages · size · last opened. */
export function entryDetails(e: RecentEntry, now = Date.now()): string {
  const parts: string[] = [];
  if (e.pages) parts.push(e.pages === 1 ? '1 page' : `${e.pages} pages`);
  parts.push(formatSize(e.size), `opened ${formatOpened(e.openedAt, now)}`);
  return parts.join(' · ');
}

/** What the recent files list uses. */
export interface RecentListHost {
  adapter: WebAdapter;
  /** Open the PDF read from an entry. */
  open(file: PdfFile): Promise<void>;
}

/** Add the recent files list to the start screen; resolves once it is shown. */
export async function mountRecentList(empty: HTMLElement, host: RecentListHost): Promise<void> {
  const { recent } = host.adapter;
  const section = document.createElement('section');
  section.className = 'ink-recent';
  section.hidden = true;
  const title = document.createElement('h2');
  title.textContent = 'Recent';
  const list = document.createElement('ul');
  section.append(title, list);
  empty.appendChild(section);

  async function remove(id: string): Promise<void> {
    await recent.remove(id).catch(e => console.warn('Could not remove the recent file', e));
    await refresh();
  }

  async function reopen(e: RecentEntry): Promise<void> {
    let file;
    try {
      file = await host.adapter.openRecent(e.id);
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

  function item(e: RecentEntry): HTMLLIElement {
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

  async function refresh(): Promise<void> {
    let entries: RecentEntry[] = [];
    try {
      entries = await recent.list();
    } catch (e) {
      console.warn('Could not read the recent files', e); // e.g. IndexedDB blocked
    }
    list.replaceChildren(...entries.map(item));
    section.hidden = entries.length === 0;
  }

  await refresh();
}
