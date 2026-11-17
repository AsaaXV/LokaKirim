import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomInt } from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { HostBridgeInfo, PeerInfo, RoomInfo } from './src/types/chat.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const DEFAULT_ROOM_ID = 'ruang-utama';
const MAX_BRIDGE_HOPS = 4;

interface ConnectedClient {
  ws: WebSocket;
  peer: PeerInfo;
}

interface BridgedPeerEntry {
  peer: PeerInfo;
  viaBridgeId: string;
  hops: number;
  hopPath: string[];
}

interface BridgeLink {
  id: string;
  targetUrl: string;
  targetHostId: string | null;
  targetHostLabel: string | null;
  direction: 'outbound' | 'inbound';
  status: 'connected' | 'handshaking' | 'reconnecting' | 'auth_error';
  error: string | null;
  connectedAt: number | null;
  ws: WebSocket | null;
  stopped?: boolean;
  retryTimer?: ReturnType<typeof setTimeout> | null;
}

interface ActiveCallSession {
  callId: string;
  callType: 'audio' | 'video';
  callerId: string;
  calleeId: string;
  state: 'ringing' | 'active';
  startedAt: number;
}

function generateHostId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += alphabet[randomInt(alphabet.length)];
  }
  return `LK-${suffix}`;
}

let hostId = generateHostId();
let hostLabel = `Host ${os.hostname().slice(0, 20) || 'LokaKirim'}`;
let accessCode: string | null = null;
let bridgeSeq = 1;

const clients = new Map<string, ConnectedClient>();
const socketToPeerId = new Map<WebSocket, string>();
const bridgePeers = new Map<string, BridgedPeerEntry>();
const bridges = new Map<string, BridgeLink>();
const socketToInboundBridgeId = new Map<WebSocket, string>();
const activeCalls = new Map<string, ActiveCallSession>();

const rooms = new Map<string, RoomInfo>([
  [
    DEFAULT_ROOM_ID,
    {
      roomId: DEFAULT_ROOM_ID,
      name: 'Ruang Utama Wi-Fi',
      createdBy: 'system',
      createdAt: Date.now(),
      isDefault: true,
      memberIds: [],
      originHostId: hostId,
      originHostLabel: hostLabel,
    },
  ],
]);

function normalizeWsUrl(targetUrl: string): string | null {
  const trimmed = targetUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let wsBase = trimmed;
  if (wsBase.startsWith('https://')) {
    wsBase = `wss://${wsBase.slice(8)}`;
  } else if (wsBase.startsWith('http://')) {
    wsBase = `ws://${wsBase.slice(7)}`;
  } else if (!wsBase.startsWith('ws://') && !wsBase.startsWith('wss://')) {
    wsBase = wsBase.includes(':') ? `ws://${wsBase}` : `ws://${wsBase}:${PORT}`;
  }
  return wsBase.endsWith('/ws') ? wsBase : `${wsBase}/ws`;
}

function getLanNetworkInfo(requestHost?: string, protocol = 'http') {
  const interfaces = os.networkInterfaces();
  const addresses: { name: string; address: string; url: string; priority: number }[] = [];

  for (const [ifaceName, ifaceList] of Object.entries(interfaces)) {
    if (!ifaceList) continue;
    for (const info of ifaceList) {
      if (
        info.family === 'IPv4' &&
        !info.internal &&
        !info.address.startsWith('169.254.')
      ) {
        let priority = 3;
        if (info.address.startsWith('192.168.')) priority = 0;
        else if (info.address.startsWith('10.')) priority = 1;
        else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) priority = 2;

        addresses.push({
          name: ifaceName,
          address: info.address,
          url: `http://${info.address}:${PORT}`,
          priority,
        });
      }
    }
  }

  addresses.sort((a, b) => a.priority - b.priority);

  const cleanAddresses = addresses.map(({ name, address, url }) => ({
    name,
    address,
    url,
  }));

  const fallbackUrl = requestHost ? `${protocol}://${requestHost}` : `http://localhost:${PORT}`;

  return {
    port: PORT,
    hostname: os.hostname(),
    addresses: cleanAddresses,
    primaryUrl: cleanAddresses[0]?.url || fallbackUrl,
    hostId,
    hostLabel,
    requiresAccessCode: Boolean(accessCode && accessCode.length > 0),
  };
}

function sendJson(ws: WebSocket | null | undefined, payload: unknown): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function annotateLocalPeer(peer: PeerInfo): PeerInfo {
  return {
    ...peer,
    originHostId: hostId,
    originHostLabel: hostLabel,
    hops: 0,
  };
}

function allKnownPeersForClient(): PeerInfo[] {
  const list: PeerInfo[] = [];
  for (const c of clients.values()) {
    list.push(annotateLocalPeer(c.peer));
  }
  for (const bp of bridgePeers.values()) {
    if (!clients.has(bp.peer.peerId)) {
      list.push(bp.peer);
    }
  }
  return list;
}

function allKnownPeersForBridge(excludeOriginHostId?: string): PeerInfo[] {
  const list: PeerInfo[] = [];
  for (const c of clients.values()) {
    list.push(annotateLocalPeer(c.peer));
  }
  for (const bp of bridgePeers.values()) {
    if (clients.has(bp.peer.peerId)) continue;
    if (excludeOriginHostId && bp.hopPath.includes(excludeOriginHostId)) continue;
    if (bp.hops + 1 < MAX_BRIDGE_HOPS) {
      list.push(bp.peer);
    }
  }
  return list;
}

function broadcastJson(payload: unknown, excludePeerId?: string) {
  const raw = JSON.stringify(payload);
  for (const [peerId, client] of clients.entries()) {
    if (peerId !== excludePeerId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(raw);
    }
  }
}

function listBridgesDto(): HostBridgeInfo[] {
  return Array.from(bridges.values()).map((b) => ({
    id: b.id,
    targetUrl: b.targetUrl,
    targetHostId: b.targetHostId,
    targetHostLabel: b.targetHostLabel,
    direction: b.direction,
    status: b.status,
    error: b.error,
    connectedAt: b.connectedAt,
  }));
}

function upsertBridgedPeer(
  incomingPeer: PeerInfo,
  viaBridgeId: string,
  originHostId: string,
  originHostLabel: string,
  hopPath: string[]
): PeerInfo | null {
  if (!incomingPeer.peerId || clients.has(incomingPeer.peerId)) {
    return null;
  }
  if (hopPath.includes(hostId)) {
    return null;
  }
  const effectiveHops = Math.max(1, incomingPeer.hops ?? hopPath.length);
  if (effectiveHops >= MAX_BRIDGE_HOPS) {
    return null;
  }

  const existing = bridgePeers.get(incomingPeer.peerId);
  if (existing && existing.viaBridgeId !== viaBridgeId && existing.hops <= effectiveHops) {
    return null;
  }

  const normalized: PeerInfo = {
    ...incomingPeer,
    originHostId: incomingPeer.originHostId || originHostId,
    originHostLabel: incomingPeer.originHostLabel || originHostLabel,
    hops: effectiveHops,
    online: true,
  };
  bridgePeers.set(incomingPeer.peerId, {
    peer: normalized,
    viaBridgeId,
    hops: effectiveHops,
    hopPath,
  });
  return normalized;
}

function cleanupBridgePeers(bridgeId: string) {
  const removedIds: string[] = [];
  for (const [pid, entry] of bridgePeers.entries()) {
    if (entry.viaBridgeId === bridgeId) {
      bridgePeers.delete(pid);
      removedIds.push(pid);
    }
  }
  for (const pid of removedIds) {
    broadcastJson({ type: 'peer:left', peerId: pid });
    for (const b of bridges.values()) {
      if (b.id !== bridgeId && b.status === 'connected' && b.ws) {
        sendJson(b.ws, {
          type: 'bridge:peer_sync',
          action: 'remove',
          peerId: pid,
          hopPath: [hostId],
        });
      }
    }
  }
}

interface ParsedBinaryHeader {
  conversationType: 'room' | 'dm';
  targetId: string;
  senderId: string;
  hopPath?: string[];
  [key: string]: unknown;
}

function parseBinaryFrame(buf: Buffer): { header: ParsedBinaryHeader; payload: Buffer } | null {
  if (buf.length < 8) return null;
  const headerLen = buf.readUInt32BE(0);
  if (headerLen <= 0 || headerLen > 16384 || buf.length < 4 + headerLen) return null;
  try {
    const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8')) as ParsedBinaryHeader;
    return { header, payload: buf.subarray(4 + headerLen) };
  } catch {
    return null;
  }
}

function buildBinaryWithHop(buf: Buffer, header: ParsedBinaryHeader, addHostId: string): Buffer | null {
  const hopPath = Array.isArray(header.hopPath) ? [...header.hopPath] : [];
  if (!hopPath.includes(addHostId)) {
    hopPath.push(addHostId);
  }
  if (hopPath.length >= MAX_BRIDGE_HOPS) return null;
  const updatedHeaderBytes = Buffer.from(JSON.stringify({ ...header, hopPath }), 'utf8');
  if (updatedHeaderBytes.length > 16384) return null;
  const payload = parseBinaryFrame(buf)?.payload;
  if (!payload) return null;
  const out = Buffer.allocUnsafe(4 + updatedHeaderBytes.length + payload.length);
  out.writeUInt32BE(updatedHeaderBytes.length, 0);
  updatedHeaderBytes.copy(out, 4);
  payload.copy(out, 4 + updatedHeaderBytes.length);
  return out;
}

function relayToTarget(
  conversationType: 'room' | 'dm',
  targetId: string,
  senderId: string,
  packetObj: Record<string, unknown> | null,
  rawData: string | Buffer,
  isBinary = false,
  incomingHopPath: string[] = [],
  skipBridgeId?: string
): number {
  let delivered = 0;

  if (conversationType === 'dm') {
    const targetClient = clients.get(targetId);
    if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
      targetClient.ws.send(rawData, { binary: isBinary });
      return 1;
    }

    const bp = bridgePeers.get(targetId);
    if (bp && bp.viaBridgeId !== skipBridgeId) {
      const link = bridges.get(bp.viaBridgeId);
      if (link && link.status === 'connected' && link.ws && link.ws.readyState === WebSocket.OPEN) {
        const nextHops = incomingHopPath.includes(hostId)
          ? [...incomingHopPath]
          : [...incomingHopPath, hostId];
        if (!isBinary && packetObj) {
          sendJson(link.ws, {
            type: 'bridge:relay_dm',
            targetPeerId: targetId,
            senderPeerId: senderId,
            hopPath: nextHops,
            packet: packetObj,
          });
          return 1;
        }
        if (isBinary && Buffer.isBuffer(rawData)) {
          const parsed = parseBinaryFrame(rawData);
          if (parsed) {
            const forwarded = buildBinaryWithHop(rawData, parsed.header, hostId);
            if (forwarded) {
              link.ws.send(forwarded, { binary: true });
              return 1;
            }
          }
        }
      }
    }
    return 0;
  }

  // Room relay
  if (targetId === DEFAULT_ROOM_ID) {
    const defRoom = rooms.get(DEFAULT_ROOM_ID);
    if (defRoom && senderId && !defRoom.memberIds.includes(senderId)) {
      defRoom.memberIds.push(senderId);
    }
    for (const [peerId, client] of clients.entries()) {
      if (peerId === senderId) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(rawData, { binary: isBinary });
        delivered += 1;
      }
    }
  } else {
    const room = rooms.get(targetId);
    if (room) {
      if (senderId && !room.memberIds.includes(senderId)) {
        room.memberIds.push(senderId);
      }
      for (const memberId of room.memberIds) {
        if (memberId === senderId) continue;
        const memberClient = clients.get(memberId);
        if (memberClient && memberClient.ws.readyState === WebSocket.OPEN) {
          memberClient.ws.send(rawData, { binary: isBinary });
          delivered += 1;
        }
      }
    }
  }

  if (incomingHopPath.length < MAX_BRIDGE_HOPS) {
    const nextHops = incomingHopPath.includes(hostId)
      ? [...incomingHopPath]
      : [...incomingHopPath, hostId];
    for (const link of bridges.values()) {
      if (link.status !== 'connected' || link.id === skipBridgeId) continue;
      if (link.targetHostId && nextHops.includes(link.targetHostId)) continue;
      if (!link.ws || link.ws.readyState !== WebSocket.OPEN) continue;

      if (!isBinary && packetObj) {
        sendJson(link.ws, {
          type: 'bridge:relay_room',
          roomId: targetId,
          senderPeerId: senderId,
          hopPath: nextHops,
          packet: packetObj,
        });
        delivered += 1;
      } else if (isBinary && Buffer.isBuffer(rawData)) {
        const parsed = parseBinaryFrame(rawData);
        if (parsed) {
          const forwarded = buildBinaryWithHop(rawData, parsed.header, hostId);
          if (forwarded) {
            link.ws.send(forwarded, { binary: true });
            delivered += 1;
          }
        }
      }
    }
  }

  return delivered;
}

function handleBridgeMessage(bridgeId: string, msg: Record<string, unknown>) {
  const type = String(msg.type || '');

  if (type === 'bridge:welcome') {
    const remoteHostId = String(msg.bridgeHostId || '').trim();
    const remoteHostLabel = String(msg.bridgeHostLabel || 'Host Bridge').trim();
    if (!remoteHostId) return;

    const link = bridges.get(bridgeId);
    if (!link) return;

    if (remoteHostId === hostId) {
      link.status = 'auth_error';
      link.error = 'Tidak dapat menjembatani ke host sendiri';
      try {
        link.ws?.close();
      } catch {
        // ignore
      }
      return;
    }

    link.targetHostId = remoteHostId;
    link.targetHostLabel = remoteHostLabel;
    link.status = 'connected';
    link.error = null;
    link.connectedAt = Date.now();

    const incomingPeers = (Array.isArray(msg.peers) ? msg.peers : []) as PeerInfo[];
    const incomingRooms = (Array.isArray(msg.rooms) ? msg.rooms : []) as RoomInfo[];

    const addedPeers: PeerInfo[] = [];
    for (const p of incomingPeers) {
      const up = upsertBridgedPeer(p, bridgeId, remoteHostId, remoteHostLabel, [remoteHostId]);
      if (up) addedPeers.push(up);
    }

    const addedRooms: RoomInfo[] = [];
    for (const r of incomingRooms) {
      if (r.roomId === DEFAULT_ROOM_ID) {
        const def = rooms.get(DEFAULT_ROOM_ID);
        if (def) {
          for (const m of r.memberIds || []) {
            if (!def.memberIds.includes(m)) def.memberIds.push(m);
          }
        }
        continue;
      }
      if (!rooms.has(r.roomId)) {
        const storedRoom: RoomInfo = {
          ...r,
          originHostId: r.originHostId || remoteHostId,
          originHostLabel: r.originHostLabel || remoteHostLabel,
        };
        rooms.set(r.roomId, storedRoom);
        addedRooms.push(storedRoom);
      }
    }

    for (const p of addedPeers) {
      broadcastJson({ type: 'peer:joined', peer: p });
      for (const other of bridges.values()) {
        if (
          other.id !== bridgeId &&
          other.status === 'connected' &&
          other.targetHostId !== remoteHostId &&
          other.ws
        ) {
          sendJson(other.ws, {
            type: 'bridge:peer_sync',
            action: 'upsert',
            peer: p,
            hopPath: [remoteHostId, hostId],
          });
        }
      }
    }

    for (const r of addedRooms) {
      broadcastJson({ type: 'room:created', room: r });
      for (const other of bridges.values()) {
        if (other.id !== bridgeId && other.status === 'connected' && other.ws) {
          sendJson(other.ws, {
            type: 'bridge:room_sync',
            action: 'upsert',
            room: r,
            hopPath: [remoteHostId, hostId],
          });
        }
      }
    }
    return;
  }

  if (type === 'bridge:peer_sync') {
    const action = String(msg.action || '');
    const hopPath = (Array.isArray(msg.hopPath) ? msg.hopPath : []).map(String);
    if (hopPath.includes(hostId) || hopPath.length >= MAX_BRIDGE_HOPS) return;

    const link = bridges.get(bridgeId);
    const origId = link?.targetHostId || bridgeId;
    const origLbl = link?.targetHostLabel || 'Bridge';
    const nextHops = hopPath.includes(hostId) ? [...hopPath] : [...hopPath, hostId];

    if (action === 'upsert' && msg.peer) {
      const inserted = upsertBridgedPeer(
        msg.peer as PeerInfo,
        bridgeId,
        origId,
        origLbl,
        hopPath
      );
      if (inserted) {
        broadcastJson({ type: 'peer:joined', peer: inserted });
        for (const other of bridges.values()) {
          if (
            other.id !== bridgeId &&
            other.status === 'connected' &&
            (!other.targetHostId || !hopPath.includes(other.targetHostId)) &&
            other.ws
          ) {
            sendJson(other.ws, {
              type: 'bridge:peer_sync',
              action: 'upsert',
              peer: inserted,
              hopPath: nextHops,
            });
          }
        }
      }
    } else if (action === 'remove') {
      const pid = String(msg.peerId || '').trim();
      if (!pid) return;
      const existing = bridgePeers.get(pid);
      if (existing && existing.viaBridgeId === bridgeId) {
        bridgePeers.delete(pid);
        broadcastJson({ type: 'peer:left', peerId: pid });
        for (const other of bridges.values()) {
          if (
            other.id !== bridgeId &&
            other.status === 'connected' &&
            (!other.targetHostId || !hopPath.includes(other.targetHostId)) &&
            other.ws
          ) {
            sendJson(other.ws, {
              type: 'bridge:peer_sync',
              action: 'remove',
              peerId: pid,
              hopPath: nextHops,
            });
          }
        }
      }
    }
    return;
  }

  if (type === 'bridge:room_sync') {
    const hopPath = (Array.isArray(msg.hopPath) ? msg.hopPath : []).map(String);
    if (hopPath.includes(hostId) || hopPath.length >= MAX_BRIDGE_HOPS) return;
    const incomingRoom = msg.room as RoomInfo | undefined;
    if (!incomingRoom || !incomingRoom.roomId) return;

    const existed = rooms.has(incomingRoom.roomId);
    const link = bridges.get(bridgeId);
    if (existed) {
      const existing = rooms.get(incomingRoom.roomId)!;
      for (const m of incomingRoom.memberIds || []) {
        if (!existing.memberIds.includes(m)) existing.memberIds.push(m);
      }
    } else {
      rooms.set(incomingRoom.roomId, {
        ...incomingRoom,
        originHostId: incomingRoom.originHostId || link?.targetHostId || undefined,
        originHostLabel: incomingRoom.originHostLabel || link?.targetHostLabel || undefined,
      });
    }

    const merged = rooms.get(incomingRoom.roomId)!;
    broadcastJson({
      type: existed ? 'room:updated' : 'room:created',
      room: merged,
    });
    const nextHops = hopPath.includes(hostId) ? [...hopPath] : [...hopPath, hostId];
    for (const other of bridges.values()) {
      if (
        other.id !== bridgeId &&
        other.status === 'connected' &&
        (!other.targetHostId || !hopPath.includes(other.targetHostId)) &&
        other.ws
      ) {
        sendJson(other.ws, {
          type: 'bridge:room_sync',
          action: 'upsert',
          room: merged,
          hopPath: nextHops,
        });
      }
    }
    return;
  }

  if (type === 'bridge:relay_dm') {
    const targetPeerId = String(msg.targetPeerId || '').trim();
    const senderPeerId = String(msg.senderPeerId || '').trim();
    const hopPath = (Array.isArray(msg.hopPath) ? msg.hopPath : []).map(String);
    const packet = msg.packet as Record<string, unknown> | undefined;
    if (!packet || hopPath.includes(hostId) || hopPath.length >= MAX_BRIDGE_HOPS) return;

    const pktType = String(packet.type || '');
    if (pktType === 'call:invite') {
      const callId = String(packet.callId || '');
      const callType = packet.callType === 'video' ? 'video' : 'audio';
      const localTarget = clients.get(targetPeerId);
      if (localTarget) {
        const isBusy = Array.from(activeCalls.values()).some(
          (c) =>
            c.callerId === targetPeerId ||
            c.calleeId === targetPeerId ||
            c.callerId === senderPeerId ||
            c.calleeId === senderPeerId
        );
        if (isBusy) {
          const busyPkt = {
            type: 'call:busy',
            callId,
            targetPeerId,
            reason: 'Perangkat sedang dalam panggilan lain',
          };
          relayToTarget(
            'dm',
            senderPeerId,
            targetPeerId,
            busyPkt,
            JSON.stringify(busyPkt),
            false,
            [],
            undefined
          );
        } else {
          activeCalls.set(callId, {
            callId,
            callType,
            callerId: senderPeerId,
            calleeId: targetPeerId,
            state: 'ringing',
            startedAt: Date.now(),
          });
          sendJson(localTarget.ws, packet);
        }
        return;
      }
    } else if (pktType === 'call:accept') {
      const callId = String(packet.callId || '');
      const call = activeCalls.get(callId);
      if (call) {
        call.state = 'active';
        call.startedAt = Date.now();
      }
    } else if (pktType === 'call:reject' || pktType === 'call:hangup' || pktType === 'call:cancel') {
      activeCalls.delete(String(packet.callId || ''));
    }

    const raw = JSON.stringify(packet);
    const delivered = relayToTarget(
      'dm',
      targetPeerId,
      senderPeerId,
      packet,
      raw,
      false,
      hopPath,
      bridgeId
    );
    if (pktType === 'chat:message' && delivered > 0) {
      const ack = { type: 'chat:ack', id: packet.id ?? null, recipientCount: delivered };
      relayToTarget(
        'dm',
        senderPeerId,
        targetPeerId,
        ack,
        JSON.stringify(ack),
        false,
        [],
        undefined
      );
    }
    return;
  }

  if (type === 'bridge:relay_room') {
    const roomId = String(msg.roomId || '');
    const senderPeerId = String(msg.senderPeerId || '');
    const hopPath = (Array.isArray(msg.hopPath) ? msg.hopPath : []).map(String);
    const packet = msg.packet as Record<string, unknown> | undefined;
    if (!packet || hopPath.includes(hostId) || hopPath.length >= MAX_BRIDGE_HOPS) return;

    const delivered = relayToTarget(
      'room',
      roomId,
      senderPeerId,
      packet,
      JSON.stringify(packet),
      false,
      hopPath,
      bridgeId
    );

    if (packet.type === 'chat:message' && delivered > 0) {
      const ack = { type: 'chat:ack', id: packet.id ?? null, recipientCount: delivered };
      relayToTarget(
        'dm',
        senderPeerId,
        '',
        ack,
        JSON.stringify(ack),
        false,
        [],
        undefined
      );
    }
  }
}

function handleBridgeBinary(bridgeId: string, buf: Buffer) {
  const parsed = parseBinaryFrame(buf);
  if (!parsed) return;
  const hops = Array.isArray(parsed.header.hopPath) ? parsed.header.hopPath.map(String) : [];
  if (hops.includes(hostId)) return;
  relayToTarget(
    parsed.header.conversationType,
    parsed.header.targetId,
    parsed.header.senderId,
    null,
    buf,
    true,
    hops,
    bridgeId
  );
}

function startOutboundBridgeLoop(bridgeId: string, wsUrl: string, suppliedCode?: string | null) {
  let attempt = 0;

  const connectOnce = () => {
    const link = bridges.get(bridgeId);
    if (!link || link.stopped) return;

    let authRejected = false;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'nodebuffer';
    link.ws = ws;
    link.status = 'handshaking';

    ws.on('open', () => {
      attempt = 0;
      const cur = bridges.get(bridgeId);
      if (!cur || cur.stopped) {
        ws.close();
        return;
      }
      sendJson(ws, {
        type: 'bridge:hello',
        bridgeHostId: hostId,
        bridgeHostLabel: hostLabel,
        accessCode: suppliedCode || undefined,
        hopPath: [hostId],
        peers: allKnownPeersForBridge(),
        rooms: Array.from(rooms.values()),
      });
    });

    ws.on('message', (rawData: RawData, isBinary: boolean) => {
      const buf = rawDataToBuffer(rawData);
      if (isBinary) {
        handleBridgeBinary(bridgeId, buf);
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'auth:rejected') {
        authRejected = true;
        const cur = bridges.get(bridgeId);
        if (cur) {
          cur.status = 'auth_error';
          cur.error = String(msg.reason || 'Kode akses host bridge ditolak');
          cur.ws = null;
        }
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      handleBridgeMessage(bridgeId, msg);
    });

    ws.on('error', (err) => {
      const cur = bridges.get(bridgeId);
      if (cur && !authRejected) {
        cur.error = err.message || `Gagal menjangkau ${wsUrl}`;
      }
    });

    ws.on('close', () => {
      cleanupBridgePeers(bridgeId);
      const cur = bridges.get(bridgeId);
      if (!cur || cur.stopped) return;
      cur.ws = null;
      if (authRejected || cur.status === 'auth_error') return;

      cur.status = 'reconnecting';
      if (!cur.error) {
        cur.error = 'Koneksi bridge terputus, menyambung ulang...';
      }
      attempt += 1;
      const waitMs = Math.min(8000, Math.pow(2, Math.min(3, attempt)) * 1000);
      cur.retryTimer = setTimeout(connectOnce, waitMs);
    });
  };

  connectOnce();
}

function addOutboundBridge(targetUrl: string, suppliedCode?: string | null): HostBridgeInfo {
  const wsUrl = normalizeWsUrl(targetUrl);
  if (!wsUrl) {
    throw new Error('Alamat host tujuan tidak valid');
  }

  for (const b of bridges.values()) {
    if (b.direction === 'outbound' && b.targetUrl === wsUrl) {
      return {
        id: b.id,
        targetUrl: b.targetUrl,
        targetHostId: b.targetHostId,
        targetHostLabel: b.targetHostLabel,
        direction: b.direction,
        status: b.status,
        error: b.error,
        connectedAt: b.connectedAt,
      };
    }
  }

  const id = `out::${bridgeSeq++}`;
  const link: BridgeLink = {
    id,
    targetUrl: wsUrl,
    targetHostId: null,
    targetHostLabel: null,
    direction: 'outbound',
    status: 'handshaking',
    error: null,
    connectedAt: null,
    ws: null,
  };
  bridges.set(id, link);
  startOutboundBridgeLoop(id, wsUrl, suppliedCode);

  return {
    id: link.id,
    targetUrl: link.targetUrl,
    targetHostId: link.targetHostId,
    targetHostLabel: link.targetHostLabel,
    direction: link.direction,
    status: link.status,
    error: link.error,
    connectedAt: link.connectedAt,
  };
}

function removeBridgeById(bridgeId: string) {
  const existing = bridges.get(bridgeId);
  if (!existing) return;
  existing.stopped = true;
  if (existing.retryTimer) {
    clearTimeout(existing.retryTimer);
    existing.retryTimer = null;
  }
  bridges.delete(bridgeId);
  try {
    existing.ws?.close();
  } catch {
    // ignore
  }
  cleanupBridgePeers(bridgeId);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isLoopbackReq(req: express.Request): boolean {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hostId,
      hostLabel,
      requiresAccessCode: Boolean(accessCode && accessCode.length > 0),
      peersOnline: clients.size + bridgePeers.size,
      localPeers: clients.size,
      bridgeCount: Array.from(bridges.values()).filter((b) => b.status === 'connected').length,
      roomsCount: rooms.size,
      activeCalls: activeCalls.size,
      engine: 'node-ws',
    });
  });

  app.get('/api/network-info', (req, res) => {
    const protoHeader = req.headers['x-forwarded-proto'];
    const proto = typeof protoHeader === 'string' ? protoHeader.split(',')[0].trim() : req.protocol;
    res.json(getLanNetworkInfo(req.headers.host, proto));
  });

  app.get('/api/host-config', (req, res) => {
    res.json({
      hostId,
      hostLabel,
      requiresAccessCode: Boolean(accessCode && accessCode.length > 0),
      accessCode: isLoopbackReq(req) ? accessCode : null,
      bridgeCount: Array.from(bridges.values()).filter((b) => b.status === 'connected').length,
    });
  });

  app.post('/api/host-config', (req, res) => {
    const body = (req.body || {}) as { hostLabel?: string; accessCode?: string };
    if (typeof body.hostLabel === 'string') {
      const trimmed = body.hostLabel.trim().slice(0, 36);
      if (trimmed) {
        hostLabel = trimmed;
      }
    }
    if (typeof body.accessCode === 'string') {
      const trimmedCode = body.accessCode.trim().slice(0, 24);
      accessCode = trimmedCode.length > 0 ? trimmedCode : null;
    }
    res.json({
      hostId,
      hostLabel,
      requiresAccessCode: Boolean(accessCode && accessCode.length > 0),
      accessCode: isLoopbackReq(req) ? accessCode : null,
      bridgeCount: Array.from(bridges.values()).filter((b) => b.status === 'connected').length,
    });
  });

  app.get('/api/bridges', (_req, res) => {
    res.json(listBridgesDto());
  });

  app.post('/api/bridges', (req, res) => {
    const body = (req.body || {}) as { targetUrl?: string; accessCode?: string };
    try {
      const created = addOutboundBridge(String(body.targetUrl || ''), body.accessCode || null);
      res.json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal membuat bridge' });
    }
  });

  app.delete('/api/bridges/:id', (req, res) => {
    removeBridgeById(req.params.id);
    res.json({ ok: true });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 8 * 1024 * 1024,
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (rawData: RawData, isBinary: boolean) => {
      const inboundBridgeId = socketToInboundBridgeId.get(ws);

      if (isBinary) {
        const buf = rawDataToBuffer(rawData);
        if (inboundBridgeId) {
          handleBridgeBinary(inboundBridgeId, buf);
          return;
        }
        const parsed = parseBinaryFrame(buf);
        if (!parsed) return;
        const hops = Array.isArray(parsed.header.hopPath)
          ? parsed.header.hopPath.map(String)
          : [];
        relayToTarget(
          parsed.header.conversationType,
          parsed.header.targetId,
          parsed.header.senderId,
          null,
          buf,
          true,
          hops,
          undefined
        );
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      const type = String(msg.type || '');

      if (type === 'ping') {
        sendJson(ws, {
          type: 'pong',
          clientTs: msg.clientTs,
          serverTs: Date.now(),
        });
        return;
      }

      // Inbound Host-to-Host Bridge Handshake
      if (type === 'bridge:hello') {
        const remoteHostId = String(msg.bridgeHostId || '').trim();
        const remoteHostLabel = String(msg.bridgeHostLabel || 'Host Bridge').trim();
        const suppliedCode = String(msg.accessCode || '').trim();
        if (!remoteHostId) return;

        if (remoteHostId === hostId) {
          sendJson(ws, {
            type: 'auth:rejected',
            reason: 'Tidak dapat membuat bridge ke host yang sama',
          });
          ws.close();
          return;
        }
        if (accessCode && accessCode.length > 0 && accessCode !== suppliedCode) {
          sendJson(ws, {
            type: 'auth:rejected',
            reason: 'Kode akses host tujuan tidak cocok',
          });
          ws.close();
          return;
        }

        const bid = `in::${remoteHostId}`;
        socketToInboundBridgeId.set(ws, bid);

        const peersForRemote = allKnownPeersForBridge(remoteHostId);
        const roomsForRemote = Array.from(rooms.values());

        bridges.set(bid, {
          id: bid,
          targetUrl: `inbound://${remoteHostId}`,
          targetHostId: remoteHostId,
          targetHostLabel: remoteHostLabel,
          direction: 'inbound',
          status: 'connected',
          error: null,
          connectedAt: Date.now(),
          ws,
        });

        sendJson(ws, {
          type: 'bridge:welcome',
          bridgeHostId: hostId,
          bridgeHostLabel: hostLabel,
          peers: peersForRemote,
          rooms: roomsForRemote,
        });

        handleBridgeMessage(bid, { ...msg, type: 'bridge:welcome' });
        return;
      }

      if (inboundBridgeId) {
        handleBridgeMessage(inboundBridgeId, msg);
        return;
      }

      if (type === 'hello') {
        const peerId = String(msg.peerId || '').trim();
        const displayName = String(msg.displayName || 'Perangkat Lokal').trim().slice(0, 40);
        const deviceLabel = String(msg.deviceLabel || 'Browser').trim().slice(0, 40);
        const publicKeyHex = String(msg.publicKeyHex || '').trim();
        const suppliedCode = String(msg.accessCode || '').trim();
        if (!peerId || !publicKeyHex) return;

        if (accessCode && accessCode.length > 0 && accessCode !== suppliedCode) {
          sendJson(ws, {
            type: 'auth:rejected',
            hostId,
            hostLabel,
            reason: 'Kode akses host diperlukan atau tidak cocok',
          });
          ws.close();
          return;
        }

        // Close stale socket if same peerId reconnected
        const prev = clients.get(peerId);
        if (prev && prev.ws !== ws) {
          socketToPeerId.delete(prev.ws);
          try {
            prev.ws.close();
          } catch {
            // ignore
          }
        }

        // Remove bridged copy if peer connected directly
        bridgePeers.delete(peerId);

        const peerInfo: PeerInfo = {
          peerId,
          displayName,
          publicKeyHex,
          deviceLabel,
          connectedAt: Date.now(),
          online: true,
          originHostId: hostId,
          originHostLabel: hostLabel,
          hops: 0,
        };

        clients.set(peerId, { ws, peer: peerInfo });
        socketToPeerId.set(ws, peerId);

        const defaultRoom = rooms.get(DEFAULT_ROOM_ID);
        if (defaultRoom && !defaultRoom.memberIds.includes(peerId)) {
          defaultRoom.memberIds.push(peerId);
        }

        sendJson(ws, {
          type: 'init',
          selfPeerId: peerId,
          hostId,
          hostLabel,
          peers: allKnownPeersForClient(),
          rooms: Array.from(rooms.values()),
        });

        const annotated = annotateLocalPeer(peerInfo);
        broadcastJson({ type: 'peer:joined', peer: annotated }, peerId);
        if (defaultRoom) {
          broadcastJson({ type: 'room:updated', room: defaultRoom }, peerId);
        }
        for (const b of bridges.values()) {
          if (b.status === 'connected' && b.ws) {
            sendJson(b.ws, {
              type: 'bridge:peer_sync',
              action: 'upsert',
              peer: annotated,
              hopPath: [hostId],
            });
          }
        }
        return;
      }

      const senderPeerId = socketToPeerId.get(ws);
      if (!senderPeerId) return;

      if (type === 'peer:rename') {
        const client = clients.get(senderPeerId);
        if (!client) return;
        const newName = String(msg.displayName || '').trim().slice(0, 40);
        if (!newName) return;
        client.peer.displayName = newName;
        const annotated = annotateLocalPeer(client.peer);
        broadcastJson({ type: 'peer:updated', peer: annotated });
        for (const b of bridges.values()) {
          if (b.status === 'connected' && b.ws) {
            sendJson(b.ws, {
              type: 'bridge:peer_sync',
              action: 'upsert',
              peer: annotated,
              hopPath: [hostId],
            });
          }
        }
        return;
      }

      if (type === 'room:create') {
        const roomId = String(msg.roomId || '').trim();
        const name = String(msg.name || '').trim().slice(0, 48);
        if (!roomId || !name || rooms.has(roomId)) return;

        const newRoom: RoomInfo = {
          roomId,
          name,
          createdBy: senderPeerId,
          createdAt: Date.now(),
          isDefault: false,
          memberIds: [senderPeerId],
          originHostId: hostId,
          originHostLabel: hostLabel,
        };
        rooms.set(roomId, newRoom);
        broadcastJson({ type: 'room:created', room: newRoom });
        for (const b of bridges.values()) {
          if (b.status === 'connected' && b.ws) {
            sendJson(b.ws, {
              type: 'bridge:room_sync',
              action: 'upsert',
              room: newRoom,
              hopPath: [hostId],
            });
          }
        }
        return;
      }

      if (type === 'room:join') {
        const roomId = String(msg.roomId || '').trim();
        const room = rooms.get(roomId);
        if (!room) return;
        if (!room.memberIds.includes(senderPeerId)) {
          room.memberIds.push(senderPeerId);
        }
        broadcastJson({ type: 'room:updated', room });
        for (const b of bridges.values()) {
          if (b.status === 'connected' && b.ws) {
            sendJson(b.ws, {
              type: 'bridge:room_sync',
              action: 'upsert',
              room,
              hopPath: [hostId],
            });
          }
        }
        return;
      }

      if (type === 'room:key_request') {
        const roomId = String(msg.roomId || '').trim();
        const pkt = {
          type: 'room:key_request',
          roomId,
          requesterPeerId: senderPeerId,
        };
        relayToTarget('room', roomId, senderPeerId, pkt, JSON.stringify(pkt), false, [], undefined);
        return;
      }

      if (type === 'room:key_share') {
        const targetPeerId = String(msg.targetPeerId || '').trim();
        const pkt = {
          type: 'room:key_share',
          roomId: msg.roomId,
          fromPeerId: senderPeerId,
          encryptedKeyPayload: msg.encryptedKeyPayload,
        };
        relayToTarget('dm', targetPeerId, senderPeerId, pkt, JSON.stringify(pkt), false, [], undefined);
        return;
      }

      if (type === 'chat:message') {
        const conversationType = msg.conversationType as 'room' | 'dm';
        const targetId = String(msg.targetId || '');
        const relayObj = {
          type: 'chat:message',
          id: msg.id,
          conversationType,
          targetId,
          senderId: senderPeerId,
          senderName: msg.senderName,
          timestamp: msg.timestamp,
          encryptedPayload: msg.encryptedPayload,
          verifiedAtSend: Boolean(msg.verifiedAtSend),
        };
        const recipientCount = relayToTarget(
          conversationType,
          targetId,
          senderPeerId,
          relayObj,
          JSON.stringify(relayObj),
          false,
          [],
          undefined
        );
        sendJson(ws, { type: 'chat:ack', id: msg.id, recipientCount });
        return;
      }

      if (type === 'file:offer' || type === 'file:complete' || type === 'file:cancel') {
        const conversationType = msg.conversationType as 'room' | 'dm';
        const targetId = String(msg.targetId || '');
        const relayObj = {
          ...msg,
          senderId: senderPeerId,
        };
        relayToTarget(
          conversationType,
          targetId,
          senderPeerId,
          relayObj,
          JSON.stringify(relayObj),
          false,
          [],
          undefined
        );
        return;
      }

      if (type === 'call:invite') {
        const callId = String(msg.callId || '').trim();
        const targetPeerId = String(msg.targetPeerId || '').trim();
        const callType = msg.callType === 'video' ? 'video' : 'audio';
        if (!callId || !targetPeerId) return;

        const targetClient = clients.get(targetPeerId);
        const bridgedTarget = bridgePeers.get(targetPeerId);
        if (!targetClient && !bridgedTarget) {
          sendJson(ws, {
            type: 'call:unavailable',
            callId,
            targetPeerId,
            reason: 'Perangkat tujuan sedang offline',
          });
          return;
        }

        const isBusy = Array.from(activeCalls.values()).some(
          (c) =>
            c.callerId === targetPeerId ||
            c.calleeId === targetPeerId ||
            c.callerId === senderPeerId ||
            c.calleeId === senderPeerId
        );
        if (isBusy) {
          sendJson(ws, {
            type: 'call:busy',
            callId,
            targetPeerId,
            reason: 'Perangkat sedang dalam panggilan lain',
          });
          return;
        }

        activeCalls.set(callId, {
          callId,
          callType,
          callerId: senderPeerId,
          calleeId: targetPeerId,
          state: 'ringing',
          startedAt: Date.now(),
        });

        const inviteObj = {
          type: 'call:invite',
          callId,
          callType,
          callerId: senderPeerId,
          callerName: msg.callerName || null,
          timestamp: Date.now(),
        };
        relayToTarget(
          'dm',
          targetPeerId,
          senderPeerId,
          inviteObj,
          JSON.stringify(inviteObj),
          false,
          [],
          undefined
        );
        return;
      }

      if (type === 'call:accept') {
        const callId = String(msg.callId || '').trim();
        let targetPeerId = String(msg.targetPeerId || '').trim();
        if (!callId) return;
        const call = activeCalls.get(callId);
        if (call) {
          call.state = 'active';
          call.startedAt = Date.now();
          if (!targetPeerId) targetPeerId = call.callerId;
        }
        const acceptObj = {
          type: 'call:accept',
          callId,
          peerId: senderPeerId,
          timestamp: Date.now(),
        };
        relayToTarget(
          'dm',
          targetPeerId,
          senderPeerId,
          acceptObj,
          JSON.stringify(acceptObj),
          false,
          [],
          undefined
        );
        return;
      }

      if (type === 'call:reject' || type === 'call:hangup' || type === 'call:cancel') {
        const callId = String(msg.callId || '').trim();
        let targetPeerId = String(msg.targetPeerId || '').trim();
        if (!callId) return;
        const removed = activeCalls.get(callId);
        activeCalls.delete(callId);
        if (!targetPeerId && removed) {
          targetPeerId =
            removed.callerId === senderPeerId ? removed.calleeId : removed.callerId;
        }
        const endObj = { ...msg, senderId: senderPeerId };
        relayToTarget(
          'dm',
          targetPeerId,
          senderPeerId,
          endObj,
          JSON.stringify(endObj),
          false,
          [],
          undefined
        );
        return;
      }

      if (
        type === 'call:rtc_signal' ||
        type === 'call:media_state' ||
        type === 'call:switch_type'
      ) {
        const targetPeerId = String(msg.targetPeerId || '').trim();
        if (!targetPeerId) return;
        if (type === 'call:switch_type') {
          const cid = String(msg.callId || '').trim();
          const call = activeCalls.get(cid);
          if (call && (msg.callType === 'audio' || msg.callType === 'video')) {
            call.callType = msg.callType;
          }
        }
        const sigObj = { ...msg, senderId: senderPeerId };
        relayToTarget(
          'dm',
          targetPeerId,
          senderPeerId,
          sigObj,
          JSON.stringify(sigObj),
          false,
          [],
          undefined
        );
        return;
      }
    });

    ws.on('close', () => {
      const inboundBridgeId = socketToInboundBridgeId.get(ws);
      socketToInboundBridgeId.delete(ws);
      if (inboundBridgeId) {
        const existingBridge = bridges.get(inboundBridgeId);
        if (existingBridge && existingBridge.ws === ws) {
          bridges.delete(inboundBridgeId);
        }
        cleanupBridgePeers(inboundBridgeId);
        return;
      }

      const peerId = socketToPeerId.get(ws);
      socketToPeerId.delete(ws);
      if (!peerId) return;

      const existing = clients.get(peerId);
      if (existing && existing.ws === ws) {
        clients.delete(peerId);
        for (const [cid, call] of activeCalls.entries()) {
          if (call.callerId === peerId || call.calleeId === peerId) {
            activeCalls.delete(cid);
            const otherId = call.callerId === peerId ? call.calleeId : call.callerId;
            const hangupObj = {
              type: 'call:hangup',
              callId: cid,
              senderId: peerId,
              reason: 'peer_disconnected',
            };
            relayToTarget(
              'dm',
              otherId,
              peerId,
              hangupObj,
              JSON.stringify(hangupObj),
              false,
              [],
              undefined
            );
          }
        }
        broadcastJson({ type: 'peer:left', peerId });
        for (const b of bridges.values()) {
          if (b.status === 'connected' && b.ws) {
            sendJson(b.ws, {
              type: 'bridge:peer_sync',
              action: 'remove',
              peerId,
              hopPath: [hostId],
            });
          }
        }
      }
    });
  });

  server.listen(PORT, HOST, () => {
    const info = getLanNetworkInfo();
    console.log(`LokaKirim server aktif pada http://localhost:${PORT} (Host ID: ${hostId})`);
    if (info.addresses.length > 0) {
      console.log(`Akses Wi-Fi Lokal: ${info.primaryUrl}`);
    }
  });
}

startServer().catch((err) => {
  console.error('Gagal memulai server LokaKirim:', err);
  process.exit(1);
});
