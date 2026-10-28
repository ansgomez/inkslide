/* Inkslide desktop - PDFs to open before the page can take them, and the one it has open (no Electron)
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

/**
 * The PDF the front end has open, as main knows it. Reading a PDF for the
 * page (readPdf) does not make it the open one: the page may fail to load
 * it, or keep the open PDF (its notes could not be saved). Only the page's
 * opened() call does. The export may not replace the open PDF, and a
 * reloaded page reopens it; dialogs start in its folder, else in the folder
 * of the PDF read last.
 */
export class CurrentPdf {
  private shown: string | null = null;
  private lastRead: string | null = null;

  /** Main read `path` for the page. */
  read(path: string): void {
    this.lastRead = path;
  }

  /** The page opened a PDF: `path`, or null for one without a path. */
  opened(path: string | null): void {
    this.shown = path;
  }

  /** The open PDF's path; null if none is open or it has no path. */
  get open(): string | null {
    return this.shown;
  }

  /** The PDF whose folder dialogs start in: the open one, else the one read last. */
  get forDialogs(): string | null {
    return this.shown ?? this.lastRead;
  }
}
