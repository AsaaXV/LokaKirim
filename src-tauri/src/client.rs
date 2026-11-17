use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

struct ActiveWsConnection {
    conn_id: u64,
    ws_url: String,
    tx: mpsc::UnboundedSender<Message>,
    join_handle: tauri::async_runtime::JoinHandle<()>,
}

static ACTIVE_WS: OnceLock<Mutex<Option<ActiveWsConnection>>> = OnceLock::new();
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

fn ws_slot() -> &'static Mutex<Option<ActiveWsConnection>> {
    ACTIVE_WS.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustWsOpenPayload {
    pub conn_id: u64,
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustWsTextPayload {
    pub conn_id: u64,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustWsBinaryPayload {
    pub conn_id: u64,
    pub data_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustWsClosePayload {
    pub conn_id: u64,
    pub reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustHostProbeResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub peers_online: usize,
    pub active_calls: usize,
    pub engine: String,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustClientStatus {
    pub connected: bool,
    pub conn_id: Option<u64>,
    pub url: Option<String>,
    pub engine: String,
}

fn disconnect_internal() {
    if let Ok(mut guard) = ws_slot().lock() {
        if let Some(prev) = guard.take() {
            prev.join_handle.abort();
        }
    }
}

#[tauri::command]
pub async fn rust_ws_connect(app: AppHandle, ws_url: String) -> Result<u64, String> {
    let trimmed = ws_url.trim().to_string();
    if trimmed.is_empty() {
        return Err("URL WebSocket tidak boleh kosong".to_string());
    }

    disconnect_internal();
    let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let url_clone = trimmed.clone();
    let app_clone = app.clone();

    let join_handle = tauri::async_runtime::spawn(async move {
        let connect_res =
            tokio::time::timeout(Duration::from_secs(6), connect_async(url_clone.as_str())).await;

        let ws_stream = match connect_res {
            Ok(Ok((stream, _response))) => stream,
            Ok(Err(err)) => {
                let _ = app_clone.emit(
                    "rust-ws-close",
                    RustWsClosePayload {
                        conn_id,
                        reason: format!("Gagal terhubung ke host: {err}"),
                    },
                );
                if let Ok(mut guard) = ws_slot().lock() {
                    if guard.as_ref().map(|c| c.conn_id) == Some(conn_id) {
                        *guard = None;
                    }
                }
                return;
            }
            Err(_) => {
                let _ = app_clone.emit(
                    "rust-ws-close",
                    RustWsClosePayload {
                        conn_id,
                        reason: "Waktu koneksi ke host habis (timeout 6 detik)".to_string(),
                    },
                );
                if let Ok(mut guard) = ws_slot().lock() {
                    if guard.as_ref().map(|c| c.conn_id) == Some(conn_id) {
                        *guard = None;
                    }
                }
                return;
            }
        };

        let (mut write, mut read) = ws_stream.split();

        let _ = app_clone.emit(
            "rust-ws-open",
            RustWsOpenPayload {
                conn_id,
                url: url_clone.clone(),
            },
        );

        let write_task = tauri::async_runtime::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(msg).await.is_err() {
                    break;
                }
            }
        });

        let mut close_reason = "Koneksi WebSocket ditutup".to_string();
        while let Some(item) = read.next().await {
            match item {
                Ok(Message::Text(text)) => {
                    let _ = app_clone.emit(
                        "rust-ws-text",
                        RustWsTextPayload {
                            conn_id,
                            data: text.as_str().to_string(),
                        },
                    );
                }
                Ok(Message::Binary(bytes)) => {
                    let _ = app_clone.emit(
                        "rust-ws-binary",
                        RustWsBinaryPayload {
                            conn_id,
                            data_base64: B64.encode(&bytes),
                        },
                    );
                }
                Ok(Message::Close(frame)) => {
                    if let Some(cf) = frame {
                        if !cf.reason.is_empty() {
                            close_reason = cf.reason.to_string();
                        }
                    }
                    break;
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                Err(err) => {
                    close_reason = format!("Koneksi terputus: {err}");
                    break;
                }
            }
        }

        write_task.abort();

        if let Ok(mut guard) = ws_slot().lock() {
            if guard.as_ref().map(|c| c.conn_id) == Some(conn_id) {
                *guard = None;
            }
        }

        let _ = app_clone.emit(
            "rust-ws-close",
            RustWsClosePayload {
                conn_id,
                reason: close_reason,
            },
        );
    });

    if let Ok(mut guard) = ws_slot().lock() {
        *guard = Some(ActiveWsConnection {
            conn_id,
            ws_url: trimmed,
            tx,
            join_handle,
        });
    }

    Ok(conn_id)
}

#[tauri::command]
pub fn rust_ws_disconnect() {
    disconnect_internal();
}

#[tauri::command]
pub fn rust_ws_send_text(payload: String) -> Result<bool, String> {
    let guard = ws_slot()
        .lock()
        .map_err(|_| "Gagal mengunci status koneksi Rust".to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(false);
    };
    Ok(conn.tx.send(Message::text(payload)).is_ok())
}

#[tauri::command]
pub fn rust_ws_send_binary(data_base64: String) -> Result<bool, String> {
    let bytes = B64
        .decode(data_base64.trim())
        .map_err(|e| format!("Data biner base64 tidak valid: {e}"))?;
    let guard = ws_slot()
        .lock()
        .map_err(|_| "Gagal mengunci status koneksi Rust".to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(false);
    };
    Ok(conn.tx.send(Message::binary(bytes)).is_ok())
}

#[tauri::command]
pub fn rust_ws_status() -> RustClientStatus {
    if let Ok(guard) = ws_slot().lock() {
        if let Some(conn) = guard.as_ref() {
            return RustClientStatus {
                connected: true,
                conn_id: Some(conn.conn_id),
                url: Some(conn.ws_url.clone()),
                engine: "rust-tokio-tungstenite".to_string(),
            };
        }
    }
    RustClientStatus {
        connected: false,
        conn_id: None,
        url: None,
        engine: "rust-tokio-tungstenite".to_string(),
    }
}

fn parse_host_and_port(host_url: &str) -> Result<(String, u16), String> {
    let without_scheme = host_url
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("ws://")
        .trim_start_matches("wss://");
    let authority = without_scheme.split('/').next().unwrap_or("").trim();
    if authority.is_empty() {
        return Err("Alamat host kosong".to_string());
    }
    if let Some((host, port_str)) = authority.rsplit_once(':') {
        let port = port_str.parse::<u16>().unwrap_or(3000);
        Ok((host.to_string(), port))
    } else {
        Ok((authority.to_string(), 3000))
    }
}

#[tauri::command]
pub async fn rust_probe_host(host_url: String) -> RustHostProbeResult {
    let started = Instant::now();
    let (host, port) = match parse_host_and_port(&host_url) {
        Ok(v) => v,
        Err(err) => {
            return RustHostProbeResult {
                ok: false,
                latency_ms: 0,
                peers_online: 0,
                active_calls: 0,
                engine: "rust-probe".to_string(),
                error: Some(err),
            };
        }
    };

    let addr = format!("{host}:{port}");
    let stream_res = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(&addr)).await;
    let mut stream = match stream_res {
        Ok(Ok(s)) => s,
        Ok(Err(err)) => {
            return RustHostProbeResult {
                ok: false,
                latency_ms: started.elapsed().as_millis() as u64,
                peers_online: 0,
                active_calls: 0,
                engine: "rust-probe".to_string(),
                error: Some(format!("Tidak dapat menjangkau {addr}: {err}")),
            };
        }
        Err(_) => {
            return RustHostProbeResult {
                ok: false,
                latency_ms: started.elapsed().as_millis() as u64,
                peers_online: 0,
                active_calls: 0,
                engine: "rust-probe".to_string(),
                error: Some(format!("Timeout saat menghubungi {addr}")),
            };
        }
    };

    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    );
    if let Err(err) = stream.write_all(req.as_bytes()).await {
        return RustHostProbeResult {
            ok: false,
            latency_ms: started.elapsed().as_millis() as u64,
            peers_online: 0,
            active_calls: 0,
            engine: "rust-probe".to_string(),
            error: Some(format!("Gagal mengirim permintaan ke host: {err}")),
        };
    }

    let mut buf = Vec::with_capacity(2048);
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut buf)).await;
    let raw = String::from_utf8_lossy(&buf);
    let latency_ms = started.elapsed().as_millis().max(1) as u64;

    if let Some((_, body)) = raw.split_once("\r\n\r\n") {
        if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(body.trim()) {
            let ok = json_val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let peers_online = json_val
                .get("peersOnline")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
            let active_calls = json_val
                .get("activeCalls")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
            let engine = json_val
                .get("engine")
                .and_then(|v| v.as_str())
                .unwrap_or("rust-lan")
                .to_string();
            return RustHostProbeResult {
                ok,
                latency_ms,
                peers_online,
                active_calls,
                engine,
                error: if ok {
                    None
                } else {
                    Some("Host bukan server LokaKirim".to_string())
                },
            };
        }
    }

    RustHostProbeResult {
        ok: true,
        latency_ms,
        peers_online: 0,
        active_calls: 0,
        engine: "tcp-open".to_string(),
        error: None,
    }
}
