# User guide

Inkslide opens a PDF one page at a time, fitted to the window, and lets you write on it with a
pen. Your ink is saved automatically in a separate notes file; the PDF is never changed.

## Opening a PDF

- **Desktop:** File → Open… (Ctrl/Cmd+O), File → Open Recent, drop a PDF on the window, open it
  with Inkslide from the file manager ("Open With"), or start `inkslide lecture.pdf`. Opening
  a second PDF while Inkslide runs uses the same window. Inkslide opens local files only: a PDF
  on a network location (sftp://, smb://) has to be copied to the computer first.
- **Browser:** the **Open PDF…** button (Ctrl/Cmd+O) or drop a PDF on the page. A link
  `…/?pdf=<url>` opens a PDF from the same site as Inkslide (not from other sites). The
  start page lists the recently opened PDFs: click one to open it again, × removes it from
  the list. Chrome and Edge reopen the file
  itself (they may ask for permission to read it again); other browsers (Safari, Firefox)
  keep a copy of the PDF in the site's storage, up to 250 MB together, the oldest first to go.

### Installing as an app (iPad, Chrome, Edge)

The browser version can be installed and then works without a network connection:

- **iPad (Safari 17 or later):** open the Inkslide page, tap Share → **Add to Home Screen**.
  Inkslide then opens full screen from its icon. The app has its own storage, separate
  from the Safari tab: kept PDFs and notes stay in the app's
  storage; deleting the app from the home screen deletes them.
- **Chrome / Edge:** the install button in the address bar (or menu → Install Inkslide).
  The installed app can be chosen with "Open with" for PDFs.

When a new version is available, a message offers **Reload to update**; your notes are saved
first (if that fails, Inkslide asks before reloading). If another window of the app was
updated first, a message offers **Reload**.

Before another PDF opens, the notes of the open one are saved. A PDF you open while another
is still loading opens right after it.

## Annotate mode

A PDF opens in annotate mode, ready to write on. **A** (or the first toolbar button) switches
between annotate mode and plain viewing. In plain viewing the bar collapses, and the page keys,
swipes and the overview still work.

The toolbar can sit on any edge of the window: the dock button next to the mode button moves
it to the next edge. The choice is remembered.

## Tools

| Tool | Key | What it does |
|---|---|---|
| Pen | P | Pressure-sensitive ink. Hold **Shift** to draw a straight line. |
| Highlighter | H | Wide, transparent strokes, always drawn under the pen ink. Shift for a straight line. |
| Select | S | Tap a stroke to select it, drag a box, or draw a loop (lasso) around strokes. Drag the selection to move it; pick a color or size to restyle it; Delete or Backspace removes it; Esc deselects. |
| Laser pointer | L | A red trail that fades out. Never saved. |
| Stroke eraser | E | Removes every stroke it touches. |
| Partial eraser | Shift+E | Erases only the parts of strokes it touches. |

**Colors:** black, white, red, blue, green, orange, yellow and purple. The pen and the
highlighter each remember their own color.

**Sizes:** S, M, L, XL (keys **1**–**4**). Pen, highlighter and both erasers each remember
their own size. Sizes are relative to the page: they look the same on a slide, a 960×540 PDF
or an A4 page.

**Undo** (Ctrl/Cmd+Z) and **redo** (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y) work per finished stroke,
erase, move or page change. **Clear page** (trash button) removes all ink on the page and can
be undone.

## Pen, touch and mouse

- **Pen:** draws with pressure. The **eraser end** of the pen erases (stroke eraser) whatever
  tool is chosen. The **side button**, held while writing, also uses the stroke eraser.
- **Palm rejection:** once the pen has been used, a finger never draws. While the pen touches
  or hovers the screen, and for half a second after, touch is ignored completely, so a resting
  palm neither zooms nor turns the page.
- **Touch:** before a pen has been seen, one finger draws. Two fingers pinch to zoom and pan;
  a quick two-finger swipe sideways turns the page (to the left: next). Once zoomed in, one
  finger pans.
- **Mouse and touchpad:** the left button draws; Ctrl + wheel (or a touchpad pinch) zooms at
  the pointer; the wheel (or a two-finger touchpad scroll) moves a zoomed page or scrolls a
  page in fit-width mode.

## Pages and navigation

| Key | Action |
|---|---|
| → ↓ PgDn Space | Next page (blank pages included; in fit width PgDn and Space scroll first) |
| ← ↑ PgUp Shift+Space | Previous page (in fit width PgUp and Shift+Space scroll first) |
| W | Fit width / whole page |
| Alt+PgDn / Alt+PgUp | Next / previous PDF page, skipping blank pages |
| Home / End | First page / last page |
| G, a number, Enter | Jump to that PDF page (shown in the counter as "Go to 12_") |
| G, Enter | Open the overview |

The page keys work in annotate mode and in plain viewing; while a stroke is being drawn they
do nothing, so the page never moves under the pen (with the laser they still turn the page). The large arrows at the ends of the
toolbar turn pages too.

### Fit width

**W** (or the fit-width button next to the page buttons) switches between showing the whole
page and filling the window width. Fit width suits a portrait page (A4) on a landscape screen:
the page is larger and scrolls up and down. Scroll with the wheel or touchpad, with two
fingers, or with one finger once the pen has been used (or in plain viewing). **PgDn** and
**Space** scroll about a screen and turn to the next page at the bottom; **PgUp** and
**Shift+Space** scroll back and, at the top, go to the bottom of the previous page. The arrow
keys still turn pages; a new page starts at its top. Pinch zoom works on top. The mode is
remembered.

The counter shows "3 / 37" on PDF page 3 of 37, "3 / 37 · +2 blank" when two blank pages
follow it, and "3 / 37 · blank 1/2" on the first of them.

## Blank pages

- **B** (or the page-with-plus button) inserts a blank page after the current page, with the
  current paper.
- Paper: **plain**, **lined** (with a margin line) or **grid**. The paper buttons change the
  current blank page and set the paper for new ones.
- The delete button removes the current blank page with its ink (undoable). PDF pages cannot be
  deleted.

Blank pages have the size of the PDF page they follow and are part of the export.

## Overview

Click the page counter (or press G, Enter) to see all PDF pages as thumbnails with their ink.
Badges show pages with notes and blank pages. Click a page, or move with the arrow keys,
Home and End and press Enter, to jump there. Esc closes the overview. In plain viewing the
overview has its own toolbar button.

## Saving

Notes are saved by themselves 2 seconds after the last change, at once on every page turn,
before another PDF opens and before the window closes. Ctrl/Cmd+S (or the save button) saves
now. The save button shows a dot while there are unsaved changes; the dot turns red when saving
failed; Inkslide then keeps retrying. If the notes cannot be saved when you close the window,
Inkslide asks before closing.

### Where notes are stored

- **Desktop:** next to the PDF as `<name>.pdf.notes.json` (e.g. `lecture.pdf.notes.json`).
  Copy or move it together with the PDF. If the PDF's folder is read-only, the notes go to the
  app's own storage instead (`~/.config/Inkslide/notes/` on Linux,
  `%APPDATA%\Inkslide\notes\` on Windows, `~/Library/Application Support/Inkslide/notes/` on
  macOS), named after the PDF's checksum. Inkslide finds them there again.
- **Browser:** in the browser's storage for the site, keyed by the PDF's checksum, so the same
  PDF finds its notes again under any name. Clearing the site data deletes them; export a PDF
  with notes to keep a copy.

If saved notes exist but cannot be read (a damaged file, one made by a newer Inkslide, or one a
sync app is holding), Inkslide tries again a second later. If they still cannot be read:

- On the desktop, if there is a backup (below), it asks *The notes file could not be read
  (<reason>). Open the backup from <time> instead?* **OK** opens the backup.
- Otherwise, or after **Cancel**, it asks whether to open the PDF anyway, because new notes
  would replace the saved ones. **Cancel** leaves everything as it is.

When the desktop app opens the PDF either way, it first keeps the unreadable file as it was, in
its own storage: `notes/<checksum>.notes.unreadable.json` (in `~/.config/Inkslide/` on Linux,
`%APPDATA%\Inkslide\` on Windows, `~/Library/Application Support/Inkslide/` on macOS). A
message says where. Only the latest such copy per PDF is kept.

**Getting the notes back from that copy:** copy the file somewhere else first. If it was made by
a newer Inkslide, close this one, copy it over `<name>.pdf.notes.json` next to the PDF and open
the PDF in the newer version. Otherwise repair it if you can (it is JSON text) and load it with
**File → Import Notes…**. If the copy cannot be made, Inkslide says so and asks before opening.
Kept copies are deleted after 90 days (below), so recover what you need before then.

### Backup (desktop)

The desktop app keeps one backup of each PDF's notes in its own storage
(`notes/<checksum>.notes.backup.json`, next to the notes it keeps there, see above), never in
the PDF's folder. When a save is about to replace the notes, the notes as they were saved
before are copied to the backup first, if the backup is missing or more than 2 minutes old.
So the backup is the state of a few minutes ago. Empty notes and notes that cannot be read are
never copied, and the backup stays when you close the PDF.

**File → Revert to Backup…** puts it back: after asking *Replace the current notes with the
backup from <time>?*, the backup becomes the notes and the notes you had become the backup,
so choosing Revert to Backup again undoes it. Unsaved strokes are saved first. Revert is not an
undo step (Ctrl/Cmd+Z does not take it back); it is greyed out while there is no backup. The
backup has the format of a notes file, so **File → Import Notes…** can load it too.

**File → Keep a Backup of the Notes** turns backups on and off (on by default; the choice is
remembered). Turning it off deletes the backups of all PDFs (not the kept unreadable files)
and greys out Revert to Backup.

Backups and kept unreadable files older than 90 days are deleted when Inkslide starts. The
browser, the PWA and the iPad and Android apps keep no backup.

### Notes from a Marp deck

Notes saved by the annotation mode of a Marp HTML deck can be imported into the PDF of that
deck: the import button (File → Import Notes… on the desktop) or drop the `.json` file on the
window. The strokes are scaled to the PDF pages (usually by 0.75). Importing replaces the
notes of the open PDF, after asking.

Warnings appear when the notes seem to belong to another document (different title,
checksum, page count or page size). The notes load anyway.

## Export

The PDF button (desktop: File → Export Annotated PDF…, Ctrl/Cmd+E) writes a copy of the PDF
with your ink as vector graphics and the blank pages inserted, named `<name>-notes.pdf`. The
text of the original stays selectable. The original PDF cannot be overwritten. On the web, the
file is saved through a save dialog where the browser has one; on an iPad (or another touch
device) the share sheet opens, where **Save to Files** stores it; otherwise it is downloaded.
If the export took a while, tap **Save or share…** in the message that appears.

A PDF protected against changes by its author (encrypted with an owner password) opens and
can be annotated, but cannot be exported or printed with the notes: save an unprotected copy
first, for example with `qpdf --decrypt in.pdf out.pdf`.

## Print

The printer button, Ctrl/Cmd+P or (desktop) File → Print… prints what the export contains: the
PDF pages with your ink and the blank pages. On the desktop the system print dialog prints the
annotated PDF itself, so text and ink stay sharp and every page keeps its size. In the browser
the pages are printed as images at 200 dpi (Safari cannot print a PDF from a web page
reliably); each page gets its own paper size where the browser supports it (Chrome, Edge,
Safari 18.2 and later).

## Presenter mode (desktop)

**View → Presenter Mode** (or **F5**) opens a second window for the projector: the audience
window. It shows the page you are on, your ink (also the stroke you are writing), the laser
pointer and blank pages, filling the window on black, with no toolbar. You keep writing in
the main window; the audience window takes no input.

- With a second display (a projector or an external screen), the audience window opens full
  screen on it. With one display, it opens as a small window: move it to the other screen
  and press **F11** there to make it full screen.
- The audience window always shows the whole page; zooming or fit width in the main window
  does not change it. Erasing and moving strokes show there once they are done.
- **F5** again, View → Presenter Mode, or **Esc** in the audience window ends presenter mode,
  as does closing the audience window. Closing the main window closes it too.
- Many presenter remotes send F5 for their "start presentation" button.
- PDFs larger than 256 MB are not mirrored; the audience window says so.

The browser and the iPad and Android apps have no presenter mode yet.

## Other keys

| Key | Action |
|---|---|
| F5 | Presenter mode on or off (desktop) |
| Ctrl/Cmd+O | Open a PDF |
| Ctrl/Cmd+S | Save the notes now |
| Ctrl/Cmd+E | Export annotated PDF (desktop menu) |
| Ctrl/Cmd+P | Print with the notes |
| Ctrl/Cmd+Q | Quit (desktop, Linux and Windows) |
| Alt | Show the hidden menu bar (desktop, Linux and Windows; View → Hide Menu Bar) |

Tool and size keys follow the physical key position, so they work with any keyboard layout.
