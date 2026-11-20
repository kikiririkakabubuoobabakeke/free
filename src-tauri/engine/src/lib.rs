//! Nikki に同梱した LLM のエンジン（Ollama）を、このPCの中で起動・停止する部品。
//!
//! - エンジンは、同梱したフォルダー（Windows: `ollama.exe` と `lib/ollama/`、macOS: `ollama` と部品）
//!   のまま起動する。Ollama は自分の実行ファイルから見た場所で部品を探すので、並びを崩さない。
//! - モデルの置き場所・待ち受けるアドレス・ポートは環境変数で渡す。ふだん入れている Ollama とは
//!   ポートもモデルの置き場所も分けるので、両方あってもぶつからない。
//! - 止めるときは、エンジンが起動した子プロセス（モデルを動かす llama-server など）までまとめて終わらせる。
//!   Windows ではジョブオブジェクトに入れておき、アプリが落ちたときも OS が片付けるようにする。
//!   macOS / Linux では小さな見張り役（/bin/sh）越しに新しいプロセスグループで起動し、グループごと止める。
//!   見張り役はアプリとの間の管（標準入力）を見ていて、アプリが落ちて管が閉じたら、グループごと止める。

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// 同梱のエンジンが待ち受けるポート。ふだんの Ollama（11434）とぶつからないよう、別の番号にする。
pub const DEFAULT_PORT: u16 = 11545;

pub struct EngineConfig {
    /// `ollama`（Windows では `ollama.exe`）が入っているフォルダー
    pub engine_dir: PathBuf,
    /// モデルの置き場所
    pub models_dir: PathBuf,
    /// エンジンの出力を書き出すファイル（起動のたびに書き直す）
    pub log_path: PathBuf,
    /// true なら同じネットワークの他の端末からも使えるようにする（0.0.0.0 で待ち受ける）
    pub share: bool,
    pub port: u16,
}

/// エンジンの実行ファイルの場所
pub fn executable(engine_dir: &Path) -> PathBuf {
    engine_dir.join(if cfg!(windows) { "ollama.exe" } else { "ollama" })
}

/// このフォルダーにエンジンが入っているか
pub fn is_available(engine_dir: &Path) -> bool {
    executable(engine_dir).is_file()
}

/// 動いているエンジン。手放す（drop する）と止まる。
pub struct Engine {
    child: Option<Child>,
    /// 見張り役への管。アプリが終わる（落ちる）とこれが閉じ、見張り役がエンジンを止める。
    #[allow(dead_code)]
    watch: Option<ChildStdin>,
    #[cfg(windows)]
    job: Option<win::Job>,
    pub port: u16,
    pub share: bool,
    /// 起動したときには既に同じポートで Ollama が動いていて、それを使っている（前回の残りなど）
    pub adopted: bool,
}

impl Engine {
    /// エンジンを起動する。応答できるようになるまでは待たない（[`Engine::wait_ready`] で待つ）。
    pub fn start(config: &EngineConfig) -> io::Result<Engine> {
        // 前回アプリが落ちたときの残りなどで、同じポートに Ollama が既にいれば、それを使う
        if probe(config.port, Duration::from_millis(500)).is_ok() {
            return Ok(Engine {
                child: None,
                watch: None,
                #[cfg(windows)]
                job: None,
                port: config.port,
                share: config.share,
                adopted: true,
            });
        }

        let exe = executable(&config.engine_dir);
        if !exe.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("エンジンが見つかりません: {}", exe.display()),
            ));
        }
        fs::create_dir_all(&config.models_dir)?;
        if let Some(dir) = config.log_path.parent() {
            fs::create_dir_all(dir)?;
        }
        let log = File::create(&config.log_path)?;
        let host = if config.share { "0.0.0.0" } else { "127.0.0.1" };

        #[cfg(unix)]
        let mut command = {
            // 見張り役：エンジンを裏で起動し、管（標準入力）が閉じるまで待つ。
            // 閉じたら（アプリが終わった・落ちた）、自分のプロセスグループ（エンジンと、その子プロセス）ごと止める。
            let mut c = Command::new("/bin/sh");
            c.arg("-c")
                .arg("\"$0\" serve </dev/null &\nread _\nkill -TERM 0")
                .arg(&exe)
                .stdin(Stdio::piped());
            c
        };
        #[cfg(not(unix))]
        let mut command = {
            let mut c = Command::new(&exe);
            c.arg("serve").stdin(Stdio::null());
            c
        };
        command
            .current_dir(&config.engine_dir)
            .env("OLLAMA_HOST", format!("{host}:{}", config.port))
            .env("OLLAMA_MODELS", &config.models_dir)
            // 続けて何件も分析する間はモデルを読み込んだままにし、使わなくなれば10分で手放す
            .env("OLLAMA_KEEP_ALIVE", "10m")
            // 日記を外へ出さないよう、クラウドの機能は使わない
            .env("OLLAMA_NO_CLOUD", "1")
            .stdout(log.try_clone()?)
            .stderr(log);
        // ふだん入れている Ollama 用の設定が混ざらないようにする
        for key in ["OLLAMA_ORIGINS", "OLLAMA_CONTEXT_LENGTH", "OLLAMA_NUM_PARALLEL", "OLLAMA_MAX_LOADED_MODELS"] {
            command.env_remove(key);
        }

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // 新しいプロセスグループの頭にして、止めるときにエンジンが起動した子プロセスごと止められるようにする
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // 黒い画面（コンソール）を出さない
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }

        let mut child = command.spawn()?;
        let watch = child.stdin.take();

        #[cfg(windows)]
        let job = match win::Job::new() {
            Ok(job) => match job.assign(&child) {
                Ok(()) => Some(job),
                Err(_) => None, // 入れられなければ、止めるときに taskkill で子プロセスごと止める
            },
            Err(_) => None,
        };

        Ok(Engine {
            child: Some(child),
            watch,
            #[cfg(windows)]
            job,
            port: config.port,
            share: config.share,
            adopted: false,
        })
    }

    /// 応答できるようになるまで待つ。エンジンの版を返す。
    pub fn wait_ready(&mut self, timeout: Duration) -> io::Result<String> {
        let started = Instant::now();
        loop {
            if let Some(child) = self.child.as_mut() {
                if let Some(status) = child.try_wait()? {
                    return Err(io::Error::other(format!("エンジンが起動直後に終了しました（{status}）")));
                }
            }
            if let Ok(version) = probe(self.port, Duration::from_millis(800)) {
                return Ok(version);
            }
            if started.elapsed() > timeout {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "エンジンが時間内に起動しませんでした"));
            }
            sleep(Duration::from_millis(200));
        }
    }

    /// まだ動いていて、応答できるか（エンジンだけが落ちて見張り役が残っている場合も、動いていないとみなす）
    pub fn is_running(&mut self) -> bool {
        let alive = match self.child.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => true,
        };
        alive && probe(self.port, Duration::from_millis(800)).is_ok()
    }

    /// エンジンの OS 上のプロセス番号（前回の残りを使っているときは None）
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.id())
    }

    /// エンジンと、それが起動した子プロセスをまとめて止める
    pub fn stop(&mut self) {
        let Some(mut child) = self.child.take() else { return };

        #[cfg(unix)]
        {
            let group = child.id() as libc::pid_t;
            self.watch.take();
            // まず穏やかに止めてもらう（Ollama は自分で子プロセスを片付ける）
            unsafe {
                libc::kill(-group, libc::SIGTERM);
            }
            let _ = child.wait();
            // グループの全員がいなくなるまで待つ（kill(.., 0) はグループがあるかだけを調べる）
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && unsafe { libc::kill(-group, 0) } == 0 {
                sleep(Duration::from_millis(100));
            }
            // 残っているものは、グループごと強制的に止める
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }

        #[cfg(windows)]
        {
            match self.job.take() {
                Some(job) => job.terminate(),
                None => {
                    let _ = Command::new("taskkill")
                        .args(["/T", "/F", "/PID", &child.id().to_string()])
                        .creation_flags_no_window()
                        .status();
                    let _ = child.kill();
                }
            }
            let _ = child.wait();
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl NoWindow for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
    }
}

#[cfg(windows)]
mod win {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// ジョブオブジェクト。中のプロセス（とその子孫）は、これを閉じたとき（アプリが落ちたときも）まとめて終わる。
    pub struct Job(HANDLE);

    // HANDLE はただの番号として扱う（別のスレッドへ渡しても問題ない）
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> io::Result<Job> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub fn assign(&self, child: &Child) -> io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// 入っているモデルの名前（例: `gemma4:e4b`）。エンジンを起動せずに、モデルの目録のファイルから調べる。
/// 目録は `models/manifests/{ホスト}/{名前空間}/{モデル}/{タグ}` に置かれる（Ollama の決まり）。
pub fn installed_models(models_dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(hosts) = fs::read_dir(models_dir.join("manifests")) else { return names };
    for host in hosts.flatten() {
        let host_name = host.file_name().to_string_lossy().to_string();
        let Ok(namespaces) = fs::read_dir(host.path()) else { continue };
        for namespace in namespaces.flatten() {
            let namespace_name = namespace.file_name().to_string_lossy().to_string();
            let Ok(models) = fs::read_dir(namespace.path()) else { continue };
            for model in models.flatten() {
                let model_name = model.file_name().to_string_lossy().to_string();
                let Ok(tags) = fs::read_dir(model.path()) else { continue };
                for tag in tags.flatten() {
                    if !tag.path().is_file() {
                        continue;
                    }
                    let tag_name = tag.file_name().to_string_lossy().to_string();
                    let name = match (host_name.as_str(), namespace_name.as_str()) {
                        ("registry.ollama.ai", "library") => format!("{model_name}:{tag_name}"),
                        ("registry.ollama.ai", ns) => format!("{ns}/{model_name}:{tag_name}"),
                        (host, ns) => format!("{host}/{ns}/{model_name}:{tag_name}"),
                    };
                    names.push(name);
                }
            }
        }
    }
    names.sort();
    names
}

/// エンジンに `GET /api/version` を問い合わせ、Ollama なら版を返す
pub fn probe(port: u16, timeout: Duration) -> io::Result<String> {
    let (status, body) = http_request("127.0.0.1", port, "GET", "/api/version", None, timeout)?;
    if status != 200 {
        return Err(io::Error::other(format!("HTTP {status}")));
    }
    json_string_field(&body, "version").ok_or_else(|| io::Error::other("Ollama の応答ではありません"))
}

/// 同じネットワークの他の端末から、このPCを指すときのアドレス（分からなければ None）。
/// 外へは何も送らない（UDP の宛先を決めるだけで、OS がどの経路のアドレスを使うかを教えてくれる）。
pub fn lan_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_unspecified() || ip.is_loopback() {
        None
    } else {
        Some(ip.to_string())
    }
}

/// 最小限の HTTP/1.1 のやりとり（エンジンの確認と、確認用のプログラムで使う）。
/// `Connection: close` で送り、本文を最後まで読む。chunked にも対応する。
pub fn http_request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout: Duration,
) -> io::Result<(u16, String)> {
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "アドレスが正しくありません"))?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> io::Result<(u16, String)> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| io::Error::other("HTTP の応答が途中で切れています"))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut rest = &raw[split + 4..];
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| io::Error::other("HTTP の応答ではありません"))?;
    let chunked = head
        .lines()
        .any(|line| line.to_ascii_lowercase().starts_with("transfer-encoding:") && line.to_ascii_lowercase().contains("chunked"));
    if !chunked {
        return Ok((status, String::from_utf8_lossy(rest).to_string()));
    }
    let mut body = Vec::new();
    loop {
        let line_end = rest
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| io::Error::other("chunked の区切りが見つかりません"))?;
        let size_text = String::from_utf8_lossy(&rest[..line_end]).to_string();
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| io::Error::other("chunked の長さが読めません"))?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size {
            return Err(io::Error::other("chunked の本文が途中で切れています"));
        }
        body.extend_from_slice(&rest[..size]);
        rest = &rest[(size + 2).min(rest.len())..];
    }
    Ok((status, String::from_utf8_lossy(&body).to_string()))
}

/// `{"version":"0.35.1"}` のような JSON から、文字列の値を1つ取り出す（エンジンの確認用の、ごく簡単なもの）
fn json_string_field(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{key}\"");
    let start = json.find(&pattern)? + pattern.len();
    let rest = json[start..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_and_chunked_responses() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{\"version\":\"0.35.1\"}";
        assert_eq!(parse_response(plain).unwrap(), (200, "{\"version\":\"0.35.1\"}".to_string()));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n4\r\n\"b\"}\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).unwrap(), (200, "{\"a\":\"b\"}".to_string()));
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn finds_version_field() {
        assert_eq!(json_string_field("{\"version\": \"0.35.1\"}", "version").as_deref(), Some("0.35.1"));
        assert_eq!(json_string_field("{\"models\":[]}", "version"), None);
    }

    #[test]
    fn lists_installed_models_from_manifests() {
        let dir = std::env::temp_dir().join(format!("nikki-engine-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(installed_models(&dir).is_empty());
        for path in [
            "manifests/registry.ollama.ai/library/gemma4/e4b",
            "manifests/registry.ollama.ai/library/gemma4/26b",
            "manifests/registry.ollama.ai/someone/diary/latest",
            "manifests/hf.co/org/model/q4",
        ] {
            let file = dir.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "{}").unwrap();
        }
        assert_eq!(
            installed_models(&dir),
            vec!["gemma4:26b", "gemma4:e4b", "hf.co/org/model:q4", "someone/diary:latest"]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn executable_name_depends_on_os() {
        let exe = executable(Path::new("/x"));
        assert_eq!(exe.file_name().unwrap(), if cfg!(windows) { "ollama.exe" } else { "ollama" });
    }
}
