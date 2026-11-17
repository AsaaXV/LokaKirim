use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_RUST_TRACES: usize = 200;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustPacketTraceEntry {
    pub seq: u64,
    pub ts_ms: u64,
    pub level: String,
    pub target: String,
    pub event: String,
    pub msg_id: Option<String>,
    pub conv_id: Option<String>,
    pub details: String,
}

static PACKET_TRACE_LOG: OnceLock<Mutex<VecDeque<RustPacketTraceEntry>>> = OnceLock::new();
static NEXT_TRACE_SEQ: AtomicU64 = AtomicU64::new(1);

fn trace_log_slot() -> &'static Mutex<VecDeque<RustPacketTraceEntry>> {
    PACKET_TRACE_LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_RUST_TRACES)))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn record_rust_trace(
    level: &str,
    target: &str,
    event: &str,
    msg_id: Option<&str>,
    conv_id: Option<&str>,
    details: &str,
) {
    let seq = NEXT_TRACE_SEQ.fetch_add(1, Ordering::Relaxed);
    let ts_ms = now_ms();
    eprintln!(
        "[Rust][#{seq}] {level} {target}: {event}{}{}{}",
        msg_id.map(|m| format!(" msg_id={m}")).unwrap_or_default(),
        conv_id.map(|c| format!(" conv_id={c}")).unwrap_or_default(),
        if details.is_empty() {
            String::new()
        } else {
            format!(" {{ {details} }}")
        }
    );

    if let Ok(mut guard) = trace_log_slot().lock() {
        if guard.len() >= MAX_RUST_TRACES {
            guard.pop_front();
        }
        guard.push_back(RustPacketTraceEntry {
            seq,
            ts_ms,
            level: level.to_string(),
            target: target.to_string(),
            event: event.to_string(),
            msg_id: msg_id.map(str::to_string),
            conv_id: conv_id.map(str::to_string),
            details: details.to_string(),
        });
    }
}

#[tauri::command]
pub fn rust_log_packet_trace(
    level: String,
    target: String,
    event: String,
    msg_id: Option<String>,
    conv_id: Option<String>,
    details: String,
) {
    record_rust_trace(
        &level,
        &target,
        &event,
        msg_id.as_deref(),
        conv_id.as_deref(),
        &details,
    );
}

#[tauri::command]
pub fn rust_get_packet_traces() -> Vec<RustPacketTraceEntry> {
    trace_log_slot()
        .lock()
        .map(|g| g.iter().cloned().collect())
        .unwrap_or_default()
}

struct ActiveWsConnection {
    host_key: String,
    conn_id: u64,
    ws_url: String,
    tx: mpsc::UnboundedSender<Message>,
    join_handle: tauri::async_runtime::JoinHandle<()>,
}

static ACTIVE_WS_MAP: OnceLock<Mutex<HashMap<String, ActiveWsConnection>>> = OnceLock::new();
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

fn ws_map_slot() -> &'static Mutex<HashMap<String, ActiveWsConnection>> {
    ACTIVE_WS_MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustWsOpenPayload {
    pub host_key: String,
    pub conn_id: u64,
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustWsTextPayload {
    pub host_key: String,
    pub conn_id: u64,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustWsBinaryPayload {
    pub host_key: String,
    pub conn_id: u64,
    pub data_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustWsClosePayload {
    pub host_key: String,
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
    pub host_id: Option<String>,
    pub host_label: Option<String>,
    pub requires_access_code: bool,
    pub bridge_count: usize,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustClientStatus {
    pub host_key: String,
    pub connected: bool,
    pub conn_id: Option<u64>,
    pub url: Option<String>,
    pub engine: String,
}

fn disconnect_host_internal(host_key: Option<&str>) {
    if let Ok(mut guard) = ws_map_slot().lock() {
        if let Some(key) = host_key {
            if let Some(prev) = guard.remove(key) {
                prev.join_handle.abort();
            }
        } else {
            for (_, prev) in guard.drain() {
                prev.join_handle.abort();
            }
        }
    }
}

#[tauri::command]
pub async fn rust_ws_connect(
    app: AppHandle,
    host_key: String,
    ws_url: String,
    client_conn_id: Option<u64>,
) -> Result<u64, String> {
    let trimmed_url = ws_url.trim().to_string();
    let key = if host_key.trim().is_empty() {
        "local".to_string()
    } else {
        host_key.trim().to_string()
    };
    if trimmed_url.is_empty() {
        return Err("URL WebSocket tidak boleh kosong".to_string());
    }

    disconnect_host_internal(Some(&key));
    let conn_id = client_conn_id.unwrap_or_else(|| NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let url_clone = trimmed_url.clone();
    let key_clone = key.clone();
    let app_clone = app.clone();

    let join_handle = tauri::async_runtime::spawn(async move {
        record_rust_trace(
            "INFO",
            "transport::rust_ws",
            "ws_connect_begin",
            None,
            None,
            &format!("host={key_clone} conn_id={conn_id} url={url_clone}"),
        );

        let connect_res =
            tokio::time::timeout(Duration::from_secs(6), connect_async(url_clone.as_str())).await;

        let ws_stream = match connect_res {
            Ok(Ok((stream, _response))) => stream,
            Ok(Err(err)) => {
                record_rust_trace(
                    "ERROR",
                    "transport::rust_ws",
                    "ws_connect_failed",
                    None,
                    None,
                    &format!("host={key_clone} conn_id={conn_id} url={url_clone} err={err}"),
                );
                let _ = app_clone.emit(
                    "rust-ws-close",
                    RustWsClosePayload {
                        host_key: key_clone.clone(),
                        conn_id,
                        reason: format!("Gagal terhubung ke host: {err}"),
                    },
                );
                if let Ok(mut guard) = ws_map_slot().lock() {
                    if guard.get(&key_clone).map(|c| c.conn_id) == Some(conn_id) {
                        guard.remove(&key_clone);
                    }
                }
                return;
            }
            Err(_) => {
                record_rust_trace(
                    "ERROR",
                    "transport::rust_ws",
                    "ws_connect_timeout",
                    None,
                    None,
                    &format!("host={key_clone} conn_id={conn_id} url={url_clone} timeout_s=6"),
                );
                let _ = app_clone.emit(
                    "rust-ws-close",
                    RustWsClosePayload {
                        host_key: key_clone.clone(),
                        conn_id,
                        reason: "Waktu koneksi ke host habis (timeout 6 detik)".to_string(),
                    },
                );
                if let Ok(mut guard) = ws_map_slot().lock() {
                    if guard.get(&key_clone).map(|c| c.conn_id) == Some(conn_id) {
                        guard.remove(&key_clone);
                    }
                }
                return;
            }
        };

        let (mut write, mut read) = ws_stream.split();

        record_rust_trace(
            "INFO",
            "transport::rust_ws",
            "ws_open",
            None,
            None,
            &format!("host={key_clone} conn_id={conn_id} url={url_clone}"),
        );

        let _ = app_clone.emit(
            "rust-ws-open",
            RustWsOpenPayload {
                host_key: key_clone.clone(),
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
                            host_key: key_clone.clone(),
                            conn_id,
                            data: text.as_str().to_string(),
                        },
                    );
                }
                Ok(Message::Binary(bytes)) => {
                    let _ = app_clone.emit(
                        "rust-ws-binary",
                        RustWsBinaryPayload {
                            host_key: key_clone.clone(),
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

        if let Ok(mut guard) = ws_map_slot().lock() {
            if guard.get(&key_clone).map(|c| c.conn_id) == Some(conn_id) {
                guard.remove(&key_clone);
            }
        }

        record_rust_trace(
            "WARN",
            "transport::rust_ws",
            "ws_closed",
            None,
            None,
            &format!("host={key_clone} conn_id={conn_id} reason=\"{close_reason}\""),
        );

        let _ = app_clone.emit(
            "rust-ws-close",
            RustWsClosePayload {
                host_key: key_clone,
                conn_id,
                reason: close_reason,
            },
        );
    });

    if let Ok(mut guard) = ws_map_slot().lock() {
        guard.insert(
            key.clone(),
            ActiveWsConnection {
                host_key: key,
                conn_id,
                ws_url: trimmed_url,
                tx,
                join_handle,
            },
        );
    }

    Ok(conn_id)
}

#[tauri::command]
pub fn rust_ws_disconnect(host_key: Option<String>) {
    disconnect_host_internal(host_key.as_deref());
}

#[tauri::command]
pub fn rust_ws_send_text(host_key: String, payload: String) -> Result<bool, String> {
    let key = if host_key.trim().is_empty() {
        "local"
    } else {
        host_key.trim()
    };
    let guard = ws_map_slot()
        .lock()
        .map_err(|_| "Gagal mengunci status koneksi Rust".to_string())?;
    let Some(conn) = guard.get(key) else {
        record_rust_trace(
            "WARN",
            "transport::rust_ws",
            "send_text_no_socket",
            None,
            None,
            &format!("host={key} bytes={}", payload.len()),
        );
        return Ok(false);
    };
    let ok = conn.tx.send(Message::text(payload)).is_ok();
    if !ok {
        record_rust_trace(
            "ERROR",
            "transport::rust_ws",
            "send_text_channel_closed",
            None,
            None,
            &format!("host={key} conn_id={}", conn.conn_id),
        );
    }
    Ok(ok)
}

#[tauri::command]
pub fn rust_ws_send_binary(host_key: String, data_base64: String) -> Result<bool, String> {
    let key = if host_key.trim().is_empty() {
        "local"
    } else {
        host_key.trim()
    };
    let bytes = B64
        .decode(data_base64.trim())
        .map_err(|e| format!("Data biner base64 tidak valid: {e}"))?;
    let guard = ws_map_slot()
        .lock()
        .map_err(|_| "Gagal mengunci status koneksi Rust".to_string())?;
    let Some(conn) = guard.get(key) else {
        record_rust_trace(
            "WARN",
            "transport::rust_ws",
            "send_binary_no_socket",
            None,
            None,
            &format!("host={key} bytes={}", bytes.len()),
        );
        return Ok(false);
    };
    let ok = conn.tx.send(Message::binary(bytes)).is_ok();
    if !ok {
        record_rust_trace(
            "ERROR",
            "transport::rust_ws",
            "send_binary_channel_closed",
            None,
            None,
            &format!("host={key} conn_id={}", conn.conn_id),
        );
    }
    Ok(ok)
}

#[tauri::command]
pub fn rust_ws_status(host_key: Option<String>) -> Vec<RustClientStatus> {
    if let Ok(guard) = ws_map_slot().lock() {
        if let Some(key) = host_key {
            if let Some(conn) = guard.get(&key) {
                return vec![RustClientStatus {
                    host_key: conn.host_key.clone(),
                    connected: true,
                    conn_id: Some(conn.conn_id),
                    url: Some(conn.ws_url.clone()),
                    engine: "rust-tokio-tungstenite".to_string(),
                }];
            }
            return vec![RustClientStatus {
                host_key: key,
                connected: false,
                conn_id: None,
                url: None,
                engine: "rust-tokio-tungstenite".to_string(),
            }];
        }
        return guard
            .values()
            .map(|conn| RustClientStatus {
                host_key: conn.host_key.clone(),
                connected: true,
                conn_id: Some(conn.conn_id),
                url: Some(conn.ws_url.clone()),
                engine: "rust-tokio-tungstenite".to_string(),
            })
            .collect();
    }
    Vec::new()
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
                host_id: None,
                host_label: None,
                requires_access_code: false,
                bridge_count: 0,
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
                host_id: None,
                host_label: None,
                requires_access_code: false,
                bridge_count: 0,
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
                host_id: None,
                host_label: None,
                requires_access_code: false,
                bridge_count: 0,
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
            host_id: None,
            host_label: None,
            requires_access_code: false,
            bridge_count: 0,
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
            let host_id = json_val
                .get("hostId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let host_label = json_val
                .get("hostLabel")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let requires_access_code = json_val
                .get("requiresAccessCode")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let bridge_count = json_val
                .get("bridgeCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;

            return RustHostProbeResult {
                ok,
                latency_ms,
                peers_online,
                active_calls,
                engine,
                host_id,
                host_label,
                requires_access_code,
                bridge_count,
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
        host_id: None,
        host_label: None,
        requires_access_code: false,
        bridge_count: 0,
        error: None,
    }
}
