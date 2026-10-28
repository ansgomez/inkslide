# User guide

Inkslide opens a PDF one page at a time, fitted to the window, and lets you write on it with a
pen. Your ink is saved automatically in a separate notes file; the PDF is never changed.

## Opening a PDF

- **Desktop:** File → Open… (Ctrl/Cmd+O), File → Open Recent, drop a PDF on the window, open it
  with Inkslide from the file manager ("Open With"), or start `inkslide lecture.pdf`. The
  start page lists the recently opened PDFs that still exist, with the pages that have notes:
  click one to open it with its notes, × removes it from the list. Opening
  a second PDF while Inkslide runs uses the same window. Inkslide opens local files only: a PDF
  on a network location (sftp://, smb://) has to be copied to the computer first.
- **Browser:** the **Open PDF…** button (Ctrl/Cmd+O) or drop a PDF on the page. A link
  `…/?pdf=<url>` opens a PDF from the same site as Inkslide (not from other sites). The
  start page lists the recently opened PDFs: click one to open it again, × removes it from
  the list. Chrome and Edge reopen the file
  itself (they may ask for permission to read it again); other browsers (Safari, Firefox)
  keep a copy of the PDF in the site's storage, up to 250 MB together, the oldest first to go.

A PDF can have at most 100,000 pages; a larger one is not opened, and a message says so.

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
| Select | S | Tap a stroke to select it, drag a box, or draw a loop (lasso) around strokes. Drag the selection to move it; pick a color or size to restyle it (− and + make each selected stroke one size thinner or thicker); Delete or Backspace removes it; Esc deselects. Copy, cut, paste and duplicate: see below. |
| Laser pointer | L | A red trail that fades out. Never saved. |
| Stroke eraser | E | Removes every stroke it touches, and images it touches when it erases no stroke. |
| Partial eraser | Shift+E | Erases only the parts of strokes it touches. Images stay. |
| Snapshot | C | Drag over an area to copy it as an image: the PDF page, the paper and the ink. Paste it with Ctrl/Cmd+V, on any page. See below. |

**Colors:** black, white, red, blue, green, orange, yellow and purple. The pen and the
highlighter each remember their own color.

**Sizes:** the size control has **−** and **+** buttons (keys **[** and **]**) and between them a
dot in the current size and color. It steps through nine sizes and stops at the thinnest and
the thickest. Keys **1**–**4** pick the sizes S, M, L and XL (the 2nd, 4th, 6th and 8th of the
nine; the four sizes of earlier versions). Pen, highlighter and both erasers each remember
their own size; with the selector or the laser, − and + change the pen's size and switch to
the pen. Sizes are relative to the page: they look the same on a slide, a 960×540 PDF
or an A4 page.

## Copy and paste

With strokes selected, **Ctrl/Cmd+C** copies them, **Ctrl/Cmd+X** cuts them and
**Ctrl/Cmd+D** duplicates them on their page. **Ctrl/Cmd+V** pastes onto the shown page, also
after turning the page or opening another PDF. The pasted strokes become the selection (the
select tool is switched on), ready to drag into place. For writing with the pen alone, copy and
cut buttons appear in the toolbar while strokes are selected, and a paste button once something
was copied in this window. The keys do not work while the overview is open.

Pasted strokes keep their place on the page. Where they would cover the strokes they were
copied from (or an earlier paste), they are moved a little down and to the right, a bit further
with every paste (up or to the left where the page ends). On a page of another size they are scaled with the page, and they are always
kept on the page. A paste, a cut and a duplicate are each one undo step.

Copied strokes also go on the system clipboard where the platform allows it (as text that
other programs show as JSON), so Ctrl/Cmd+V pastes them into Inkslide in another browser
window or tab too; some browsers (Safari, Firefox) first ask to allow the paste. If something
else was copied after the strokes, Ctrl/Cmd+V pastes nothing. In the desktop app on macOS,
copied strokes stay within the app window.

**Undo** (Ctrl/Cmd+Z) and **redo** (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y) work per finished stroke,
erase, move or page change. **Clear page** (trash button) removes all ink and images on the
page and can be undone.

## Snapshots

The snapshot tool (camera button, **C**) copies an area of the page as an image. Drag a
rectangle over it with the pen, the mouse or a finger; on release the area is copied with
everything it shows (the PDF page or the paper of a blank page, images and ink), a message
says so, and the tool you used before comes back. A tap, or an area thinner than a few
points, copies nothing; a second finger cancels the drag, as does **Esc**, which also leaves
the tool.

**Ctrl/Cmd+V** or the paste button then pastes the image on the shown page: another page, a
blank page or another PDF opened in the same window. It is placed like pasted strokes: where
the area was on a page of the same size (a little down and to the right over the same image),
scaled with the page on a page of another size, and always on the page. A pasted image lies
below all ink, so you can write on it. Select it with the select tool (tap it where no stroke
is, or drag a box or lasso around it) to move, copy, cut, duplicate or delete it. The stroke
eraser (also the pen's eraser end) removes an image only in a stroke that erases no ink: erasing
what you wrote on a snapshot leaves the snapshot, and an image the stroke already went over comes
back once it reaches ink. To remove the image itself, erase over a part without ink, or select it
and press Delete. The partial eraser never touches images. Each paste, move, erase and delete is
one undo step. Images are saved in the notes and exported and printed with them.

The image has the resolution of the page on screen (at least twice the screen size, at most
2048 pixels on its long side). Where the platform allows it, the snapshot also goes on the
system clipboard as a PNG, to paste into other programs; the desktop app does not let its pages
write to the system clipboard themselves, so there the snapshot stays within the app window. An image copied in
another program pastes into Inkslide with Ctrl/Cmd+V too (centered, at most 80 % of the page).
It wins over a snapshot that stayed within the app window: there, while the system clipboard holds
an image from another program, Ctrl/Cmd+V pastes that image and the paste button the snapshot.

A page holds at most 32 images and a PDF's notes at most 256, with about 24 MB of image data in
all; a paste beyond that is refused with a message. Notes with images are saved in a newer
format (version 3) that Inkslide versions without snapshots refuse to open rather than lose the
images; see [NOTES-FORMAT.md](NOTES-FORMAT.md#images). In the browser, very large snapshots can
exceed the site storage of browsers without OPFS; the app then reports that saving failed.

## Pen, touch and mouse

- **Pen:** draws with pressure. The **eraser end** of the pen erases (stroke eraser) whatever
  tool is chosen. The **side button**, held while writing, also uses the stroke eraser.
- **Palm rejection:** once the pen has been used, a finger never draws. While the pen touches
  or hovers the screen, and for half a second after, touch is ignored completely, so a resting
  palm neither zooms nor turns the page.
- **Touch:** before a pen has been seen, one finger draws; after that it does nothing (it
  never scrolls or pans, so a brushing hand does not move the page). Two fingers scroll and
  pan, and zoom once they pinch apart or together; a quick two-finger swipe sideways turns the
  page (to the left: next).
- **Mouse and touchpad:** the left button draws; Ctrl + wheel (or a touchpad pinch) zooms at
  the pointer; the wheel (or a two-finger touchpad scroll) moves a zoomed page or scrolls a
  page in fit-width mode.

## Pages and navigation

| Key | Action |
|---|---|
| → ↓ PgDn Space | Next page (blank pages included; in fit width PgDn and Space scroll first) |
| ← ↑ PgUp Shift+Space | Previous page (in fit width PgUp and Shift+Space scroll first) |
| W | Fit width / whole page |
| Ctrl/Cmd+= / Ctrl/Cmd+− | Zoom in / out (also Ctrl/Cmd++) |
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
the page is larger and scrolls up and down. Scroll with the wheel, the touchpad or two
fingers on the screen. **PgDn** and **Space** scroll about a screen and turn to the next page at the bottom; **PgUp** and
**Shift+Space** scroll back and, at the top, go to the bottom of the previous page. The arrow
keys still turn pages; a new page starts at its top. Pinch zoom works on top. The mode is
remembered.

The counter shows "3 / 37" on PDF page 3 of 37, "3 / 37 · +2 blank" when two blank pages
follow it, and "3 / 37 · blank 1/2" on the first of them.

### Zoom

The **−** and **+** on both sides of the page counter (or **Ctrl/Cmd+=** and **Ctrl/Cmd+−**)
zoom out and in around the middle of the view, in steps from the fitted page (whole page or
width) through 125%, 150%, 200%, 300% and 400% to 600% of it. − is greyed out at the fit, +
at 600%. Their tooltips show the zoom ("now 150% of fit page"). Pinch and Ctrl + wheel zoom
in between; the buttons then go on to the next step. A page turn and **W** start the page at
the fit again.

## Blank pages

- **B** (or the page-with-plus button) inserts a blank page after the current page, with the
  current paper.
- Paper: **plain**, **lined** (with a margin line) or **grid**. The paper button cycles plain →
  lined → grid → plain, and its icon shows the current paper. On a blank page it changes that
  page and the paper for new ones (undo takes back both); on a PDF page it sets the paper for
  new ones.
  The paper for new blank pages is remembered.
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

In the browser, a tab can be closed or reloaded before a save has finished. Leaving the page
with unsaved changes therefore also puts them in the site's small quick storage at once, and
the next time you open the PDF Inkslide uses them if they are newer than the saved notes. If
they cannot be kept there (notes with large snapshots, or that storage is full), the browser
asks whether to leave the page.

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

- If there is a backup (below; desktop and browser), it asks *The notes file could not be
  read (<reason>). Open the backup from <time> instead?* **OK** opens the backup.
- Otherwise, or after **Cancel**, it asks whether to open the PDF anyway, because new notes
  would replace the saved ones. **Cancel** leaves everything as it is.

When the desktop app opens the PDF either way, it first keeps the unreadable file as it was, in
its own storage: `notes/<checksum>.notes.unreadable.json` (in `~/.config/Inkslide/` on Linux,
`%APPDATA%\Inkslide\` on Windows, `~/Library/Application Support/Inkslide/` on macOS). A
message says where. Only the latest such copy per PDF is kept.

The browser and the installed web app (PWA) keep the copy the same way, in the browser's storage
for the site (`notes/inkslide-notes_<checksum>.notes.unreadable.json` there; the message says
so). That storage is not a folder you can open: the copy is there for a later Inkslide to
recover, or through the browser's developer tools (Application → Storage). If the copy cannot
be made (storage full, or Safari before version 26), Inkslide says so and asks before opening.

**Getting the notes back from that copy:** copy the file somewhere else first. If it was made by
a newer Inkslide, close this one, copy it over `<name>.pdf.notes.json` next to the PDF and open
the PDF in the newer version. Otherwise repair it if you can (it is JSON text) and load it with
**File → Import Notes…**. If the copy cannot be made, Inkslide says so and asks before opening.
Kept copies are deleted after 90 days (below), so recover what you need before then.

### Backup

The desktop app keeps one backup of each PDF's notes in its own storage
(`notes/<checksum>.notes.backup.json`, next to the notes it keeps there, see above), never in
the PDF's folder. When a save is about to replace the notes, the notes as they were saved
before are copied to the backup first, if the backup is missing or more than 2 minutes old.
So the backup is the state of a few minutes ago. Empty notes and notes that cannot be read are
never copied, and the backup stays when you close the PDF.

**File → Revert to Backup…** puts it back: after asking *Replace the current notes with the
backup from <time>?*, the backup becomes the notes and the notes you had become the backup,
so choosing Revert to Backup again undoes it. Unsaved strokes are saved first, and the pen
does nothing until the backup is loaded; if the notes change meanwhile (an undo, say), they
are kept and the backup stays the backup, with a message saying so. Revert is not an
undo step (Ctrl/Cmd+Z does not take it back); it is greyed out while there is no backup. The
backup has the format of a notes file, so **File → Import Notes…** can load it too.

**File → Keep a Backup of the Notes** turns backups on and off (on by default; the choice is
remembered). Turning it off deletes the backups of all PDFs (not the kept unreadable files)
and greys out Revert to Backup.

Backups and kept unreadable files older than 90 days are deleted when Inkslide starts.

**In the browser and the installed web app (PWA)** the backup works the same way, kept in the
browser's storage for the site next to the notes. Instead of a menu, a **Revert to backup**
button (a clock with an arrow) appears in the File group of the toolbar once the PDF has a
backup; it asks the same question, and pressing it again undoes the revert. There is no switch
to turn backups off. The backup goes when the PDF is removed from the recent files on the start
screen (by you, or because newer PDFs pushed it out); its notes and a kept unreadable copy stay.
Like on the desktop, backups and kept copies older than 90 days are deleted when Inkslide
starts. If a backup that has gone is still offered, pressing the button says there is none and
hides it. Clearing the site data
deletes the backup together with the notes, so it guards against unwanted changes, not against
losing the browser's storage: export a PDF with notes for that. Safari before version 26 keeps
no backup (it cannot write that storage from the page), and neither do the iPad and Android
apps.

### Notes from a Marp deck

Notes saved by the annotation mode of a Marp HTML deck can be imported into the PDF of that
deck: the import button (File → Import Notes… on the desktop) or drop the `.json` file on the
window. The strokes are scaled to the PDF pages (usually by 0.75). Importing replaces the
notes of the open PDF, after asking.

Warnings appear when the notes seem to belong to another document (different title,
checksum, page count or page size). The notes load anyway.

## Export

The PDF button (desktop: File → Export Annotated PDF…, Ctrl/Cmd+E) writes a copy of the PDF
with your ink as vector graphics, pasted images (below the ink) and the blank pages inserted,
named `<name>-notes.pdf`. The
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

## Crash reports (desktop)

If the desktop app crashes, it writes a crash report (a minidump) to the `Crashpad` folder in
its own storage: `~/.config/Inkslide/Crashpad/` on Linux, `%APPDATA%\Inkslide\Crashpad\` on
Windows, `~/Library/Application Support/Inkslide/Crashpad/` on macOS. Nothing is uploaded;
the reports stay on your computer until you delete them. To report a crash, attach the newest
file from that folder (under `pending/` or `completed/`). A report holds part of the app's
memory, which can include text of the open PDF and your notes and file paths, so share it only
with people you would show those to.

## Presenter mode

**View → Presenter Mode** (or **F5**) opens a second window for the projector: the audience
window. It shows the page you are on, your ink (also the stroke you are writing, and strokes
as you erase or move them), the laser pointer and blank pages, filling the window on black,
with no toolbar. You keep writing in the main window; the audience window takes no input.
This is the same in the desktop app and in the browser.

- With a second display (a projector or an external screen), the audience window opens full
  screen on it. With one display, it opens as a small window; press **F11** in it to make it
  full screen.
- On Linux with Wayland, apps cannot choose the screen a window opens on, so it always opens
  as a small window: drag it to the projector. If the two screens use different scaling (for
  example a laptop at 125% or 200% and a projector at 100%), it goes full screen there by
  itself. If they use the same scaling, the app cannot tell where the window is, so press
  **F11** in it. If you leave full screen with F11, it stays a window until you move it to
  another screen or start presenter mode again. It never goes full screen on its own on the
  main window's screen.
- The audience window always shows the whole page; zooming or fit width in the main window
  does not change it.
- **F5** again, View → Presenter Mode, or **Esc** in the audience window ends presenter mode,
  as does closing the audience window. Closing the main window closes it too.
- Many presenter remotes send F5 for their "start presentation" button.
- PDFs larger than 256 MB are not mirrored; the audience window says so.

**In the browser** (and the installed web app), press **F5** with a PDF open, or click the
presenter button (a screen) at the end of the toolbar. The audience window opens as a pop-up:

- If the browser blocks it, Inkslide says so. Allow pop-ups for the site (the browser shows
  how in its address bar) and press F5 again.
- Drag the window to the projector's screen and click in it (or press **F11**) to make it
  full screen. A hint at the bottom says so; browsers let a page go full screen only on a click.
- **F5** again (in either window), the presenter button, or **Esc** in the audience window
  (when it is not full screen) ends presenter mode, as does closing the audience window.
- Reloading either window is fine: the audience window shows everything again once both are
  back. If you close the main tab (or it stops responding), the audience window waits about
  10 seconds for it, then closes.
- Each tab has its own audience window: presenting from two tabs (also a duplicated tab)
  opens two.
- While a PDF is open, F5 is presenter mode, not reload: reload with **Ctrl+R** (**Cmd+R** on
  a Mac). In a text field F5 does nothing then. Without a PDF open, F5 reloads the page as
  usual.

The iPad and Android apps have no presenter mode.

## Other keys

| Key | Action |
|---|---|
| F5 | Presenter mode on or off (with a PDF open in the browser) |
| Ctrl/Cmd+O | Open a PDF |
| Ctrl/Cmd+S | Save the notes now |
| Ctrl/Cmd+E | Export annotated PDF (desktop menu) |
| Ctrl/Cmd+P | Print with the notes |
| Ctrl/Cmd+Q | Quit (desktop, Linux and Windows) |
| Alt | Show the hidden menu bar (desktop, Linux and Windows; View → Hide Menu Bar) |

Tool and size keys follow the physical key position, so they work with any keyboard layout;
**[** and **]** follow the key label.
