//! 同梱するエンジンが、本物の OS の上で動くかを確かめるプログラム（GitHub Actions で使う）。
//!
//! 使い方: smoke <エンジンのフォルダー> <小さなモデル>[,<代わりのモデル>...] [crash]
//!
//! 1. エンジンを起動し、応答するまで待つ
//! 2. 小さなモデルを取ってくる
//! 3. JSON スキーマを渡して答えさせ、決まった形の JSON が返ることを確かめる
//! 4. 止めて、もう応答しないことを確かめる
//! crash を付けると、最後に止めずにこのプログラムごと終わる（アプリが落ちた場合の確認。
//! そのあと子プロセスが残っていないかは、呼び出した側で確かめる）。
//! wait を付けると、最後に止めずに待ち続ける（呼び出した側が強制終了して確かめる）。

use nikki_engine::{http_request, probe, Engine, EngineConfig};
use std::path::PathBuf;
use std::time::Duration;

const PORT: u16 = 11546;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("使い方: smoke <エンジンのフォルダー> <モデル>[,<代わり>...] [crash]");
        std::process::exit(2);
    }
    let engine_dir = PathBuf::from(&args[1]);
    let models: Vec<&str> = args[2].split(',').collect();
    let crash = args.get(3).map(|a| a == "crash").unwrap_or(false);
    let hang = args.get(3).map(|a| a == "wait").unwrap_or(false);
    let work = std::env::temp_dir().join("nikki-engine-smoke");

    let config = EngineConfig {
        engine_dir,
        models_dir: work.join("models"),
        log_path: work.join("engine.log"),
        share: false,
        port: PORT,
    };
    let mut engine = Engine::start(&config).unwrap_or_else(|e| fail(&format!("起動できません: {e}"), &config));
    assert!(!engine.adopted, "前の残りのエンジンが動いています");
    let version = engine.wait_ready(Duration::from_secs(90)).unwrap_or_else(|e| fail(&format!("応答しません: {e}"), &config));
    println!("ok  エンジンが起動した（Ollama {version}、pid {:?}）", engine.pid());

    let mut model = None;
    for candidate in &models {
        let body = format!(r#"{{"model":"{candidate}","stream":false}}"#);
        match http_request("127.0.0.1", PORT, "POST", "/api/pull", Some(&body), Duration::from_secs(900)) {
            Ok((200, text)) if text.contains("success") => {
                model = Some(candidate.to_string());
                break;
            }
            Ok((status, text)) => println!("--  {candidate} を取ってこられませんでした（{status}）: {}", text.chars().take(200).collect::<String>()),
            Err(e) => println!("--  {candidate} を取ってこられませんでした: {e}"),
        }
    }
    let model = model.unwrap_or_else(|| fail("どのモデルも取ってこられませんでした", &config));
    println!("ok  モデルを取ってきた（{model}）");

    let request = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            {"role": "system", "content": "日記を読み、指定された形のJSONだけを返してください。"},
            {"role": "user", "content": "日記: 川沿いを散歩した。風が冷たかったが楽しかった。\nsummary に一言のまとめ、mood に -2〜2 の気分を入れてください。"}
        ],
        "format": {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "mood": {"type": "integer", "enum": [-2, -1, 0, 1, 2]}
            },
            "required": ["summary", "mood"]
        },
        "options": {"temperature": 0.2, "num_ctx": 2048, "num_predict": 200}
    });
    let (status, text) = http_request("127.0.0.1", PORT, "POST", "/api/chat", Some(&request.to_string()), Duration::from_secs(600))
        .unwrap_or_else(|e| fail(&format!("答えが返りません: {e}"), &config));
    if status != 200 {
        fail(&format!("答えがエラーでした（{status}）: {text}"), &config);
    }
    let reply: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| fail(&format!("応答が JSON ではありません: {e}: {text}"), &config));
    let content = reply["message"]["content"].as_str().unwrap_or_default().to_string();
    let answer: serde_json::Value =
        serde_json::from_str(&content).unwrap_or_else(|e| fail(&format!("答えが指定の形の JSON ではありません: {e}: {content}"), &config));
    if !answer["summary"].is_string() || !answer["mood"].is_i64() {
        fail(&format!("答えに summary と mood がありません: {content}"), &config);
    }
    println!("ok  JSON の形で答えが返った: {content}");

    if hang {
        println!("ok  止めずに待ちます（呼び出し側が強制終了して確かめる）");
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    if crash {
        // 止めずにこのプログラムごと終わる。Windows ではジョブオブジェクトのおかげで、エンジンと子プロセスも一緒に終わるはず。
        println!("ok  止めずに終わります（子プロセスが残らないかは呼び出し側で確かめる）");
        std::process::exit(0);
    }

    engine.stop();
    std::thread::sleep(Duration::from_millis(500));
    if probe(PORT, Duration::from_millis(800)).is_ok() {
        fail("止めた後も応答があります", &config);
    }
    println!("ok  止めると応答しなくなった");
}

fn fail(message: &str, config: &EngineConfig) -> ! {
    eprintln!("NG: {message}");
    if let Ok(log) = std::fs::read_to_string(&config.log_path) {
        let tail: Vec<&str> = log.lines().rev().take(40).collect();
        eprintln!("--- エンジンの出力（最後の40行）");
        for line in tail.into_iter().rev() {
            eprintln!("{line}");
        }
    }
    std::process::exit(1);
}
