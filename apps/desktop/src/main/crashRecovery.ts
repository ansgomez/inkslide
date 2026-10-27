/* Inkslide desktop - what to do when the page's renderer process dies (no Electron)
 *
 * A crash (or the OS killing the renderer for memory) leaves a blank window
 * that can no longer save or take open requests. The first time, main
 * reloads the page at once and it reopens the PDF; if the page dies again
 * soon after, a PDF may be what kills it, so the user is asked instead of
 * reloading in a loop.
 */

/** A second crash within this time of an automatic reload is asked about. */
export const CRASH_REPEAT_MS = 30_000;

/** none: a normal exit, nothing to do; reload: reload and reopen the PDF; ask: let the user choose. */
export type CrashAction = 'none' | 'reload' | 'ask';

/** Decides, crash by crash, between an automatic reload and asking. */
export class CrashRecovery {
  private lastReload = -Infinity;

  constructor(private readonly repeatMs = CRASH_REPEAT_MS) {}

  /** The renderer went away for `reason` (render-process-gone) at `now`. */
  next(reason: string, now = Date.now()): CrashAction {
    if (reason === 'clean-exit') return 'none';
    if (now - this.lastReload < this.repeatMs) return 'ask';
    this.lastReload = now;
    return 'reload';
  }
}
