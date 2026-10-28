/* Inkslide desktop - Electron main process
 *
 * One window with the shared front end (apps/web, served from app://inkslide/,
 * paths.ts APP_ORIGIN), file access over IPC for
 * the preload bridge (window.inkslide), single instance, recent files, window
 * state, preferences and a small native menu. No rendering happens here.
 * Presenter mode adds a second, read-only window (the audience window) that
 * gets the app window's presenter messages through main (presenter.ts).
 *
 * Environment:
 *   INKSLIDE_DEV_URL    load this URL (Vite dev server) instead of apps/web/dist
 *   INKSLIDE_DESKTOP_NAME  development only: desktop file id, and so the window's app id
 *                       (the dev desktop entry sets inkslide-dev.desktop)
 * Tests only (packaged builds ignore them unless built with dist.mjs --test-build; paths.ts testEnv):
 *   INKSLIDE_PAGE       load this HTML file instead (tests)
 *   INKSLIDE_USER_DATA  use this userData directory (tests)
 *   INKSLIDE_SMOKE      smoke test mode: run window.inkslideSmoke(), print, quit
 *                       (mode "close": close the window instead, the page saves on close;
 *                       mode "backupsoff": then switch backups off as the menu does)
 *   INKSLIDE_PRINT_TO_PDF  smoke test mode only: Print writes this PDF file instead of
 *                       showing the print dialog
 */
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, net, protocol, screen, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePresenterMessage } from '@inkslide/annotate/presenter';
import { IPC, type MenuCommand, type PdfFile, type PdfRef } from '../shared/bridge';
import { checkDroppedPdf, checkPath, checkPdfBytes, checkText, HashGrants, notesTargetFor, PathGrants } from './access';
import { CrashRecovery } from './crashRecovery';
import { MAX_PDF_BYTES, MAX_TEXT_BYTES, readFileLimited, writeExport } from './fsutil';
import { confirmLinks, lockNavigation, restrictPermissions, SAFE_WEB_PREFERENCES } from './harden';
import { buildMenu } from './menu';
import {
  cleanupNotesStore, hasBackup, keepUnreadableFor, readBackupFor, readNotesFor, removeAllBackups, removeLegacyBackup, revertToBackupFor,
  writeNotesFor, type NotesTarget,
} from './notes';
import { OpenRequests } from './openRequests';
import { APP_ORIGIN, APP_SCHEME, isSha256, pdfFromArgv, resolveWebEntry, testEnv, webFileFor, type WebEntry } from './paths';
import { loadPreferences, savePreferences } from './preferences';
import { audienceEntry, audienceKey, audiencePlacement } from './presenter';
import { PrintGate, printPdf } from './print';
import { RECENT_MAX, recentInfo, RecentFiles } from './recent';
import { fitToDisplays, loadWindowState, MIN_SIZE, saveWindowState, type WindowState } from './windowState';

/** true in a test build (dist.mjs --test-build, via build.mjs): packaged, it still takes the test variables. */
declare const INKSLIDE_TEST_BUILD: boolean;

// Native Wayland when available (pen pressure, tilt and eraser need it).
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
const testVars = testEnv(process.env, !app.isPackaged || INKSLIDE_TEST_BUILD);
if (testVars.userData) app.setPath('userData', resolve(testVars.userData));
// Native crashes (main, GPU, renderer) leave a minidump in userData/Crashpad for
// bug reports; nothing is uploaded. After setPath, so tests keep theirs apart.
crashReporter.start({ uploadToServer: false });
// The dev build gets its own app id, so GNOME does not group it with an installed
// Inkslide. app.setDesktopName is what Electron itself calls with package.json's
// desktopName; it is not in the typings.
if (!app.isPackaged && process.env.INKSLIDE_DESKTOP_NAME) {
  (app as typeof app & { setDesktopName?(name: string): void }).setDesktopName?.(process.env.INKSLIDE_DESKTOP_NAME);
}

const smokeMode = testVars.smoke;
// The front end's origin, app://inkslide/ (paths.ts APP_ORIGIN): standard and
// secure like https, so its CSP 'self' is that origin only, and module
// workers, fetch and wasm work. Must be registered before 'ready'.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
]);
const onWayland = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

if (!app.requestSingleInstanceLock()) {
  // The running instance gets our argv through 'second-instance'.
  app.quit();
} else {
  start();
}

function start(): void {
  const userData = app.getPath('userData');
  const stateFile = join(userData, 'window-state.json');
  const recent = new RecentFiles(join(userData, 'recent-files.v2.json'), RECENT_MAX, join(userData, 'recent-files.json'));
  const prefsFile = join(userData, 'preferences.json');
  const prefs = loadPreferences(prefsFile);
  /** The PDF the front end has open (opened()), and whether it has a backup (File → Revert to Backup…). */
  let notesTarget: NotesTarget | null = null;
  let canRevert = false;
  const grants = new PathGrants(p => recent.has(p));
  /** Hashes of the PDFs main read or was sent: the only ones notes calls may use. */
  const hashes = new HashGrants();

  let win: BrowserWindow | null = null;
  let state: WindowState = loadWindowState(stateFile);
  let loaded = false;
  /** The folder app://inkslide/ serves (the front end's, or the INKSLIDE_PAGE fixture's). */
  let webRoot: string | null = null;
  /** PDFs from the command line or the OS before the page loaded. */
  const opens = new OpenRequests();
  /** The PDF opened last (default folder for dialogs, never an export target). */
  let current: string | null = null;
  /** Window close: the front end was asked to save first / said it may close. */
  let closeAsked = false;
  let closeOk = false;
  /** The app quits once the window has closed (menu Quit, Cmd+Q). */
  let quitting = false;
  /** Notes writes in progress; quitting waits for them. */
  const writes = new Set<Promise<unknown>>();
  /** Renderer crashes: reload at once, or ask (crashRecovery.ts). */
  const crashes = new CrashRecovery();

  const argPdf = pdfFromArgv(process.argv, process.cwd());
  if (argPdf && 'path' in argPdf) opens.add(grants.grant(argPdf.path));
  /** A remote URI from the command line: explained once the window has loaded (as its child, not behind it). */
  let remoteAtStart = argPdf && 'remote' in argPdf ? argPdf.remote : null;

  function focusWindow(w: BrowserWindow): void {
    if (w.isMinimized()) w.restore();
    w.focus();
  }

  /** Ask the front end to open `path` (second instance, open-file, menu). */
  function requestOpen(path: string): void {
    const p = grants.grant(path);
    if (!win) {
      opens.add(p);
      if (app.isReady()) createWindow();
      return;
    }
    focusWindow(win);
    if (loaded) win.webContents.send(IPC.openRequest, p);
    else opens.add(p);
  }

  /** The recent files changed: rebuild the menu and tell the start screen. */
  function recentChanged(): void {
    refreshMenu();
    if (win && loaded) win.webContents.send(IPC.recentChanged);
  }

  function refreshMenu(): void {
    Menu.setApplicationMenu(buildMenu({
      open: () => { void showOpenDialog().then(p => p && requestOpen(p)); },
      openRecent: p => {
        if (existsSync(p)) requestOpen(p);
        else {
          recent.remove(p);
          recentChanged();
          void dialog.showMessageBox({ type: 'warning', message: `${basename(p)} no longer exists.`, detail: p });
        }
      },
      clearRecent: () => {
        recent.clear();
        app.clearRecentDocuments();
        recentChanged();
      },
      command: (c: MenuCommand) => win?.webContents.send(IPC.menuCommand, c),
      toggleMenuBar: () => {
        state.menuHidden = !state.menuHidden;
        applyMenuBar();
        refreshMenu();
      },
      toggleBackups: () => void toggleBackups(),
      recent: () => recent.paths(),
      menuHidden: () => state.menuHidden,
      backups: () => prefs.backups,
      canRevert: () => canRevert,
      togglePresenter: () => togglePresenter(),
      presenting: () => !!audience,
      canPresent: () => !!win,
    }, !app.isPackaged));
  }

  /** File → Keep a Backup of the Notes. Off: every PDF's backup is deleted (the unreadable copies stay). */
  async function toggleBackups(): Promise<void> {
    prefs.backups = !prefs.backups;
    savePreferences(prefsFile, prefs);
    refreshMenu();
    if (!prefs.backups) {
      await Promise.allSettled([...writes]); // a save already running may still make a backup
      await tracked(removeAllBackups(userData)).catch(err => console.warn(`could not delete the backups: ${(err as Error).message}`));
    }
    await updateRevert();
  }

  /** Enable Revert to Backup when backups are on and the open PDF has one. */
  async function updateRevert(): Promise<void> {
    const t = notesTarget;
    const on = prefs.backups && !!t && await hasBackup(t, userData).catch(() => false);
    if (t !== notesTarget || on === canRevert) return;
    canRevert = on;
    refreshMenu();
  }

  function applyMenuBar(): void {
    if (!win || process.platform === 'darwin') return;
    win.setAutoHideMenuBar(state.menuHidden);
    win.setMenuBarVisibility(!state.menuHidden);
  }

  /** Folder the dialogs start in: the open PDF's, else Documents. */
  const dialogDir = (): string => (current ? dirname(current) : app.getPath('documents'));
  // Dialogs are modal to the window when there is one.
  const openDialog = (o: Electron.OpenDialogOptions) => (win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o));
  const saveDialog = (o: Electron.SaveDialogOptions) => (win ? dialog.showSaveDialog(win, o) : dialog.showSaveDialog(o));
  const messageBox = (o: Electron.MessageBoxOptions) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));

  /** A PDF given as a non-local URI (e.g. sftp:// from a file manager): say why it does not open. */
  function refuseRemote(uri: string): void {
    void messageBox({ type: 'warning', message: 'Inkslide can only open local files; copy the PDF to this computer first.', detail: uri });
  }

  async function showOpenDialog(): Promise<string | null> {
    const r = await openDialog({
      title: 'Open PDF',
      defaultPath: dialogDir(),
      filters: [{ name: 'PDF', extensions: ['pdf'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    return r.canceled || !r.filePaths[0] ? null : grants.grant(r.filePaths[0]);
  }

  // ── Window ───────────────────────────────────────────────────

  function createWindow(): void {
    if (win) return;
    const areas = screen.getAllDisplays().map(d => d.workArea);
    state = fitToDisplays(state, areas);
    win = new BrowserWindow({
      width: state.width,
      height: state.height,
      ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: 'Inkslide',
      backgroundColor: '#1e1e1e',
      show: false,
      ...(!app.isPackaged && process.platform === 'linux' ? { icon: join(app.getAppPath(), 'build', 'icons', '512x512.png') } : {}),
      webPreferences: { ...SAFE_WEB_PREFERENCES, preload: join(__dirname, 'preload.js') },
    });
    applyMenuBar();
    refreshMenu(); // Presenter Mode is enabled with a window
    const w = win;
    const wc = w.webContents;
    closeAsked = closeOk = false;

    w.once('ready-to-show', () => {
      if (smokeMode) return;
      if (state.maximized) w.maximize();
      if (state.fullScreen) w.setFullScreen(true);
      w.show();
    });
    w.on('close', e => {
      const b = w.getNormalBounds();
      state = {
        ...state, width: b.width, height: b.height, x: b.x, y: b.y,
        maximized: w.isMaximized(), fullScreen: w.isFullScreen(),
      };
      // Wayland hides window positions (always 0,0); keep only the size there.
      if (onWayland) {
        delete state.x;
        delete state.y;
      }
      if (!smokeMode) saveWindowState(stateFile, state);
      // Ask the front end to write its notes first (closeReply closes the
      // window again). Closing once more while it is asked closes at once.
      if (closeOk || closeAsked || !loaded) return;
      e.preventDefault();
      closeAsked = true;
      wc.send(IPC.closeRequest);
    });
    w.on('closed', () => {
      audience?.close(); // presenter mode ends with the app window
      win = null;
      loaded = false;
      opens.newPage();
      refreshMenu(); // Presenter Mode needs a window
    });

    // The page never navigates or opens windows; links go to the browser
    // once the user confirms them (the dialog shows where they lead).
    lockNavigation(wc, confirmLinks(async url => (await dialog.showMessageBox(w, {
      type: 'question', buttons: ['Cancel', 'Open in Browser'], defaultId: 0, cancelId: 0,
      title: 'Inkslide', message: `Open a link to ${url.host} in your browser?`, detail: url.href,
    })).response === 1, url => void shell.openExternal(url)));

    wc.on('did-start-loading', () => { loaded = false; });
    // A new page asks initialPath() again; a reload (menu in development,
    // DevTools, after a crash) gets the PDF that was open, unless the user
    // chose to reload without it.
    let navigated = false;
    let reopen = true;
    wc.on('did-navigate', () => {
      opens.newPage(navigated && reopen ? current : null);
      navigated = true;
      reopen = true;
    });
    // The renderer died (crash, killed for memory): the window would stay
    // blank, unable to save or take open requests. Reload it (it reopens the
    // PDF; requests that come meanwhile are queued); if it dies again soon or
    // before it saved, ask (crashRecovery.ts). While closing, the window just
    // closes: there is nothing left to save.
    wc.on('render-process-gone', (_e, details) => {
      loaded = false;
      if (closeAsked) {
        w.close();
        return;
      }
      if (smokeMode || w.isDestroyed()) return;
      const action = crashes.next(details.reason);
      if (action === 'reload') wc.reload();
      else if (action === 'ask') void askAfterCrash(details.reason);
    });
    async function askAfterCrash(reason: string): Promise<void> {
      const r = await dialog.showMessageBox(w, {
        type: 'error', buttons: ['Reload', 'Reload Without the PDF', 'Close Window'], defaultId: 1, cancelId: 2,
        title: 'Inkslide', message: `The Inkslide window stopped working again (${reason}).`,
        detail: 'Notes saved before it stopped are kept. If the open PDF makes it stop, reload without it.',
      });
      if (w.isDestroyed() || loaded) return;
      if (r.response === 2) w.close();
      else {
        reopen = r.response === 0;
        crashes.reloaded();
        wc.reload();
      }
    }
    wc.on('did-finish-load', () => {
      loaded = true;
      if (audienceLoaded) wc.send(IPC.presenterState, true); // a reloaded page presents again
      opens.takeQueued().forEach(p => wc.send(IPC.openRequest, p));
      if (remoteAtStart) refuseRemote(remoteAtStart);
      remoteAtStart = null;
      // Smoke mode "backupsoff": then switch backups off as the menu does.
      if (smokeMode) void runSmoke(w, smokeMode === 'backupsoff' ? toggleBackups : undefined);
    });

    const entry = webEntry();
    if (entry.kind === 'url') void w.loadURL(entry.url);
    else if (!existsSync(entry.file)) {
      void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(missingPage(entry.file))}`);
    } else void w.loadURL(appUrl(entry.file, smokeMode ? `#smoke=${encodeURIComponent(smokeMode)}` : ''));
  }

  /**
   * The app://inkslide/ URL of a front-end page (index.html, audience.html):
   * app:// serves the page's folder (webRoot), never file:// (paths.ts APP_ORIGIN).
   */
  function appUrl(file: string, hash = ''): string {
    webRoot = dirname(file);
    return `${APP_ORIGIN}/${encodeURIComponent(basename(file))}${hash}`;
  }

  function webEntry(): WebEntry {
    return resolveWebEntry({
      devUrl: process.env.INKSLIDE_DEV_URL,
      pageOverride: testVars.page,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
  }

  // ── Presenter mode ───────────────────────────────────────────

  /** The audience window (View → Presenter Mode), and whether its page has loaded. */
  let audience: BrowserWindow | null = null;
  let audienceLoaded = false;

  function togglePresenter(): void {
    if (audience) audience.close();
    else openAudience();
  }

  /** Open the audience window: full screen on another display if there is one; the app window keeps the focus. */
  function openAudience(): void {
    if (!win || audience) {
      refreshMenu(); // the checkbox has toggled itself
      return;
    }
    const appWin = win;
    // Wayland: no window positions, so no full screen that could land on the app window's display.
    const place = audiencePlacement(screen.getAllDisplays(), screen.getDisplayMatching(appWin.getBounds()).id, !onWayland);
    const a = new BrowserWindow({
      ...place.bounds,
      title: 'Inkslide audience',
      backgroundColor: '#000000',
      show: false,
      autoHideMenuBar: true,
      ...(!app.isPackaged && process.platform === 'linux' ? { icon: join(app.getAppPath(), 'build', 'icons', '512x512.png') } : {}),
      webPreferences: { ...SAFE_WEB_PREFERENCES, preload: join(__dirname, 'preload.js') },
    });
    audience = a;
    audienceLoaded = false;
    if (process.platform !== 'darwin') a.setMenu(null);
    const wc = a.webContents;
    lockNavigation(wc);
    // No menu there: Escape (or F5 again) ends presenter mode, F11 toggles full screen.
    wc.on('before-input-event', (e, input) => {
      const action = audienceKey(input);
      if (!action) return;
      e.preventDefault();
      if (action === 'exit') a.close();
      else a.setFullScreen(!a.isFullScreen());
    });
    a.once('ready-to-show', () => {
      a.showInactive();
      if (place.fullScreen) a.setFullScreen(true);
      if (win && !win.isDestroyed()) win.focus();
    });
    wc.on('did-start-loading', () => { audienceLoaded = false; });
    wc.on('did-finish-load', () => {
      audienceLoaded = true;
      if (win && loaded) win.webContents.send(IPC.presenterState, true); // the app window sends everything
    });
    wc.on('render-process-gone', () => { if (!a.isDestroyed()) a.close(); });
    a.on('closed', () => {
      if (audience !== a) return;
      audience = null;
      audienceLoaded = false;
      if (win && loaded) win.webContents.send(IPC.presenterState, false);
      refreshMenu();
    });
    const entry = audienceEntry(webEntry());
    if (entry.kind === 'url') void a.loadURL(entry.url);
    else if (!existsSync(entry.file)) {
      void a.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(missingPage(entry.file))}`);
    } else void a.loadURL(appUrl(entry.file));
    refreshMenu();
  }

  // ── IPC ──────────────────────────────────────────────────────

  const fromOurWindow = (e: IpcMainInvokeEvent | IpcMainEvent): void => {
    if (!win || e.sender !== win.webContents) throw new Error('unknown sender');
  };

  function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
    ipcMain.handle(channel, async (e, ...args) => {
      fromOurWindow(e);
      return fn(...(args as A));
    });
  }

  function checkRef(value: unknown): PdfRef & { path: string | null } {
    if (!value || typeof value !== 'object') throw new Error('invalid pdf');
    const v = value as Record<string, unknown>;
    let path: string | null = null;
    if (v.path !== null && v.path !== undefined) {
      path = resolve(checkPath(v.path, 'pdf path'));
      if (!grants.allows(path)) throw new Error('pdf path was not opened by the user');
    }
    const bytes = v.bytes instanceof Uint8Array ? v.bytes : undefined;
    return { path, name: typeof v.name === 'string' ? v.name : '', bytes };
  }

  function checkSha(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isSha256(value)) throw new Error('invalid sha256');
    return value;
  }

  const checkTarget = (ref: unknown, sha256: unknown): NotesTarget => notesTargetFor(checkRef(ref), checkSha(sha256), hashes);

  handle(IPC.openPdf, async (path?: unknown): Promise<PdfFile | null> => {
    let p: string | null;
    if (path === undefined || path === null) p = await showOpenDialog();
    else {
      p = resolve(checkPath(path));
      if (!grants.allows(p)) throw new Error('Inkslide only opens files chosen by the user');
    }
    return p ? readPdf(p) : null;
  });

  /** Start screen: a recent file, or null (and dropped from the list) if it is gone or no longer listed. */
  handle(IPC.openRecent, async (path: unknown): Promise<PdfFile | null> => {
    const p = resolve(checkPath(path));
    const st = recent.has(p) ? await stat(p).catch(() => null) : null;
    if (!st?.isFile()) {
      if (recent.has(p)) recent.remove(p);
      recentChanged();
      return null;
    }
    return readPdf(p);
  });

  /** Read a granted PDF and make it the current and most recent file. */
  async function readPdf(p: string): Promise<PdfFile> {
    const { bytes: buf, ...st } = await readFileLimited(p, MAX_PDF_BYTES);
    hashes.grantBytes(buf); // the page's notes calls name this hash
    grants.grant(p); // also a recent file: its notes stay writable after Clear Recent
    void removeLegacyBackup(p);
    current = p;
    recent.add(p, { size: st.size, mtimeMs: st.mtimeMs });
    app.addRecentDocument(p);
    recentChanged();
    return { path: p, name: basename(p), bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  }

  handle(IPC.readNotes, (ref: unknown, sha256?: unknown) =>
    readNotesFor(checkTarget(ref, sha256), userData));

  handle(IPC.keepUnreadableNotes, (ref: unknown, sha256?: unknown): Promise<string | null> =>
    tracked(keepUnreadableFor(checkTarget(ref, sha256), userData)));

  handle(IPC.opened, (ref: unknown, sha256: unknown, pages?: unknown): void => {
    notesTarget = checkTarget(ref, sha256);
    if (notesTarget.path) recent.describe(notesTarget.path, { sha256: notesTarget.sha256, pages: typeof pages === 'number' ? pages : undefined });
    void updateRevert();
  });

  /** Run a notes or backup write; quitting waits for it. */
  async function tracked<T>(p: Promise<T>): Promise<T> {
    writes.add(p);
    try {
      return await p;
    } finally {
      writes.delete(p);
    }
  }

  // With backups on, the save first copies the saved notes to the backup (notes.ts).
  handle(IPC.writeNotes, async (ref: unknown, text: unknown, sha256?: unknown): Promise<void> => {
    await tracked(writeNotesFor(checkTarget(ref, sha256), checkText(text), userData, prefs.backups));
    crashes.saved();
    void updateRevert();
  });

  handle(IPC.readBackup, (ref: unknown, sha256?: unknown) =>
    (prefs.backups ? readBackupFor(checkTarget(ref, sha256), userData) : null));

  handle(IPC.revertToBackup, async (ref: unknown, sha256?: unknown): Promise<string> => {
    const t = checkTarget(ref, sha256);
    if (!prefs.backups) throw new Error('backups are turned off');
    const text = await tracked(revertToBackupFor(t, userData));
    void updateRevert();
    return text;
  });

  handle(IPC.exportPdf, async (value: unknown, suggestedName: unknown): Promise<boolean> => {
    const bytes = checkPdfBytes(value, 'export');
    let name = basename(typeof suggestedName === 'string' && suggestedName ? suggestedName : 'annotated.pdf');
    if (extname(name).toLowerCase() !== '.pdf') name += '.pdf';
    const r = await saveDialog({
      title: 'Export Annotated PDF',
      defaultPath: join(dialogDir(), name),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return false;
    await writeExport(r.filePath, bytes, current);
    return true;
  });

  // One print at a time per window (PrintGate), of at most MAX_PDF_BYTES.
  const prints = new PrintGate();
  handle(IPC.print, (value: unknown, name: unknown): Promise<boolean> => {
    const bytes = checkPdfBytes(value, 'print');
    const parent = win!; // the sender, checked by handle()
    return prints.run(parent, () => printPdf(bytes, typeof name === 'string' ? name : '', {
      parent,
      toPdf: smokeMode ? testVars.printToPdf : undefined,
    }));
  });

  handle(IPC.importNotes, async (): Promise<{ name: string; text: string } | null> => {
    const r = await openDialog({
      title: 'Import Notes',
      defaultPath: dialogDir(),
      filters: [{ name: 'Notes', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    const p = !r.canceled && r.filePaths[0];
    if (!p) return null;
    return { name: basename(p), text: (await readFileLimited(p, MAX_TEXT_BYTES)).bytes.toString('utf8') };
  });

  handle(IPC.confirm, async (message: unknown): Promise<boolean> => {
    const r = await messageBox({
      type: 'question', buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1,
      title: 'Inkslide', message: String(message ?? '').slice(0, 4000),
    });
    return r.response === 0;
  });

  handle(IPC.initialPath, (): string | null => opens.takeInitial());

  handle(IPC.recentFiles, () => recentInfo(recent.records(), userData));

  handle(IPC.removeRecent, (path: unknown): void => {
    recent.remove(checkPath(path));
    recentChanged();
  });

  // Synchronous: preload's pathForFile grants a dropped PDF before openPdf.
  ipcMain.on(IPC.grantPath, (e, path: unknown) => {
    try {
      fromOurWindow(e);
      grants.grant(checkDroppedPdf(path));
      e.returnValue = true;
    } catch (_) {
      e.returnValue = false;
    }
  });

  // Presenter mode: checked, rebuilt with only the known fields, and passed to the audience window.
  ipcMain.on(IPC.presenterSend, (e, message: unknown) => {
    try {
      fromOurWindow(e);
      const m = parsePresenterMessage(message);
      if (audience && audienceLoaded) audience.webContents.send(IPC.audience, m);
    } catch (err) {
      console.warn(`presenter message dropped: ${(err as Error).message}`);
      // A PDF that cannot be relayed: the audience says so instead of waiting.
      const open = !!message && typeof message === 'object' && (message as { type?: unknown }).type === 'open';
      if (open && audience && audienceLoaded && e.sender === win?.webContents) {
        audience.webContents.send(IPC.audience, { type: 'close', reason: 'failed' });
      }
    }
  });

  ipcMain.on(IPC.closeReply, (e, ok: unknown) => {
    try {
      fromOurWindow(e);
    } catch (_) {
      return;
    }
    if (!win || !closeAsked) return;
    closeAsked = false;
    if (ok === true) {
      closeOk = true;
      win.close();
    } else {
      quitting = false; // the user kept the window open
    }
  });

  // ── App events ───────────────────────────────────────────────

  app.on('second-instance', (_e, argv, workingDirectory) => {
    const p = pdfFromArgv(argv, workingDirectory);
    if (p && 'path' in p) requestOpen(p.path);
    else {
      if (win) focusWindow(win);
      if (p) refuseRemote(p.remote);
    }
  });

  // macOS: Finder / Dock opens (may come before 'ready').
  app.on('open-file', (e, path) => {
    e.preventDefault();
    requestOpen(path);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || smokeMode || quitting) app.quit();
  });
  // A notes write that is still running finishes before the process ends.
  app.on('will-quit', e => {
    if (!writes.size) return;
    e.preventDefault();
    void Promise.allSettled([...writes]).then(() => app.quit());
  });
  app.on('activate', () => { if (!win) createWindow(); });

  void app.whenReady().then(() => {
    // Old backups and unreadable copies go, in the background.
    void cleanupNotesStore(userData).catch(err => console.warn(`notes cleanup failed: ${(err as Error).message}`));
    restrictPermissions(session.defaultSession);
    // app://inkslide/<path>: files of webRoot only (webFileFor refuses anything outside it).
    protocol.handle(APP_SCHEME, async req => {
      const file = webRoot ? webFileFor(webRoot, req.url) : null;
      if (!file) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href).catch(() => new Response('Not found', { status: 404 }));
    });
    refreshMenu();
    createWindow();
  });
}

/** Smoke test: the fixture page's window.inkslideSmoke() drives the bridge. */
async function runSmoke(w: BrowserWindow, after?: () => Promise<void>): Promise<void> {
  const timeout = setTimeout(() => {
    console.log('SMOKE FAIL timeout');
    app.exit(1);
  }, 30_000);
  console.log('SMOKE READY');
  try {
    const result: unknown = await w.webContents.executeJavaScript('window.inkslideSmoke()', true);
    if (after) await after();
    console.log(`SMOKE OK ${JSON.stringify(result)}`);
    if (smokeMode === 'close') {
      w.close(); // the page saves first; the app quits when the window is gone
      return;
    }
    clearTimeout(timeout);
    app.exit(0);
  } catch (err) {
    console.log(`SMOKE FAIL ${err instanceof Error ? err.message : String(err)}`);
    clearTimeout(timeout);
    app.exit(1);
  }
}

function missingPage(file: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>Inkslide</title>
<body style="font:16px system-ui;background:#1e1e1e;color:#ddd;padding:2em">
<h1>Front end not built</h1><p>Missing <code>${esc(file)}</code>.</p>
<p>Build it with <code>pnpm --filter @inkslide/web build</code>, or run with
<code>INKSLIDE_DEV_URL=http://localhost:5173</code>.</p></body>`;
}
