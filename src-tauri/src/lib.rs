// 画面とデータの扱いはすべて src/ 側（TypeScript）にある。
// ネイティブ側の役目は、ウィンドウを開くことと、端末内のSQLiteを画面側へ貸すこと、
// LLMのサーバーとの通信を画面側の代わりに行うこと、それに同梱したLLMのエンジンを起動・停止することだけ。

mod engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .manage(engine::EngineState::default())
        .invoke_handler(tauri::generate_handler![engine::engine_info, engine::engine_start, engine::engine_stop])
        .build(tauri::generate_context!())
        .expect("アプリを起動できませんでした");

    app.run(|handle, event| {
        // アプリを閉じるときは、同梱のエンジン（と、それが動かしているモデル）も必ず止める
        if let tauri::RunEvent::Exit = event {
            engine::shutdown(handle);
        }
    });
}
