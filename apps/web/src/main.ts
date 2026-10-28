/* Inkslide web - entry point: page shell, platform adapter, open requests */
import '@inkslide/annotate/toolbar.css';
import './style.css';
import { banner } from './banner';
import { getAdapter, isWebAdapter } from './platform';
import { createPresenter } from './presenter';
import { setupPwa } from './pwa';
import { desktopRecentSource, mountRecentList } from './recent-list';
import { createViewer } from './viewer';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const adapter = getAdapter();
// Presenter mode (desktop): the audience window mirrors this one (presenter.ts, audience.ts).
const bridge = window.inkslide;
const presenter = bridge && typeof bridge.onPresenter === 'function' ? createPresenter(m => bridge.presenterSend(m)) : null;
if (presenter) bridge!.onPresenter(on => presenter.setActive(on));
const viewer = createViewer({
  stage: $('.ink-stage'),
  page: $('.ink-page'),
  pdfCanvas: $('canvas.ink-pdf'),
  liveCanvas: $('canvas.ink-live'),
  empty: $('.ink-empty'),
}, adapter, presenter);

document.body.dataset.platform = adapter.platform;
$('.ink-open').addEventListener('click', () => void viewer.openFrom());

// Drag and drop: a PDF opens, a .json imports notes into the open PDF.
const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  document.body.classList.add('ink-dropping');
});
window.addEventListener('dragleave', e => {
  if (!e.relatedTarget) document.body.classList.remove('ink-dropping');
});
window.addEventListener('drop', e => {
  document.body.classList.remove('ink-dropping');
  if (!hasFiles(e)) return;
  e.preventDefault();
  const files = [...e.dataTransfer!.files];
  const pdf = files.find(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const json = files.find(f => /\.json$/i.test(f.name));
  if (pdf) void viewer.openFile(pdf);
  else if (json && viewer.session) void json.text().then(text => viewer.importNotes({ name: json.name, text }));
  else banner('Drop a PDF to open it, or a notes .json file to import it.', 'warn');
});

// Browser build: service worker, recent files, launchQueue (pwa.ts).
const web = isWebAdapter(adapter) ? adapter : null;
if (web) setupPwa(viewer, web, $('.ink-empty'));

// Files the OS asks the app to open while it runs.
if (adapter.onOpenRequest) adapter.onOpenRequest(path => void viewer.openFrom(path));

// Native menu commands (Electron) that need the front end.
if (window.inkslide) {
  window.inkslide.onMenuCommand(command => {
    if (command === 'export') void viewer.exportPdf();
    else if (command === 'import-notes') void viewer.importNotes();
    else if (command === 'print') void viewer.print();
    else if (command === 'revert-backup') void viewer.revertToBackup();
  });
}

// Startup: the file from the command line (Electron), or ?pdf=<url> (web).
void (async () => {
  try {
    const initial = adapter.initialPath ? await adapter.initialPath() : null;
    const url = new URLSearchParams(location.search).get('pdf');
    if (initial) await viewer.openFrom(initial);
    else if (url && adapter.platform === 'web') await viewer.openFrom(url);
  } catch (e) {
    banner(`Could not open the file: ${(e as Error).message || e}`, 'error');
  }
  // Desktop: the recent files on the start screen, only if it is still shown
  // (reading their notes is wasted work when a PDF was opened at start).
  if (window.inkslide && !viewer.session) {
    void mountRecentList($('.ink-empty'), { source: desktopRecentSource(window.inkslide), open: file => viewer.open(file) });
  }
})();

// Leaving the page: write unsaved notes now. The write is asynchronous and the
// page may be gone before it ends, so the browser build first keeps the unsaved
// notes in localStorage at once (a checkpoint, read on the next open if it is the
// newer copy). If that fails (notes too large, storage full), the browser asks
// before it closes or reloads the page.
const flush = (): void => {
  if (!viewer.session) return;
  if (web) viewer.checkpoint();
  void viewer.save();
};
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
if (web) {
  window.addEventListener('beforeunload', e => {
    if (viewer.checkpoint()) return;
    e.preventDefault();
    e.returnValue = ''; // older browsers ask only with this
  });
}

// Electron: the window closes (or the app quits) only after the notes are
// written; if that fails, the user decides. pagehide cannot wait for a write.
if (window.inkslide) {
  window.inkslide.onCloseRequest(() => viewer.saveOrAsk('The notes could not be saved. Close anyway and lose the unsaved notes?'));
}

// For tests and debugging in the console.
(window as unknown as { inkslideViewer: typeof viewer }).inkslideViewer = viewer;
