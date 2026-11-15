// Windowsのリリース版で、余計なコンソール窓が開かないようにする
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nikki_lib::run();
}
