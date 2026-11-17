use axum::{
    body::Body,
    extract::{
        ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade},
        Path as AxumPath, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as TungMessage};
use tower_http::cors::{Any, CorsLayer};

const DEFAULT_ROOM_ID: &str = "ruang-utama";
const MAX_BRIDGE_HOPS: u8 = 4;
pub const LAN_PORT: u16 = 3000;

static DIST_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist");
static LAN_APP_STATE: OnceLock<AppState> = OnceLock::new();
static NEXT_BRIDGE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
enum WireMsg {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub peer_id: String,
    pub display_name: String,
    pub public_key_hex: String,
    pub device_label: String,
    pub connected_at: u64,
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_host_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hops: Option<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub room_id: String,
    pub name: String,
    pub created_by: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    pub member_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_host_label: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAddress {
    pub name: String,
    pub address: String,
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanNetworkInfo {
    pub port: u16,
    pub hostname: String,
    pub addresses: Vec<LanAddress>,
    pub primary_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustHostConfigDto {
    pub host_id: String,
    pub host_label: String,
    pub requires_access_code: bool,
    pub access_code: Option<String>,
    pub bridge_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustBridgeStatusDto {
    pub id: String,
    pub target_url: String,
    pub target_host_id: Option<String>,
    pub target_host_label: Option<String>,
    pub direction: String,
    pub status: String,
    pub error: Option<String>,
    pub connected_at: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BinaryRelayHeader {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    call_id: Option<String>,
    #[serde(default)]
    sample_rate: Option<u32>,
    #[serde(default)]
    transfer_id: Option<String>,
    conversation_type: String,
    target_id: String,
    sender_id: String,
    #[serde(default)]
    chunk_index: Option<u32>,
    #[serde(default)]
    total_chunks: Option<u32>,
    #[serde(default)]
    iv: Option<String>,
    #[serde(default)]
    hop_path: Vec<String>,
}

static ACTIVE_CALL_COUNTER: AtomicUsize = AtomicUsize::new(0);

pub fn active_call_count_sync() -> usize {
    ACTIVE_CALL_COUNTER.load(Ordering::Relaxed)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCallSession {
    pub call_id: String,
    pub call_type: String,
    pub caller_id: String,
    pub callee_id: String,
    pub state: String,
    pub started_at: u64,
}

struct ConnectedClient {
    tx: mpsc::UnboundedSender<WireMsg>,
    peer: PeerInfo,
    conn_id: u64,
}

#[derive(Clone)]
struct BridgedPeerEntry {
    peer: PeerInfo,
    via_bridge_id: String,
    hops: u8,
    hop_path: Vec<String>,
}

struct BridgeLink {
    id: String,
    target_url: String,
    target_host_id: Option<String>,
    target_host_label: Option<String>,
    direction: String,
    status: String,
    error: Option<String>,
    connected_at: Option<u64>,
    tx: Option<mpsc::UnboundedSender<WireMsg>>,
    task_handle: Option<tokio::task::JoinHandle<()>>,
}

struct ServerStateInner {
    host_id: String,
    host_label: String,
    access_code: Option<String>,
    clients: HashMap<String, ConnectedClient>,
    bridge_peers: HashMap<String, BridgedPeerEntry>,
    bridges: HashMap<String, BridgeLink>,
    rooms: HashMap<String, RoomInfo>,
    calls: HashMap<String, ActiveCallSession>,
    next_conn_id: u64,
}

#[derive(Clone)]
struct AppState {
    inner: Arc<RwLock<ServerStateInner>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_host_id() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut raw = [0u8; 4];
    OsRng.fill_bytes(&mut raw);
    let suffix: String = raw
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect();
    format!("LK-{suffix}")
}

fn send_wire_json(tx: &mpsc::UnboundedSender<WireMsg>, payload: &Value) {
    let _ = tx.send(WireMsg::Text(payload.to_string()));
}

fn normalize_ws_url(target_url: &str) -> Result<String, String> {
    let trimmed = target_url.trim();
    if trimmed.is_empty() {
        return Err("Alamat host tujuan kosong".to_string());
    }
    let without_trailing = trimmed.trim_end_matches('/');
    let ws_base = if let Some(rest) = without_trailing.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = without_trailing.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if without_trailing.starts_with("ws://") || without_trailing.starts_with("wss://") {
        without_trailing.to_string()
    } else if without_trailing.contains(':') {
        format!("ws://{without_trailing}")
    } else {
        format!("ws://{without_trailing}:{LAN_PORT}")
    };

    if ws_base.ends_with("/ws") {
        Ok(ws_base)
    } else {
        Ok(format!("{ws_base}/ws"))
    }
}

fn build_binary_with_hop(bin: &[u8], mut header: BinaryRelayHeader, add_host_id: &str) -> Option<Vec<u8>> {
    if !header.hop_path.iter().any(|h| h == add_host_id) {
        header.hop_path.push(add_host_id.to_string());
    }
    let orig_header_len = u32::from_be_bytes([bin[0], bin[1], bin[2], bin[3]]) as usize;
    let payload_slice = &bin[4 + orig_header_len..];
    let new_header_bytes = serde_json::to_vec(&header).ok()?;
    let new_len = new_header_bytes.len() as u32;
    let mut out = Vec::with_capacity(4 + new_header_bytes.len() + payload_slice.len());
    out.extend_from_slice(&new_len.to_be_bytes());
    out.extend_from_slice(&new_header_bytes);
    out.extend_from_slice(payload_slice);
    Some(out)
}

fn annotate_local_peer(peer: &PeerInfo, host_id: &str, host_label: &str) -> PeerInfo {
    let mut p = peer.clone();
    p.origin_host_id = Some(host_id.to_string());
    p.origin_host_label = Some(host_label.to_string());
    p.hops = Some(0);
    p
}

fn all_known_peers_for_client(guard: &ServerStateInner) -> Vec<PeerInfo> {
    let mut out: Vec<PeerInfo> = guard
        .clients
        .values()
        .map(|c| annotate_local_peer(&c.peer, &guard.host_id, &guard.host_label))
        .collect();
    for entry in guard.bridge_peers.values() {
        out.push(entry.peer.clone());
    }
    out
}

fn all_known_peers_for_bridge(guard: &ServerStateInner, target_host_id: Option<&str>) -> Vec<PeerInfo> {
    let mut out: Vec<PeerInfo> = guard
        .clients
        .values()
        .map(|c| annotate_local_peer(&c.peer, &guard.host_id, &guard.host_label))
        .collect();
    for entry in guard.bridge_peers.values() {
        if entry.hops >= MAX_BRIDGE_HOPS {
            continue;
        }
        if let Some(thid) = target_host_id {
            if entry.hop_path.iter().any(|h| h == thid) {
                continue;
            }
        }
        out.push(entry.peer.clone());
    }
    out
}

fn upsert_bridged_peer(
    guard: &mut ServerStateInner,
    mut incoming: PeerInfo,
    via_bridge_id: &str,
    default_origin_id: &str,
    default_origin_label: &str,
    mut hop_path: Vec<String>,
) -> Option<PeerInfo> {
    if incoming.peer_id.is_empty() || guard.clients.contains_key(&incoming.peer_id) {
        return None;
    }
    if hop_path.iter().any(|h| h == &guard.host_id) {
        return None;
    }
    if !hop_path.iter().any(|h| h == default_origin_id) {
        hop_path.push(default_origin_id.to_string());
    }
    let hops = hop_path.len().min(u8::MAX as usize) as u8;
    if hops > MAX_BRIDGE_HOPS {
        return None;
    }

    if let Some(existing) = guard.bridge_peers.get(&incoming.peer_id) {
        if existing.via_bridge_id != via_bridge_id && hops >= existing.hops {
            return None;
        }
    }

    if incoming.origin_host_id.is_none() {
        incoming.origin_host_id = Some(default_origin_id.to_string());
    }
    if incoming.origin_host_label.is_none() {
        incoming.origin_host_label = Some(default_origin_label.to_string());
    }
    incoming.hops = Some(hops);
    incoming.online = true;

    guard.bridge_peers.insert(
        incoming.peer_id.clone(),
        BridgedPeerEntry {
            peer: incoming.clone(),
            via_bridge_id: via_bridge_id.to_string(),
            hops,
            hop_path,
        },
    );

    Some(incoming)
}

pub fn collect_lan_network_info(port: u16) -> LanNetworkInfo {
    let mut found_ips: Vec<std::net::Ipv4Addr> = Vec::new();

    if let Ok(fib) = std::fs::read_to_string("/proc/net/fib_trie") {
        let mut prev_ip: Option<std::net::Ipv4Addr> = None;
        for line in fib.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("|-- ") {
                if let Ok(ip) = rest.trim().parse::<std::net::Ipv4Addr>() {
                    prev_ip = Some(ip);
                } else {
                    prev_ip = None;
                }
            } else if trimmed.contains("/32 host LOCAL") {
                if let Some(ip) = prev_ip {
                    if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() {
                        let octets = ip.octets();
                        if !(octets[0] == 169 && octets[1] == 254) && !found_ips.contains(&ip) {
                            found_ips.push(ip);
                        }
                    }
                }
            }
        }
    }

    for probe in [
        "192.168.43.1:80",
        "192.168.137.1:80",
        "192.168.1.1:80",
        "192.168.0.1:80",
        "10.0.0.1:80",
        "172.16.0.1:80",
        "8.8.8.8:80",
    ] {
        if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(probe).is_ok() {
                if let Ok(local) = sock.local_addr() {
                    if let IpAddr::V4(v4) = local.ip() {
                        let octets = v4.octets();
                        if !v4.is_loopback()
                            && !v4.is_link_local()
                            && !v4.is_unspecified()
                            && !(octets[0] == 169 && octets[1] == 254)
                            && !found_ips.contains(&v4)
                        {
                            found_ips.push(v4);
                        }
                    }
                }
            }
        }
    }

    let mut entries: Vec<(u8, LanAddress)> = found_ips
        .into_iter()
        .enumerate()
        .map(|(idx, v4)| {
            let octets = v4.octets();
            let priority = if octets[0] == 192 && octets[1] == 168 {
                0
            } else if octets[0] == 10 {
                1
            } else if octets[0] == 172 && (16..=31).contains(&octets[1]) {
                2
            } else {
                3
            };
            let addr_str = v4.to_string();
            (
                priority,
                LanAddress {
                    name: if idx == 0 {
                        "wlan0".to_string()
                    } else {
                        format!("lan{}", idx)
                    },
                    address: addr_str.clone(),
                    url: format!("http://{}:{}", addr_str, port),
                },
            )
        })
        .collect();

    entries.sort_by_key(|(prio, _)| *prio);
    let addresses: Vec<LanAddress> = entries.into_iter().map(|(_, addr)| addr).collect();

    let primary_url = addresses
        .first()
        .map(|a| a.url.clone())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", port));

    LanNetworkInfo {
        port,
        hostname: "LokaKirim-Android".to_string(),
        addresses,
        primary_url,
    }
}

#[tauri::command]
pub fn get_rust_lan_info() -> LanNetworkInfo {
    collect_lan_network_info(LAN_PORT)
}

#[tauri::command]
pub async fn rust_get_host_config() -> Result<RustHostConfigDto, String> {
    let state = LAN_APP_STATE
        .get()
        .ok_or_else(|| "Server LAN Rust belum siap".to_string())?;
    let guard = state.inner.read().await;
    Ok(RustHostConfigDto {
        host_id: guard.host_id.clone(),
        host_label: guard.host_label.clone(),
        requires_access_code: guard.access_code.as_ref().is_some_and(|c| !c.is_empty()),
        access_code: guard.access_code.clone(),
        bridge_count: guard
            .bridges
            .values()
            .filter(|b| b.status == "connected")
            .count(),
    })
}

#[tauri::command]
pub async fn rust_set_host_config(
    host_label: Option<String>,
    access_code: Option<String>,
) -> Result<RustHostConfigDto, String> {
    let state = LAN_APP_STATE
        .get()
        .ok_or_else(|| "Server LAN Rust belum siap".to_string())?;
    let mut guard = state.inner.write().await;
    if let Some(lbl) = host_label {
        let trimmed: String = lbl.trim().chars().take(36).collect();
        if !trimmed.is_empty() {
            guard.host_label = trimmed;
        }
    }
    if let Some(code) = access_code {
        let trimmed: String = code.trim().chars().take(24).collect();
        guard.access_code = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
    Ok(RustHostConfigDto {
        host_id: guard.host_id.clone(),
        host_label: guard.host_label.clone(),
        requires_access_code: guard.access_code.as_ref().is_some_and(|c| !c.is_empty()),
        access_code: guard.access_code.clone(),
        bridge_count: guard
            .bridges
            .values()
            .filter(|b| b.status == "connected")
            .count(),
    })
}

#[tauri::command]
pub async fn rust_list_bridges() -> Result<Vec<RustBridgeStatusDto>, String> {
    let state = LAN_APP_STATE
        .get()
        .ok_or_else(|| "Server LAN Rust belum siap".to_string())?;
    let guard = state.inner.read().await;
    Ok(list_bridges_from_guard(&guard))
}

#[tauri::command]
pub async fn rust_add_bridge(
    target_url: String,
    access_code: Option<String>,
) -> Result<RustBridgeStatusDto, String> {
    let state = LAN_APP_STATE
        .get()
        .ok_or_else(|| "Server LAN Rust belum siap".to_string())?
        .clone();
    add_outbound_bridge(state, target_url, access_code).await
}

#[tauri::command]
pub async fn rust_remove_bridge(bridge_id: String) -> Result<(), String> {
    let state = LAN_APP_STATE
        .get()
        .ok_or_else(|| "Server LAN Rust belum siap".to_string())?
        .clone();
    remove_bridge_by_id(&state, &bridge_id).await;
    Ok(())
}

fn list_bridges_from_guard(guard: &ServerStateInner) -> Vec<RustBridgeStatusDto> {
    guard
        .bridges
        .values()
        .map(|b| RustBridgeStatusDto {
            id: b.id.clone(),
            target_url: b.target_url.clone(),
            target_host_id: b.target_host_id.clone(),
            target_host_label: b.target_host_label.clone(),
            direction: b.direction.clone(),
            status: b.status.clone(),
            error: b.error.clone(),
            connected_at: b.connected_at,
        })
        .collect()
}

async fn add_outbound_bridge(
    state: AppState,
    target_url: String,
    access_code: Option<String>,
) -> Result<RustBridgeStatusDto, String> {
    let ws_url = normalize_ws_url(&target_url)?;
    let normalized_http = ws_url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1)
        .trim_end_matches("/ws")
        .to_string();

    {
        let guard = state.inner.read().await;
        if let Some(existing) = guard
            .bridges
            .values()
            .find(|b| b.target_url == normalized_http && b.direction == "outbound")
        {
            return Ok(RustBridgeStatusDto {
                id: existing.id.clone(),
                target_url: existing.target_url.clone(),
                target_host_id: existing.target_host_id.clone(),
                target_host_label: existing.target_host_label.clone(),
                direction: existing.direction.clone(),
                status: existing.status.clone(),
                error: existing.error.clone(),
                connected_at: existing.connected_at,
            });
        }
    }

    let bridge_id = format!("bridge-{}", NEXT_BRIDGE_SEQ.fetch_add(1, Ordering::Relaxed));
    let bid_clone = bridge_id.clone();
    let state_clone = state.clone();
    let target_http_clone = normalized_http.clone();
    let code_clone = access_code.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());

    let handle = tokio::spawn(async move {
        run_outbound_bridge_loop(state_clone, bid_clone, ws_url, code_clone).await;
    });

    let dto = {
        let mut guard = state.inner.write().await;
        guard.bridges.insert(
            bridge_id.clone(),
            BridgeLink {
                id: bridge_id.clone(),
                target_url: normalized_http.clone(),
                target_host_id: None,
                target_host_label: None,
                direction: "outbound".to_string(),
                status: "connecting".to_string(),
                error: None,
                connected_at: None,
                tx: None,
                task_handle: Some(handle),
            },
        );
        RustBridgeStatusDto {
            id: bridge_id,
            target_url: target_http_clone,
            target_host_id: None,
            target_host_label: None,
            direction: "outbound".to_string(),
            status: "connecting".to_string(),
            error: None,
            connected_at: None,
        }
    };

    Ok(dto)
}

async fn remove_bridge_by_id(state: &AppState, bridge_id: &str) {
    let task = {
        let mut guard = state.inner.write().await;
        guard.bridges.remove(bridge_id).and_then(|mut b| b.task_handle.take())
    };
    if let Some(handle) = task {
        handle.abort();
    }
    cleanup_bridge_peers(state, bridge_id).await;
}

async fn cleanup_bridge_peers(state: &AppState, bridge_id: &str) {
    let (removed_ids, self_host_id, other_bridges) = {
        let mut guard = state.inner.write().await;
        let removed: Vec<String> = guard
            .bridge_peers
            .iter()
            .filter(|(_, entry)| entry.via_bridge_id == bridge_id)
            .map(|(pid, _)| pid.clone())
            .collect();
        for pid in &removed {
            guard.bridge_peers.remove(pid);
        }
        let bridges: Vec<(String, Option<String>, mpsc::UnboundedSender<WireMsg>)> = guard
            .bridges
            .values()
            .filter(|b| b.id != bridge_id && b.status == "connected")
            .filter_map(|b| {
                b.tx.as_ref()
                    .map(|tx| (b.id.clone(), b.target_host_id.clone(), tx.clone()))
            })
            .collect();
        (removed, guard.host_id.clone(), bridges)
    };

    for pid in removed_ids {
        broadcast_json(state, &json!({ "type": "peer:left", "peerId": pid }), None).await;
        for (_, _, btx) in &other_bridges {
            send_wire_json(
                btx,
                &json!({
                    "type": "bridge:peer_sync",
                    "action": "remove",
                    "peerId": pid,
                    "hopPath": [self_host_id],
                }),
            );
        }
    }
}

async fn run_outbound_bridge_loop(
    state: AppState,
    bridge_id: String,
    ws_url: String,
    access_code: Option<String>,
) {
    let mut attempt: u32 = 0;

    loop {
        {
            let guard = state.inner.read().await;
            if !guard.bridges.contains_key(&bridge_id) {
                return;
            }
        }

        let connect_res =
            tokio::time::timeout(Duration::from_secs(6), connect_async(ws_url.as_str())).await;

        let ws_stream = match connect_res {
            Ok(Ok((stream, _))) => {
                attempt = 0;
                stream
            }
            Ok(Err(err)) => {
                let err_msg = format!("Gagal menjangkau bridge {ws_url}: {err}");
                {
                    let mut guard = state.inner.write().await;
                    if let Some(link) = guard.bridges.get_mut(&bridge_id) {
                        link.status = "reconnecting".to_string();
                        link.error = Some(err_msg);
                        link.tx = None;
                    } else {
                        return;
                    }
                }
                attempt = attempt.saturating_add(1);
                let wait_s = (2u64.saturating_pow(attempt.min(3))).min(8);
                tokio::time::sleep(Duration::from_secs(wait_s)).await;
                continue;
            }
            Err(_) => {
                {
                    let mut guard = state.inner.write().await;
                    if let Some(link) = guard.bridges.get_mut(&bridge_id) {
                        link.status = "reconnecting".to_string();
                        link.error = Some("Waktu koneksi bridge habis".to_string());
                        link.tx = None;
                    } else {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };

        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<WireMsg>();

        let write_task = tokio::spawn(async move {
            while let Some(wmsg) = rx.recv().await {
                let msg = match wmsg {
                    WireMsg::Text(t) => TungMessage::text(t),
                    WireMsg::Binary(b) => TungMessage::binary(b),
                };
                if write.send(msg).await.is_err() {
                    break;
                }
            }
        });

        let hello_payload = {
            let mut guard = state.inner.write().await;
            let peers = all_known_peers_for_bridge(&guard, None);
            let rooms: Vec<RoomInfo> = guard.rooms.values().cloned().collect();
            let host_id = guard.host_id.clone();
            let host_label = guard.host_label.clone();
            if let Some(link) = guard.bridges.get_mut(&bridge_id) {
                link.tx = Some(tx.clone());
                link.status = "handshaking".to_string();
                link.error = None;
            }
            json!({
                "type": "bridge:hello",
                "bridgeHostId": host_id,
                "bridgeHostLabel": host_label,
                "accessCode": access_code,
                "hopPath": [host_id],
                "peers": peers,
                "rooms": rooms,
            })
        };

        send_wire_json(&tx, &hello_payload);

        let mut auth_rejected = false;
        while let Some(item) = read.next().await {
            match item {
                Ok(TungMessage::Text(txt)) => {
                    let Ok(parsed) = serde_json::from_str::<Value>(txt.as_str()) else {
                        continue;
                    };
                    let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if msg_type == "auth:rejected" {
                        let reason = parsed
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Kode akses host bridge ditolak")
                            .to_string();
                        let mut guard = state.inner.write().await;
                        if let Some(link) = guard.bridges.get_mut(&bridge_id) {
                            link.status = "auth_error".to_string();
                            link.error = Some(reason);
                            link.tx = None;
                        }
                        auth_rejected = true;
                        break;
                    }
                    handle_bridge_message(&state, &bridge_id, msg_type, &parsed).await;
                }
                Ok(TungMessage::Binary(bin)) => {
                    handle_bridge_binary(&state, &bridge_id, &bin).await;
                }
                Ok(TungMessage::Close(_)) | Err(_) => break,
                _ => {}
            }
        }

        write_task.abort();
        cleanup_bridge_peers(&state, &bridge_id).await;

        if auth_rejected {
            return;
        }

        {
            let mut guard = state.inner.write().await;
            if let Some(link) = guard.bridges.get_mut(&bridge_id) {
                link.status = "reconnecting".to_string();
                link.tx = None;
                if link.error.is_none() {
                    link.error = Some("Koneksi bridge terputus, menyambung ulang...".to_string());
                }
            } else {
                return;
            }
        }

        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn api_health(State(state): State<AppState>) -> Json<Value> {
    let guard = state.inner.read().await;
    Json(json!({
        "ok": true,
        "hostId": guard.host_id,
        "hostLabel": guard.host_label,
        "requiresAccessCode": guard.access_code.as_ref().is_some_and(|c| !c.is_empty()),
        "peersOnline": guard.clients.len() + guard.bridge_peers.len(),
        "localPeers": guard.clients.len(),
        "bridgeCount": guard.bridges.values().filter(|b| b.status == "connected").count(),
        "roomsCount": guard.rooms.len(),
        "activeCalls": guard.calls.len(),
        "engine": "rust-axum"
    }))
}

async fn api_network_info() -> Json<LanNetworkInfo> {
    Json(collect_lan_network_info(LAN_PORT))
}

async fn api_get_host_config(State(state): State<AppState>) -> Json<Value> {
    let guard = state.inner.read().await;
    Json(json!({
        "hostId": guard.host_id,
        "hostLabel": guard.host_label,
        "requiresAccessCode": guard.access_code.as_ref().is_some_and(|c| !c.is_empty()),
        "bridgeCount": guard.bridges.values().filter(|b| b.status == "connected").count(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHostConfigBody {
    host_label: Option<String>,
    access_code: Option<String>,
}

async fn api_set_host_config(
    State(state): State<AppState>,
    Json(body): Json<UpdateHostConfigBody>,
) -> Json<Value> {
    let mut guard = state.inner.write().await;
    if let Some(lbl) = body.host_label {
        let trimmed: String = lbl.trim().chars().take(36).collect();
        if !trimmed.is_empty() {
            guard.host_label = trimmed;
        }
    }
    if let Some(code) = body.access_code {
        let trimmed: String = code.trim().chars().take(24).collect();
        guard.access_code = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
    Json(json!({
        "hostId": guard.host_id,
        "hostLabel": guard.host_label,
        "requiresAccessCode": guard.access_code.as_ref().is_some_and(|c| !c.is_empty()),
        "bridgeCount": guard.bridges.values().filter(|b| b.status == "connected").count(),
    }))
}

async fn api_list_bridges(State(state): State<AppState>) -> Json<Vec<RustBridgeStatusDto>> {
    let guard = state.inner.read().await;
    Json(list_bridges_from_guard(&guard))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddBridgeBody {
    target_url: String,
    access_code: Option<String>,
}

async fn api_add_bridge(
    State(state): State<AppState>,
    Json(body): Json<AddBridgeBody>,
) -> Response {
    match add_outbound_bridge(state, body.target_url, body.access_code).await {
        Ok(dto) => Json(dto).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response(),
    }
}

async fn api_delete_bridge(
    State(state): State<AppState>,
    AxumPath(bridge_id): AxumPath<String>,
) -> Json<Value> {
    remove_bridge_by_id(&state, &bridge_id).await;
    Json(json!({ "ok": true }))
}

fn serve_embedded_file(path: &str) -> Response {
    let clean = path.trim_start_matches('/');
    let file = if clean.is_empty() {
        DIST_DIR.get_file("index.html")
    } else {
        DIST_DIR
            .get_file(clean)
            .or_else(|| DIST_DIR.get_file("index.html"))
    };

    match file {
        Some(f) => {
            let mime = mime_guess::from_path(f.path()).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(f.contents()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => (
            StatusCode::NOT_FOUND,
            "Aset frontend LokaKirim belum dibundel",
        )
            .into_response(),
    }
}

async fn static_root() -> Response {
    serve_embedded_file("index.html")
}

async fn static_path(AxumPath(path): AxumPath<String>) -> Response {
    serve_embedded_file(&path)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(8 * 1024 * 1024)
        .max_frame_size(8 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn broadcast_json(state: &AppState, payload: &Value, exclude_peer_id: Option<&str>) {
    let raw = payload.to_string();
    let txs: Vec<mpsc::UnboundedSender<WireMsg>> = {
        let guard = state.inner.read().await;
        guard
            .clients
            .iter()
            .filter(|(peer_id, _)| exclude_peer_id.is_none_or(|ex| peer_id.as_str() != ex))
            .map(|(_, c)| c.tx.clone())
            .collect()
    };
    for tx in txs {
        let _ = tx.send(WireMsg::Text(raw.clone()));
    }
}

async fn relay_to_target(
    state: &AppState,
    conversation_type: &str,
    target_id: &str,
    sender_id: &str,
    raw_json_value: Option<&Value>,
    raw_wire: WireMsg,
    incoming_hop_path: &[String],
    skip_bridge_id: Option<&str>,
) -> usize {
    enum BridgeAction {
        Text(mpsc::UnboundedSender<WireMsg>, String),
        Binary(mpsc::UnboundedSender<WireMsg>, Vec<u8>),
    }

    let (local_txs, bridge_actions): (Vec<mpsc::UnboundedSender<WireMsg>>, Vec<BridgeAction>) = {
        let mut guard = state.inner.write().await;
        let self_host_id = guard.host_id.clone();

        if conversation_type == "dm" {
            if let Some(c) = guard.clients.get(target_id) {
                (vec![c.tx.clone()], Vec::new())
            } else if let Some(bp) = guard.bridge_peers.get(target_id) {
                let via_id = bp.via_bridge_id.clone();
                if skip_bridge_id == Some(via_id.as_str()) {
                    (Vec::new(), Vec::new())
                } else if let Some(btx) = guard.bridges.get(&via_id).and_then(|b| b.tx.as_ref()) {
                    let mut next_hops = incoming_hop_path.to_vec();
                    if !next_hops.iter().any(|h| h == &self_host_id) {
                        next_hops.push(self_host_id.clone());
                    }
                    let act = match (&raw_wire, raw_json_value) {
                        (WireMsg::Text(_), Some(pkt)) => {
                            let envelope = json!({
                                "type": "bridge:relay_dm",
                                "targetPeerId": target_id,
                                "senderPeerId": sender_id,
                                "hopPath": next_hops,
                                "packet": pkt,
                            });
                            Some(BridgeAction::Text(btx.clone(), envelope.to_string()))
                        }
                        (WireMsg::Binary(bin), _) => {
                            if let Some(header) = parse_binary_header(bin) {
                                build_binary_with_hop(bin, header, &self_host_id)
                                    .map(|updated| BridgeAction::Binary(btx.clone(), updated))
                            } else {
                                None
                            }
                        }
                        _ => None,
                    };
                    (Vec::new(), act.into_iter().collect())
                } else {
                    (Vec::new(), Vec::new())
                }
            } else {
                (Vec::new(), Vec::new())
            }
        } else {
            // Room relay (ruang-utama or custom room)
            let local: Vec<mpsc::UnboundedSender<WireMsg>> = if target_id == DEFAULT_ROOM_ID {
                if let Some(room) = guard.rooms.get_mut(DEFAULT_ROOM_ID) {
                    if !sender_id.is_empty() && !room.member_ids.iter().any(|id| id == sender_id) {
                        room.member_ids.push(sender_id.to_string());
                    }
                }
                guard
                    .clients
                    .iter()
                    .filter(|(peer_id, _)| peer_id.as_str() != sender_id)
                    .map(|(_, c)| c.tx.clone())
                    .collect()
            } else if let Some(room) = guard.rooms.get_mut(target_id) {
                if !sender_id.is_empty() && !room.member_ids.iter().any(|id| id == sender_id) {
                    room.member_ids.push(sender_id.to_string());
                }
                let member_ids = room.member_ids.clone();
                member_ids
                    .iter()
                    .filter(|id| id.as_str() != sender_id)
                    .filter_map(|id| guard.clients.get(id).map(|c| c.tx.clone()))
                    .collect()
            } else {
                Vec::new()
            };

            let mut bridge_acts = Vec::new();
            if (incoming_hop_path.len() as u8) < MAX_BRIDGE_HOPS {
                let mut next_hops = incoming_hop_path.to_vec();
                if !next_hops.iter().any(|h| h == &self_host_id) {
                    next_hops.push(self_host_id.clone());
                }

                for (bid, link) in &guard.bridges {
                    if link.status != "connected" || skip_bridge_id == Some(bid.as_str()) {
                        continue;
                    }
                    if let Some(ref thid) = link.target_host_id {
                        if next_hops.iter().any(|h| h == thid) {
                            continue;
                        }
                    }
                    let Some(ref btx) = link.tx else {
                        continue;
                    };
                    match (&raw_wire, raw_json_value) {
                        (WireMsg::Text(_), Some(pkt)) => {
                            let envelope = json!({
                                "type": "bridge:relay_room",
                                "roomId": target_id,
                                "senderPeerId": sender_id,
                                "hopPath": next_hops,
                                "packet": pkt,
                            });
                            bridge_acts.push(BridgeAction::Text(btx.clone(), envelope.to_string()));
                        }
                        (WireMsg::Binary(bin), _) => {
                            if let Some(header) = parse_binary_header(bin) {
                                if let Some(updated) = build_binary_with_hop(bin, header, &self_host_id)
                                {
                                    bridge_acts.push(BridgeAction::Binary(btx.clone(), updated));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }

            (local, bridge_acts)
        }
    };

    let mut delivered = 0usize;
    for tx in local_txs {
        if tx.send(raw_wire.clone()).is_ok() {
            delivered += 1;
        }
    }
    for act in bridge_actions {
        match act {
            BridgeAction::Text(btx, raw) => {
                if btx.send(WireMsg::Text(raw)).is_ok() {
                    delivered += 1;
                }
            }
            BridgeAction::Binary(btx, bytes) => {
                if btx.send(WireMsg::Binary(bytes)).is_ok() {
                    delivered += 1;
                }
            }
        }
    }
    delivered
}

fn parse_binary_header(bin: &[u8]) -> Option<BinaryRelayHeader> {
    if bin.len() < 8 {
        return None;
    }
    let header_len = u32::from_be_bytes([bin[0], bin[1], bin[2], bin[3]]) as usize;
    if header_len == 0 || header_len > 16_384 || bin.len() < 4 + header_len {
        return None;
    }
    serde_json::from_slice::<BinaryRelayHeader>(&bin[4..4 + header_len]).ok()
}

async fn handle_bridge_binary(state: &AppState, from_bridge_id: &str, bin: &[u8]) {
    let Some(header) = parse_binary_header(bin) else {
        return;
    };
    let self_host_id = state.inner.read().await.host_id.clone();
    if header.hop_path.iter().any(|h| h == &self_host_id) {
        return;
    }
    let hops = header.hop_path.clone();
    relay_to_target(
        state,
        &header.conversation_type,
        &header.target_id,
        &header.sender_id,
        None,
        WireMsg::Binary(bin.to_vec()),
        &hops,
        Some(from_bridge_id),
    )
    .await;
}

async fn handle_bridge_message(
    state: &AppState,
    bridge_id: &str,
    msg_type: &str,
    parsed: &Value,
) {
    match msg_type {
        "bridge:welcome" => {
            let remote_host_id = parsed
                .get("bridgeHostId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let remote_host_label = parsed
                .get("bridgeHostLabel")
                .and_then(|v| v.as_str())
                .unwrap_or("Host Bridge")
                .trim()
                .to_string();
            if remote_host_id.is_empty() {
                return;
            }
            let incoming_peers: Vec<PeerInfo> = parsed
                .get("peers")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let incoming_rooms: Vec<RoomInfo> = parsed
                .get("rooms")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let (added_peers, added_rooms, other_bridges, self_host_id) = {
                let mut guard = state.inner.write().await;
                if remote_host_id == guard.host_id {
                    if let Some(link) = guard.bridges.get_mut(bridge_id) {
                        link.status = "auth_error".to_string();
                        link.error = Some("Tidak dapat menjembatani ke host sendiri".to_string());
                    }
                    return;
                }
                if let Some(link) = guard.bridges.get_mut(bridge_id) {
                    link.target_host_id = Some(remote_host_id.clone());
                    link.target_host_label = Some(remote_host_label.clone());
                    link.status = "connected".to_string();
                    link.error = None;
                    link.connected_at = Some(now_ms());
                }

                let mut added_p = Vec::new();
                for p in incoming_peers {
                    let hpath = vec![remote_host_id.clone()];
                    if let Some(up) = upsert_bridged_peer(
                        &mut guard,
                        p,
                        bridge_id,
                        &remote_host_id,
                        &remote_host_label,
                        hpath,
                    ) {
                        added_p.push(up);
                    }
                }

                let mut added_r = Vec::new();
                for mut r in incoming_rooms {
                    if r.room_id == DEFAULT_ROOM_ID {
                        if let Some(def) = guard.rooms.get_mut(DEFAULT_ROOM_ID) {
                            for m in r.member_ids {
                                if !def.member_ids.contains(&m) {
                                    def.member_ids.push(m);
                                }
                            }
                        }
                        continue;
                    }
                    if !guard.rooms.contains_key(&r.room_id) {
                        if r.origin_host_id.is_none() {
                            r.origin_host_id = Some(remote_host_id.clone());
                            r.origin_host_label = Some(remote_host_label.clone());
                        }
                        guard.rooms.insert(r.room_id.clone(), r.clone());
                        added_r.push(r);
                    }
                }

                let others: Vec<(Option<String>, mpsc::UnboundedSender<WireMsg>)> = guard
                    .bridges
                    .values()
                    .filter(|b| b.id != bridge_id && b.status == "connected")
                    .filter_map(|b| b.tx.as_ref().map(|t| (b.target_host_id.clone(), t.clone())))
                    .collect();
                (added_p, added_r, others, guard.host_id.clone())
            };

            for p in &added_peers {
                broadcast_json(state, &json!({ "type": "peer:joined", "peer": p }), None).await;
                for (thid, btx) in &other_bridges {
                    if thid.as_deref() != Some(remote_host_id.as_str()) {
                        send_wire_json(
                            btx,
                            &json!({
                                "type": "bridge:peer_sync",
                                "action": "upsert",
                                "peer": p,
                                "hopPath": [remote_host_id, self_host_id],
                            }),
                        );
                    }
                }
            }
            for r in &added_rooms {
                broadcast_json(state, &json!({ "type": "room:created", "room": r }), None).await;
                for (_, btx) in &other_bridges {
                    send_wire_json(
                        btx,
                        &json!({
                            "type": "bridge:room_sync",
                            "action": "upsert",
                            "room": r,
                            "hopPath": [remote_host_id, self_host_id],
                        }),
                    );
                }
            }
        }
        "bridge:peer_sync" => {
            let action = parsed.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let hop_path: Vec<String> = parsed
                .get("hopPath")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let (self_host_id, bridge_origin_id, bridge_origin_label, other_bridges) = {
                let guard = state.inner.read().await;
                if hop_path.iter().any(|h| h == &guard.host_id)
                    || hop_path.len() as u8 >= MAX_BRIDGE_HOPS
                {
                    return;
                }
                let link = guard.bridges.get(bridge_id);
                let orig_id = link
                    .and_then(|l| l.target_host_id.clone())
                    .unwrap_or_else(|| bridge_id.to_string());
                let orig_lbl = link
                    .and_then(|l| l.target_host_label.clone())
                    .unwrap_or_else(|| "Bridge".to_string());
                let others: Vec<(Option<String>, mpsc::UnboundedSender<WireMsg>)> = guard
                    .bridges
                    .values()
                    .filter(|b| b.id != bridge_id && b.status == "connected")
                    .filter(|b| {
                        b.target_host_id
                            .as_ref()
                            .is_none_or(|tid| !hop_path.iter().any(|h| h == tid))
                    })
                    .filter_map(|b| b.tx.as_ref().map(|t| (b.target_host_id.clone(), t.clone())))
                    .collect();
                (guard.host_id.clone(), orig_id, orig_lbl, others)
            };

            let mut next_hops = hop_path.clone();
            if !next_hops.iter().any(|h| h == &self_host_id) {
                next_hops.push(self_host_id);
            }

            if action == "upsert" {
                let Ok(peer) = serde_json::from_value::<PeerInfo>(
                    parsed.get("peer").cloned().unwrap_or(Value::Null),
                ) else {
                    return;
                };
                let inserted = {
                    let mut guard = state.inner.write().await;
                    upsert_bridged_peer(
                        &mut guard,
                        peer,
                        bridge_id,
                        &bridge_origin_id,
                        &bridge_origin_label,
                        hop_path,
                    )
                };
                if let Some(p) = inserted {
                    broadcast_json(state, &json!({ "type": "peer:joined", "peer": p }), None).await;
                    for (_, btx) in other_bridges {
                        send_wire_json(
                            &btx,
                            &json!({
                                "type": "bridge:peer_sync",
                                "action": "upsert",
                                "peer": p,
                                "hopPath": next_hops,
                            }),
                        );
                    }
                }
            } else if action == "remove" {
                let peer_id = parsed
                    .get("peerId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if peer_id.is_empty() {
                    return;
                }
                let removed = {
                    let mut guard = state.inner.write().await;
                    if guard
                        .bridge_peers
                        .get(&peer_id)
                        .is_some_and(|e| e.via_bridge_id == bridge_id)
                    {
                        guard.bridge_peers.remove(&peer_id).is_some()
                    } else {
                        false
                    }
                };
                if removed {
                    broadcast_json(state, &json!({ "type": "peer:left", "peerId": peer_id }), None)
                        .await;
                    for (_, btx) in other_bridges {
                        send_wire_json(
                            &btx,
                            &json!({
                                "type": "bridge:peer_sync",
                                "action": "remove",
                                "peerId": peer_id,
                                "hopPath": next_hops,
                            }),
                        );
                    }
                }
            }
        }
        "bridge:room_sync" => {
            let hop_path: Vec<String> = parsed
                .get("hopPath")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let Ok(mut room) = serde_json::from_value::<RoomInfo>(
                parsed.get("room").cloned().unwrap_or(Value::Null),
            ) else {
                return;
            };
            let (is_new, updated, self_host_id, other_bridges) = {
                let mut guard = state.inner.write().await;
                if hop_path.iter().any(|h| h == &guard.host_id)
                    || hop_path.len() as u8 >= MAX_BRIDGE_HOPS
                {
                    return;
                }
                let existed = guard.rooms.contains_key(&room.room_id);
                if let Some(existing) = guard.rooms.get_mut(&room.room_id) {
                    for m in &room.member_ids {
                        if !existing.member_ids.contains(m) {
                            existing.member_ids.push(m.clone());
                        }
                    }
                } else {
                    if room.origin_host_id.is_none() {
                        room.origin_host_id = guard
                            .bridges
                            .get(bridge_id)
                            .and_then(|b| b.target_host_id.clone());
                        room.origin_host_label = guard
                            .bridges
                            .get(bridge_id)
                            .and_then(|b| b.target_host_label.clone());
                    }
                    guard.rooms.insert(room.room_id.clone(), room.clone());
                }
                let merged = guard.rooms.get(&room.room_id).cloned();
                let others: Vec<mpsc::UnboundedSender<WireMsg>> = guard
                    .bridges
                    .values()
                    .filter(|b| b.id != bridge_id && b.status == "connected")
                    .filter(|b| {
                        b.target_host_id
                            .as_ref()
                            .is_none_or(|tid| !hop_path.iter().any(|h| h == tid))
                    })
                    .filter_map(|b| b.tx.clone())
                    .collect();
                (!existed, merged, guard.host_id.clone(), others)
            };

            if let Some(rm) = updated {
                let ev = if is_new { "room:created" } else { "room:updated" };
                broadcast_json(state, &json!({ "type": ev, "room": rm }), None).await;
                let mut next_hops = hop_path;
                if !next_hops.iter().any(|h| h == &self_host_id) {
                    next_hops.push(self_host_id);
                }
                for btx in other_bridges {
                    send_wire_json(
                        &btx,
                        &json!({
                            "type": "bridge:room_sync",
                            "action": "upsert",
                            "room": rm,
                            "hopPath": next_hops,
                        }),
                    );
                }
            }
        }
        "bridge:relay_dm" => {
            let target_peer_id = parsed
                .get("targetPeerId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let sender_peer_id = parsed
                .get("senderPeerId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let hop_path: Vec<String> = parsed
                .get("hopPath")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let Some(packet) = parsed.get("packet") else {
                return;
            };
            let pkt_type = packet.get("type").and_then(|v| v.as_str()).unwrap_or("");

            {
                let guard = state.inner.read().await;
                if hop_path.iter().any(|h| h == &guard.host_id)
                    || hop_path.len() as u8 >= MAX_BRIDGE_HOPS
                {
                    return;
                }
            }

            // Special handling for call:invite arriving over bridge: verify local busy state
            if pkt_type == "call:invite" {
                let call_id = packet.get("callId").and_then(|v| v.as_str()).unwrap_or("");
                let call_type = packet
                    .get("callType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("audio");
                let local_outcome = {
                    let mut guard = state.inner.write().await;
                    if guard.clients.contains_key(target_peer_id) {
                        let busy = guard.calls.values().any(|c| {
                            c.caller_id == target_peer_id
                                || c.callee_id == target_peer_id
                                || c.caller_id == sender_peer_id
                                || c.callee_id == sender_peer_id
                        });
                        if busy {
                            Some(Err(("call:busy", "Perangkat sedang dalam panggilan lain")))
                        } else {
                            guard.calls.insert(
                                call_id.to_string(),
                                ActiveCallSession {
                                    call_id: call_id.to_string(),
                                    call_type: call_type.to_string(),
                                    caller_id: sender_peer_id.to_string(),
                                    callee_id: target_peer_id.to_string(),
                                    state: "ringing".to_string(),
                                    started_at: now_ms(),
                                },
                            );
                            ACTIVE_CALL_COUNTER.store(guard.calls.len(), Ordering::Relaxed);
                            Some(Ok(guard.clients.get(target_peer_id).map(|c| c.tx.clone())))
                        }
                    } else {
                        None
                    }
                };

                if let Some(outcome) = local_outcome {
                    match outcome {
                        Ok(Some(ltx)) => {
                            let _ = ltx.send(WireMsg::Text(packet.to_string()));
                        }
                        Ok(None) => {}
                        Err((err_type, reason)) => {
                            let err_pkt = json!({
                                "type": err_type,
                                "callId": call_id,
                                "targetPeerId": target_peer_id,
                                "reason": reason,
                            });
                            relay_to_target(
                                state,
                                "dm",
                                sender_peer_id,
                                target_peer_id,
                                Some(&err_pkt),
                                WireMsg::Text(err_pkt.to_string()),
                                &[],
                                None,
                            )
                            .await;
                        }
                    }
                    return;
                }
            } else if pkt_type == "call:accept" {
                let call_id = packet.get("callId").and_then(|v| v.as_str()).unwrap_or("");
                let mut guard = state.inner.write().await;
                if let Some(call) = guard.calls.get_mut(call_id) {
                    call.state = "active".to_string();
                    call.started_at = now_ms();
                }
            } else if pkt_type == "call:reject" || pkt_type == "call:hangup" || pkt_type == "call:cancel" {
                let call_id = packet.get("callId").and_then(|v| v.as_str()).unwrap_or("");
                let mut guard = state.inner.write().await;
                guard.calls.remove(call_id);
                ACTIVE_CALL_COUNTER.store(guard.calls.len(), Ordering::Relaxed);
            }

            let delivered = relay_to_target(
                state,
                "dm",
                target_peer_id,
                sender_peer_id,
                Some(packet),
                WireMsg::Text(packet.to_string()),
                &hop_path,
                Some(bridge_id),
            )
            .await;

            // If a bridged DM chat:message was delivered locally, send back chat:ack to sender
            if pkt_type == "chat:message" && delivered > 0 {
                let ack = json!({
                    "type": "chat:ack",
                    "id": packet.get("id").cloned().unwrap_or(Value::Null),
                    "recipientCount": delivered,
                });
                relay_to_target(
                    state,
                    "dm",
                    sender_peer_id,
                    target_peer_id,
                    Some(&ack),
                    WireMsg::Text(ack.to_string()),
                    &[],
                    None,
                )
                .await;
            }
        }
        "bridge:relay_room" => {
            let room_id = parsed.get("roomId").and_then(|v| v.as_str()).unwrap_or("");
            let sender_peer_id = parsed
                .get("senderPeerId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let hop_path: Vec<String> = parsed
                .get("hopPath")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let Some(packet) = parsed.get("packet") else {
                return;
            };
            {
                let guard = state.inner.read().await;
                if hop_path.iter().any(|h| h == &guard.host_id)
                    || hop_path.len() as u8 >= MAX_BRIDGE_HOPS
                {
                    return;
                }
            }

            let delivered = relay_to_target(
                state,
                "room",
                room_id,
                sender_peer_id,
                Some(packet),
                WireMsg::Text(packet.to_string()),
                &hop_path,
                Some(bridge_id),
            )
            .await;

            if packet.get("type").and_then(|v| v.as_str()) == Some("chat:message") && delivered > 0 {
                let ack = json!({
                    "type": "chat:ack",
                    "id": packet.get("id").cloned().unwrap_or(Value::Null),
                    "recipientCount": delivered,
                });
                relay_to_target(
                    state,
                    "dm",
                    sender_peer_id,
                    "",
                    Some(&ack),
                    WireMsg::Text(ack.to_string()),
                    &[],
                    None,
                )
                .await;
            }
        }
        _ => {}
    }
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<WireMsg>();

    let write_task = tokio::spawn(async move {
        while let Some(wmsg) = rx.recv().await {
            let msg = match wmsg {
                WireMsg::Text(t) => AxumMessage::Text(t.into()),
                WireMsg::Binary(b) => AxumMessage::Binary(b.into()),
            };
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut current_peer_id: Option<String> = None;
    let mut current_conn_id: u64 = 0;
    let mut current_inbound_bridge_id: Option<String> = None;

    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            AxumMessage::Binary(bin) => {
                if let Some(ref bid) = current_inbound_bridge_id {
                    handle_bridge_binary(&state, bid, &bin).await;
                    continue;
                }
                let Some(header) = parse_binary_header(&bin) else {
                    continue;
                };
                let hops = header.hop_path.clone();
                relay_to_target(
                    &state,
                    &header.conversation_type,
                    &header.target_id,
                    &header.sender_id,
                    None,
                    WireMsg::Binary(bin.to_vec()),
                    &hops,
                    None,
                )
                .await;
            }
            AxumMessage::Text(text) => {
                let Ok(parsed) = serde_json::from_str::<Value>(text.as_str()) else {
                    continue;
                };
                let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");

                if msg_type == "ping" {
                    let pong = json!({
                        "type": "pong",
                        "clientTs": parsed.get("clientTs").cloned().unwrap_or(Value::Null),
                        "serverTs": now_ms(),
                    });
                    send_wire_json(&tx, &pong);
                    continue;
                }

                // Inbound Host-to-Host Bridge Handshake
                if msg_type == "bridge:hello" {
                    let remote_host_id = parsed
                        .get("bridgeHostId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let remote_host_label = parsed
                        .get("bridgeHostLabel")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Host Bridge")
                        .trim()
                        .to_string();
                    let supplied_code = parsed
                        .get("accessCode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();

                    if remote_host_id.is_empty() {
                        continue;
                    }

                    let auth_err = {
                        let guard = state.inner.read().await;
                        if remote_host_id == guard.host_id {
                            Some("Tidak dapat membuat bridge ke host yang sama".to_string())
                        } else if let Some(ref expected) = guard.access_code {
                            if !expected.is_empty() && expected != &supplied_code {
                                Some("Kode akses host tujuan tidak cocok".to_string())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    };

                    if let Some(reason) = auth_err {
                        send_wire_json(
                            &tx,
                            &json!({
                                "type": "auth:rejected",
                                "reason": reason,
                            }),
                        );
                        break;
                    }

                    let bid = format!("in::{remote_host_id}");
                    current_inbound_bridge_id = Some(bid.clone());

                    let welcome_payload = {
                        let mut guard = state.inner.write().await;
                        let peers_for_remote =
                            all_known_peers_for_bridge(&guard, Some(&remote_host_id));
                        let rooms_for_remote: Vec<RoomInfo> =
                            guard.rooms.values().cloned().collect();
                        let self_host_id = guard.host_id.clone();
                        let self_host_label = guard.host_label.clone();

                        guard.bridges.insert(
                            bid.clone(),
                            BridgeLink {
                                id: bid.clone(),
                                target_url: format!("inbound://{remote_host_id}"),
                                target_host_id: Some(remote_host_id.clone()),
                                target_host_label: Some(remote_host_label.clone()),
                                direction: "inbound".to_string(),
                                status: "connected".to_string(),
                                error: None,
                                connected_at: Some(now_ms()),
                                tx: Some(tx.clone()),
                                task_handle: None,
                            },
                        );

                        json!({
                            "type": "bridge:welcome",
                            "bridgeHostId": self_host_id,
                            "bridgeHostLabel": self_host_label,
                            "peers": peers_for_remote,
                            "rooms": rooms_for_remote,
                        })
                    };
                    send_wire_json(&tx, &welcome_payload);

                    // Also ingest peers & rooms announced in bridge:hello
                    handle_bridge_message(&state, &bid, "bridge:welcome", &parsed).await;
                    continue;
                }

                if let Some(ref bid) = current_inbound_bridge_id {
                    handle_bridge_message(&state, bid, msg_type, &parsed).await;
                    continue;
                }

                if msg_type == "hello" {
                    let peer_id = parsed
                        .get("peerId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let public_key_hex = parsed
                        .get("publicKeyHex")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let supplied_code = parsed
                        .get("accessCode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();

                    if peer_id.is_empty() || public_key_hex.is_empty() {
                        continue;
                    }

                    // Server-authoritative access code check
                    let auth_reject = {
                        let guard = state.inner.read().await;
                        guard.access_code.as_ref().and_then(|expected| {
                            if !expected.is_empty() && expected != &supplied_code {
                                Some((guard.host_id.clone(), guard.host_label.clone()))
                            } else {
                                None
                            }
                        })
                    };
                    if let Some((hid, hlabel)) = auth_reject {
                        send_wire_json(
                            &tx,
                            &json!({
                                "type": "auth:rejected",
                                "hostId": hid,
                                "hostLabel": hlabel,
                                "reason": "Kode akses host diperlukan atau tidak cocok",
                            }),
                        );
                        break;
                    }

                    let display_name: String = parsed
                        .get("displayName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Perangkat Lokal")
                        .trim()
                        .chars()
                        .take(40)
                        .collect();
                    let device_label: String = parsed
                        .get("deviceLabel")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Android APK")
                        .trim()
                        .chars()
                        .take(40)
                        .collect();

                    let raw_peer_info = PeerInfo {
                        peer_id: peer_id.clone(),
                        display_name,
                        public_key_hex,
                        device_label,
                        connected_at: now_ms(),
                        online: true,
                        origin_host_id: None,
                        origin_host_label: None,
                        hops: Some(0),
                    };

                    let (init_payload, updated_default_room, annotated_peer, bridge_txs, self_hid) = {
                        let mut guard = state.inner.write().await;
                        guard.next_conn_id += 1;
                        let conn_id = guard.next_conn_id;
                        current_conn_id = conn_id;
                        current_peer_id = Some(peer_id.clone());

                        // Remove any stale bridged copy of this peer since they are now local (hops = 0)
                        guard.bridge_peers.remove(&peer_id);

                        guard.clients.insert(
                            peer_id.clone(),
                            ConnectedClient {
                                tx: tx.clone(),
                                peer: raw_peer_info.clone(),
                                conn_id,
                            },
                        );

                        if let Some(default_room) = guard.rooms.get_mut(DEFAULT_ROOM_ID) {
                            if !default_room.member_ids.contains(&peer_id) {
                                default_room.member_ids.push(peer_id.clone());
                            }
                        }

                        let annotated =
                            annotate_local_peer(&raw_peer_info, &guard.host_id, &guard.host_label);
                        let peers_list = all_known_peers_for_client(&guard);
                        let rooms_list: Vec<RoomInfo> = guard.rooms.values().cloned().collect();
                        let default_room_clone = guard.rooms.get(DEFAULT_ROOM_ID).cloned();
                        let btxs: Vec<mpsc::UnboundedSender<WireMsg>> = guard
                            .bridges
                            .values()
                            .filter(|b| b.status == "connected")
                            .filter_map(|b| b.tx.clone())
                            .collect();

                        (
                            json!({
                                "type": "init",
                                "selfPeerId": peer_id,
                                "hostId": guard.host_id,
                                "hostLabel": guard.host_label,
                                "peers": peers_list,
                                "rooms": rooms_list,
                            }),
                            default_room_clone,
                            annotated,
                            btxs,
                            guard.host_id.clone(),
                        )
                    };

                    send_wire_json(&tx, &init_payload);
                    broadcast_json(
                        &state,
                        &json!({ "type": "peer:joined", "peer": annotated_peer }),
                        Some(&peer_id),
                    )
                    .await;
                    if let Some(ref room) = updated_default_room {
                        broadcast_json(
                            &state,
                            &json!({ "type": "room:updated", "room": room }),
                            Some(&peer_id),
                        )
                        .await;
                    }
                    for btx in bridge_txs {
                        send_wire_json(
                            &btx,
                            &json!({
                                "type": "bridge:peer_sync",
                                "action": "upsert",
                                "peer": annotated_peer,
                                "hopPath": [self_hid],
                            }),
                        );
                    }
                    continue;
                }

                let Some(sender_peer_id) = current_peer_id.as_ref() else {
                    continue;
                };

                match msg_type {
                    "peer:rename" => {
                        let new_name: String = parsed
                            .get("displayName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .chars()
                            .take(40)
                            .collect();
                        if new_name.is_empty() {
                            continue;
                        }
                        let (updated_peer, btxs, self_hid) = {
                            let mut guard = state.inner.write().await;
                            let host_id = guard.host_id.clone();
                            let host_label = guard.host_label.clone();
                            let p = guard.clients.get_mut(sender_peer_id).map(|c| {
                                c.peer.display_name = new_name;
                                annotate_local_peer(&c.peer, &host_id, &host_label)
                            });
                            let bridges: Vec<mpsc::UnboundedSender<WireMsg>> = guard
                                .bridges
                                .values()
                                .filter(|b| b.status == "connected")
                                .filter_map(|b| b.tx.clone())
                                .collect();
                            (p, bridges, host_id)
                        };
                        if let Some(peer) = updated_peer {
                            broadcast_json(
                                &state,
                                &json!({ "type": "peer:updated", "peer": peer }),
                                None,
                            )
                            .await;
                            for btx in btxs {
                                send_wire_json(
                                    &btx,
                                    &json!({
                                        "type": "bridge:peer_sync",
                                        "action": "upsert",
                                        "peer": peer,
                                        "hopPath": [self_hid],
                                    }),
                                );
                            }
                        }
                    }
                    "room:create" => {
                        let room_id = parsed
                            .get("roomId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        let name: String = parsed
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .chars()
                            .take(48)
                            .collect();
                        if room_id.is_empty() || name.is_empty() {
                            continue;
                        }
                        let (created, btxs, self_hid) = {
                            let mut guard = state.inner.write().await;
                            let hid = guard.host_id.clone();
                            let hlbl = guard.host_label.clone();
                            let c = if guard.rooms.contains_key(&room_id) {
                                None
                            } else {
                                let room = RoomInfo {
                                    room_id: room_id.clone(),
                                    name,
                                    created_by: sender_peer_id.clone(),
                                    created_at: now_ms(),
                                    is_default: Some(false),
                                    member_ids: vec![sender_peer_id.clone()],
                                    origin_host_id: Some(hid.clone()),
                                    origin_host_label: Some(hlbl),
                                };
                                guard.rooms.insert(room_id, room.clone());
                                Some(room)
                            };
                            let bridges: Vec<mpsc::UnboundedSender<WireMsg>> = guard
                                .bridges
                                .values()
                                .filter(|b| b.status == "connected")
                                .filter_map(|b| b.tx.clone())
                                .collect();
                            (c, bridges, hid)
                        };
                        if let Some(room) = created {
                            broadcast_json(
                                &state,
                                &json!({ "type": "room:created", "room": room }),
                                None,
                            )
                            .await;
                            for btx in btxs {
                                send_wire_json(
                                    &btx,
                                    &json!({
                                        "type": "bridge:room_sync",
                                        "action": "upsert",
                                        "room": room,
                                        "hopPath": [self_hid],
                                    }),
                                );
                            }
                        }
                    }
                    "room:join" => {
                        let room_id = parsed
                            .get("roomId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        if room_id.is_empty() {
                            continue;
                        }
                        let (updated_room, btxs, self_hid) = {
                            let mut guard = state.inner.write().await;
                            let rm = guard.rooms.get_mut(room_id).map(|room| {
                                if !room.member_ids.contains(sender_peer_id) {
                                    room.member_ids.push(sender_peer_id.clone());
                                }
                                room.clone()
                            });
                            let bridges: Vec<mpsc::UnboundedSender<WireMsg>> = guard
                                .bridges
                                .values()
                                .filter(|b| b.status == "connected")
                                .filter_map(|b| b.tx.clone())
                                .collect();
                            (rm, bridges, guard.host_id.clone())
                        };
                        if let Some(room) = updated_room {
                            broadcast_json(
                                &state,
                                &json!({ "type": "room:updated", "room": room }),
                                None,
                            )
                            .await;
                            for btx in btxs {
                                send_wire_json(
                                    &btx,
                                    &json!({
                                        "type": "bridge:room_sync",
                                        "action": "upsert",
                                        "room": room,
                                        "hopPath": [self_hid],
                                    }),
                                );
                            }
                        }
                    }
                    "room:key_request" => {
                        let room_id = parsed
                            .get("roomId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        if room_id.is_empty() {
                            continue;
                        }
                        let payload = json!({
                            "type": "room:key_request",
                            "roomId": room_id,
                            "requesterPeerId": sender_peer_id,
                        });
                        relay_to_target(
                            &state,
                            "room",
                            room_id,
                            sender_peer_id,
                            Some(&payload),
                            WireMsg::Text(payload.to_string()),
                            &[],
                            None,
                        )
                        .await;
                    }
                    "room:key_share" => {
                        let target_peer_id = parsed
                            .get("targetPeerId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        let payload = json!({
                            "type": "room:key_share",
                            "roomId": parsed.get("roomId").cloned().unwrap_or(Value::Null),
                            "fromPeerId": sender_peer_id,
                            "targetPeerId": target_peer_id,
                            "encryptedKeyPayload": parsed.get("encryptedKeyPayload").cloned().unwrap_or(Value::Null),
                        });
                        relay_to_target(
                            &state,
                            "dm",
                            target_peer_id,
                            sender_peer_id,
                            Some(&payload),
                            WireMsg::Text(payload.to_string()),
                            &[],
                            None,
                        )
                        .await;
                    }
                    "chat:message" => {
                        let conversation_type = parsed
                            .get("conversationType")
                            .and_then(|v| v.as_str())
                            .unwrap_or("room");
                        let target_id = parsed
                            .get("targetId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let msg_id = parsed.get("id").cloned().unwrap_or(Value::Null);
                        let relay_payload = json!({
                            "type": "chat:message",
                            "id": msg_id,
                            "conversationType": conversation_type,
                            "targetId": target_id,
                            "senderId": sender_peer_id,
                            "senderName": parsed.get("senderName").cloned().unwrap_or(Value::Null),
                            "timestamp": parsed.get("timestamp").cloned().unwrap_or(Value::Null),
                            "encryptedPayload": parsed.get("encryptedPayload").cloned().unwrap_or(Value::Null),
                            "verifiedAtSend": parsed.get("verifiedAtSend").and_then(|v| v.as_bool()).unwrap_or(false),
                        });
                        let recipient_count = relay_to_target(
                            &state,
                            conversation_type,
                            target_id,
                            sender_peer_id,
                            Some(&relay_payload),
                            WireMsg::Text(relay_payload.to_string()),
                            &[],
                            None,
                        )
                        .await;
                        if recipient_count == 0 {
                            eprintln!(
                                "WARN  host::relay: chat_zero_recipients {{ conv_type={conversation_type} target_id={target_id} sender={sender_peer_id} }}"
                            );
                        }
                        send_wire_json(
                            &tx,
                            &json!({
                                "type": "chat:ack",
                                "id": msg_id,
                                "recipientCount": recipient_count,
                            }),
                        );
                    }
                    "file:offer" | "file:complete" | "file:cancel" => {
                        let conversation_type = parsed
                            .get("conversationType")
                            .and_then(|v| v.as_str())
                            .unwrap_or("room");
                        let target_id = parsed
                            .get("targetId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let mut relayed = parsed.clone();
                        if let Some(obj) = relayed.as_object_mut() {
                            obj.insert(
                                "senderId".to_string(),
                                Value::String(sender_peer_id.clone()),
                            );
                        }
                        relay_to_target(
                            &state,
                            conversation_type,
                            target_id,
                            sender_peer_id,
                            Some(&relayed),
                            WireMsg::Text(relayed.to_string()),
                            &[],
                            None,
                        )
                        .await;
                    }
                    "call:invite" => {
                        let call_id = parsed
                            .get("callId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        let target_peer_id = parsed
                            .get("targetPeerId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        let call_type = parsed
                            .get("callType")
                            .and_then(|v| v.as_str())
                            .unwrap_or("audio")
                            .to_string();
                        if call_id.is_empty() || target_peer_id.is_empty() {
                            continue;
                        }

                        let outcome = {
                            let mut guard = state.inner.write().await;
                            let target_reachable = guard.clients.contains_key(&target_peer_id)
                                || guard.bridge_peers.contains_key(&target_peer_id);
                            if !target_reachable {
                                Err(("call:unavailable", "Perangkat tujuan sedang offline"))
                            } else {
                                let busy = guard.calls.values().any(|c| {
                                    c.caller_id == target_peer_id
                                        || c.callee_id == target_peer_id
                                        || c.caller_id == *sender_peer_id
                                        || c.callee_id == *sender_peer_id
                                });
                                if busy {
                                    Err(("call:busy", "Perangkat sedang dalam panggilan lain"))
                                } else {
                                    guard.calls.insert(
                                        call_id.clone(),
                                        ActiveCallSession {
                                            call_id: call_id.clone(),
                                            call_type: call_type.clone(),
                                            caller_id: sender_peer_id.clone(),
                                            callee_id: target_peer_id.clone(),
                                            state: "ringing".to_string(),
                                            started_at: now_ms(),
                                        },
                                    );
                                    ACTIVE_CALL_COUNTER.store(guard.calls.len(), Ordering::Relaxed);
                                    Ok(())
                                }
                            }
                        };

                        match outcome {
                            Ok(()) => {
                                let payload = json!({
                                    "type": "call:invite",
                                    "callId": call_id,
                                    "callType": call_type,
                                    "callerId": sender_peer_id,
                                    "callerName": parsed.get("callerName").cloned().unwrap_or(Value::Null),
                                    "timestamp": now_ms(),
                                });
                                relay_to_target(
                                    &state,
                                    "dm",
                                    &target_peer_id,
                                    sender_peer_id,
                                    Some(&payload),
                                    WireMsg::Text(payload.to_string()),
                                    &[],
                                    None,
                                )
                                .await;
                            }
                            Err((err_type, reason)) => {
                                send_wire_json(
                                    &tx,
                                    &json!({
                                        "type": err_type,
                                        "callId": call_id,
                                        "targetPeerId": target_peer_id,
                                        "reason": reason,
                                    }),
                                );
                            }
                        }
                    }
                    "call:accept" => {
                        let call_id = parsed
                            .get("callId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        let target_peer_id = parsed
                            .get("targetPeerId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        if call_id.is_empty() {
                            continue;
                        }
                        let resolved_target = {
                            let mut guard = state.inner.write().await;
                            let mut target = target_peer_id.to_string();
                            if let Some(call) = guard.calls.get_mut(call_id) {
                                call.state = "active".to_string();
                                call.started_at = now_ms();
                                if target.is_empty() {
                                    target = call.caller_id.clone();
                                }
                            }
                            target
                        };
                        let payload = json!({
                            "type": "call:accept",
                            "callId": call_id,
                            "peerId": sender_peer_id,
                            "timestamp": now_ms(),
                        });
                        relay_to_target(
                            &state,
                            "dm",
                            &resolved_target,
                            sender_peer_id,
                            Some(&payload),
                            WireMsg::Text(payload.to_string()),
                            &[],
                            None,
                        )
                        .await;
                    }
                    "call:reject" | "call:hangup" | "call:cancel" => {
                        let call_id = parsed
                            .get("callId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        let target_peer_id = parsed
                            .get("targetPeerId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        if call_id.is_empty() {
                            continue;
                        }
                        let resolved_target = {
                            let mut guard = state.inner.write().await;
                            let removed = guard.calls.remove(call_id);
                            ACTIVE_CALL_COUNTER.store(guard.calls.len(), Ordering::Relaxed);
                            let mut target = target_peer_id.to_string();
                            if target.is_empty() {
                                if let Some(call) = removed {
                                    target = if call.caller_id == *sender_peer_id {
                                        call.callee_id
                                    } else {
                                        call.caller_id
                                    };
                                }
                            }
                            target
                        };
                        let mut relayed = parsed.clone();
                        if let Some(obj) = relayed.as_object_mut() {
                            obj.insert(
                                "senderId".to_string(),
                                Value::String(sender_peer_id.clone()),
                            );
                        }
                        relay_to_target(
                            &state,
                            "dm",
                            &resolved_target,
                            sender_peer_id,
                            Some(&relayed),
                            WireMsg::Text(relayed.to_string()),
                            &[],
                            None,
                        )
                        .await;
                    }
                    "call:rtc_signal" | "call:media_state" | "call:switch_type" => {
                        let target_peer_id = parsed
                            .get("targetPeerId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        if target_peer_id.is_empty() {
                            continue;
                        }
                        if msg_type == "call:switch_type" {
                            if let (Some(cid), Some(ct)) = (
                                parsed.get("callId").and_then(|v| v.as_str()),
                                parsed.get("callType").and_then(|v| v.as_str()),
                            ) {
                                let mut guard = state.inner.write().await;
                                if let Some(call) = guard.calls.get_mut(cid) {
                                    call.call_type = ct.to_string();
                                }
                            }
                        }
                        let mut relayed = parsed.clone();
                        if let Some(obj) = relayed.as_object_mut() {
                            obj.insert(
                                "senderId".to_string(),
                                Value::String(sender_peer_id.clone()),
                            );
                        }
                        relay_to_target(
                            &state,
                            "dm",
                            target_peer_id,
                            sender_peer_id,
                            Some(&relayed),
                            WireMsg::Text(relayed.to_string()),
                            &[],
                            None,
                        )
                        .await;
                    }
                    _ => {}
                }
            }
            AxumMessage::Close(_) => break,
            _ => {}
        }
    }

    write_task.abort();

    if let Some(bid) = current_inbound_bridge_id {
        {
            let mut guard = state.inner.write().await;
            guard.bridges.remove(&bid);
        }
        cleanup_bridge_peers(&state, &bid).await;
    }

    if let Some(peer_id) = current_peer_id {
        let (removed, orphaned_calls, bridge_txs, self_hid) = {
            let mut guard = state.inner.write().await;
            let is_same_conn = guard
                .clients
                .get(&peer_id)
                .map(|c| c.conn_id == current_conn_id)
                .unwrap_or(false);
            if is_same_conn {
                guard.clients.remove(&peer_id);
                let mut ended_peer_calls = Vec::new();
                guard.calls.retain(|_, call| {
                    if call.caller_id == peer_id || call.callee_id == peer_id {
                        let other_id = if call.caller_id == peer_id {
                            call.callee_id.clone()
                        } else {
                            call.caller_id.clone()
                        };
                        ended_peer_calls.push((other_id, call.call_id.clone()));
                        false
                    } else {
                        true
                    }
                });
                ACTIVE_CALL_COUNTER.store(guard.calls.len(), Ordering::Relaxed);
                let btxs: Vec<mpsc::UnboundedSender<WireMsg>> = guard
                    .bridges
                    .values()
                    .filter(|b| b.status == "connected")
                    .filter_map(|b| b.tx.clone())
                    .collect();
                (true, ended_peer_calls, btxs, guard.host_id.clone())
            } else {
                (false, Vec::new(), Vec::new(), String::new())
            }
        };
        for (other_id, call_id) in orphaned_calls {
            let hangup = json!({
                "type": "call:hangup",
                "callId": call_id,
                "senderId": peer_id,
                "reason": "peer_disconnected",
            });
            relay_to_target(
                &state,
                "dm",
                &other_id,
                &peer_id,
                Some(&hangup),
                WireMsg::Text(hangup.to_string()),
                &[],
                None,
            )
            .await;
        }
        if removed {
            broadcast_json(
                &state,
                &json!({ "type": "peer:left", "peerId": peer_id }),
                None,
            )
            .await;
            for btx in bridge_txs {
                send_wire_json(
                    &btx,
                    &json!({
                        "type": "bridge:peer_sync",
                        "action": "remove",
                        "peerId": peer_id,
                        "hopPath": [self_hid],
                    }),
                );
            }
        }
    }
}

pub async fn start_lan_server(port: u16) {
    let mut rooms = HashMap::new();
    let host_id = generate_host_id();
    let host_label = "Host HP Ini".to_string();

    rooms.insert(
        DEFAULT_ROOM_ID.to_string(),
        RoomInfo {
            room_id: DEFAULT_ROOM_ID.to_string(),
            name: "Ruang Utama Wi-Fi".to_string(),
            created_by: "system".to_string(),
            created_at: now_ms(),
            is_default: Some(true),
            member_ids: Vec::new(),
            origin_host_id: Some(host_id.clone()),
            origin_host_label: Some(host_label.clone()),
        },
    );

    let state = AppState {
        inner: Arc::new(RwLock::new(ServerStateInner {
            host_id,
            host_label,
            access_code: None,
            clients: HashMap::new(),
            bridge_peers: HashMap::new(),
            bridges: HashMap::new(),
            rooms,
            calls: HashMap::new(),
            next_conn_id: 0,
        })),
    };

    let _ = LAN_APP_STATE.set(state.clone());

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(api_health))
        .route("/api/network-info", get(api_network_info))
        .route("/api/host-config", get(api_get_host_config).post(api_set_host_config))
        .route("/api/bridges", get(api_list_bridges).post(api_add_bridge))
        .route("/api/bridges/{id}", delete(api_delete_bridge))
        .route("/ws", get(ws_handler))
        .route("/", get(static_root))
        .route("/{*path}", get(static_path))
        .with_state(state)
        .layer(cors);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            if let Err(err) = axum::serve(listener, app).await {
                eprintln!("Server LAN Rust berhenti: {err}");
            }
        }
        Err(err) => {
            eprintln!("Port {port} sudah terpakai ({err}); melewati server LAN Rust.");
        }
    }
}
