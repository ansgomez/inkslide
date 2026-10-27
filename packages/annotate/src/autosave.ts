/* Inkslide annotate - autosave controller (pure, no DOM, no file system)
 *
 * Saves the notes 2 s after the last change, at once on a page turn and on
 * flush() (window close). Writes never overlap: a save requested while one
 * is running waits for it and then writes the newest state once. A failed
 * write is retried with exponential backoff; changes keep being collected
 * meanwhile. onState drives the "unsaved" indicator:
 *   saved   everything is written
 *   dirty   changes are waiting for the debounce
 *   saving  a write is running
 *   error   the last write failed; a retry is scheduled
 *
 * Create it after loading the notes: NotesDoc.load() emits change events
 * too, and those would count as edits.
 */
import type { ChangeKind, NotesDoc } from './model';

/** See the module comment. */
export type AutosaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** Options of createAutosave. */
export interface AutosaveOptions {
  /** Document to watch (its change events call markDirty); marked saved after a write. */
  doc?: Pick<NotesDoc, 'onChange' | 'markSaved'> | null;
  /** The text to write (e.g. () => serializeNotes(doc)); called when a write starts. */
  serialize: () => string;
  /** Write the text crash-safe (PlatformAdapter.writeNotes). Rejects on failure. */
  write: (text: string) => Promise<void>;
  /** Wait after the last change before saving. */
  delayMs?: number;
  /** First retry delay after a failed write; doubles per failure. */
  retryMs?: number;
  /** Longest retry delay. */
  maxRetryMs?: number;
  onState?: (state: AutosaveState) => void;
  /** Called with each failed write's error. */
  onError?: (error: unknown) => void;
}

/** An autosave controller (see createAutosave). */
export interface Autosave {
  /** Note a change; the save follows delayMs after the last one. */
  markDirty(): void;
  /** Save now if there are changes (or a write is running); rejects if that write fails. */
  flush(): Promise<void>;
  /** Save now if there are changes; never rejects (failures retry). */
  pageTurned(): Promise<void>;
  /** Stop timers and ignore further changes. Call flush() first to keep them. */
  dispose(): void;
  readonly state: AutosaveState;
  /** Failed writes since the last successful one. */
  readonly failures: number;
}

/** Autosave for one document: debounced, serialized, retried writes (see the module comment). */
export function createAutosave(opts: AutosaveOptions): Autosave {
  const { doc, serialize, write, onState, onError } = opts;
  const delayMs = opts.delayMs ?? 2000;
  const retryMs = opts.retryMs ?? 1000;
  const maxRetryMs = opts.maxRetryMs ?? 30000;

  let state: AutosaveState = 'saved';
  let changes = 0;       // change counter; `written` is its value at the last good write
  let written = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  let disposed = false;

  const dirty = (): boolean => changes !== written;
  const setState = (next: AutosaveState): void => {
    if (next === state) return;
    state = next;
    if (onState) onState(next);
  };
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number): void => {
    clearTimer();
    if (!disposed) timer = setTimeout(() => { timer = null; save().catch(() => {}); }, ms);
  };

  async function writeOnce(): Promise<void> {
    const at = changes;
    setState('saving');
    try {
      await write(serialize());
    } catch (e) {
      failures++;
      if (onError) onError(e);
      setState('error');
      schedule(Math.min(maxRetryMs, retryMs * 2 ** (failures - 1)));
      throw e;
    }
    failures = 0;
    written = at;
    if (!dirty() && doc) doc.markSaved();
    setState(dirty() ? 'dirty' : 'saved');
    // Changes made during the write already restarted the debounce timer.
    if (dirty() && timer === null && !queued) schedule(delayMs);
  }

  /** Start a write, or queue one behind the running write (at most one queued). */
  function save(): Promise<void> {
    if (disposed) return Promise.resolve();
    clearTimer();
    if (running) {
      return queued ||= running.catch(() => {}).then(() => {
        queued = null;
        return save();
      });
    }
    if (!dirty()) return Promise.resolve();
    running = writeOnce().finally(() => { running = null; });
    return running;
  }

  function markDirty(): void {
    if (disposed) return;
    changes++;
    if (state === 'saved') setState('dirty');
    // While a retry is pending, keep its backoff instead of the shorter debounce.
    if (state !== 'error' || timer === null) schedule(delayMs);
  }

  const unsubscribe = doc ? doc.onChange((_pageId: string | null, kind: ChangeKind) => {
    if (kind !== 'saved') markDirty();
  }) : null;

  return {
    markDirty,
    flush: save,
    pageTurned: () => save().catch(() => {}),
    dispose() {
      disposed = true;
      clearTimer();
      if (unsubscribe) unsubscribe();
    },
    get state() { return state; },
    get failures() { return failures; },
  };
}
