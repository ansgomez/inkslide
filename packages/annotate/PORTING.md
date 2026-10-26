# Porting notes

`src/` is a TypeScript port of the Marp Notes modules (extracted unchanged from a Marp deck
exported with Marp Notes). Algorithms and behaviour are kept. `legacy/` keeps the two
originals the parity test needs: `test/legacy.test.ts` runs the same inputs through
`legacy/geometry.js`, `legacy/model.js` and the port and expects equal results.

| Legacy | Port | Notes |
|---|---|---|
| `geometry.js` | `src/geometry.ts` | Unchanged. Adds `freehandOutline` (perfect-freehand) and `setOutlineEngine`; `strokeOutline` stays classic by default. |
| `model.js` | `src/model.ts` | Deck gets `source` (`marp` / `pdf`), `pageSizes`, `sha256`. PDF pages are `p<n>`, Marp slides stay `s<n>`. `pageSize(id)` added. |
| `render.js` | `src/render.ts` | Unchanged; adds `createPageSurface(size, { paper })` for PDF and blank pages. |
| `input.js` | `src/input.ts` | Side button (masks 2 and 4) added; `destroy()` added. |
| `tools.js` | `src/tools.ts` | Unchanged; the renderer can be injected (tests). |
| `toolbar.js` | `src/toolbar.ts`, `src/toolbar.css` | Groups via `registerGroup()` instead of `MarpNotes.toolbarGroups`. Same DOM, classes and CSS. |
| `pages.js` | `src/pages.ts` | Only `PAPERS`, `formatLabel`, `parseSlideNumber` and the toolbar group. |
| `io.js` | `src/io.ts` | Only the file format and the `PlatformAdapter` interface. |
| `main.js` | `src/app.ts` | App state and commands (`createAnnotator`); no Marp bootstrap. |
| `overview.js` | – | Not ported. |
| `sync.js` | – | Not ported (presenter mode, see the roadmap). `NotesDoc.applyRemote*` are kept for it. |

## Changes in behaviour

- **Notes file v2.** PDF documents save `version: 2` with `deck.source: "pdf"`,
  `deck.sha256` and `deck.pageSizes`. Marp decks still save v1, so the HTML decks can read
  them. `checkFormat` accepts versions up to 2.
- **v1 notes on a PDF.** `io.loadNotes` scales v1 strokes (points and size) from the slide
  size to the PDF page size when the aspect ratio matches within 1 % (1280×720 → 960×540 pt
  gives 0.75). Otherwise strokes load unscaled and the size warning stays. Title and slide
  count warnings are kept.
- **Deck warnings.** With equal `sha256` the title warning is skipped (a renamed PDF is the
  same file). A different `sha256` gives its own warning. Differing per-page sizes are
  counted in one warning.
- **Pen side button.** Masks 2 (Electron) and 4 (Chromium/CEF) both count as the side
  button; default tool is the stroke eraser, set by `InputHost.sideButtonTool()`. Mask 32
  stays the eraser end.
- **Stroke checks.** `createStroke` also rejects strokes without points, a size above
  `MAX_COORD` (10⁶) and coordinates beyond ±`MAX_COORD`, and clamps pressure to 0..1.
  `replaceStrokes` checks every new or changed stroke the same way (moves, restyles), and
  `moveStrokes` ignores a non-finite offset.
- **Failures are contained.** A change listener that throws (`NotesDoc.onChange`,
  `History.onChange`) is logged and the others still run, so the undo step and the autosave
  are not lost. A tool handler that throws is logged by `attachInput`; a failing down, move
  or up drops the gesture and cancels the tool. A stroke or erase whose page was deleted
  during the gesture is dropped (`NotesDoc.hasPage`).
- **Laser** always uses the classic outline, also when the pen uses perfect-freehand.
- The two-finger swipe calls `app.pages.step()`, as before; `pages` is now the viewer's
  `PagesController`.
- No file group: `io.js`'s Save / Load / Export buttons are built by the app (`apps/web`
  registers its own `file` group), so only the placeholder is in `toolbar.ts`.

## Not ported

- `pages.js` navigation: bespoke buttons, `#n` hash navigation, fragment stepping, blank
  page overlays positioned over Marp's parent. The viewer implements `PagesController`.
- `overview.js` (thumbnail grid cloned from slide SVGs, `G` + number). Its CSS is only in
  the original Marp Notes stylesheet. `parseSlideNumber` is kept for the new overview.
- `io.js` DOM parts: download via `<a download>`, file picker, drag and drop, banners,
  `beforeunload` guard, Ctrl+S binding, print-to-PDF with extra `<svg>` pages. The
  banner CSS (`.ann-banner*`, `body.ann-dropping`) is still in `toolbar.css`.
- `main.js` bootstrap: finding `svg[data-marpit-svg]`, the presenter's next-slide check,
  the `MutationObserver` on bespoke's active class (call `app.pageChanged(prev)`
  instead), `window.MarpNotes.app` and the `marp-notes:ready` event.
- `toolbar.css` drops the `.bespoke-marp-*` layout rules; the `--ann-off-*` variables are
  kept for the viewer's page area.
- `sync.js` (presenter mirroring).

## Open points

- Sizes (tool widths, eraser radius, laser, selection padding, paper grid step) are in page
  units. On a 960×540 pt PDF they are 4/3 larger relative to the page than on a 1280×720
  slide; on A4 portrait pages the pen is relatively thicker still. Decide later
  whether to scale by page width.
- perfect-freehand options (`FREEHAND_OPTIONS`) need tuning; stored points are already
  smoothed once by `smoothPoints`.
