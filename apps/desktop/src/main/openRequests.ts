/* Inkslide desktop - PDFs to open before the page can take them (no Electron)
 *
 * The page asks initialPath() once, early while it loads; main sends later
 * requests as openRequest messages once it has loaded (the preload keeps them
 * until the front end subscribes). A request that comes after the page asked
 * must be queued: initialPath() is not asked again until the next page load.
 */

/** Open requests that came while no page was loaded. */
export class OpenRequests {
  private initial: string | null = null;
  private initialTaken = false;
  private readonly queued: string[] = [];

  /** A PDF to open while the page is not loaded (or there is no window). */
  add(path: string): void {
    if (this.initial === null && !this.initialTaken) this.initial = path;
    else this.queued.push(path);
  }

  /** initialPath(): the first request, handed out once per page. */
  takeInitial(): string | null {
    this.initialTaken = true;
    const p = this.initial;
    this.initial = null;
    return p;
  }

  /** The other requests, to send once the page has loaded. */
  takeQueued(): string[] {
    return this.queued.splice(0);
  }

  /**
   * A page starts loading, or the window is gone: the next page asks
   * initialPath() again. `reopen`: the PDF a reloaded page showed, offered
   * again unless another one is waiting.
   */
  newPage(reopen: string | null = null): void {
    this.initialTaken = false;
    if (reopen !== null && this.initial === null && !this.queued.length) this.initial = reopen;
  }
}
