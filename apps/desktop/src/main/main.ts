/* Inkslide desktop - Electron main process
 *
 * One window with the shared front end (apps/web), file access over IPC for
 * the preload bridge (window.inkslide), single instance, recent files, window
 * state, preferences and a small native menu. No rendering happens here.
 *
 * Environment:
 *   INKSLIDE_DEV_URL    load this URL (Vite dev server) instead of apps/web/dist
 *   INKSLIDE_DESKTOP_NAME  development only: desktop file id, and so the window's app id
 *                       (the dev desktop entry sets inkslide-dev.desktop)
 * Tests only (packaged builds ignore them unless built with INKSLIDE_TEST_BUILD=1; paths.ts testEnv):
 *   INKSLIDE_PAGE       load this HTML file instead (tests)
 *   INKSLIDE_USER_DATA  use this userData directory (tests)
 *   INKSLIDE_SMOKE      smoke test mode: run window.inkslideSmoke(), print, quit
 *                       (mode "close": close the window instead, the page saves on close;
 *                       mode "backupsoff": then switch backups off as the menu does)
 *   INKSLIDE_PRINT_TO_PDF  smoke test mode only: Print writes this PDF file instead of
 *                       showing the print dialog
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { IPC, type MenuCommand, type PdfFile, type PdfRef } from '../shared/bridge';
import { checkDroppedPdf, checkPath, PathGrants } from './access';
import { CrashRecovery } from './crashRecovery';
import { sameFile, writeFileAtomic } from './fsutil';
import { lockNavigation, restrictPermissions, SAFE_WEB_PREFERENCES } from './harden';
import { buildMenu } from './menu';
import {
  cleanupNotesStore, hasBackup, keepUnreadableFor, readBackupFor, readNotesFor, removeAllBackups, removeLegacyBackup, revertToBackupFor,
  writeNotesFor, type NotesTarget,
} from './notes';
import { OpenRequests } from './openRequests';
import { isSha256, pdfFromArgv, resolveWebEntry, testEnv } from './paths';
import { loadPreferences, savePreferences } from './preferences';
import { printPdf } from './print';
import { RecentFiles } from './recent';
import { fitToDisplays, loadWindowState, MIN_SIZE, saveWindowState, type WindowState } from './windowState';

/** true in a test build (scripts/build.mjs, INKSLIDE_TEST_BUILD=1): packaged, it still takes the test variables. */
declare const INKSLIDE_TEST_BUILD: boolean;

const MAX_PDF_BYTES = 2 ** 31 - 1;
const MAX_TEXT_BYTES = 256 * 2 ** 20;

// Native Wayland when available (pen pressure, tilt and eraser need it).
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
const testVars = testEnv(process.env, !app.isPackaged || INKSLIDE_TEST_BUILD);
if (testVars.userData) app.setPath('userData', resolve(testVars.userData));
// The dev build gets its own app id, so GNOME does not group it with an installed
// Inkslide. app.setDesktopName is what Electron itself calls with package.json's
// desktopName; it is not in the typings.
if (!app.isPackaged && process.env.INKSLIDE_DESKTOP_NAME) {
  (app as typeof app & { setDesktopName?(name: string): void }).setDesktopName?.(process.env.INKSLIDE_DESKTOP_NAME);
}

const smokeMode = testVars.smoke;
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
  const recent = new RecentFiles(join(userData, 'recent-files.json'));
  const prefsFile = join(userData, 'preferences.json');
  const prefs = loadPreferences(prefsFile);
  /** The PDF the front end has open (opened()), and whether it has a backup (File → Revert to Backup…). */
  let notesTarget: NotesTarget | null = null;
  let canRevert = false;
  const grants = new PathGrants(p => recent.has(p));

  let win: BrowserWindow | null = null;
  let state: WindowState = loadWindowState(stateFile);
  let loaded = false;
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

  function refreshMenu(): void {
    Menu.setApplicationMenu(buildMenu({
      open: () => { void showOpenDialog().then(p => p && requestOpen(p)); },
      openRecent: p => {
        if (existsSync(p)) requestOpen(p);
        else {
          recent.remove(p);
          refreshMenu();
          void dialog.showMessageBox({ type: 'warning', message: `${basename(p)} no longer exists.`, detail: p });
        }
      },
      clearRecent: () => {
        recent.clear();
        app.clearRecentDocuments();
        refreshMenu();
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
      win = null;
      loaded = false;
      opens.newPage();
    });

    // The page never navigates or opens windows; links go to the browser.
    lockNavigation(wc, url => void shell.openExternal(url));

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
    // PDF; requests that come meanwhile are queued); if it dies again soon,
    // ask. While closing, the window just closes: there is nothing left to save.
    const crashes = new CrashRecovery();
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
        wc.reload();
      }
    }
    wc.on('did-finish-load', () => {
      loaded = true;
      opens.takeQueued().forEach(p => wc.send(IPC.openRequest, p));
      if (remoteAtStart) refuseRemote(remoteAtStart);
      remoteAtStart = null;
      // Smoke mode "backupsoff": then switch backups off as the menu does.
      if (smokeMode) void runSmoke(w, smokeMode === 'backupsoff' ? toggleBackups : undefined);
    });

    const entry = resolveWebEntry({
      devUrl: process.env.INKSLIDE_DEV_URL,
      pageOverride: testVars.page,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
    if (entry.kind === 'url') void w.loadURL(entry.url);
    else if (!existsSync(entry.file)) {
      void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(missingPage(entry.file))}`);
    } else void w.loadFile(entry.file, smokeMode ? { hash: `smoke=${encodeURIComponent(smokeMode)}` } : {});
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

  const checkTarget = (ref: unknown, sha256: unknown): NotesTarget => ({ ...checkRef(ref), sha256: checkSha(sha256) });

  function checkText(value: unknown): string {
    if (typeof value !== 'string') throw new Error('notes must be a string');
    if (value.length > MAX_TEXT_BYTES) throw new Error('notes too large');
    return value;
  }

  handle(IPC.openPdf, async (path?: unknown): Promise<PdfFile | null> => {
    let p: string | null;
    if (path === undefined || path === null) p = await showOpenDialog();
    else {
      p = resolve(checkPath(path));
      if (!grants.allows(p)) throw new Error('Inkslide only opens files chosen by the user');
    }
    if (!p) return null;
    const st = await stat(p);
    if (!st.isFile()) throw new Error(`${basename(p)} is not a file`);
    if (st.size > MAX_PDF_BYTES) throw new Error(`${basename(p)} is too large`);
    const buf = await readFile(p);
    grants.grant(p); // also a recent file: its notes stay writable after Clear Recent
    void removeLegacyBackup(p);
    current = p;
    recent.add(p);
    app.addRecentDocument(p);
    refreshMenu();
    return { path: p, name: basename(p), bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  });

  handle(IPC.readNotes, (ref: unknown, sha256?: unknown) =>
    readNotesFor(checkTarget(ref, sha256), userData));

  handle(IPC.keepUnreadableNotes, (ref: unknown, sha256?: unknown): Promise<string | null> =>
    tracked(keepUnreadableFor(checkTarget(ref, sha256), userData)));

  handle(IPC.opened, (ref: unknown, sha256: unknown): void => {
    notesTarget = checkTarget(ref, sha256);
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

  handle(IPC.exportPdf, async (bytes: unknown, suggestedName: unknown): Promise<boolean> => {
    if (!(bytes instanceof Uint8Array)) throw new Error('export bytes must be a Uint8Array');
    let name = basename(typeof suggestedName === 'string' && suggestedName ? suggestedName : 'annotated.pdf');
    if (extname(name).toLowerCase() !== '.pdf') name += '.pdf';
    const r = await saveDialog({
      title: 'Export Annotated PDF',
      defaultPath: join(dialogDir(), name),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return false;
    if (current && await sameFile(r.filePath, current)) {
      throw new Error('The export cannot replace the PDF that is open; choose another name.');
    }
    await writeFileAtomic(r.filePath, bytes);
    return true;
  });

  handle(IPC.print, (bytes: unknown, name: unknown): Promise<boolean> => {
    if (!(bytes instanceof Uint8Array)) throw new Error('print bytes must be a Uint8Array');
    return printPdf(bytes, typeof name === 'string' ? name : '', {
      parent: win,
      toPdf: smokeMode ? testVars.printToPdf : undefined,
    });
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
    if ((await stat(p)).size > MAX_TEXT_BYTES) throw new Error(`${basename(p)} is too large`);
    return { name: basename(p), text: await readFile(p, 'utf8') };
  });

  handle(IPC.confirm, async (message: unknown): Promise<boolean> => {
    const r = await messageBox({
      type: 'question', buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1,
      title: 'Inkslide', message: String(message ?? '').slice(0, 4000),
    });
    return r.response === 0;
  });

  handle(IPC.initialPath, (): string | null => opens.takeInitial());

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
