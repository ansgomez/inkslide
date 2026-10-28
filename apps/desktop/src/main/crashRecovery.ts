/* Inkslide desktop - what to do when the page's renderer process dies (no Electron)
 *
 * A crash (or the OS killing the renderer for memory) leaves a blank window
 * that can no longer save or take open requests. The first time, main
 * reloads the page at once and it reopens the PDF. After that it reloads on
 * its own only if the reloaded page worked for a while: it saved notes and
 * lasted CRASH_REPEAT_MS. Otherwise a PDF may be what kills it, so the user
 * is asked instead of reloading in a loop.
 */

/** A crash within this time of the last reload is asked about. */
export const CRASH_REPEAT_MS = 5 * 60_000;

/** none: a normal exit, nothing to do; reload: reload and reopen the PDF; ask: let the user choose. */
export type CrashAction = 'none' | 'reload' | 'ask';

/** Decides, crash by crash, between an automatic reload and asking. */
export class CrashRecovery {
  private lastReload: number | null = null;
  private savedSinceReload = false;

  constructor(private readonly repeatMs = CRASH_REPEAT_MS) {}

  /** The renderer went away for `reason` (render-process-gone) at `now`. A 'reload' counts as a reload. */
  next(reason: string, now = Date.now()): CrashAction {
    if (reason === 'clean-exit') return 'none';
    if (this.lastReload !== null && (now - this.lastReload < this.repeatMs || !this.savedSinceReload)) return 'ask';
    this.reloaded(now);
    return 'reload';
  }

  /** The page was reloaded after a crash (also when the user chose to). */
  reloaded(now = Date.now()): void {
    this.lastReload = now;
    this.savedSinceReload = false;
  }

  /** The page saved its notes: it works, at least with this PDF. */
  saved(): void {
    this.savedSinceReload = true;
  }
}
