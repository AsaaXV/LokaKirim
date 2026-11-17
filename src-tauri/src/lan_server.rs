use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, RwLock};
use tower_http::cors::{Any, CorsLayer};

const DEFAULT_ROOM_ID: &str = "ruang-utama";
pub const LAN_PORT: u16 = 3000;

static DIST_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist");

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub peer_id: String,
    pub display_name: String,
    pub public_key_hex: String,
    pub device_label: String,
    pub connected_at: u64,
    pub online: bool,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryRelayHeader {
    conversation_type: String,
    target_id: String,
    sender_id: String,
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
    tx: mpsc::UnboundedSender<Message>,
    peer: PeerInfo,
    conn_id: u64,
}

struct ServerStateInner {
    clients: HashMap<String, ConnectedClient>,
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

async fn api_health(State(state): State<AppState>) -> Json<Value> {
    let guard = state.inner.read().await;
    Json(json!({
        "ok": true,
        "peersOnline": guard.clients.len(),
        "roomsCount": guard.rooms.len(),
        "activeCalls": guard.calls.len(),
        "engine": "rust-axum"
    }))
}

async fn api_network_info() -> Json<LanNetworkInfo> {
    Json(collect_lan_network_info(LAN_PORT))
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

fn send_json_tx(tx: &mpsc::UnboundedSender<Message>, payload: &Value) {
    let _ = tx.send(Message::Text(payload.to_string().into()));
}

async fn broadcast_json(state: &AppState, payload: &Value, exclude_peer_id: Option<&str>) {
    let raw = payload.to_string();
    let guard = state.inner.read().await;
    for (peer_id, client) in guard.clients.iter() {
        if let Some(excluded) = exclude_peer_id {
            if peer_id == excluded {
                continue;
            }
        }
        let _ = client.tx.send(Message::Text(raw.clone().into()));
    }
}

async fn relay_to_target(
    state: &AppState,
    conversation_type: &str,
    target_id: &str,
    sender_id: &str,
    msg: Message,
) {
    let recipients: Vec<mpsc::UnboundedSender<Message>> = {
        let mut guard = state.inner.write().await;
        if conversation_type == "dm" {
            guard
                .clients
                .get(target_id)
                .map(|c| vec![c.tx.clone()])
                .unwrap_or_default()
        } else if target_id == DEFAULT_ROOM_ID {
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
        }
    };

    for tx in recipients {
        let _ = tx.send(msg.clone());
    }
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut current_peer_id: Option<String> = None;
    let mut current_conn_id: u64 = 0;

    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Binary(bin) => {
                if bin.len() < 8 {
                    continue;
                }
                let header_len = u32::from_be_bytes([bin[0], bin[1], bin[2], bin[3]]) as usize;
                if header_len == 0 || header_len > 16_384 || bin.len() < 4 + header_len {
                    continue;
                }
                if let Ok(header) =
                    serde_json::from_slice::<BinaryRelayHeader>(&bin[4..4 + header_len])
                {
                    relay_to_target(
                        &state,
                        &header.conversation_type,
                        &header.target_id,
                        &header.sender_id,
                        Message::Binary(bin),
                    )
                    .await;
                }
            }
            Message::Text(text) => {
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
                    send_json_tx(&tx, &pong);
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

                    if peer_id.is_empty() || public_key_hex.is_empty() {
                        continue;
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

                    let peer_info = PeerInfo {
                        peer_id: peer_id.clone(),
                        display_name,
                        public_key_hex,
                        device_label,
                        connected_at: now_ms(),
                        online: true,
                    };

                    let (init_payload, updated_default_room) = {
                        let mut guard = state.inner.write().await;
                        guard.next_conn_id += 1;
                        let conn_id = guard.next_conn_id;
                        current_conn_id = conn_id;
                        current_peer_id = Some(peer_id.clone());

                        guard.clients.insert(
                            peer_id.clone(),
                            ConnectedClient {
                                tx: tx.clone(),
                                peer: peer_info.clone(),
                                conn_id,
                            },
                        );

                        if let Some(default_room) = guard.rooms.get_mut(DEFAULT_ROOM_ID) {
                            if !default_room.member_ids.contains(&peer_id) {
                                default_room.member_ids.push(peer_id.clone());
                            }
                        }

                        let peers_list: Vec<PeerInfo> =
                            guard.clients.values().map(|c| c.peer.clone()).collect();
                        let rooms_list: Vec<RoomInfo> = guard.rooms.values().cloned().collect();
                        let default_room_clone = guard.rooms.get(DEFAULT_ROOM_ID).cloned();

                        (
                            json!({
                                "type": "init",
                                "selfPeerId": peer_id,
                                "peers": peers_list,
                                "rooms": rooms_list,
                            }),
                            default_room_clone,
                        )
                    };

                    send_json_tx(&tx, &init_payload);
                    broadcast_json(
                        &state,
                        &json!({ "type": "peer:joined", "peer": peer_info }),
                        Some(&peer_id),
                    )
                    .await;
                    if let Some(room) = updated_default_room {
                        broadcast_json(
                            &state,
                            &json!({ "type": "room:updated", "room": room }),
                            Some(&peer_id),
                        )
                        .await;
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
                        let updated_peer = {
                            let mut guard = state.inner.write().await;
                            guard.clients.get_mut(sender_peer_id).map(|c| {
                                c.peer.display_name = new_name;
                                c.peer.clone()
                            })
                        };
                        if let Some(peer) = updated_peer {
                            broadcast_json(
                                &state,
                                &json!({ "type": "peer:updated", "peer": peer }),
                                None,
                            )
                            .await;
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
                        let created = {
                            let mut guard = state.inner.write().await;
                            if guard.rooms.contains_key(&room_id) {
                                None
                            } else {
                                let room = RoomInfo {
                                    room_id: room_id.clone(),
                                    name,
                                    created_by: sender_peer_id.clone(),
                                    created_at: now_ms(),
                                    is_default: Some(false),
                                    member_ids: vec![sender_peer_id.clone()],
                                };
                                guard.rooms.insert(room_id, room.clone());
                                Some(room)
                            }
                        };
                        if let Some(room) = created {
                            broadcast_json(
                                &state,
                                &json!({ "type": "room:created", "room": room }),
                                None,
                            )
                            .await;
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
                        let updated_room = {
                            let mut guard = state.inner.write().await;
                            guard.rooms.get_mut(room_id).map(|room| {
                                if !room.member_ids.contains(sender_peer_id) {
                                    room.member_ids.push(sender_peer_id.clone());
                                }
                                room.clone()
                            })
                        };
                        if let Some(room) = updated_room {
                            broadcast_json(
                                &state,
                                &json!({ "type": "room:updated", "room": room }),
                                None,
                            )
                            .await;
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
                        let guard = state.inner.read().await;
                        if room_id == DEFAULT_ROOM_ID {
                            for (peer_id, client) in &guard.clients {
                                if peer_id != sender_peer_id {
                                    send_json_tx(&client.tx, &payload);
                                }
                            }
                        } else if let Some(room) = guard.rooms.get(room_id) {
                            for member_id in &room.member_ids {
                                if member_id == sender_peer_id {
                                    continue;
                                }
                                if let Some(member_client) = guard.clients.get(member_id) {
                                    send_json_tx(&member_client.tx, &payload);
                                }
                            }
                        }
                    }
                    "room:key_share" => {
                        let target_peer_id = parsed
                            .get("targetPeerId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        let guard = state.inner.read().await;
                        if let Some(target_client) = guard.clients.get(target_peer_id) {
                            let payload = json!({
                                "type": "room:key_share",
                                "roomId": parsed.get("roomId").cloned().unwrap_or(Value::Null),
                                "fromPeerId": sender_peer_id,
                                "encryptedKeyPayload": parsed.get("encryptedKeyPayload").cloned().unwrap_or(Value::Null),
                            });
                            send_json_tx(&target_client.tx, &payload);
                        }
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
                        relay_to_target(
                            &state,
                            conversation_type,
                            target_id,
                            sender_peer_id,
                            Message::Text(relay_payload.to_string().into()),
                        )
                        .await;
                        send_json_tx(
                            &tx,
                            &json!({
                                "type": "chat:ack",
                                "id": msg_id,
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
                            Message::Text(relayed.to_string().into()),
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
                            let target_online = guard.clients.contains_key(&target_peer_id);
                            if !target_online {
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
                                    Ok(guard.clients.get(&target_peer_id).map(|c| c.tx.clone()))
                                }
                            }
                        };

                        match outcome {
                            Ok(Some(target_tx)) => {
                                let payload = json!({
                                    "type": "call:invite",
                                    "callId": call_id,
                                    "callType": call_type,
                                    "callerId": sender_peer_id,
                                    "callerName": parsed.get("callerName").cloned().unwrap_or(Value::Null),
                                    "timestamp": now_ms(),
                                });
                                send_json_tx(&target_tx, &payload);
                            }
                            Ok(None) => {}
                            Err((err_type, reason)) => {
                                send_json_tx(
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
                        let forward_tx = {
                            let mut guard = state.inner.write().await;
                            let mut resolved_target = target_peer_id.to_string();
                            if let Some(call) = guard.calls.get_mut(call_id) {
                                call.state = "active".to_string();
                                call.started_at = now_ms();
                                if resolved_target.is_empty() {
                                    resolved_target = call.caller_id.clone();
                                }
                            }
                            guard.clients.get(&resolved_target).map(|c| c.tx.clone())
                        };
                        if let Some(target_tx) = forward_tx {
                            send_json_tx(
                                &target_tx,
                                &json!({
                                    "type": "call:accept",
                                    "callId": call_id,
                                    "peerId": sender_peer_id,
                                    "timestamp": now_ms(),
                                }),
                            );
                        }
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
                        let forward_tx = {
                            let mut guard = state.inner.write().await;
                            let removed = guard.calls.remove(call_id);
                            ACTIVE_CALL_COUNTER.store(guard.calls.len(), Ordering::Relaxed);
                            let mut resolved_target = target_peer_id.to_string();
                            if resolved_target.is_empty() {
                                if let Some(call) = removed {
                                    resolved_target = if call.caller_id == *sender_peer_id {
                                        call.callee_id
                                    } else {
                                        call.caller_id
                                    };
                                }
                            }
                            guard.clients.get(&resolved_target).map(|c| c.tx.clone())
                        };
                        if let Some(target_tx) = forward_tx {
                            let mut relayed = parsed.clone();
                            if let Some(obj) = relayed.as_object_mut() {
                                obj.insert(
                                    "senderId".to_string(),
                                    Value::String(sender_peer_id.clone()),
                                );
                            }
                            send_json_tx(&target_tx, &relayed);
                        }
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
                        let target_tx = {
                            let guard = state.inner.read().await;
                            guard.clients.get(target_peer_id).map(|c| c.tx.clone())
                        };
                        if let Some(ttx) = target_tx {
                            let mut relayed = parsed.clone();
                            if let Some(obj) = relayed.as_object_mut() {
                                obj.insert(
                                    "senderId".to_string(),
                                    Value::String(sender_peer_id.clone()),
                                );
                            }
                            send_json_tx(&ttx, &relayed);
                        }
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    write_task.abort();

    if let Some(peer_id) = current_peer_id {
        let (removed, orphaned_calls) = {
            let mut guard = state.inner.write().await;
            let is_same_conn = guard
                .clients
                .get(&peer_id)
                .map(|c| c.conn_id == current_conn_id)
                .unwrap_or(false);
            if is_same_conn {
                guard.clients.remove(&peer_id);
                let mut ended = Vec::new();
                guard.calls.retain(|_, call| {
                    if call.caller_id == peer_id || call.callee_id == peer_id {
                        let other_id = if call.caller_id == peer_id {
                            call.callee_id.clone()
                        } else {
                            call.caller_id.clone()
                        };
                        if let Some(other_client) = guard.clients.get(&other_id) {
                            ended.push((other_client.tx.clone(), call.call_id.clone()));
                        }
                        false
                    } else {
                        true
                    }
                });
                ACTIVE_CALL_COUNTER.store(guard.calls.len(), Ordering::Relaxed);
                (true, ended)
            } else {
                (false, Vec::new())
            }
        };
        for (other_tx, call_id) in orphaned_calls {
            send_json_tx(
                &other_tx,
                &json!({
                    "type": "call:hangup",
                    "callId": call_id,
                    "senderId": peer_id,
                    "reason": "peer_disconnected",
                }),
            );
        }
        if removed {
            broadcast_json(
                &state,
                &json!({ "type": "peer:left", "peerId": peer_id }),
                None,
            )
            .await;
        }
    }
}

pub async fn start_lan_server(port: u16) {
    let mut rooms = HashMap::new();
    rooms.insert(
        DEFAULT_ROOM_ID.to_string(),
        RoomInfo {
            room_id: DEFAULT_ROOM_ID.to_string(),
            name: "Ruang Utama Wi-Fi".to_string(),
            created_by: "system".to_string(),
            created_at: now_ms(),
            is_default: Some(true),
            member_ids: Vec::new(),
        },
    );

    let state = AppState {
        inner: Arc::new(RwLock::new(ServerStateInner {
            clients: HashMap::new(),
            rooms,
            calls: HashMap::new(),
            next_conn_id: 0,
        })),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(api_health))
        .route("/api/network-info", get(api_network_info))
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
