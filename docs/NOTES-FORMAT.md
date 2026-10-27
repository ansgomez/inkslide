# Notes file format

Inkslide keeps the ink of a PDF in a separate JSON file, the *notes file*. The PDF itself is
never changed. The format is the `marp-notes` format of the Marp Notes annotation mode in the
lecture HTML decks, extended for PDFs:

| Version | Written for | Page ids | Read by |
|---|---|---|---|
| 1 | Marp HTML decks | `s1 … sN` | Marp Notes (HTML decks) and Inkslide |
| 2 | PDFs | `p1 … pN` | Inkslide only |

Sources: `packages/annotate/src/model.ts` (`NotesDoc.toJSON`, `NotesDoc.load`, `checkFormat`,
`deckWarnings`), `packages/annotate/src/io.ts` (`serializeNotes`, `parseNotes`, `scaleV1ToPdf`,
`loadNotes`) and, for where the file lives, `apps/desktop/src/main/notes.ts` and
`apps/web/src/platform/web.ts`.

## Example (version 2)

```json
{
 "format": "marp-notes",
 "version": 2,
 "deck": {
  "source": "pdf",
  "title": "Exercise 1",
  "slides": 3,
  "size": [960, 540],
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "pageSizes": [[960, 540], [960, 540], [595.28, 841.89]]
 },
 "pages": [
  {
   "id": "p1", "kind": "slide", "slide": 1,
   "strokes": [
    { "id": "lq3k9x2a1b-0", "tool": "pen", "color": "#be1e3c", "size": 3,
      "points": [[120.5, 80.25, 0.512], [124, 82.1, 0.6]] }
   ]
  },
  { "id": "b-x7k2q9-1", "kind": "blank", "after": 1, "paper": "grid", "strokes": [] }
 ]
}
```

The file is written with `JSON.stringify(notes, null, 1)` (one space indent, as Marp Notes
does). Readers must not depend on the layout.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `format` | `"marp-notes"` | Required. Any other value is rejected ("Not a marp-notes file"). |
| `version` | number | `1` or `2`. Files with a version above 2, any other number (0, negative, fractional) or no numeric version are rejected ("Unsupported notes version"), so a newer Inkslide never has its files silently misread. |
| `deck` | object | What the notes were made for (see below). |
| `pages` | array | Pages that have notes (see below). A `pages` that is not an array is skipped with a warning; the file loads without pages. |

## `deck`

| Field | v1 | v2 | Meaning |
|---|---|---|---|
| `source` | – | `"pdf"` | Missing means a Marp deck. |
| `title` | yes | yes | Marp: the deck title. PDF: the PDF's `Title` metadata, else the file name without `.pdf`. |
| `slides` | yes | yes | Number of source pages (slides or PDF pages). Blank pages are not counted. |
| `size` | yes | yes | `[width, height]` of page 1 in page units (Marp: viewBox px, usually 1280×720; PDF: points). |
| `pageSizes` | – | optional | `[width, height]` per PDF page, page 1 first. A page without an entry has `size`. |
| `sha256` | – | optional | Lower-case hex SHA-256 of the PDF bytes. |

Page sizes are the sizes a viewer shows: PDF.js `page.getViewport({ scale: 1 })`, so the
CropBox (clipped to the MediaBox) with `/Rotate` applied.

The deck is only used for checks. On load, Inkslide compares it with the open document and
shows warnings, but loads the notes anyway:

- the file has no `deck` ("File has no deck information"; no other deck checks then);
- the `sha256` differs ("made for a different version of this PDF");
- the `title` differs, unless both `sha256` are equal (a renamed copy of the same PDF);
- `slides` differs;
- page 1's `size` differs (a `size` that is not an array counts as missing);
- other entries of `pageSizes` differ (counted in one warning; a `pageSizes` that is not an
  array is ignored).

## `pages`

Each entry is a slide page (a page of the source document) or a blank page.

| Field | Slide page | Blank page | Meaning |
|---|---|---|---|
| `id` | yes | yes | Page id, see below. A page without a string `id` is skipped with a warning. |
| `kind` | `"slide"` | `"blank"` | Other kinds are skipped with a warning. |
| `slide` | yes | – | 1-based number of the source page. |
| `after` | – | yes | Number of the source page the blank page follows. |
| `paper` | – | yes | `"plain"`, `"lined"` or `"grid"`. Unknown values load as `"plain"`. |
| `strokes` | yes | yes | Strokes, bottom to top. A `strokes` that is not an array is skipped with a warning; the page loads without strokes. |

Writing:

- Pages are written in reading order: source page 1, its blank pages, page 2, …
- Slide pages without strokes are left out. Blank pages are always written, also when empty.
- Pages kept from a longer PDF (see below) follow at the end, unchanged.

### Page ids

- Source pages are `s<n>` in a Marp deck and `p<n>` in a PDF. On load the id of a slide page
  is rebuilt from `slide` and the open document's kind, so the `id` in the file does not
  matter for slide pages. That is how `s<n>` pages of a v1 file land on `p<n>` of a PDF.
- Blank pages keep the id from the file. New blank pages get `b-<random>-<counter>`, where
  the random part differs per window and the id never repeats one that is in use or kept.
- A page id that appears twice is skipped with a warning.

### Blank pages

A blank page has the size of the source page it follows. Its paper is drawn by the app, not
stored: white, with ruled lines (and a red margin line) or a grid, with a spacing of
`width / 32` page units. Blank pages after the same source page keep the order of the file.

### Pages beyond the PDF

When the PDF has fewer pages than the notes (a shorter version of the PDF), slide pages with
`slide > slides` and blank pages with `after > slides` are not shown, but kept: they are written
back unchanged on the next save, so the notes come back when the pages do. Each one gives a
"Kept … not shown" notice (shown when the PDF opens; `loadNotes` returns it in `notices`, apart
from the `warnings` about real problems). The annotated PDF export leaves them out silently.

Pages with an invalid number (not an integer, or below 1) are skipped with a warning and lost
on the next save.

## Strokes

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique within the file. A missing, non-string or duplicate id gets a new one on load. |
| `tool` | `"pen"` or `"highlighter"` | The laser is never stored. Other tools make the stroke invalid. |
| `color` | string | CSS color, e.g. `#be1e3c`. |
| `size` | number, 0 < size ≤ 10⁶ | Pen: ink width at pressure 0.5. Highlighter: line width. In page units. |
| `points` | `[x, y, pressure][]`, at least one | Page units, origin top-left, y down; `\|x\|`, `\|y\|` ≤ 10⁶. Pressure 0..1 (clamped on load); a missing pressure loads as 0.5. |

Coordinates are rounded to 2 decimals, pressure to 3, when saved. Points are already smoothed
(they are not the raw pointer positions). A pen stroke's width at pressure `p` is
`size × (1 − 1.2 × (0.5 − p))`, at least 0.5 units. A stroke with a bad tool, a size that is
not a number or out of range, no points, non-finite or non-numeric coordinates, or coordinates
beyond ±10⁶ is skipped with a warning; the rest of the page loads. (Such numbers would overflow when rounded for saving, or end up as
`Infinity` in an exported PDF.) The same check applies to every new or changed stroke, so the
app never writes one.

### Tool sizes

The four sizes S, M, L, XL of each tool are defined for a 1280×720 slide:

| Tool | S | M | L | XL |
|---|---|---|---|---|
| Pen (width) | 2 | 4 | 7 | 12 |
| Highlighter (width) | 12 | 20 | 32 | 48 |
| Eraser, partial eraser (radius) | 8 | 16 | 32 | 64 |

On other pages they are scaled by the page diagonal, `unit = hypot(w, h) / hypot(1280, 720)`:
0.75 on a 960×540 pt PDF page, about 0.70 on A4. A stroke stores the scaled `size` in page
units, so it keeps its look if the scaling rules change later; files store no size index.

## Version 1 notes on a PDF

A v1 file (for example the notes of a Marp HTML deck) can be opened with or imported into the
PDF exported from that deck. Its strokes are in slide px; the PDF is in points. Before loading,
`scaleV1ToPdf` scales them:

- per page, `s = pageWidth / deck.size[0]`, but only if the aspect ratio matches within 1 %
  (`|sx − sy| / sx ≤ 0.01`); then `x`, `y` and `size` are multiplied by `s`, pressure stays.
  Only numbers are scaled: other values are left as they are, so the stroke is skipped as
  invalid on load;
- a page with strokes whose aspect ratio differs is left unscaled; when page 1 or another
  page fits, one warning names the pages left unscaled ("Notes not scaled to the PDF …");
- pages beyond the PDF (kept, see above) are scaled with the size of page 1, since they are
  saved as v2 too;
- the deck's `size` counts as matching whenever PDF page 1 fits, whether or not any page has
  strokes (no size warning then); if page 1 does not fit, the size warning stays even when
  other pages are scaled;
- the scale reported (and shown in the banner) is page 1's if it fits and is not 1, else that
  of the first page scaled, else none;
- if no page fits, nothing is scaled and only the size warning is shown.

Marp exports 1280×720 px slides as 960×540 pt pages, so the usual scale is 0.75. The app says
so in a banner. Once saved, the notes are a v2 file.

## Where the file lives

### Desktop (Electron)

- **Sidecar:** `<pdf path>.notes.json`, next to the PDF, e.g. `lecture.pdf.notes.json`.
- **App storage:** `<userData>/notes/<sha256>.notes.json` when the sidecar cannot be written
  (the PDF's folder or an existing sidecar is not writable, or the write fails), or the PDF has
  no path. Next to it, `<sha256>.sidecar.json` records which sidecar the notes replace and the
  SHA-256 of what it held then. `<userData>` is `~/.config/Inkslide` on Linux,
  `%APPDATA%\Inkslide` on Windows and `~/Library/Application Support/Inkslide` on macOS.
- **Reading:** both files exist when the sidecar could not be written for a while. App storage
  wins while the sidecar still holds what was recorded; once the sidecar changes (a later save,
  or a backup put back, whatever its date) the sidecar wins. Without a record (notes saved
  without a path) the newer file by modification time wins, the sidecar on a tie. If only one
  exists, that one is read.
- **Writing** is crash-safe: a temp file in the same folder, `fsync`, rename over the old file,
  then `fsync` of the folder. A crash leaves the old or the new file, never half of one. A
  sidecar that is a symlink is written through, and the replaced file keeps its permissions.
- **Backup:** always in app storage, `<userData>/notes/<sha256>.notes.backup.json`, keyed by
  the PDF's SHA-256 like the app-storage notes; the same format as the notes file, written the
  same crash-safe way. Before a save replaces the notes, the saved notes (as read above) are
  copied there if they parse, are not empty (strokes or blank pages) and the backup is missing
  or older than 2 minutes by its modification time. File → Revert to Backup… swaps the notes
  and the backup. For a notes file that cannot be read or parsed (also on a second try a
  second later), the app offers to open the backup instead (see
  [USER-GUIDE.md](USER-GUIDE.md#backup)). Off with File → Keep a Backup of the Notes
  (`<userData>/preferences.json`, `{"backups": false}`), which deletes every backup in
  `<userData>/notes`. A `<pdf path>.notes.backup.json` next to a PDF (written by development
  builds before 2026-10-27) is deleted when the PDF is opened.
- **Unreadable copy:** before the app replaces a notes file that could not be read (with the
  backup, or after "open anyway"), it copies the file byte for byte, unparsed, to
  `<userData>/notes/<sha256>.notes.unreadable.json`; only the latest copy per PDF is kept.
- **Cleanup:** at startup, `*.notes.backup.json` and `*.notes.unreadable.json` in
  `<userData>/notes` that were last changed more than 90 days ago are deleted (in the
  background; notes files are never deleted).

### Browser and PWA

There are no file paths. Notes are kept in the site's storage, keyed by the PDF's SHA-256:

- OPFS (Origin Private File System), file `notes/inkslide-notes_<sha256>.json`, where the
  browser has it;
- else `localStorage`, key `inkslide-notes:<sha256>`.

Clearing the site data deletes the notes. The same PDF opened from another folder or under
another name finds its notes, because the key is the hash.

- **Backup:** OPFS file `notes/inkslide-notes_<sha256>.notes.backup.json`, same format and
  same rules as the desktop's (copied before a save if usable and the backup is missing or
  older than 2 minutes, by the file's `lastModified`; Revert to Backup swaps). Only where the
  page can write OPFS: there is no `localStorage` backup, because that store is small (about
  5 MB) and shared with the notes that fall back to it, and a full store fails their save. A
  failed backup write never fails the save; it is written after the notes, so near the quota
  it never takes the room the notes need. The backup is deleted when the PDF leaves the
  recent files (`apps/web/src/recent.ts`); the notes stay. It lives in the same site storage
  as the notes, so it protects against unwanted changes, not against clearing the site data.
- **Unreadable copy:** notes that exist but cannot be read or parsed are copied as they are to
  `notes/inkslide-notes_<sha256>.notes.unreadable.json` before they are replaced (only where
  OPFS can be written; otherwise the app asks first). An OPFS file that exists but cannot be
  read is an error, never "no notes", unless `localStorage` holds a copy (the notes are written
  there when OPFS fails), which is then read.
- **Cleanup:** the backup goes with the PDF's recent-files entry (the unreadable copy stays: it
  may be the only copy of real notes); at startup, backups and unreadable copies last changed
  more than 90 days ago are deleted (notes files never are).

### iPad and Android (Tauri)

No sidecars: picked files are copies (iPadOS) or content URIs (Android), next to which the app
can rarely write. Notes are kept in the app data directory, `notes/<sha256>.notes.json`, keyed
by the PDF's SHA-256 like the desktop's app storage. A save writes a
temp file (`<sha256>.notes.json.<random>.tmp`), then renames it over the old file (no `fsync`: the fs plugin has
none). Uninstalling the app deletes the notes; Import brings notes from elsewhere. No backup
is kept yet (the Tauri adapter has no `readBackup`; it could live next to the notes in the app
data directory once it can be tested on devices).

## Compatibility rules

- Marp decks still write version 1, so the HTML decks can read what Inkslide writes for them.
  PDFs write version 2, which the HTML decks reject (their reader accepts version 1 only).
- Readers accept every version up to their own and reject newer ones.
- Readers ignore unknown fields, but do not write them back: the model keeps only the fields
  above. New optional fields can be added without a version change only if losing them on a
  save by an older Inkslide is acceptable; a change that old readers would misread needs a new
  version.
- Content that a reader cannot place (pages beyond the document) is kept, not dropped.
- Saved notes that cannot be read or parsed are never overwritten silently: the app reads them
  again, then asks (open the backup instead, or open anyway); the desktop and the browser keep
  a copy of the unreadable file before replacing it.
