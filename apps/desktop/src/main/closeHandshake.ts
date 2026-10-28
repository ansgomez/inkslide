/* Inkslide desktop - closing the window once the page has saved its notes (no Electron)
 *
 * On a close request main cancels the close and asks the page to write its
 * notes (closeRequest); the page's reply closes the window or keeps it open.
 * Every further close request while the page is asked is cancelled too, so
 * closing twice (a double click, Cmd+Q again) does not skip the save. A page
 * that never replies (a hung renderer) would then keep the window open for
 * good: after REPLY_TIMEOUT_MS main asks the user whether to close anyway
 * and lose the notes not saved yet, and asks again after each wait. A page
 * that dies while asked closes at once (main sees it as not loaded).
 */

/** How long the page has to reply before the user is asked. */
export const REPLY_TIMEOUT_MS = 15_000;

/** What the handshake does with the window and the user. */
export interface CloseActions {
  /** Ask the page to write its notes (closeRequest). */
  request(): void;
  /** Close the window; the close is not cancelled again. */
  close(): void;
  /** The page has not replied in time: ask the user whether to close anyway. Resolves true to close. */
  confirm(): Promise<boolean>;
  /** The page or the user kept the window open. */
  keptOpen(): void;
  /** Whether the page is showing a dialog (its own question about unsaved notes): the timeout waits for it. */
  busy?(): boolean;
}

export class CloseHandshake {
  private asked = false;
  private ok = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly actions: CloseActions, private readonly timeoutMs = REPLY_TIMEOUT_MS) {}

  /** Whether the page has been asked and has not replied yet. */
  get asking(): boolean {
    return this.asked;
  }

  /** A new window: forget an earlier close. Also when the window is gone (stops the timer). */
  reset(): void {
    this.asked = this.ok = false;
    this.stopTimer();
  }

  /**
   * The window is about to close: true lets it, false cancels this close.
   * It closes when that was decided already, or when the page is not
   * loaded (nothing to save). Otherwise the page is asked, once.
   */
  closing(loaded: boolean): boolean {
    if (this.ok || !loaded) return true;
    if (!this.asked) {
      this.asked = true;
      this.actions.request();
      this.startTimer();
    }
    return false;
  }

  /** The page's reply: true closes the window, anything else keeps it open. */
  reply(ok: unknown): void {
    if (!this.asked) return;
    this.asked = false;
    this.stopTimer();
    if (ok === true) this.closeNow();
    else this.actions.keptOpen();
  }

  private closeNow(): void {
    this.ok = true;
    this.actions.close();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setTimeout(() => void this.timedOut(), this.timeoutMs);
  }

  private stopTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** No reply in time: ask the user (unless the page's own dialog is open; then wait again). */
  private async timedOut(): Promise<void> {
    this.timer = undefined;
    if (!this.asked) return;
    if (this.actions.busy?.()) {
      this.startTimer();
      return;
    }
    const close = await this.actions.confirm().catch(() => false);
    if (!this.asked) return; // the page replied meanwhile
    if (close) {
      this.asked = false;
      this.closeNow();
    } else {
      this.startTimer();
    }
  }
}
