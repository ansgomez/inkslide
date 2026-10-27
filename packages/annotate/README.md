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
| `model` | no | `NotesDoc` (pages, blank pages, kept pages, change events), `History` (undo/redo), `createStroke`, the notes file JSON (`toJSON` / `load`), deck warnings. |
| `io` | no | Notes file text (`serializeNotes`, `parseNotes`, `loadNotes`), v1 to PDF scaling, `deckFromPdf`, `sha256Hex`, the sidecar name, the `PlatformAdapter` interface. |
| `clipboard` | no | Copy and paste of strokes: the window's clip, its system clipboard text, `placeClip` (new ids, scaling, offset, clamping). |
| `autosave` | no | `createAutosave`: debounced, serialized, retried writes and the saved / dirty / saving / error state. |
| `tools` | no¹ | Pen, highlighter, selector, laser, erasers; colors, sizes, prefs. |
| `input` | yes | Pointer routing to the tools, pen buttons, palm rejection, two-finger swipe. |
| `render` | yes | SVG annotation layers, page surfaces with paper (`PAPER_STYLE`, also used by the PDF export), selection and eraser overlays, laser. |
| `toolbar` | yes | The Marp Notes toolbar (groups, dock, icons) and keyboard shortcuts. Styles: `toolbar.css`. |
| `pages` | no | `PagesController` interface, page counter text, G + number parsing, the pages toolbar group. |
| `app` | yes | `createAnnotator`: ties doc, tools, input, toolbar and keys together. |

¹ The tools draw through an injectable `ToolRenderer` (default: `render`).

## Using it

```ts
const doc = new NotesDoc(deckFromPdf({ title, pageSizes, sha256 }));
loadNotesText(doc, savedText);                       // optional
const app = createAnnotator({ doc, activeSurface: () => current });

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

Coordinates are page units (PDF points for PDFs, viewBox px for Marp slides), origin top-left.
Tool sizes are defined for a 1280×720 slide and scaled per page by `render.pageUnit`.

The file format is described in [docs/NOTES-FORMAT.md](../../docs/NOTES-FORMAT.md).

## Tests

```sh
pnpm --filter @inkslide/annotate test
```

Vitest, with happy-dom for the DOM modules. `test/legacy.test.ts` runs the same inputs
through `legacy/*.js` and the port and expects equal results.
