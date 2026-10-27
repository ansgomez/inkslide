// The app's own commands (src/lib.rs) get an `allow-<command>` permission
// each; a window may call one only if a capability grants it.
const COMMANDS: &[&str] = &["write_notes", "save_pdf", "write_share_file", "remove_share_file"];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
