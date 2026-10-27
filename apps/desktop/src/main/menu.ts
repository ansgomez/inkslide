/* Inkslide desktop - the native menu (Open, Open Recent, Export, Print, notes backup, Quit, Presenter Mode) */
import { Menu, type MenuItemConstructorOptions } from 'electron';
import { basename } from 'node:path';
import type { MenuCommand } from '../shared/bridge';

/** What the menu items do; supplied by main.ts. */
export interface MenuActions {
  open(): void;
  openRecent(path: string): void;
  clearRecent(): void;
  command(command: MenuCommand): void;
  toggleMenuBar(): void;
  toggleBackups(): void;
  recent(): string[];
  menuHidden(): boolean;
  backups(): boolean;
  /** Backups are on and the open PDF has one. */
  canRevert(): boolean;
  /** View → Presenter Mode: open or close the audience window. */
  togglePresenter(): void;
  /** The audience window is open. */
  presenting(): boolean;
}

/** Where the menu runs. */
export interface MenuOptions {
  isMac: boolean;
  /** Development build: View has Reload. */
  dev: boolean;
}

/**
 * The application menu: File (Open, Open Recent, Import Notes, Export, Print, Revert to Backup, Keep a Backup, Quit) and View
 * (with Presenter Mode).
 * Rebuild it when the recent files change.
 */
export const buildMenu = (a: MenuActions, dev: boolean): Menu =>
  Menu.buildFromTemplate(menuTemplate(a, { isMac: process.platform === 'darwin', dev }));

/**
 * The menu's template. Reload only in development: it skips the save before
 * closing, so the newest edits can be lost while a notes write is running.
 */
export function menuTemplate(a: MenuActions, { isMac, dev }: MenuOptions): MenuItemConstructorOptions[] {
  const recent = a.recent();
  const recentItems: MenuItemConstructorOptions[] = recent.length
    ? [
      ...recent.map((p, i): MenuItemConstructorOptions => ({
        label: `${i < 9 ? `&${i + 1} ` : ''}${basename(p).replace(/&/g, '&&')}`,
        toolTip: p,
        click: () => a.openRecent(p),
      })),
      { type: 'separator' },
      { label: 'Clear Recent', click: () => a.clearRecent() },
    ]
    : [{ label: 'No Recent Files', enabled: false }];

  return [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '&File',
      submenu: [
        { label: '&Open…', accelerator: 'CmdOrCtrl+O', click: () => a.open() },
        { label: 'Open &Recent', submenu: recentItems },
        { type: 'separator' },
        { label: '&Import Notes…', click: () => a.command('import-notes') },
        { label: '&Export Annotated PDF…', accelerator: 'CmdOrCtrl+E', click: () => a.command('export') },
        { label: '&Print…', accelerator: 'CmdOrCtrl+P', click: () => a.command('print') },
        { type: 'separator' },
        { label: 'Re&vert to Backup…', enabled: a.canRevert(), click: () => a.command('revert-backup') },
        {
          label: 'Keep a &Backup of the Notes', type: 'checkbox', checked: a.backups(),
          toolTip: 'Before a save, copy the saved notes to a backup in the app storage (at most every 2 minutes)',
          click: () => a.toggleBackups(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    {
      label: '&View',
      submenu: [
        ...(isMac ? [] : [{
          label: 'Hide Menu Bar (Alt Shows It)', type: 'checkbox' as const,
          checked: a.menuHidden(), click: () => a.toggleMenuBar(),
        }]),
        { role: 'togglefullscreen' },
        {
          // F5 starts a presentation in most slide apps, and presenter remotes send it.
          label: '&Presenter Mode', type: 'checkbox', checked: a.presenting(), accelerator: 'F5',
          toolTip: 'Mirror the page, the ink and the laser in a second window, full screen on the other display',
          click: () => a.togglePresenter(),
        },
        { type: 'separator' },
        ...(dev ? [{ role: 'reload' as const }] : []),
        { role: 'toggleDevTools' },
      ],
    },
  ];
}
