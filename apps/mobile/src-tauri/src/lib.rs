//! Inkslide for iPad and Android: a Tauri 2 window around the web front end
//! (`apps/web/dist`). Sharing is the sharekit plugin, called from Rust; the
//! front end's adapter is `apps/web/src/platform/tauri.ts`.
//!
//! The web view has no fs plugin permission at all and no file dialog of its
//! own. The dialog plugin's open and save commands add every chosen file to
//! the fs scope, and on mobile the fs plugin reads and writes file and
//! content URLs without checking the scope, so any fs permission would let
//! the page read whatever the app can reach and overwrite the user's PDFs.
//! Every file access goes through the commands below instead:
//!
//! - `pick_file` opens the system picker and remembers the chosen file;
//!   `read_picked` reads only files picked that way in this session.
//! - `read_notes` / `write_notes` take a notes key, not a path, and stay in
//!   `notes/` of the app data directory.
//! - `write_share_file` / `remove_share_file` take a checked file name and
//!   stay in the share folder; `share_pdf` hands such a file, written in this
//!   session, to the share sheet. The web view has no sharekit permission: the
//!   plugin's own command shares any file URL it is given.
//! - `save_pdf` opens the save dialog itself and writes only to the file
//!   chosen there, which the web view never sees.
//!
//! The dialog, fs and sharekit plugins are still used from Rust (`DialogExt`,
//! `FsExt`: content URIs on Android, security-scoped URLs on iOS; `ShareExt`).
//!
//! Known limit: on iOS and Android the dialog plugin's Rust API
//! (`blocking_pick_file`, `blocking_save_file`) reports a failed dialog (no
//! activity, a provider error) as `None`, the same as a cancel, so
//! `pick_file` and `save_pdf` answer such a failure as "cancelled" (null,
//! false) and the page shows nothing. The plugin gives no way to tell them
//! apart on top of these calls.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, Runtime, State, Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_fs::{FsExt, OpenOptions};
use tauri_plugin_sharekit::{ShareExt, ShareFileOptions};

/// Suffix of a notes file (`NOTES_SUFFIX` of `@inkslide/annotate/io`).
const NOTES_SUFFIX: &str = ".notes.json";
/// Max. bytes of a notes key: the file name, with the suffix and a temp extension, stays far below 255.
const MAX_KEY_BYTES: usize = 200;
/// Max. bytes of a shared file's name (200 before ".pdf", as `shareName` of tauri.ts).
const MAX_SHARE_NAME_BYTES: usize = 204;
/// Max. size of a PDF the web view hands over (export, share): `MAX_FILE_BYTES`
/// of tauri.ts, which refuses larger files before encoding them. Android sends
/// base64, a string a third larger, and web views cap strings at a few hundred
/// MB; Tauri has also built the whole request before this check runs.
const MAX_FILE_BYTES: usize = 256 << 20;

/// A notes key (the PDF's SHA-256 in hex, or `name-<safe name>`): 1 to 200 of `[A-Za-z0-9_-]`.
fn notes_key(key: &str) -> Result<&str, String> {
    let ok = !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok { Ok(key) } else { Err(format!("invalid notes key: {key:?}")) }
}

/// A shared file's name: one plain path component ending in `.pdf`, no
/// separators, `:` or control characters (C0, DEL, C1), not hidden, at most 204 bytes.
fn share_name(name: &str) -> Result<&str, String> {
    let base = name.strip_suffix(".pdf").unwrap_or("");
    let ok = !base.is_empty()
        && name.len() <= MAX_SHARE_NAME_BYTES
        && !name.starts_with('.')
        && !name.starts_with(' ')
        && !name.chars().any(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
        && Path::new(name).file_name().and_then(|f| f.to_str()) == Some(name);
    if ok { Ok(name) } else { Err(format!("invalid file name: {name:?}")) }
}

/// Decodes a percent-encoded header value (`encodeURIComponent` in the web view).
fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
            let byte = hex.and_then(|h| u8::from_str_radix(h, 16).ok());
            out.push(byte.ok_or_else(|| format!("bad percent-encoding: {value:?}"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("not UTF-8: {value:?}"))
}

/// The file bytes and name of a request, in one of two forms:
/// - a raw body with the name percent-encoded in the `name` header (iOS, desktop);
/// - JSON `{ name, data }` with `data` a base64 string (Android, where Tauri
///   has no raw bodies).
/// A JSON number array is refused: Tauri would hold it as a `serde_json::Value`
/// of ~32 bytes per byte, unbounded, before any check here.
fn payload<'a>(body: &'a InvokeBody, name_header: Option<&str>) -> Result<(Cow<'a, [u8]>, String), String> {
    match body {
        InvokeBody::Raw(bytes) => {
            if bytes.len() > MAX_FILE_BYTES {
                return Err("file too large".into());
            }
            let name = name_header.ok_or("missing name header")?;
            Ok((Cow::Borrowed(bytes), percent_decode(name)?))
        }
        InvokeBody::Json(json) => {
            let name = json.get("name").and_then(|n| n.as_str()).ok_or("missing name")?.to_owned();
            let bytes = match json.get("data") {
                Some(serde_json::Value::String(b64)) => {
                    if b64.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
                        return Err("file too large".into());
                    }
                    base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("bad base64: {e}"))?
                }
                _ => return Err("missing data: a base64 string".into()),
            };
            if bytes.len() > MAX_FILE_BYTES {
                return Err("file too large".into());
            }
            Ok((Cow::Owned(bytes), name))
        }
    }
}

/// [`payload`] of a request.
fn request_payload<'a>(request: &'a Request<'_>) -> Result<(Cow<'a, [u8]>, String), String> {
    let header = request.headers().get("name").and_then(|v| v.to_str().ok());
    payload(request.body(), header)
}

/// A temp file name next to `file`, unique within this process and run.
fn temp_name(file: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("{file}.{nanos:x}{:x}.tmp", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Writes `data` to `dir/file` through a temp file (flushed to disk), renames
/// it, then flushes the directory so the rename survives a power cut.
fn write_atomic(dir: &Path, file: &str, data: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(temp_name(file));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        fs::rename(&tmp, dir.join(file))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    sync_dir(dir);
    Ok(())
}

/// fsync of a directory, where the platform supports it (not on Windows, where
/// a directory can not be opened as a file); errors are ignored, the data is
/// already written.
fn sync_dir(dir: &Path) {
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

/// Where shared files go. iOS: the app's tmp/, where the share plugin copies
/// the file to anyway. Elsewhere: cache/share/ (on Android the plugin copies
/// it into the cache root for its FileProvider).
fn share_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    #[cfg(target_os = "ios")]
    let dir = app.path().temp_dir();
    #[cfg(not(target_os = "ios"))]
    let dir = app.path().app_cache_dir().map(|d| d.join("share"));
    dir.map_err(|e| e.to_string())
}

/// Names of the files `write_share_file` wrote to the share folder in this
/// session and `remove_share_file` has not removed: the only ones `share_pdf` shares.
#[derive(Default)]
struct Shared(Mutex<HashSet<String>>);

impl Shared {
    fn add(&self, name: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(name.to_owned());
    }

    fn remove(&self, name: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(name);
    }

    fn check(&self, name: &str) -> Result<(), String> {
        let shared = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if shared.contains(name) { Ok(()) } else { Err(format!("not a file written for sharing: {name:?}")) }
    }
}

/// The file URL of `dir/name` for the share plugin, if that is a regular file
/// (not a link, which could point anywhere).
fn shared_file_url(dir: &Path, name: &str) -> Result<String, String> {
    let path = dir.join(share_name(name)?);
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() {
        return Err(format!("not a regular file: {name:?}"));
    }
    Url::from_file_path(&path).map(String::from).map_err(|()| format!("no file URL for {name:?}"))
}

fn notes_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("notes"))
}

/// Files picked with `pick_file` in this session, by the id handed to the web view.
#[derive(Default)]
struct Picked(Mutex<HashMap<String, FilePath>>);

impl Picked {
    fn add(&self, file: FilePath) -> String {
        let id = file.to_string();
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), file);
        id
    }

    fn get(&self, id: &str) -> Result<FilePath, String> {
        let picked = self.0.lock().unwrap_or_else(|e| e.into_inner());
        picked.get(id).cloned().ok_or_else(|| "not a file picked in this session".to_owned())
    }
}

/// The picker's filter for a kind of file the web view may ask for.
fn picker_filter(kind: &str) -> Result<(&'static str, &'static [&'static str]), String> {
    match kind {
        "pdf" => Ok(("PDF", &["pdf"])),
        "notes" => Ok(("Notes", &["json"])),
        _ => Err(format!("unknown kind of file: {kind:?}")),
    }
}

/// Opens the system picker for a PDF or a notes file; the picked file's path
/// or URI (also its id for `read_picked`), null if cancelled.
#[tauri::command]
async fn pick_file<R: Runtime>(app: AppHandle<R>, picked: State<'_, Picked>, kind: String) -> Result<Option<String>, String> {
    let (name, extensions) = picker_filter(&kind)?;
    Ok(app.dialog().file().add_filter(name, extensions).blocking_pick_file().map(|f| picked.add(f)))
}

/// Options to read a file. `OpenOptions::new()` of plugin-fs has `read: false`
/// (only its JSON form defaults to true), which `std` refuses to open.
fn read_options() -> OpenOptions {
    let mut opts = OpenOptions::new();
    opts.read(true);
    opts
}

/// All bytes of the file `open` opens with [`read_options`].
fn read_all(open: impl FnOnce(OpenOptions) -> std::io::Result<fs::File>) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open(read_options())?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The bytes of a file picked with `pick_file` in this session; any other path is refused.
#[tauri::command]
async fn read_picked<R: Runtime>(app: AppHandle<R>, picked: State<'_, Picked>, id: String) -> Result<Response, String> {
    let file = picked.get(&id)?;
    let read = read_all(|opts| app.fs().open(file.clone(), opts));
    #[cfg(target_os = "ios")]
    let _ = app.fs().stop_accessing_security_scoped_resource(file);
    #[cfg(not(target_os = "ios"))]
    drop(file);
    Ok(Response::new(read.map_err(|e| e.to_string())?))
}

/// Reads the notes of a PDF (app data `notes/<key>.notes.json`); null if there are none.
#[tauri::command]
async fn read_notes<R: Runtime>(app: AppHandle<R>, key: String) -> Result<Option<String>, String> {
    let path = notes_dir(&app)?.join(format!("{}{NOTES_SUFFIX}", notes_key(&key)?));
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes the notes of a PDF: app data `notes/<key>.notes.json`.
#[tauri::command]
async fn write_notes<R: Runtime>(app: AppHandle<R>, key: String, text: String) -> Result<(), String> {
    let key = notes_key(&key)?;
    write_atomic(&notes_dir(&app)?, &format!("{key}{NOTES_SUFFIX}"), text.as_bytes()).map_err(|e| e.to_string())
}

/// Writes a PDF to the share folder under a checked name (see [`payload`]), for `share_pdf`.
#[tauri::command]
async fn write_share_file<R: Runtime>(app: AppHandle<R>, shared: State<'_, Shared>, request: Request<'_>) -> Result<(), String> {
    let (bytes, name) = request_payload(&request)?;
    write_atomic(&share_dir(&app)?, share_name(&name)?, &bytes).map_err(|e| e.to_string())?;
    shared.add(&name);
    Ok(())
}

/// Hands a PDF that `write_share_file` wrote in this session to the share
/// sheet, titled with its file name. The plugin's errors are passed on as they
/// are (its "Share cancelled" when the user dismissed the sheet).
#[tauri::command]
async fn share_pdf<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    shared: State<'_, Shared>,
    name: String,
) -> Result<(), String> {
    shared.check(&name)?;
    let url = shared_file_url(&share_dir(&app)?, &name)?;
    let options = ShareFileOptions { mime_type: Some("application/pdf".into()), title: Some(name), position: None };
    app.share().share_file(window, url, options).map_err(|e| e.to_string())
}

/// Removes a file from the share folder; a missing file is no error.
#[tauri::command]
async fn remove_share_file<R: Runtime>(app: AppHandle<R>, shared: State<'_, Shared>, name: String) -> Result<(), String> {
    let path = share_dir(&app)?.join(share_name(&name)?);
    shared.remove(&name);
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Asks where to save a PDF (see [`payload`]; the name is the suggested one)
/// and writes it there; false if the user cancelled. The target is only the
/// file picked in this dialog, which the web view never sees.
#[tauri::command]
async fn save_pdf<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<bool, String> {
    let (bytes, name) = request_payload(&request)?;
    let Some(target) = app.dialog().file().set_file_name(name).add_filter("PDF", &["pdf"]).blocking_save_file() else {
        return Ok(false);
    };
    let mut opts = OpenOptions::new();
    opts.read(false).write(true).create(true).truncate(true);
    let mut file = app.fs().open(target, opts).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sharekit::init())
        .manage(Picked::default())
        .manage(Shared::default())
        .setup(|_app| {
            // The smoke test (apps/mobile/test/smoke.mjs, built with --features smoke) can not use
            // the picker: it hands over one file as if picked.
            #[cfg(feature = "smoke")]
            if let Some(path) = std::env::var_os("INKSLIDE_SMOKE_PICK") {
                _app.state::<Picked>().add(FilePath::from(PathBuf::from(path)));
            }
            Ok(())
        })
        // build.rs lists the same commands (an `allow-<command>` permission each).
        .invoke_handler(tauri::generate_handler![
            pick_file, read_picked, read_notes, write_notes, save_pdf, write_share_file, share_pdf, remove_share_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Inkslide");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notes_keys() {
        let sha = "0123456789abcdef".repeat(4);
        assert_eq!(notes_key(&sha), Ok(sha.as_str()));
        assert!(notes_key("name-Lecture_1_pdf").is_ok());
        assert!(notes_key(&"x".repeat(200)).is_ok());
        for bad in ["", "..", ".", "a/b", "a\\b", "../x", "/etc/passwd", "a.b", "a b", "a\0b", "Ä", "C:x"] {
            assert!(notes_key(bad).is_err(), "{bad:?}");
        }
        assert!(notes_key(&"x".repeat(201)).is_err());
    }

    #[test]
    fn share_names() {
        for good in ["deck-notes.pdf", "My deck (1).pdf", "講義.pdf", "a..b.pdf", "x.notes.json.pdf"] {
            assert_eq!(share_name(good), Ok(good));
        }
        assert!(share_name(&format!("{}.pdf", "x".repeat(200))).is_ok());
        for bad in [
            "", ".pdf", "..pdf", "../a.pdf", "a/b.pdf", "a\\b.pdf", "/tmp/a.pdf", "C:a.pdf", ".hidden.pdf",
            " a.pdf", "a\nb.pdf", "a\0.pdf", "a\u{85}.pdf", "a\u{9f}.pdf", "a.PDF", "a.pdf/", "a.json", "..", ".",
        ] {
            assert!(share_name(bad).is_err(), "{bad:?}");
        }
        assert!(share_name(&format!("{}.pdf", "x".repeat(201))).is_err());
    }

    /// The same cases as apps/web/test/tauri-adapter.test.ts: what the front
    /// end's `shareName` makes of each input is accepted here, the input itself
    /// (where marked bad) is not.
    #[test]
    fn share_names_match_the_front_end() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../test/share-names.json")).expect("share-names.json");
        assert!(cases.len() > 10);
        for case in cases {
            let (input, output) = (case["input"].as_str().unwrap(), case["output"].as_str().unwrap());
            assert_eq!(share_name(output), Ok(output), "output of {input:?}");
            if case["bad"].as_bool() == Some(true) {
                assert!(share_name(input).is_err(), "{input:?}");
            }
        }
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("My%20deck%20%231.pdf").unwrap(), "My deck #1.pdf");
        assert_eq!(percent_decode("%E8%AC%9B.pdf").unwrap(), "講.pdf");
        assert_eq!(percent_decode("..%2Fx.pdf").unwrap(), "../x.pdf"); // decoded, then rejected by share_name
        assert!(percent_decode("a%2").is_err());
        assert!(percent_decode("a%zz").is_err());
        assert!(percent_decode("%FF").is_err());
    }

    #[test]
    fn payload_raw_with_name_header() {
        let body = InvokeBody::Raw(vec![37, 80, 68, 70]);
        let (bytes, name) = payload(&body, Some("My%20deck.pdf")).unwrap();
        assert_eq!((&*bytes, name.as_str()), (&[37u8, 80, 68, 70][..], "My deck.pdf"));
        assert!(payload(&body, None).is_err());
    }

    #[test]
    fn payload_json_base64() {
        let body = InvokeBody::Json(json!({ "name": "a.pdf", "data": "JVBERg==" }));
        let (bytes, name) = payload(&body, None).unwrap();
        assert_eq!((&*bytes, name.as_str()), (&b"%PDF"[..], "a.pdf"));
        let empty = InvokeBody::Json(json!({ "name": "a.pdf", "data": "" }));
        assert!(payload(&empty, None).unwrap().0.is_empty());
        for bad in ["JVBERg=", "%%%%", "JVBE Rg=="] {
            assert!(payload(&InvokeBody::Json(json!({ "name": "a.pdf", "data": bad })), None).is_err(), "{bad}");
        }
    }

    #[test]
    fn payload_refuses_number_arrays() {
        let body = InvokeBody::Json(json!({ "name": "a.pdf", "data": [0, 37, 255] }));
        assert!(payload(&body, None).is_err());
    }

    #[test]
    fn payload_size_limit() {
        // Base64 of exactly MAX_FILE_BYTES zero bytes (256 MiB is 1 mod 3: the last group is "AA==").
        assert_eq!(MAX_FILE_BYTES % 3, 1);
        let body = "A".repeat(MAX_FILE_BYTES.div_ceil(3) * 4 - 4);
        let ok = InvokeBody::Json(json!({ "name": "a.pdf", "data": format!("{body}AA==") }));
        assert_eq!(payload(&ok, None).unwrap().0.len(), MAX_FILE_BYTES);
        let one_more = InvokeBody::Json(json!({ "name": "a.pdf", "data": format!("{body}AAA=") }));
        assert!(payload(&one_more, None).is_err());
        let longer = InvokeBody::Json(json!({ "name": "a.pdf", "data": format!("{body}AAAAAAAA") }));
        assert!(payload(&longer, None).is_err());
        assert!(payload(&InvokeBody::Raw(vec![0; MAX_FILE_BYTES + 1]), Some("a.pdf")).is_err());
        assert!(payload(&InvokeBody::Raw(vec![0; MAX_FILE_BYTES]), Some("a.pdf")).is_ok());
    }

    /// The read path of `read_picked`, with the options turned into std's as plugin-fs does on
    /// the desktop and for iOS file URLs (Android content URIs map them to mode "r").
    #[test]
    fn reads_a_file_with_the_read_options() {
        let path = std::env::temp_dir().join(temp_name("inkslide-read-test.pdf"));
        fs::write(&path, b"%PDF-1.4 test").unwrap();
        let bytes = read_all(|opts| std::fs::OpenOptions::from(opts).open(&path));
        fs::remove_file(&path).unwrap();
        assert_eq!(bytes.unwrap(), b"%PDF-1.4 test");
        // What the read path did before: plugin-fs's OpenOptions::new() alone does not read.
        assert!(std::fs::OpenOptions::from(OpenOptions::new()).open(std::env::temp_dir()).is_err());
    }

    #[test]
    fn payload_json_needs_name_and_data() {
        assert!(payload(&InvokeBody::Json(json!({ "data": "" })), Some("a.pdf")).is_err());
        assert!(payload(&InvokeBody::Json(json!({ "name": "a.pdf" })), None).is_err());
        assert!(payload(&InvokeBody::Json(json!({ "name": "a.pdf", "data": { "0": 1 } })), None).is_err());
        assert!(payload(&InvokeBody::Json(json!([1, 2])), None).is_err());
    }

    #[test]
    fn picker_kinds() {
        assert_eq!(picker_filter("pdf"), Ok(("PDF", &["pdf"][..])));
        assert_eq!(picker_filter("notes"), Ok(("Notes", &["json"][..])));
        assert!(picker_filter("any").is_err());
    }

    #[test]
    fn reads_only_picked_files() {
        let picked = Picked::default();
        assert!(picked.get("/etc/passwd").is_err());
        let id = picked.add(FilePath::from(PathBuf::from("/home/me/deck.pdf")));
        assert_eq!(id, "/home/me/deck.pdf");
        assert!(picked.get(&id).is_ok());
        assert!(picked.get("/home/me/other.pdf").is_err());
        let url = picked.add("content://com.android.providers/document/42".parse::<FilePath>().unwrap());
        assert!(picked.get(&url).is_ok());
        assert!(picked.get("content://com.android.providers/document/43").is_err());
    }

    #[test]
    fn shares_only_files_written_for_sharing() {
        let shared = Shared::default();
        assert!(shared.check("a.pdf").is_err());
        shared.add("a.pdf");
        assert!(shared.check("a.pdf").is_ok());
        assert!(shared.check("b.pdf").is_err());
        shared.remove("a.pdf");
        assert!(shared.check("a.pdf").is_err());
    }

    #[test]
    fn shared_file_urls() {
        let dir = std::env::temp_dir().join(format!("inkslide-test-{}", temp_name("s")));
        write_atomic(&dir, "My deck #1.pdf", b"%PDF").unwrap();
        let url = shared_file_url(&dir, "My deck #1.pdf").unwrap();
        assert!(url.starts_with("file:///") && url.ends_with("/My%20deck%20%231.pdf"), "{url}");
        assert_eq!(Url::parse(&url).unwrap().to_file_path().unwrap(), dir.join("My deck #1.pdf"));
        // Missing, not a share name, a folder.
        assert!(shared_file_url(&dir, "missing.pdf").is_err());
        assert!(shared_file_url(&dir, "../My deck #1.pdf").is_err());
        fs::create_dir(dir.join("d.pdf")).unwrap();
        assert!(shared_file_url(&dir, "d.pdf").is_err());
        // A link, even to a file in the folder.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("My deck #1.pdf"), dir.join("link.pdf")).unwrap();
            assert!(shared_file_url(&dir, "link.pdf").is_err());
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writes_atomically_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("inkslide-test-{}", temp_name("w")));
        write_atomic(&dir, "a.notes.json", b"one").unwrap();
        write_atomic(&dir, "a.notes.json", b"two").unwrap();
        assert_eq!(fs::read(dir.join("a.notes.json")).unwrap(), b"two");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        // A rename onto a directory fails; the temp file is removed.
        fs::create_dir(dir.join("d")).unwrap();
        assert!(write_atomic(&dir, "d", b"x").is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn temp_names_are_unique() {
        assert_ne!(temp_name("a"), temp_name("a"));
        assert!(temp_name("a.notes.json").starts_with("a.notes.json."));
        assert!(temp_name("a").ends_with(".tmp"));
    }
}
