// 画面とデータの扱いはすべて src/ 側（TypeScript）にある。
// ネイティブ側の役目は、ウィンドウを開くことと、端末内のSQLiteを画面側へ貸すことだけ。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("アプリを起動できませんでした");
}
