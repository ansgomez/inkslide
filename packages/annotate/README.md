# @inkslide/annotate

The annotation core of Inkslide: everything about ink that does not depend on PDFs or a file
system. It is a TypeScript port of Marp Notes, an annotation mode embedded in Marp decks
(changes listed in [PORTING.md](PORTING.md); [`legacy/`](legacy) keeps two originals for parity tests).

The package ships TypeScript source; there is no build step. Import the
entry point or a single module:

```ts
import { NotesDoc, createAnnotator } from '@inkslide/annotate';
import { deckFromPdf, loadNotesText, serializeNotes } from '@inkslide/annotate/io';
import '@inkslide/annotate/toolbar.css';
```

## Modules

| Module | DOM | Content |
|---|---|---|
| `geometry` | no | Smoothing, pressure width, stroke outlines (classic Marp outline or perfect-freehand), bounding boxes, hit tests, partial erase, lasso, laser trail. |
| `model` | no | `NotesDoc` (pages, blank pages, kept pages, page images, change events), `History` (undo/redo), `createStroke`, `createImage` and the image limits, the notes file JSON (`toJSON` / `load`), deck warnings. |
| `io` | no | Notes file text (`serializeNotes`, `parseNotes`, `loadNotes`), v1 to PDF scaling, `deckFromPdf`, `sha256Hex`, the sidecar name, the `PlatformAdapter` interface. |
| `clipboard` | no | Copy and paste of strokes and images: the window's clip, its system clipboard text, `placeItems` (new ids, scaling, offset, clamping). |
| `autosave` | no | `createAutosave`: debounced, serialized, retried writes and the saved / dirty / saving / error state. |
| `tools` | no¹ | Pen, highlighter, selector, laser, erasers, snapshot; colors, sizes, prefs. |
| `input` | yes | Pointer routing to the tools, pen buttons, palm rejection, two-finger swipe. |
| `render` | yes | SVG annotation layers (images, highlighter, pen), page surfaces with paper (`PAPER_STYLE`, also used by the PDF export), selection and eraser overlays, laser. |
| `toolbar` | yes | The Marp Notes toolbar (groups, dock, icons) and keyboard shortcuts. Styles: `toolbar.css`. |
| `pages` | no | `PagesController` interface, page counter text, G + number parsing, the pages toolbar group. |
| `app` | yes | `createAnnotator`: ties doc, tools, input, toolbar and keys together; snapshots and pasted images through host callbacks. |

¹ The tools draw through an injectable `ToolRenderer` (default: `render`).

## Using it

```ts
const doc = new NotesDoc(deckFromPdf({ title, pageSizes, sha256 }));
loadNotesText(doc, savedText);                       // optional
const app = createAnnotator({
  doc, activeSurface: () => current,
  captureArea: (pageId, rect) => drawArea(pageId, rect),   // optional: the snapshot tool
  notify: text => showMessage(text),                       // optional
});

const { svg, layer } = render.createPageSurface(doc.pageSize('p1'));
current = { pageId: 'p1', svg, layer };
app.surfaces.set('p1', current);
app.input.attach(current);

app.pages = myPagesController;                       // optional
registerGroup('pages', pagesGroup);                  // optional
app.mount();                                         // keys + toolbar
app.toggle(true);                                    // annotate mode on
```

The host (the viewer in `apps/web`) places the SVG over the page, creates surfaces per page,
calls `app.pageChanged(previous)` on a page turn, and writes `serializeNotes(doc)` through its
platform adapter, usually with `createAutosave`.

The snapshot tool needs the host to draw the area, since the core has no PDF renderer:
`captureArea(pageId, rect)` resolves to `{ src, png? }`, a PNG or JPEG data URL within the
model's limits (`MAX_IMAGE_CHARS`) and optionally a PNG `Blob` for the system clipboard. The
app makes it the window's clip, at the area's place, and goes back to the previous tool.
`importImage(blob)` does the same for an image pasted from another program (with its pixel
size, `width` and `height`). Without them the snapshot tool captures nothing and pasted
images are ignored.

Coordinates are page units (PDF points for PDFs, viewBox px for Marp slides), origin top-left.
Tool sizes are defined for a 1280×720 slide and scaled per page by `render.pageUnit`.

The file format is described in [docs/NOTES-FORMAT.md](../../docs/NOTES-FORMAT.md).

## Tests

```sh
pnpm --filter @inkslide/annotate test
```

Vitest, with happy-dom for the DOM modules. `test/legacy.test.ts` runs the same inputs
through `legacy/*.js` and the port and expects equal results.
