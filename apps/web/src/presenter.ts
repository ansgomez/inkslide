/* Inkslide web - presenter mode, the presenter's side
 *
 * While the audience window is open (desktop: View → Presenter Mode), the
 * viewer reports what it shows and this module turns it into presenter
 * messages (@inkslide/annotate/presenter) for that window:
 *
 * - the audience opening (or loading again) gets everything: the PDF, the
 *   notes, the page shown;
 * - a finished edit sends the strokes of its page, collected until the end
 *   of the task (one message per page, however many changes);
 * - page changes and blank pages (insert, delete, paper) go at once;
 * - the stroke being written and the laser go at most every LIVE_MS, the
 *   stroke only with the points that changed since the last message.
 *
 * Nothing is sent while the audience window is closed. Erasing and moving
 * strokes show on the audience when they are done, not while they happen.
 */
import type { NotesDoc, PdfFile, Point, Stroke, StrokeTool } from '@inkslide/annotate';
import { serializeStroke } from '@inkslide/annotate/model';
import { commonPrefix, type PresenterMessage } from '@inkslide/annotate/presenter';
import type { LiveStroke } from '@inkslide/annotate/render';

/** Shortest time between two messages of the stroke being written or the laser, ms. */
export const LIVE_MS = 30;

/** The viewer's side of presenter mode: what it reports (see createViewer). */
export interface ViewerMirror {
  /** A PDF was opened with `doc` as its notes (its first page is shown next). */
  opened(file: PdfFile, doc: NotesDoc): void;
  /** Page `pageId` is shown. */
  shown(pageId: string): void;
  /** A laser point on a page (ToolHost.sync). */
  laser(pageId: string, pt: Point): void;
  /** The stroke being written on a page: `inner` draws it here, the result also mirrors it. */
  liveStroke(pageId: string, tool: StrokeTool, inner: LiveStroke): LiveStroke;
}

/** Presenter mode of one window: the viewer's mirror plus the switch. */
export interface Presenter extends ViewerMirror {
  /** The audience window is open (and listening). */
  readonly active: boolean;
  /** The audience window opened or loaded (true: send everything) or closed (false). */
  setActive(on: boolean): void;
}

/** Timers, injectable for tests. */
export interface PresenterTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  queueMicrotask(fn: () => void): void;
}

const defaultTimers: PresenterTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
  queueMicrotask: fn => queueMicrotask(fn),
};

/** Presenter mode sending through `send` (desktop: the bridge's presenterSend). */
export function createPresenter(send: (message: PresenterMessage) => void, timers: PresenterTimers = defaultTimers): Presenter {
  let active = false;
  let file: PdfFile | null = null;
  let doc: NotesDoc | null = null;
  let page = '';
  /** Pages whose strokes changed, sent at the end of the task. */
  const dirty = new Set<string>();
  let flushQueued = false;
  /** The stroke being written: what the audience has, and what it should get. */
  let live: { page: string; tool: StrokeTool; stroke: Stroke | null; sent: readonly Point[]; ended: boolean } | null = null;
  let laser: { page: string; points: [number, number][] } | null = null;
  let timer: unknown = null;

  const post = (m: PresenterMessage): void => {
    try {
      send(m);
    } catch (e) {
      console.error('Presenter mode: a message could not be sent', e);
    }
  };

  /** Strokes of the pages that changed, then the end of a live stroke (so the audience never shows neither). */
  function flush(): void {
    flushQueued = false;
    if (active && doc) {
      for (const id of dirty) {
        if (doc.hasPage(id)) post({ type: 'strokes', page: id, strokes: doc.strokes(id).map(serializeStroke) });
      }
    }
    dirty.clear();
    if (live && live.ended) {
      live = null;
      if (active) post({ type: 'live-end' });
    }
  }

  function queueFlush(): void {
    if (flushQueued) return;
    flushQueued = true;
    timers.queueMicrotask(flush);
  }

  /** Send the live stroke's new points and the laser points collected; then wait LIVE_MS before the next. */
  function sendLive(): void {
    timer = null;
    if (!active) return;
    let sent = false;
    if (live && live.stroke && !live.ended) {
      const { stroke } = live;
      const from = commonPrefix(live.sent, stroke.points);
      if (from < stroke.points.length || from < live.sent.length) {
        post({
          type: 'live', page: live.page, tool: live.tool, color: stroke.color, size: stroke.size,
          from, points: stroke.points.slice(from).map(p => [p[0], p[1], p[2]]),
        });
        live.sent = stroke.points;
        sent = true;
      }
    }
    if (laser && laser.points.length) {
      post({ type: 'laser', page: laser.page, points: laser.points });
      laser = null;
      sent = true;
    }
    if (sent) timer = timers.setTimeout(sendLive, LIVE_MS); // the next update waits its turn
  }

  function scheduleLive(): void {
    if (active && timer === null) sendLive();
  }

  function sendAll(): void {
    if (!active) return;
    if (!file || !doc) {
      post({ type: 'close' });
      return;
    }
    post({ type: 'open', pdf: file.bytes, title: doc.deck.title || file.name });
    post({ type: 'notes', notes: JSON.stringify(doc.toJSON()) });
    if (page) post({ type: 'page', page });
  }

  function watch(d: NotesDoc): void {
    d.onChange((pageId, kind) => {
      if (d !== doc || !active || kind === 'saved') return;
      if (kind === 'pages') {
        post({ type: 'blanks', blanks: d.blankMeta() });
        // An undone delete brings its strokes back with it.
        d.blankOrder.forEach(id => dirty.add(id));
        queueFlush();
      } else if (pageId) {
        dirty.add(pageId);
        queueFlush();
      } else {
        dirty.clear(); // everything (load, import, revert)
        post({ type: 'notes', notes: JSON.stringify(d.toJSON()) });
      }
    });
  }

  return {
    get active() { return active; },

    setActive(on) {
      active = on;
      dirty.clear();
      laser = null;
      if (live) live.sent = [];
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      sendAll();
    },

    opened(f, d) {
      file = f;
      doc = d;
      page = '';
      live = null;
      dirty.clear();
      watch(d);
      sendAll();
    },

    shown(pageId) {
      if (pageId === page) return;
      page = pageId;
      if (active) post({ type: 'page', page: pageId });
    },

    laser(pageId, pt) {
      if (!active) return;
      if (laser && laser.page !== pageId) {
        post({ type: 'laser', page: laser.page, points: laser.points });
        laser = null;
      }
      laser ??= { page: pageId, points: [] };
      laser.points.push([pt[0], pt[1]]);
      scheduleLive();
    },

    liveStroke(pageId, tool, inner) {
      const mine = { page: pageId, tool, stroke: null as Stroke | null, sent: [] as readonly Point[], ended: false };
      live = mine;
      return {
        update(stroke) {
          inner.update(stroke);
          if (live !== mine) return;
          mine.stroke = stroke;
          scheduleLive();
        },
        remove() {
          inner.remove();
          if (live !== mine) return;
          mine.ended = true;
          // The finished stroke is added to the document right after this: its page goes first.
          queueFlush();
        },
      };
    },
  };
}
