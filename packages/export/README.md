# @inkslide/export

Annotated PDF export for Inkslide. It takes the original PDF bytes and a notes file
(`NotesJSON`) and returns a new PDF with the ink drawn as vector graphics and the blank pages
inserted. The input bytes are never modified.

```ts
import { exportAnnotatedPdfWithReport } from '@inkslide/export';

const { bytes, warnings, pageCount } = await exportAnnotatedPdfWithReport(pdfBytes, doc.toJSON());
```

`exportAnnotatedPdf(pdfBytes, notes, opts)` returns only the bytes and reports warnings to
`opts.onWarning` (default `console.warn`).

## How it works

- The PDF is loaded with pdf-lib; the notes are read through `NotesDoc` and `io.loadNotes`
  from `@inkslide/annotate`, so v1 Marp notes are scaled onto the pages, and malformed pages
  and strokes become warnings instead of errors. A page count or page size that differs from
  the notes is a warning too; title and checksum are not checked. Notes kept for pages beyond
  the PDF (the PDF got shorter) are left out silently.
- An encrypted PDF (typically an owner password that restricts changes) is refused with a
  plain error: pdf-lib cannot decrypt it.
- Pages are written in reading order. Blank pages are inserted after their PDF page, with the
  size of that page and their paper (white, lined with a margin line, or grid), drawn from the
  screen's `PAPER_STYLE` (`@inkslide/annotate/render`).
- Each annotated page gets one extra content stream. The existing content is only wrapped in
  `q/Q`, so the page text stays selectable.
- Strokes are drawn in display coordinates (origin top-left of the page as shown, after the
  CropBox and `/Rotate`); `displayMatrix` maps them to the page's user space.
- Pen strokes are the same filled outline the screen draws (`geometry.strokeOutline`, with the
  current outline engine unless `opts.outline` says otherwise). Highlighter strokes are stroked
  centerlines with round caps, opacity 0.35 and multiply blend, under the pen strokes, as in
  `toolbar.css`.

`ops.ts` holds the pure helpers: SVG path data to PDF operators, rotation and display
matrices, CSS color parsing.

## Tests

```sh
pnpm --filter @inkslide/export test
```

The tests export small PDFs and read them back with pdf-lib and PDF.js (text still
extractable, page sizes and rotation, blank pages, operators).

The web app loads this package lazily (`apps/web/src/export.ts`), so pdf-lib stays out of the
startup bundle.
