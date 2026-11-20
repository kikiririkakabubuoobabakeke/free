//! 同梱した LLM のエンジンを、画面側から起動・停止するための窓口。
//! パソコン版（Windows / macOS / Linux）だけで動く。スマホ版では「使えない」と答える。

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Default)]
pub struct EngineState {
    #[cfg(desktop)]
    engine: Mutex<Option<nikki_engine::Engine>>,
    #[cfg(not(desktop))]
    #[allow(dead_code)]
    engine: Mutex<Option<()>>,
}

#[derive(Serialize, Clone)]
pub struct EngineInfo {
    /// このアプリにエンジンが入っているか
    available: bool,
    running: bool,
    port: u16,
    /// 同じネットワークの他の端末からも使えるようにしているか
    share: bool,
    /// "windows" / "macos" / "linux" / "android" / "ios"
    os: &'static str,
    models_dir: String,
    log_path: String,
    /// 他の端末からこのPCを指すときのアドレス（分からなければ null）
    lan_address: Option<String>,
    /// 入っているモデル（エンジンを起動せずに調べたもの）
    models: Vec<String>,
    /// このアプリが起動したエンジンのプロセス番号（前回の残りを使っているときや、動いていないときは null）
    pid: Option<u32>,
}

#[cfg(desktop)]
mod desktop {
    use super::*;
    use std::path::PathBuf;

    /// エンジンの入っているフォルダー。確認用に NIKKI_ENGINE_DIR で差し替えられる。
    pub fn engine_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("NIKKI_ENGINE_DIR") {
            return Some(PathBuf::from(dir));
        }
        app.path().resource_dir().ok().map(|d| d.join("ollama"))
    }

    pub fn config<R: Runtime>(app: &AppHandle<R>, share: bool) -> Result<nikki_engine::EngineConfig, String> {
        let engine_dir = engine_dir(app).ok_or("エンジンの場所が分かりません")?;
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let logs = app.path().app_log_dir().unwrap_or_else(|_| data.join("logs"));
        Ok(nikki_engine::EngineConfig {
            engine_dir,
            models_dir: data.join("models"),
            log_path: logs.join("engine.log"),
            share,
            port: nikki_engine::DEFAULT_PORT,
        })
    }
}

#[tauri::command]
pub fn engine_info<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, EngineState>) -> EngineInfo {
    #[cfg(desktop)]
    {
        let config = desktop::config(&app, false).ok();
        let available = config.as_ref().map(|c| nikki_engine::is_available(&c.engine_dir)).unwrap_or(false);
        let mut guard = state.engine.lock().unwrap_or_else(|e| e.into_inner());
        let (running, share, pid) = match guard.as_mut() {
            Some(engine) => (engine.is_running(), engine.share, engine.pid()),
            None => (false, false, None),
        };
        EngineInfo {
            available,
            running,
            port: nikki_engine::DEFAULT_PORT,
            share,
            os: std::env::consts::OS,
            models_dir: config.as_ref().map(|c| c.models_dir.display().to_string()).unwrap_or_default(),
            log_path: config.as_ref().map(|c| c.log_path.display().to_string()).unwrap_or_default(),
            lan_address: if share { nikki_engine::lan_address() } else { None },
            models: config.as_ref().map(|c| nikki_engine::installed_models(&c.models_dir)).unwrap_or_default(),
            pid,
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state);
        EngineInfo {
            available: false,
            running: false,
            port: 0,
            share: false,
            os: std::env::consts::OS,
            models_dir: String::new(),
            log_path: String::new(),
            lan_address: None,
            models: Vec::new(),
            pid: None,
        }
    }
}

/// エンジンを起動する（動いていれば何もしない。共有の設定が変わったときは起動し直す）。応答できるまで待ってから返す。
#[tauri::command]
pub async fn engine_start<R: Runtime>(app: AppHandle<R>, share: bool) -> Result<EngineInfo, String> {
    #[cfg(desktop)]
    {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let state = handle.state::<EngineState>();
            let mut guard = state.engine.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(engine) = guard.as_mut() {
                if engine.is_running() && engine.share == share {
                    return Ok(());
                }
            }
            // 止まっている・共有の設定が違うときは、止めてから起動し直す
            if let Some(mut old) = guard.take() {
                old.stop();
            }
            let config = desktop::config(&handle, share)?;
            let mut engine = nikki_engine::Engine::start(&config).map_err(|e| e.to_string())?;
            engine
                .wait_ready(std::time::Duration::from_secs(60))
                .map_err(|e| format!("{e}（記録: {}）", config.log_path.display()))?;
            *guard = Some(engine);
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
        let state = app.state::<EngineState>();
        Ok(engine_info(app.clone(), state))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, share);
        Err("この端末では、同梱のエンジンは使えません".into())
    }
}

#[tauri::command]
pub fn engine_stop(state: tauri::State<'_, EngineState>) {
    let mut guard = state.engine.lock().unwrap_or_else(|e| e.into_inner());
    // 手放すと止まる
    guard.take();
}

/// アプリを閉じるときに呼ぶ
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<EngineState>() {
        let mut guard = state.engine.lock().unwrap_or_else(|e| e.into_inner());
        guard.take();
    }
}
