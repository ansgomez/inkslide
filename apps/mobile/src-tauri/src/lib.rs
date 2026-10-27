//! Inkslide for iPad and Android: a Tauri 2 window around the web front end
//! (`apps/web/dist`). File access is the dialog and fs plugins (read only),
//! sharing the sharekit plugin; the front end's adapter is
//! `apps/web/src/platform/tauri.ts`.
//!
//! The web view may not write, remove or rename files through the fs plugin:
//! the dialog plugin adds every picked file (the user's PDFs) to the fs scope,
//! and on mobile the fs plugin writes file and content URLs without a scope
//! check. Every write goes through the commands below instead. They take a
//! validated file name, never a path, and only write in the app's own folders
//! (`notes/` in the app data directory, the share folder), or to the file
//! the user picks in a save dialog that the command opens itself.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FsExt, OpenOptions};

/// Suffix of a notes file (`NOTES_SUFFIX` of `@inkslide/annotate/io`).
const NOTES_SUFFIX: &str = ".notes.json";
/// Max. bytes of a notes key: the file name, with the suffix and a temp extension, stays far below 255.
const MAX_KEY_BYTES: usize = 200;
/// Max. bytes of a shared file's name (200 before ".pdf", as `shareName` of tauri.ts).
const MAX_SHARE_NAME_BYTES: usize = 204;

/// A notes key (the PDF's SHA-256 in hex, or `name-<safe name>`): 1 to 200 of `[A-Za-z0-9_-]`.
fn notes_key(key: &str) -> Result<&str, String> {
    let ok = !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok { Ok(key) } else { Err(format!("invalid notes key: {key:?}")) }
}

/// A shared file's name: one plain path component ending in `.pdf`, no
/// separators, `:` or control characters, not hidden, at most 204 bytes.
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

/// The raw bytes and the percent-encoded `name` header of a request.
fn bytes_and_name<'a>(request: &'a Request<'_>) -> Result<(&'a [u8], String), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes as the request body".into());
    };
    let name = request
        .headers()
        .get("name")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing name header")?;
    Ok((bytes, percent_decode(name)?))
}

/// A temp file name next to `file`, unique within this process and run.
fn temp_name(file: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("{file}.{nanos:x}{:x}.tmp", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Writes `data` to `dir/file` through a temp file (flushed to disk), then renames it.
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
    }
    result
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

/// Writes the notes of a PDF: app data `notes/<key>.notes.json`.
#[tauri::command]
async fn write_notes<R: Runtime>(app: AppHandle<R>, key: String, text: String) -> Result<(), String> {
    let key = notes_key(&key)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("notes");
    write_atomic(&dir, &format!("{key}{NOTES_SUFFIX}"), text.as_bytes()).map_err(|e| e.to_string())
}

/// Writes a PDF (raw body) to the share folder under the `name` header; returns its path.
#[tauri::command]
async fn write_share_file<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<String, String> {
    let (bytes, name) = bytes_and_name(&request)?;
    let dir = share_dir(&app)?;
    write_atomic(&dir, share_name(&name)?, bytes).map_err(|e| e.to_string())?;
    Ok(dir.join(&name).to_string_lossy().into_owned())
}

/// Removes a file from the share folder; a missing file is no error.
#[tauri::command]
async fn remove_share_file<R: Runtime>(app: AppHandle<R>, name: String) -> Result<(), String> {
    let path = share_dir(&app)?.join(share_name(&name)?);
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Asks where to save a PDF (raw body; `name` header: the suggested name) and
/// writes it there; false if the user cancelled. The target is only the file
/// picked in this dialog, which the web view never sees.
#[tauri::command]
async fn save_pdf<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<bool, String> {
    let (bytes, name) = bytes_and_name(&request)?;
    let Some(target) = app.dialog().file().set_file_name(name).add_filter("PDF", &["pdf"]).blocking_save_file() else {
        return Ok(false);
    };
    let mut opts = OpenOptions::new();
    opts.read(false).write(true).create(true).truncate(true);
    let mut file = app.fs().open(target, opts).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sharekit::init())
        // build.rs lists the same commands (an `allow-<command>` permission each).
        .invoke_handler(tauri::generate_handler![write_notes, save_pdf, write_share_file, remove_share_file])
        .run(tauri::generate_context!())
        .expect("error while running Inkslide");
}

#[cfg(test)]
mod tests {
    use super::*;

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
            " a.pdf", "a\nb.pdf", "a\0.pdf", "a.PDF", "a.pdf/", "a.json", "..", ".",
        ] {
            assert!(share_name(bad).is_err(), "{bad:?}");
        }
        assert!(share_name(&format!("{}.pdf", "x".repeat(201))).is_err());
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
