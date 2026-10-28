# Notes file format

Inkslide keeps the ink of a PDF in a separate JSON file, the *notes file*. The PDF itself is
never changed. The format is the `marp-notes` format of the Marp Notes annotation mode in the
lecture HTML decks, extended for PDFs:

| Version | Written for | Page ids | Read by |
|---|---|---|---|
| 1 | Marp HTML decks | `s1 … sN` | Marp Notes (HTML decks) and Inkslide |
| 2 | PDFs | `p1 … pN` | Inkslide only |
| 3 | Notes with images (snapshots), either source | as above | Inkslide with snapshots only |

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
| `version` | number | `1`, `2` or `3`. Files with a version above 3, any other number (0, negative, fractional) or no numeric version are rejected ("Unsupported notes version"), so a newer Inkslide never has its files silently misread. |
| `deck` | object | What the notes were made for (see below). |
| `pages` | array | Pages that have notes (see below). A `pages` that is not an array is skipped with a warning; the file loads without pages. |

## `deck`

| Field | v1 | v2 | Meaning |
|---|---|---|---|
| `source` | – | `"pdf"` | Missing means a Marp deck. |
| `title` | yes | yes | Marp: the deck title. PDF: the PDF's `Title` metadata, else the file name without `.pdf`. |
| `slides` | yes | yes | Number of source pages (slides or PDF pages). Blank pages are not counted. |
| `size` | yes | yes | `[width, height]` of page 1 in page units (Marp: viewBox px, usually 1280×720; PDF: points, see below). |
| `pageSizes` | – | optional | `[width, height]` per PDF page, page 1 first. A page without an entry has `size`. |
| `sha256` | – | optional | Lower-case hex SHA-256 of the PDF bytes. |

Page sizes are the sizes a viewer shows: PDF.js `page.getViewport({ scale: 1 })`, so the
CropBox (clipped to the MediaBox) with `/Rotate` applied and multiplied by the page's
`/UserUnit` (1 when missing; a page with `/UserUnit 2` shows at twice its box size).

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
| `images` | optional | optional | Version 3: images, bottom to top (see [Images](#images)). Left out when the page has none. An `images` that is not an array is skipped with a warning. |

Writing:

- Pages are written in reading order: source page 1, its blank pages, page 2, …
- Slide pages without strokes and images are left out. Blank pages are always written, also
  when empty.
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
| `id` | string | Unique within the file. A missing, non-string, longer than 200 characters or duplicate id gets a new one on load. |
| `tool` | `"pen"` or `"highlighter"` | The laser is never stored. Other tools make the stroke invalid. |
| `color` | string | CSS color, e.g. `#be1e3c`, at most 100 characters (a longer one makes the stroke invalid). |
| `size` | number, 0 < size ≤ 10⁶ | Pen: ink width at pressure 0.5. Highlighter: line width. In page units. |
| `points` | `[x, y, pressure][]`, at least one | Page units, origin top-left, y down; `\|x\|`, `\|y\|` ≤ 10⁶. Pressure 0..1 (clamped on load); a missing pressure loads as 0.5. |

Coordinates are rounded to 2 decimals, pressure to 3, when saved. Points are already smoothed
(they are not the raw pointer positions). A pen stroke's width at pressure `p` is
`size × (1 − 1.2 × (0.5 − p))`, at least 0.5 units. A stroke with a bad tool, a size that is
not a number or out of range, no points, non-finite or non-numeric coordinates, or coordinates
beyond ±10⁶ is skipped with a warning; the rest of the page loads. (Such numbers would overflow when rounded for saving, or end up as
`Infinity` in an exported PDF.) The same check applies to every new or changed stroke, so the
app never writes one.

## Images

Images are snapshots: an area of a page (PDF render, paper and ink) captured with the snapshot
tool and pasted onto a page. They live in an `images` array next to `strokes`:

```json
{ "id": "lq3k9x2a1b-7", "x": 120, "y": 80.5, "w": 320, "h": 180,
  "src": "data:image/png;base64,iVBORw0KGgo…" }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique within the file, among stroke and image ids. A missing, non-string, longer than 200 characters or duplicate id gets a new one on load. |
| `x`, `y` | number, ≤ 10⁶ in size | Top-left corner, page units (origin top-left, y down). |
| `w`, `h` | number, 0.01 ≤ w, h ≤ 10⁶ | Size on the page, page units. The image is stretched to fill it. Smaller sizes would round to 0 when saved, so they are invalid. |
| `src` | string | A base64 `data:` URL of type `image/png` or `image/jpeg`; the data must start with the PNG or JPEG signature, and its size in pixels must be readable from the start of the data (PNG: the IHDR chunk; JPEG: the first frame header, SOFn, within the first 256 KB). A PNG must not be animated (no `acTL` chunk; at most 10 000 chunks are walked). Nothing else (no SVG, no GIF, no links). |

Images are drawn below all ink (highlighter and pen strokes), in the order of the array.
Position and size are rounded to 2 decimals when saved.

**Version.** A file with at least one image (on a shown page or a [kept](#pages-beyond-the-pdf)
one) is written as version 3, whatever the source; a file without images keeps version 1 (Marp)
or 2 (PDF), byte for byte as before. Builds from before images reject version 3 ("Unsupported
notes version") and, as for any unreadable notes file, ask before replacing it (the desktop keeps
a copy first). Without the version change they would have loaded the strokes, ignored the
images and dropped them on their next autosave without a word. The `images` array still sits
next to `strokes`, so a reader that skips the version check keeps the ink.

**Limits.** Each image's `src` is at most 3 000 000 characters (about 2.2 MB of image data), a
page holds at most 32 images, a file at most 256, with at most 24 000 000 characters of `src`
in all (kept pages count). An image is at most 4096 pixels on a side and 16 000 000 pixels in
all, whatever its file size: a small PNG can hold a huge image, and decoding one (on screen, in
a snapshot, in the export) would take seconds and gigabytes. The images of a page have at most
64 000 000 pixels in all, those of a file 256 000 000 (each pixel decodes to 4 bytes: 256 MB and
1 GB); a snapshot has at most 2048 × 2048, about 4 MP. The limits keep the notes file small
enough to autosave: every save serializes the whole file, base64 image data included, so 24 MB
of images means writing about 24 MB a few seconds after each change.
The snapshot tool makes images of at most 2048 px on the long side (PNG; JPEG at 0.9 quality
when the PNG would exceed the per-image limit). On load an image with a bad `src`, bad numbers
or beyond a limit is skipped with a warning ("Skipped an image on page …"); the rest of the page
loads. New and pasted images are checked the same way, and a paste beyond the limits is refused
with a message.

In the browser, notes that do not fit in OPFS fall back to `localStorage`, which holds about
5 MB per site: a few large snapshots can make saving fail there (the app shows the error).

### Tool sizes

The nine sizes of each tool (the − and + of the size control) are defined for a 1280×720
slide. The 2nd, 4th, 6th and 8th are the presets S, M, L, XL (keys 1–4), the four sizes of
earlier versions:

| Tool | | S | | M | | L | | XL | |
|---|---|---|---|---|---|---|---|---|---|
| Pen (width) | 1 | 2 | 3 | 4 | 5.5 | 7 | 9.5 | 12 | 16 |
| Highlighter (width) | 8 | 12 | 16 | 20 | 26 | 32 | 40 | 48 | 64 |
| Eraser, partial eraser (radius) | 4 | 8 | 12 | 16 | 24 | 32 | 48 | 64 | 96 |

On other pages they are scaled by the page diagonal, `unit = hypot(w, h) / hypot(1280, 720)`:
0.75 on a 960×540 pt PDF page, about 0.70 on A4. A stroke stores the scaled `size` in page
units, so it keeps its look if the scaling rules change later; files store no size index.

## Version 1 notes on a PDF

A v1 file (for example the notes of a Marp HTML deck) can be opened with or imported into the
PDF exported from that deck. Its strokes are in slide px; the PDF is in points. Before loading,
`scaleV1ToPdf` scales them. The same applies to version 3 notes of a Marp deck (a `deck` without
`source`): Marp notes are told by their deck, not their version, and their images are scaled
too (`x`, `y`, `w`, `h` by the page's `s`).

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
  SHA-256 of what it held then (or that it was missing; a sidecar that could not be read gets no
  record). `<userData>` is `~/.config/Inkslide` on Linux,
  `%APPDATA%\Inkslide` on Windows and `~/Library/Application Support/Inkslide` on macOS.
- **Reading:** both files exist when the sidecar could not be written for a while. App storage
  wins while the sidecar still holds what was recorded, or cannot be read; once the sidecar
  changes (a later save, or a backup put back, whatever its date) the sidecar wins. When the
  app writes that sidecar again, the app-storage notes it replaced and their record are
  deleted, so they cannot win again when the sidecar later holds the recorded text once more
  (Revert to Backup). Without a record (notes saved without a path, or while the sidecar could
  not be read) the newer file by modification time wins, the sidecar on a tie. If only one
  exists, that one is read.
- **Writing** is crash-safe: a temp file in the same folder, `fsync`, rename over the old file,
  then `fsync` of the folder. A crash leaves the old or the new file, never half of one. On
  Windows a rename that fails because another program (antivirus, OneDrive) holds the file is
  tried again for up to about 0.7 s before the notes go to app storage. A
  sidecar that is a symlink is followed only to this PDF's own notes kept elsewhere (e.g. in a
  synced folder): the target must have the sidecar's name (`<name>.pdf.notes.json`, or
  `<name>.pdf.notes.backup.json`), must not be in `<userData>`, and, if it records a PDF hash
  (`deck.sha256`), it must be this PDF's (so also a link to notes made for an earlier version of
  the PDF is not followed; the linked file is left as it is). Any other link (as an archive could hold:
  `deck.pdf.notes.json -> ../../.bashrc`, or a link to another PDF's notes) is never read or
  copied (the notes count as unreadable), and a save replaces the link itself. A followed link
  is resolved once and its target read through a handle opened without following links, checked
  to be the same file. The replaced file keeps its permissions.
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

When an OPFS write fails, the notes go to `localStorage` instead and the OPFS file is removed.
If it cannot be removed, both copies exist; the `localStorage` item
`inkslide-notes-time:<sha256>`, `{"local": <ms>, "opfs": <ms>}`, says when each copy was saved
(when its save began), and the newer one is read. Without a time for the `localStorage` copy
(notes saved by an older version) the OPFS file is read. Leaving the page with unsaved notes
writes them to the same `localStorage` key at once, with their time (a checkpoint of at most
1 M characters); a later save to OPFS removes it.

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
by the PDF's SHA-256 like the desktop's app storage. A save (the app's `write_notes` command)
writes a temp file (`<sha256>.notes.json.<random>.tmp`), flushes it to disk, then renames it
over the old file. Uninstalling the app deletes the notes; Import brings notes from elsewhere. No backup
is kept yet (the Tauri adapter has no `readBackup`; it could live next to the notes in the app
data directory once it can be tested on devices).

## Compatibility rules

- Marp decks still write version 1, so the HTML decks can read what Inkslide writes for them.
  PDFs write version 2, which the HTML decks reject (their reader accepts version 1 only).
- Readers accept every version up to their own and reject newer ones.
- Version 3 is written only when the file has images, so notes without images stay readable
  by older builds.
- Readers ignore unknown fields, but do not write them back: the model keeps only the fields
  above. New optional fields can be added without a version change only if losing them on a
  save by an older Inkslide is acceptable; a change that old readers would misread needs a new
  version.
- Content that a reader cannot place (pages beyond the document) is kept, not dropped.
- Saved notes that cannot be read or parsed are never overwritten silently: the app reads them
  again, then asks (open the backup instead, or open anyway); the desktop and the browser keep
  a copy of the unreadable file before replacing it.
