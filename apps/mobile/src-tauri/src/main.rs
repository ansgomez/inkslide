// Desktop entry (development only: the desktop app ships with Electron).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    inkslide_lib::run()
}
