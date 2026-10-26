//! Inkslide for iPad and Android: a Tauri 2 window around the web front end
//! (`apps/web/dist`). File access is the dialog and fs plugins, sharing the
//! sharekit plugin; the front end's adapter is `apps/web/src/platform/tauri.ts`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sharekit::init())
        .run(tauri::generate_context!())
        .expect("error while running Inkslide");
}
