import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { PeerInfo, RoomInfo } from './src/types/chat.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const DEFAULT_ROOM_ID = 'ruang-utama';

interface ConnectedClient {
  ws: WebSocket;
  peer: PeerInfo;
}

const clients = new Map<string, ConnectedClient>();
const socketToPeerId = new Map<WebSocket, string>();

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
    },
  ],
]);

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
  };
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastJson(payload: unknown, excludePeerId?: string) {
  const raw = JSON.stringify(payload);
  for (const [peerId, client] of clients.entries()) {
    if (peerId !== excludePeerId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(raw);
    }
  }
}

function relayToTarget(
  conversationType: 'room' | 'dm',
  targetId: string,
  senderId: string,
  data: string | Buffer,
  isBinary = false
) {
  if (conversationType === 'dm') {
    const targetClient = clients.get(targetId);
    if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
      targetClient.ws.send(data, { binary: isBinary });
    }
    return;
  }

  const room = rooms.get(targetId);
  if (!room) return;

  for (const memberId of room.memberIds) {
    if (memberId === senderId) continue;
    const memberClient = clients.get(memberId);
    if (memberClient && memberClient.ws.readyState === WebSocket.OPEN) {
      memberClient.ws.send(data, { binary: isBinary });
    }
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      ok: true,
      peersOnline: clients.size,
      roomsCount: rooms.size,
    });
  });

  app.get('/api/network-info', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const protoHeader = req.headers['x-forwarded-proto'];
    const proto = typeof protoHeader === 'string' ? protoHeader.split(',')[0].trim() : req.protocol;
    res.json(getLanNetworkInfo(req.headers.host, proto));
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
      if (isBinary) {
        const buf = rawDataToBuffer(rawData);
        if (buf.length < 8) return;
        const headerLen = buf.readUInt32BE(0);
        if (headerLen <= 0 || headerLen > 16384 || buf.length < 4 + headerLen) return;
        try {
          const headerJson = buf.subarray(4, 4 + headerLen).toString('utf8');
          const header = JSON.parse(headerJson) as {
            conversationType: 'room' | 'dm';
            targetId: string;
            senderId: string;
          };
          relayToTarget(header.conversationType, header.targetId, header.senderId, buf, true);
        } catch {
          // Ignore malformed binary frame
        }
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      const type = msg.type as string;

      if (type === 'ping') {
        sendJson(ws, {
          type: 'pong',
          clientTs: msg.clientTs,
          serverTs: Date.now(),
        });
        return;
      }

      if (type === 'hello') {
        const peerId = String(msg.peerId || '').trim();
        const displayName = String(msg.displayName || 'Perangkat Lokal').trim().slice(0, 40);
        const deviceLabel = String(msg.deviceLabel || 'Browser').trim().slice(0, 40);
        const publicKeyHex = String(msg.publicKeyHex || '').trim();
        if (!peerId || !publicKeyHex) return;

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

        const peerInfo: PeerInfo = {
          peerId,
          displayName,
          publicKeyHex,
          deviceLabel,
          connectedAt: Date.now(),
          online: true,
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
          peers: Array.from(clients.values()).map((c) => c.peer),
          rooms: Array.from(rooms.values()),
        });

        broadcastJson({ type: 'peer:joined', peer: peerInfo }, peerId);
        if (defaultRoom) {
          broadcastJson({ type: 'room:updated', room: defaultRoom }, peerId);
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
        broadcastJson({ type: 'peer:updated', peer: client.peer });
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
        };
        rooms.set(roomId, newRoom);
        broadcastJson({ type: 'room:created', room: newRoom });
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
        return;
      }

      if (type === 'room:key_request') {
        const roomId = String(msg.roomId || '').trim();
        const room = rooms.get(roomId);
        if (!room) return;
        // Broadcast key request to other online members in that room
        for (const memberId of room.memberIds) {
          if (memberId === senderPeerId) continue;
          const memberClient = clients.get(memberId);
          if (memberClient && memberClient.ws.readyState === WebSocket.OPEN) {
            sendJson(memberClient.ws, {
              type: 'room:key_request',
              roomId,
              requesterPeerId: senderPeerId,
            });
          }
        }
        return;
      }

      if (type === 'room:key_share') {
        const targetPeerId = String(msg.targetPeerId || '').trim();
        const targetClient = clients.get(targetPeerId);
        if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
          sendJson(targetClient.ws, {
            type: 'room:key_share',
            roomId: msg.roomId,
            fromPeerId: senderPeerId,
            encryptedKeyPayload: msg.encryptedKeyPayload,
          });
        }
        return;
      }

      if (type === 'chat:message') {
        const conversationType = msg.conversationType as 'room' | 'dm';
        const targetId = String(msg.targetId || '');
        const relayPayload = JSON.stringify({
          type: 'chat:message',
          id: msg.id,
          conversationType,
          targetId,
          senderId: senderPeerId,
          senderName: msg.senderName,
          timestamp: msg.timestamp,
          encryptedPayload: msg.encryptedPayload,
          verifiedAtSend: Boolean(msg.verifiedAtSend),
        });
        relayToTarget(conversationType, targetId, senderPeerId, relayPayload, false);
        sendJson(ws, { type: 'chat:ack', id: msg.id });
        return;
      }

      if (type === 'file:offer' || type === 'file:complete' || type === 'file:cancel') {
        const conversationType = msg.conversationType as 'room' | 'dm';
        const targetId = String(msg.targetId || '');
        const relayPayload = JSON.stringify({
          ...msg,
          senderId: senderPeerId,
        });
        relayToTarget(conversationType, targetId, senderPeerId, relayPayload, false);
        return;
      }
    });

    ws.on('close', () => {
      const peerId = socketToPeerId.get(ws);
      socketToPeerId.delete(ws);
      if (!peerId) return;

      const existing = clients.get(peerId);
      if (existing && existing.ws === ws) {
        clients.delete(peerId);
        broadcastJson({ type: 'peer:left', peerId });
      }
    });
  });

  server.listen(PORT, HOST, () => {
    const info = getLanNetworkInfo();
    console.log(`LokaKirim server aktif pada http://localhost:${PORT}`);
    if (info.addresses.length > 0) {
      console.log(`Akses Wi-Fi Lokal: ${info.primaryUrl}`);
    }
  });
}

startServer().catch((err) => {
  console.error('Gagal memulai server LokaKirim:', err);
  process.exit(1);
});
