// 画面とデータの扱いはすべて src/ 側（TypeScript）にある。
// ネイティブ側の役目は、ウィンドウを開くことと、端末内のSQLiteを画面側へ貸すこと、
// それに自分のPC（LAN内）で動かしているLLMのサーバーとの通信を、画面側の代わりに行うことだけ。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("アプリを起動できませんでした");
}
