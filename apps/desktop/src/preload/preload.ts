/* Inkslide desktop - preload (sandboxed): exposes window.inkslide
 *
 * Sandboxed preloads can only require 'electron'; esbuild bundles the shared
 * channel names in. Bytes cross IPC as Uint8Array (structured clone).
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC, type InkslideBridge, type MenuCommand, type PdfFile, type PdfRef } from '../shared/bridge';

/** Main only needs the bytes to hash them when there is neither a path nor a sha256. */
const refOf = (pdf: PdfFile, sha256?: string): PdfRef => {
  if (!pdf || typeof pdf !== 'object') throw new TypeError('pdf must be a PdfFile');
  const ref: PdfRef = { path: pdf.path ?? null, name: String(pdf.name ?? '') };
  if (!ref.path && sha256 === undefined) ref.bytes = pdf.bytes;
  return ref;
};

/** Open requests that came before the front end subscribed are kept and replayed. */
const openHandlers = new Set<(path: string) => void>();
const pendingOpens: string[] = [];
ipcRenderer.on(IPC.openRequest, (_e: IpcRendererEvent, path: unknown) => {
  if (typeof path !== 'string') return;
  if (openHandlers.size) openHandlers.forEach(h => h(path));
  else pendingOpens.push(path);
});

const menuHandlers = new Set<(command: MenuCommand) => void>();
ipcRenderer.on(IPC.menuCommand, (_e: IpcRendererEvent, command: MenuCommand) => {
  menuHandlers.forEach(h => h(command));
});

/** Before the window closes, the front end writes its notes; ok = false keeps it open. */
let closeHandler: (() => Promise<boolean>) | null = null;
ipcRenderer.on(IPC.closeRequest, () => {
  const h = closeHandler;
  // A failing handler must not make the window impossible to close.
  void Promise.resolve().then(() => (h ? h() : true)).then(ok => ok !== false, () => true)
    .then(ok => ipcRenderer.send(IPC.closeReply, ok));
});

/** Presenter mode: the audience window's state (replayed to a late subscriber) and the messages for it. */
const presenterHandlers = new Set<(on: boolean) => void>();
let presenterOn = false;
ipcRenderer.on(IPC.presenterState, (_e: IpcRendererEvent, on: unknown) => {
  presenterOn = on === true;
  presenterHandlers.forEach(h => h(presenterOn));
});
const audienceHandlers = new Set<(message: unknown) => void>();
const pendingAudience: unknown[] = [];
ipcRenderer.on(IPC.audience, (_e: IpcRendererEvent, message: unknown) => {
  if (audienceHandlers.size) audienceHandlers.forEach(h => h(message));
  else if (pendingAudience.length < 1000) pendingAudience.push(message);
});

const bridge: InkslideBridge = {
  platform: 'electron',
  openPdf: path => ipcRenderer.invoke(IPC.openPdf, path),
  readNotes: (pdf, sha256) => ipcRenderer.invoke(IPC.readNotes, refOf(pdf, sha256), sha256),
  writeNotes: (pdf, text, sha256) => ipcRenderer.invoke(IPC.writeNotes, refOf(pdf, sha256), text, sha256),
  readBackup: (pdf, sha256) => ipcRenderer.invoke(IPC.readBackup, refOf(pdf, sha256), sha256),
  opened: (pdf, info) => ipcRenderer.invoke(IPC.opened, refOf(pdf, info?.sha256), info?.sha256),
  keepUnreadableNotes: (pdf, sha256) => ipcRenderer.invoke(IPC.keepUnreadableNotes, refOf(pdf, sha256), sha256),
  revertToBackup: (pdf, sha256) => ipcRenderer.invoke(IPC.revertToBackup, refOf(pdf, sha256), sha256),
  exportPdf: (bytes, suggestedName) => ipcRenderer.invoke(IPC.exportPdf, bytes, suggestedName),
  print: (bytes, name) => ipcRenderer.invoke(IPC.print, bytes, name),
  importNotes: () => ipcRenderer.invoke(IPC.importNotes),
  confirm: message => ipcRenderer.invoke(IPC.confirm, message),
  initialPath: () => ipcRenderer.invoke(IPC.initialPath),
  onOpenRequest(handler) {
    openHandlers.add(handler);
    pendingOpens.splice(0).forEach(p => handler(p));
    return () => { openHandlers.delete(handler); };
  },
  onMenuCommand(handler) {
    menuHandlers.add(handler);
    return () => { menuHandlers.delete(handler); };
  },
  onCloseRequest(handler) {
    closeHandler = handler;
    return () => { if (closeHandler === handler) closeHandler = null; };
  },
  onPresenter(handler) {
    presenterHandlers.add(handler);
    if (presenterOn) handler(true);
    return () => { presenterHandlers.delete(handler); };
  },
  presenterSend: message => ipcRenderer.send(IPC.presenterSend, message),
  onAudience(handler) {
    audienceHandlers.add(handler);
    pendingAudience.splice(0).forEach(m => handler(m));
    return () => { audienceHandlers.delete(handler); };
  },
  pathForFile(file) {
    const path = webUtils.getPathForFile(file);
    // Synchronous so the grant is in place before a following openPdf(path).
    // Not granted (not a .pdf): no path, the front end opens the bytes.
    return path && ipcRenderer.sendSync(IPC.grantPath, path) === true ? path : '';
  },
};

contextBridge.exposeInMainWorld('inkslide', bridge);
