/* Inkslide desktop - the bridge between the Electron shell and the front end
 *
 * The preload script exposes `window.inkslide` (contextBridge). It implements
 * PlatformAdapter from @inkslide/annotate plus a few desktop extras. The front
 * end uses it when `window.inkslide` exists and otherwise falls back to its
 * web adapter (apps/web/src/platform).
 *
 * Type-only module for the front end (`import type { InkslideBridge } from
 * '@inkslide/desktop/bridge'`); the IPC channel names are used by main and
 * preload only.
 */
import type { PdfFile, PlatformAdapter } from '@inkslide/annotate/io';
import type { PresenterMessage } from '@inkslide/annotate/presenter';

/** Commands from the native menu that the front end carries out. */
export type MenuCommand = 'export' | 'import-notes' | 'print' | 'revert-backup';

/** `window.inkslide`: the PlatformAdapter of the desktop app plus its extras. */
export interface InkslideBridge extends Required<PlatformAdapter> {
  readonly platform: 'electron';
  /** The front end opened `pdf` (its notes are loaded): main tracks it for File → Revert to Backup…. */
  opened(pdf: PdfFile, info: { sha256: string; pages: number }): Promise<void>;
  /** PDF given on the command line (or by the OS before the window loaded); null if none. Returned once. */
  initialPath(): Promise<string | null>;
  /**
   * Real file system path of a dropped File (webUtils.getPathForFile); '' if
   * it has none or is not a .pdf. Also allows `openPdf(path)` for that path.
   */
  pathForFile(file: File): string;
  /** Menu commands (Export, Import notes, Print, Revert to Backup) that need the front end. Returns unsubscribe. */
  onMenuCommand(handler: (command: MenuCommand) => void): () => void;
  /**
   * The window is about to close (or the app to quit): write unsaved notes
   * first. Resolve false to keep the window open. Without a handler the
   * window closes at once. Returns unsubscribe.
   */
  onCloseRequest(handler: () => Promise<boolean>): () => void;
  /**
   * Presenter mode, app window: the audience window has loaded (true; send it
   * everything) or closed (false). A late subscriber gets the current state. Returns unsubscribe.
   */
  onPresenter(handler: (on: boolean) => void): () => void;
  /** Presenter mode, app window: a message for the audience window (dropped while there is none). */
  presenterSend(message: PresenterMessage): void;
  /** Presenter mode, audience window: the presenter's messages, as main relays them. Returns unsubscribe. */
  onAudience(handler: (message: unknown) => void): () => void;
}

declare global {
  interface Window {
    inkslide?: InkslideBridge;
  }
}

export type { PdfFile, PlatformAdapter, PresenterMessage };

/** IPC channels (main <-> preload). */
export const IPC = {
  openPdf: 'inkslide:open-pdf',
  readNotes: 'inkslide:read-notes',
  writeNotes: 'inkslide:write-notes',
  readBackup: 'inkslide:read-backup',
  revertToBackup: 'inkslide:revert-to-backup',
  opened: 'inkslide:opened',
  keepUnreadableNotes: 'inkslide:keep-unreadable-notes',
  exportPdf: 'inkslide:export-pdf',
  print: 'inkslide:print',
  importNotes: 'inkslide:import-notes',
  confirm: 'inkslide:confirm',
  initialPath: 'inkslide:initial-path',
  grantPath: 'inkslide:grant-path',
  /** main -> renderer: a file to open (second instance, open-file, recent). */
  openRequest: 'inkslide:open-request',
  /** main -> renderer: a menu command. */
  menuCommand: 'inkslide:menu-command',
  /** main -> renderer: the window wants to close; renderer -> main: closeReply(ok). */
  closeRequest: 'inkslide:close-request',
  closeReply: 'inkslide:close-reply',
  /** main -> app window: the audience window loaded (true) or closed (false). */
  presenterState: 'inkslide:presenter-state',
  /** app window -> main: a presenter message, relayed to the audience window. */
  presenterSend: 'inkslide:presenter-send',
  /** main -> audience window: a presenter message. */
  audience: 'inkslide:audience',
} as const;

/** What preload sends for a PdfFile: no bytes unless main needs them for the hash. */
export interface PdfRef {
  path: string | null;
  name: string;
  bytes?: Uint8Array;
}
