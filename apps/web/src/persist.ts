/* Inkslide web - notes autosave for the open PDF
 *
 * A thin wrapper around the shared autosave controller
 * (@inkslide/annotate/autosave): one controller per open document.
 * scheduleSave() notes a change outside the document's own change events,
 * flushSave() writes at once (Ctrl+S, opening another PDF, leaving the
 * page), pageTurned() writes on a page turn. Failed writes are retried.
 */
import type { NotesDoc, PdfFile, PlatformAdapter } from '@inkslide/annotate';
import { createAutosave, type Autosave, type AutosaveState } from '@inkslide/annotate/autosave';
import { serializeNotes } from '@inkslide/annotate/io';

/** Autosave delay after the last change, ms. */
export const SAVE_DELAY_MS = 2000;

/** The open document and where its notes are written. */
export interface SaveTarget {
  doc: NotesDoc;
  adapter: PlatformAdapter;
  pdf: PdfFile;
  sha256?: string;
}

/** Callbacks of the autosave of the open document. */
export interface SaveHandlers {
  /** A write failed (the first failure in a row only; retries follow). */
  onError?: (e: unknown) => void;
  onState?: (state: AutosaveState) => void;
}

let current: Autosave | null = null;

/**
 * Document to save (null: none open). Create it after the notes are loaded.
 * Does not save the previous one; flush first.
 */
export function setSaveTarget(t: SaveTarget | null, handlers: SaveHandlers = {}, delayMs = SAVE_DELAY_MS): void {
  if (current) current.dispose();
  current = null;
  if (!t) return;
  const saver: Autosave = createAutosave({
    doc: t.doc,
    serialize: () => serializeNotes(t.doc),
    write: text => t.adapter.writeNotes(t.pdf, text, t.sha256),
    delayMs,
    onState: handlers.onState,
    onError: e => {
      if (saver.failures === 1) {
        if (handlers.onError) handlers.onError(e);
        else console.error('Saving notes failed', e);
      }
    },
  });
  current = saver;
}

/** Note a change; saved 2 s after the last one. */
export function scheduleSave(): void {
  if (current) current.markDirty();
}

/** Save now if anything is unsaved. Resolves false if that write failed. */
export async function flushSave(): Promise<boolean> {
  if (!current) return true;
  try {
    await current.flush();
    return true;
  } catch {
    return false;
  }
}

/** Save on a page turn; never rejects (failures retry). */
export function pageTurned(): void {
  if (current) void current.pageTurned();
}

/** State of the open document's notes ('saved' when none is open). */
export const saveState = (): AutosaveState => (current ? current.state : 'saved');
