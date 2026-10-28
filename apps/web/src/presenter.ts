/* Inkslide web - presenter mode, the presenter's side
 *
 * While the audience window is open (desktop: View → Presenter Mode; browser: F5), the
 * viewer reports what it shows and this module turns it into presenter
 * messages (@inkslide/annotate/presenter) for that window:
 *
 * - the audience opening (or loading again) gets everything: the PDF, the
 *   notes, the page shown;
 * - a finished edit sends its page's changes at the end of the task (one
 *   message per page, however many changes): all strokes the first time,
 *   then a delta of the new and changed strokes plus the order of the ids
 *   (strokes are immutable, so a changed stroke is a new object); a page
 *   whose images changed also sends them all, with the image data only for
 *   images the audience does not have yet;
 * - page changes and blank pages (insert, delete, paper) go at once;
 * - a PDF over PRESENTER_LIMITS.pdfBytes is not mirrored: the audience says so;
 * - the stroke being written and the laser go at most every LIVE_MS, the
 *   stroke only with the points that changed since the last message;
 * - so do erasing and moving while they happen (ToolSync.preview): an
 *   `erasing` message with the ids the page shows and only the cut pieces
 *   the audience does not have yet, or a `moving` message with the ids and
 *   the offset. When the gesture ends (or is cancelled), its page's changes
 *   go first and `preview-end` after them, in the same task.
 *
 * Nothing is sent while the audience window is closed.
 */
import type { NotesDoc, PageImage, PdfFile, Point, Stroke, StrokeTool, ToolPreview } from '@inkslide/annotate';
import { serializeStroke } from '@inkslide/annotate/model';
import { commonPrefix, PRESENTER_LIMITS, type PresenterMessage } from '@inkslide/annotate/presenter';
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
  /** An erase or move as it happens on a page; null: it ended (ToolSync.preview). */
  preview(pageId: string, preview: ToolPreview | null): void;
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

/** Presenter mode sending through `send` (desktop: the bridge's presenterSend; browser: presenter-link.ts). */
export function createPresenter(send: (message: PresenterMessage) => void, timers: PresenterTimers = defaultTimers): Presenter {
  let active = false;
  let file: PdfFile | null = null;
  let doc: NotesDoc | null = null;
  let page = '';
  /** Pages whose strokes changed, sent at the end of the task. */
  const dirty = new Set<string>();
  let flushQueued = false;
  /** The strokes the audience has, per page it got them for (by id; the objects tell what changed). */
  const sent = new Map<string, Map<string, Stroke>>();
  /** The images the audience has, per page (by id; the objects tell what changed). */
  const sentImages = new Map<string, Map<string, PageImage>>();
  /** All notes went out in this task: the 'pages' event of the same load needs nothing more. */
  let notesSent = false;
  /** The stroke being written: what the audience has, and what it should get. */
  let live: { page: string; tool: StrokeTool; stroke: Stroke | null; sent: readonly Point[]; ended: boolean } | null = null;
  let laser: { page: string; points: [number, number][] } | null = null;
  /**
   * The erase or move under way: `dirty` until its latest state is sent,
   * `pieces` the cut pieces the audience has (by id), `shown` once the
   * audience got a message of it.
   */
  let preview: { page: string; p: ToolPreview; dirty: boolean; pieces: Set<string>; shown: boolean; ended: boolean } | null = null;
  let timer: unknown = null;

  const post = (m: PresenterMessage): boolean => {
    try {
      send(m);
      return true;
    } catch (e) {
      console.error('Presenter mode: a message could not be sent', e);
      return false;
    }
  };

  /**
   * A page's images for the audience if they changed: all of them, the data of
   * new ones only. A message that could not be sent leaves the page unknown,
   * so the next one carries all the data.
   */
  function sendImages(d: NotesDoc, id: string): void {
    const images = d.images(id);
    const had = sentImages.get(id) || new Map<string, PageImage>();
    if (images.length === had.size && images.every(i => had.get(i.id) === i)) return;
    const ok = post({
      type: 'images', page: id,
      images: images.map(i => {
        const known = had.get(i.id);
        const base = { id: i.id, x: i.x, y: i.y, w: i.w, h: i.h };
        return known && known.src === i.src ? base : { ...base, src: i.src };
      }),
    });
    if (ok) sentImages.set(id, new Map(images.map(i => [i.id, i])));
    else sentImages.delete(id);
  }

  /**
   * A page's strokes for the audience: all of them the first time, else what
   * changed. A message that could not be sent leaves the page unknown, so the
   * next change sends all of its strokes again.
   */
  function sendPage(d: NotesDoc, id: string): void {
    sendImages(d, id);
    const strokes = d.strokes(id);
    const had = sent.get(id);
    let ok: boolean;
    if (!had) {
      ok = post({ type: 'strokes', page: id, strokes: strokes.map(serializeStroke) });
    } else {
      const changed = strokes.filter(s => had.get(s.id) !== s);
      const same = !changed.length && strokes.length === had.size;
      if (same) return; // e.g. an edit undone in the same task
      ok = post({ type: 'delta', page: id, order: strokes.map(s => s.id), strokes: changed.map(serializeStroke) });
    }
    if (ok) sent.set(id, new Map(strokes.map(s => [s.id, s])));
    else sent.delete(id);
  }

  /** The audience gets all notes: no page has a known state there any more. */
  function postNotes(d: NotesDoc): void {
    dirty.clear();
    sent.clear();
    // The notes carry the images: the audience has those of every page now.
    sentImages.clear();
    for (const [id, p] of d.pages) if (p.images.length) sentImages.set(id, new Map(p.images.map(i => [i.id, i])));
    if (!post({ type: 'notes', notes: JSON.stringify(d.toJSON()) })) sentImages.clear();
    notesSent = true;
    timers.queueMicrotask(() => { notesSent = false; });
  }

  /** Strokes of the pages that changed, then the end of a live stroke (so the audience never shows neither). */
  function flush(): void {
    flushQueued = false;
    if (active && doc) {
      for (const id of dirty) {
        if (doc.hasPage(id)) sendPage(doc, id);
        else { sent.delete(id); sentImages.delete(id); } // a deleted blank page: the audience drops it with its images
      }
    }
    dirty.clear();
    if (live && live.ended) {
      live = null;
      if (active) post({ type: 'live-end' });
    }
    if (preview && preview.ended) {
      const { shown } = preview;
      preview = null;
      if (active && shown) post({ type: 'preview-end' });
    }
  }

  /** The preview's latest state, as an erasing or moving message; false if nothing was sent. */
  function sendPreview(): boolean {
    const pv = preview!;
    pv.dirty = false;
    if (!doc || !doc.hasPage(pv.page)) return false;
    const { p } = pv;
    if (p.kind === 'move') {
      pv.shown = post({ type: 'moving', page: pv.page, ids: p.ids.slice(), dx: p.dx, dy: p.dy }) || pv.shown;
      return true;
    }
    if (p.strokes.length > PRESENTER_LIMITS.strokes) return false; // the result comes when the gesture ends
    // Strokes of the page (the audience has them) and pieces sent before go by id.
    const own = new Map(doc.strokes(pv.page).map(s => [s.id, s]));
    const fresh = p.strokes.filter(s => own.get(s.id) !== s && !pv.pieces.has(s.id));
    const left = new Set(p.images.map(i => i.id));
    const ok = post({
      type: 'erasing', page: pv.page, order: p.strokes.map(s => s.id), strokes: fresh.map(serializeStroke),
      hidden: doc.images(pv.page).filter(i => !left.has(i.id)).map(i => i.id),
    });
    if (ok) {
      for (const s of fresh) pv.pieces.add(s.id);
      pv.shown = true;
    }
    return true;
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
        const ok = post({
          type: 'live', page: live.page, tool: live.tool, color: stroke.color, size: stroke.size,
          from, points: stroke.points.slice(from).map(p => [p[0], p[1], p[2]]),
        });
        if (ok) live.sent = stroke.points;
        sent = true;
      }
    }
    if (laser && laser.points.length) {
      post({ type: 'laser', page: laser.page, points: laser.points });
      laser = null;
      sent = true;
    }
    if (preview && preview.dirty && !preview.ended && sendPreview()) sent = true;
    if (sent) timer = timers.setTimeout(sendLive, LIVE_MS); // the next update waits its turn
  }

  function scheduleLive(): void {
    if (active && timer === null) sendLive();
  }

  function sendAll(): void {
    sent.clear();
    sentImages.clear();
    if (!active) return;
    if (!file || !doc) {
      post({ type: 'close' });
      return;
    }
    if (file.bytes.byteLength > PRESENTER_LIMITS.pdfBytes) {
      post({ type: 'close', reason: 'too-large' });
      return;
    }
    if (!post({ type: 'open', pdf: file.bytes, title: doc.deck.title || file.name })) {
      post({ type: 'close', reason: 'failed' });
      return;
    }
    postNotes(doc);
    if (page) post({ type: 'page', page });
  }

  function watch(d: NotesDoc): void {
    d.onChange((pageId, kind) => {
      if (d !== doc || !active || kind === 'saved') return;
      if (kind === 'pages') {
        if (pageId === null && notesSent) return; // a load: the notes just sent have the blank pages
        post({ type: 'blanks', blanks: d.blankMeta() });
        // An undone delete brings its strokes back with it.
        if (pageId) dirty.add(pageId);
        else d.blankOrder.forEach(id => dirty.add(id));
        queueFlush();
      } else if (pageId) {
        dirty.add(pageId);
        queueFlush();
      } else {
        postNotes(d); // everything (load, import, revert)
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
      // An audience that (re)loads has no pieces and no preview: the next update sends it all.
      if (preview && !preview.ended) Object.assign(preview, { dirty: true, pieces: new Set(), shown: false });
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      sendAll();
      if (preview && preview.dirty) scheduleLive();
    },

    opened(f, d) {
      file = f;
      doc = d;
      page = '';
      live = null;
      preview = null;
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

    preview(pageId, p) {
      if (!p) {
        if (preview && !preview.ended) {
          preview.ended = true;
          // The gesture's command changed the page just before: its page goes first.
          queueFlush();
        }
        return;
      }
      // The same gesture keeps the pieces the audience has; a new one starts afresh.
      const same = preview && !preview.ended && preview.page === pageId && preview.p.kind === p.kind;
      preview = { page: pageId, p, dirty: true, pieces: same ? preview!.pieces : new Set(), shown: same ? preview!.shown : false, ended: false };
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
