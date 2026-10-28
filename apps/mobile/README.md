# @inkslide/mobile

Inkslide for the iPad and Android: a Tauri 2 shell around the web front end (`apps/web`),
using the system web view (WKWebView on iPadOS, Android System WebView). The desktop app is
Electron (`apps/desktop`); the Tauri desktop target here is only for development and the
smoke test.

| Path | Role |
|---|---|
| `src-tauri/tauri.conf.json` | App id `io.github.ansgomez.inkslide`, frontend `../../web/dist` (dev: `http://localhost:5173`), CSP, icons, iOS 17+ / Android 8+ (API 26); Tauri's own file drop is off, so drops reach the page as in the browser. |
| `src-tauri/capabilities/default.json` | All platforms: message (confirm) dialogs and the app commands `pick_file`, `read_picked`, `read_notes`, `write_notes` and `save_pdf`. No fs plugin permission and no open or save dialog command (see *File access* below). |
| `src-tauri/capabilities/share-ios.json`, `share-android.json` | The app commands `write_share_file`, `share_pdf` and `remove_share_file`. No sharekit permission: its own command shares any file URL. |
| `src-tauri/src/lib.rs` | The app: plugins dialog, fs, sharekit (all three used from Rust only), and the commands that do every file access (see *File access* below). `main.rs` runs it on the desktop. |
| `src-tauri/build.rs` | Lists the app commands, so each gets an `allow-<command>` permission that a capability must grant. |
| `../web/src/platform/tauri.ts` | The front end's `PlatformAdapter` for Tauri (selected when `window.__TAURI_INTERNALS__` exists). |
| `test/config.test.mjs` | `pnpm test`: paths, dev port, icons, both CSPs agree and allow the IPC, the capabilities stay narrow (no fs plugin permission, no open or save dialog, no sharekit command), the app commands match their permissions. |
| `test/share-names.json` | Names for shared files: what the front end's `shareName` makes of them, checked by both the Rust and the front-end tests. |
| `test/smoke.mjs` | `pnpm smoke` (Linux): builds the desktop variant with a test script (and the `smoke` feature, which hands one file to `read_picked` as if picked) and checks reading a picked file and the notes through the real plugins and commands. |

## How files work on mobile

- **Open:** the system picker (`pick_file`). iPadOS hands over a copy in the app's inbox or a
  security-scoped URL, Android a `content://` URI; `read_picked` reads both. Android does not always tell the file
  name; then the PDF is called `document.pdf` (its title comes from the PDF when it has one).
- **Notes:** in the app data directory, `notes/<sha256>.notes.json` (written by `write_notes`
  to a uniquely named `.tmp` file, flushed to disk, then renamed, and the folder flushed), not
  as a sidecar. Files from the iPad Files app are security-scoped copies or
  URLs, and Android gives content URIs: the folder next to them is usually not writable, and a
  sidecar would not travel with a copy anyway. Keyed by hash, the notes follow the PDF's
  content, whatever it is called. Import (toolbar) brings notes from elsewhere (e.g. a Marp
  deck or the desktop's `*.pdf.notes.json`).
- **Export:** iPadOS: the share sheet (Save to Files, AirDrop, Mail, Print), as the PWA does.
  Android: the system save dialog (Storage Access Framework), opened by `save_pdf`. A local
  file (the desktop target) is replaced through a temp file next to it, flushed and renamed,
  so a failed export leaves an existing file as it was (and a link there is replaced, not
  written through). A content URI has no rename: `save_pdf` writes it in place (mode `"wt"`),
  but only once the whole PDF is decoded and checked in memory, so nothing on the app's side
  can fail after the old content is gone. What is left: if the provider itself fails
  mid-write (storage full, a cloud provider disconnecting), an existing document the user
  chose to replace keeps a partial PDF, and the export reports the error.
- **Shared files:** the PDF goes to a temp file (iPadOS `tmp/<name>.pdf`, Android
  `cache/share/<name>.pdf`; path separators, `:` and control characters (C0, DEL, C1) in the name become
  `_`, and it is cut to 200 bytes). Android removes it once the share plugin has copied it;
  iPadOS shares that very file, which an activity (AirDrop, Print) may still read after the
  sheet closed, so it is removed at the next share (or when iPadOS clears `tmp/`).
- **Print:** the share sheet on both (iPadOS lists Print; Android only lists a print service
  if one accepts PDFs, else save and print from a PDF viewer). The mobile web views have no
  `window.print()`.
- **Confirm:** native alert.
- **File access:** the web view has no fs plugin permission and no open or save dialog
  command. The dialog plugin's commands add every chosen file to the fs scope, and on mobile
  (plugin-fs 2.7) the fs plugin reads and writes file and content URLs without checking the
  scope at all, so any fs permission would let the page read whatever the app can reach and
  overwrite the user's PDFs. Every file access is an app command (`src-tauri/src/lib.rs`):
  `pick_file` opens the picker from Rust and remembers the file; `read_picked` reads only
  files picked so in this session, each once per pick (a pick is forgotten once read, and at
  most the 8 latest picks not read yet are kept); `read_notes` and `write_notes` take a notes key
  (`[A-Za-z0-9_-]`, at most 200 bytes) and stay in `notes/` of the app data directory;
  `write_share_file` and `remove_share_file` take one name ending in `.pdf` (no separators,
  `:`, control characters or leading dot) and stay in the share folder; `share_pdf` takes
  such a name too and hands the share sheet only a regular file that `write_share_file` wrote
  in this session (the web view has no sharekit permission: the plugin's own `share_file`
  command shares any file URL, notes and other app files included); `save_pdf` opens the
  save dialog itself and writes only to the file picked there, which the page never sees.
  File bytes go as a raw request body with the name in a header; Android's IPC has no raw
  bodies, so there they go as JSON with the bytes in base64 (a JSON number array is refused:
  Tauri would hold it at about 32 bytes per byte). Export and share take PDFs up to 256 MiB
  (`MAX_FILE_BYTES`, the same in `lib.rs` and `tauri.ts`); the front end refuses a larger one
  with a message before encoding it, as base64 strings that large break web views. Reads are
  bounded too, whatever size a file or document provider claims: `read_picked` reads at most
  512 MiB of a picked PDF (`MAX_PICKED_PDF_BYTES`) and 256 MiB of a picked notes file, and
  refuses a larger one ("the file is larger than … MB"); `read_notes` and `write_notes` keep
  the same 256 MiB for the app's notes (`MAX_NOTES_BYTES`, also in `tauri.ts`, which does not
  send notes surely over it; the desktop's limit for notes).
- **Failed dialogs look cancelled:** on iOS and Android the dialog plugin's Rust API reports a
  picker or save dialog that failed (no activity, a provider error) as no file, the same as a
  cancel, so `pick_file` and `save_pdf` then return null / false and nothing is shown.

Share uses the community plugin [tauri-plugin-sharekit](https://github.com/Choochmeque/tauri-plugin-sharekit)
0.3.1 (MIT; the Rust crate only, called by `share_pdf`), as Tauri has no official share
plugin. On iOS it copies the file to `tmp/<name>` and silently keeps an older
file of that name, so the adapter writes the export to exactly that path. On Android it copies
the file to the root of the app cache (for its FileProvider), so the adapter writes to
`cache/share/` (a copy onto the same path would empty the file); the plugin's copy stays until
Android clears the cache.

## Prerequisites (both platforms)

- Node 22, pnpm 9, `pnpm install` at the repo root.
- Rust 1.90 or newer via rustup (`rustup` and `cargo` on the `PATH`).
- On Linux, for `pnpm check` and the smoke test (Tauri's desktop target): the WebKitGTK and
  OpenSSL development packages, on Fedora `sudo dnf install webkit2gtk4.1-devel openssl-devel
  librsvg2-devel` (see <https://v2.tauri.app/start/prerequisites/>).
- `pnpm icons` outputs present (committed; `apps/desktop/build/`), used as the desktop icons.

All commands below run in `apps/mobile` (or prefix them with `pnpm --filter @inkslide/mobile`).
`beforeDevCommand` / `beforeBuildCommand` start or build `apps/web` themselves.

## Android (Linux, macOS or Windows)

1. Install [Android Studio](https://developer.android.com/studio). In *Settings → Languages &
   Frameworks → Android SDK*: *SDK Platforms*: Android 15 (API 35); *SDK Tools*: Android SDK
   Build-Tools, NDK (Side by side), Android SDK Command-line Tools, Android SDK Platform-Tools.
2. Environment (e.g. in `~/.zshrc`; paths for a default install):

   ```sh
   # Linux (macOS: "/Applications/Android Studio.app/Contents/jbr/Contents/Home" and ~/Library/Android/sdk)
   export JAVA_HOME=/opt/android-studio/jbr
   export ANDROID_HOME="$HOME/Android/Sdk"
   export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk" | sort -V | tail -1)"
   export PATH="$ANDROID_HOME/platform-tools:$PATH"
   ```

3. Rust targets:

   ```sh
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```

4. Create the Android project (once; commit `src-tauri/gen/android`), then the app icons:

   ```sh
   pnpm tauri android init
   pnpm tauri icon ../../assets/icon/inkslide.svg   # writes gen/android/.../mipmap-*; src-tauri/icons/ is not used
   ```

5. Run on an emulator (start one in Android Studio's Device Manager) or a USB device with USB
   debugging on:

   ```sh
   pnpm tauri android dev            # add --host if a device cannot reach the dev server
   ```

6. Build an APK and install it:

   ```sh
   pnpm tauri android build --apk --debug
   adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
   ```

   A release APK or AAB (`pnpm tauri android build --apk` / `--aab`) must be signed: create a
   keystore and add the signing config to `gen/android/app/build.gradle.kts` as in
   <https://v2.tauri.app/distribute/sign/android/>.

## iPad (on a Mac)

1. Install Xcode from the App Store, open it once (accept the license, install the iOS
   platform), then `xcode-select --install` and `brew install cocoapods`.
2. Rust targets (`aarch64-apple-ios-sim` is the simulator on Apple silicon):

   ```sh
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim
   ```

3. Signing: add your Apple ID in *Xcode → Settings → Accounts*. Put your team id in
   `tauri.conf.json` (`"bundle": { "iOS": { "developmentTeam": "ABCDE12345", … } }`) or export
   `APPLE_DEVELOPMENT_TEAM=ABCDE12345` before `init`. A free Apple ID can install on your own
   iPad, but the app stops launching after 7 days; the Apple Developer Program (99 USD/year)
   gives one-year profiles and TestFlight.
4. Create the Xcode project (once; commit `src-tauri/gen/apple`), then the app icons:

   ```sh
   pnpm tauri ios init
   pnpm tauri icon ../../assets/icon/inkslide.svg   # writes gen/apple/Assets.xcassets/AppIcon.appiconset
   ```

5. Run in the simulator or on the iPad (USB or same Wi-Fi, *Developer Mode* on in the iPad's
   *Settings → Privacy & Security*; trust the developer certificate in *Settings → General →
   VPN & Device Management* the first time):

   ```sh
   pnpm tauri ios dev            # pick the simulator or the iPad (it gets the dev server's network address)
   pnpm tauri ios dev --open     # or run from Xcode
   ```

6. Build: `pnpm tauri ios build` (an IPA in `src-tauri/gen/apple/build/`; `--export-method
   debugging` for your own devices, `app-store-connect` for TestFlight / the App Store).

The `ios` subcommands exist only in the CLI on macOS, so their flags above are from the Tauri
2 documentation and were not run here.

## Checks on this side

```sh
pnpm --filter @inkslide/mobile test     # config checks (node:test)
pnpm --filter @inkslide/mobile check    # cargo check of src-tauri (desktop target)
cargo test --manifest-path apps/mobile/src-tauri/Cargo.toml   # name, payload and picked-file checks of the commands
pnpm --filter @inkslide/web build:tauri && pnpm --filter @inkslide/mobile smoke   # Linux, WebKitGTK; a window flashes
pnpm --filter @inkslide/web test        # includes test/tauri-adapter.test.ts (mocked IPC)
```

The smoke test builds into `src-tauri/target/smoke` with `TAURI_CONFIG` pointing the frontend
at a copy of `apps/web/dist` plus a test script, and a temporary `XDG_DATA_HOME`. It covers
`read_picked` (a picked file is read, another refused), the `read_notes` and `write_notes`
commands and their permissions, the CSP with the IPC, and the adapter's notes path. On
WebKitGTK, IPC calls made before the page's `load` event can hang; the app makes none.

## Not tested yet (needs the devices)

Nothing here has run on Android or iOS: the SDKs are not installed on the development
machine. To check on the devices:

- `android init` / `ios init` and the builds with these plugins (Gradle, CocoaPods / Swift
  packages), the icons, the minimum versions (iOS 17, Android API 26).
- Opening PDFs from the picker: iPad Files (local, iCloud Drive, other providers), Android
  Downloads, Drive; large PDFs over the IPC; the file names.
- Notes written and read again after restarting the app; app data kept across updates.
- Export: iPad share sheet (Save to Files, AirDrop) and Android save dialog; print through the
  share sheet on both; the share sheet's position on the iPad (centre of the window).
- Confirm dialogs (unsaved notes) and import of a notes file (Android's picker may grey out
  `.json` files whose MIME type the provider reports as something else).
- Pen input in WKWebView and Android System WebView: Pencil pressure, palm rejection, hover,
  two-finger swipe; safe areas and the status bar; rotation.

Known gaps: Android's share chooser reports most completed shares as cancelled, so after a
print through it a warning about the export is not shown. No recent files on the start screen (web only), no "Open in Inkslide" from other
apps (file associations / intent filters and `onOpenRequest`), notes are not visible in the
Files app (they are in Application Support, which iCloud backup includes).

Licenses: the app ships `THIRD_PARTY_NOTICES.md` inside the web build, which covers the
front end and counts the Rust crates per license (`pnpm notices --rust`, from
`cargo metadata`). A store release should also bundle the crates' full license texts (for
example with `cargo about generate`); five crates pulled in by Tauri are MPL-2.0.
