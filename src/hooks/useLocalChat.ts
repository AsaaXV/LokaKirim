import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  decryptBinaryChunkAsync,
  decryptTextAsync,
  deriveDmSessionAsync,
  encryptBinaryChunkAsync,
  encryptTextAsync,
  generateIdentityKeyPairAsync,
  generateRoomKeyAsync,
  importRoomKeyFromBase64Async,
  randomUuid,
} from '../lib/crypto';
import { detectDeviceLabel, makeConversationId } from '../lib/format';
import {
  buildNetworkInfoUrl,
  buildWsEndpoint,
  getSavedHostUrl,
  LOCAL_RUST_HOST_URL,
  saveHostUrl,
} from '../lib/hostConfig';
import { getRustLanInfo, isTauriRuntime } from '../lib/tauriBridge';
import {
  clearAllChatData,
  clearConversationHistory,
  getFileBlob,
  loadAllMessages,
  loadAllRoomKeyRecords,
  loadCachedRooms,
  loadDeviceIdentity,
  loadVerifiedPeers,
  loadVerifiedRooms,
  removeVerifiedPeer,
  removeVerifiedRoom,
  saveCachedRooms,
  saveDeviceIdentity,
  saveFileBlob,
  saveMessageRecord,
  saveRoomKeyRecord,
  saveVerifiedPeer,
  saveVerifiedRoom,
} from '../lib/storage';
import type {
  ChatMessageRecord,
  ChatTarget,
  ConnectionQuality,
  EncryptedPayload,
  LanNetworkInfo,
  NetworkTelemetry,
  PeerInfo,
  RoomInfo,
  StoredDeviceIdentity,
  VerifiedPeerRecord,
  VerifiedRoomRecord,
} from '../types/chat';

const CHUNK_SIZE = 256 * 1024; // 256 KB per encrypted chunk
const DEFAULT_ROOM_ID = 'ruang-utama';

interface IncomingTransferState {
  transferId: string;
  conversationId: string;
  conversationType: 'room' | 'dm';
  senderId: string;
  senderName: string;
  fileName: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  chunks: (ArrayBuffer | null)[];
  receivedCount: number;
  bytesReceived: number;
  startTime: number;
  lastUiUpdate: number;
  completedHandled: boolean;
}

export function useLocalChat() {
  const [identity, setIdentity] = useState<StoredDeviceIdentity | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [rooms, setRooms] = useState<RoomInfo[]>([
    {
      roomId: DEFAULT_ROOM_ID,
      name: 'Ruang Utama Wi-Fi',
      createdBy: 'system',
      createdAt: Date.now(),
      isDefault: true,
      memberIds: [],
    },
  ]);

  const [activeTarget, setActiveTarget] = useState<ChatTarget>({
    type: 'room',
    id: DEFAULT_ROOM_ID,
  });

  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [verifiedPeers, setVerifiedPeers] = useState<Record<string, VerifiedPeerRecord>>({});
  const [verifiedRooms, setVerifiedRooms] = useState<Record<string, VerifiedRoomRecord>>({});
  const [roomSafetyCodes, setRoomSafetyCodes] = useState<Record<string, string>>({});
  const [dmSafetyCodes, setDmSafetyCodes] = useState<Record<string, string>>({});
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [lanInfo, setLanInfo] = useState<LanNetworkInfo | null>(null);
  const isTauriApp = useMemo(() => isTauriRuntime(), []);
  const [hostUrl, setHostUrl] = useState<string>(() => getSavedHostUrl());

  const [telemetry, setTelemetry] = useState<NetworkTelemetry>({
    quality: 'reconnecting',
    latencyMs: null,
    avgLatencyMs: null,
    jitterMs: null,
    samples: [],
    queuedCount: 0,
    lastPongAt: null,
    wsEndpoint: '',
  });

  const wsRef = useRef<WebSocket | null>(null);
  const hostUrlRef = useRef<string>(hostUrl);
  const identityRef = useRef<StoredDeviceIdentity | null>(null);
  const peersRef = useRef<PeerInfo[]>([]);
  const roomsRef = useRef<RoomInfo[]>([]);
  const activeTargetRef = useRef<ChatTarget>(activeTarget);
  const dmKeysRef = useRef<Map<string, { aesKey: Uint8Array; safetyCode: string }>>(new Map());
  const roomKeysRef = useRef<
    Map<string, { aesKey: Uint8Array; rawBase64: string; safetyCode: string }>
  >(new Map());
  const incomingTransfersRef = useRef<Map<string, IncomingTransferState>>(new Map());
  const cancelledTransfersRef = useRef<Set<string>>(new Set());
  const outgoingQueueRef = useRef<
    {
      id: string;
      conversationType: 'room' | 'dm';
      targetId: string;
      text: string;
      timestamp: number;
    }[]
  >([]);
  const pingIntervalRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastPingSentAtRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    activeTargetRef.current = activeTarget;
    const convId = makeConversationId(activeTarget.type, activeTarget.id);
    setUnreadCounts((prev) => {
      if (!prev[convId]) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  }, [activeTarget]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    hostUrlRef.current = hostUrl;
  }, [hostUrl]);

  const refreshLanInfo = useCallback(async () => {
    const activeHost = hostUrlRef.current;
    if (isTauriApp && (!activeHost || activeHost === LOCAL_RUST_HOST_URL)) {
      try {
        const rustInfo = await getRustLanInfo();
        setLanInfo(rustInfo);
        return;
      } catch {
        // Fallback to HTTP endpoint below
      }
    }
    try {
      const res = await fetch(buildNetworkInfoUrl(activeHost));
      if (res.ok) {
        const data = (await res.json()) as LanNetworkInfo;
        setLanInfo(data);
      }
    } catch {
      // Ignore if temporarily offline
    }
  }, [isTauriApp]);

  useEffect(() => {
    unmountedRef.current = false;

    async function bootstrap() {
      const [storedId, storedMessages, storedRoomKeys, storedRooms, vPeers, vRooms] =
        await Promise.all([
          loadDeviceIdentity(),
          loadAllMessages(),
          loadAllRoomKeyRecords(),
          loadCachedRooms(),
          loadVerifiedPeers(),
          loadVerifiedRooms(),
        ]);

      if (unmountedRef.current) return;

      for (const rk of storedRoomKeys) {
        try {
          const { keyBytes, safetyCode } = await importRoomKeyFromBase64Async(rk.rawBase64);
          roomKeysRef.current.set(rk.roomId, {
            aesKey: keyBytes,
            rawBase64: rk.rawBase64,
            safetyCode,
          });
        } catch {
          // ignore corrupted key
        }
      }

      const codeMap: Record<string, string> = {};
      for (const [rid, entry] of roomKeysRef.current.entries()) {
        codeMap[rid] = entry.safetyCode;
      }
      setRoomSafetyCodes(codeMap);

      if (storedRooms.length > 0) {
        setRooms((prev) => {
          const map = new Map(prev.map((r) => [r.roomId, r]));
          for (const r of storedRooms) map.set(r.roomId, r);
          return Array.from(map.values());
        });
      }

      const vPeerMap: Record<string, VerifiedPeerRecord> = {};
      for (const vp of vPeers) vPeerMap[vp.peerId] = vp;
      setVerifiedPeers(vPeerMap);

      const vRoomMap: Record<string, VerifiedRoomRecord> = {};
      for (const vr of vRooms) vRoomMap[vr.roomId] = vr;
      setVerifiedRooms(vRoomMap);

      const urls: Record<string, string> = {};
      for (const msg of storedMessages) {
        if (msg.kind === 'file' && msg.file?.blobStored) {
          const blobRec = await getFileBlob(msg.file.transferId);
          if (blobRec?.blob) {
            urls[msg.file.transferId] = URL.createObjectURL(blobRec.blob);
          }
        }
        if (
          msg.kind === 'file' &&
          msg.file &&
          (msg.file.status === 'sending' || msg.file.status === 'receiving')
        ) {
          msg.file.status = 'failed';
          msg.file.errorMessage = 'Terputus sebelum transfer selesai';
        }
      }

      setFileUrls(urls);
      setMessages(storedMessages);

      if (storedId && storedId.privateKeyHex && storedId.publicKeyHex) {
        identityRef.current = storedId;
        setIdentity(storedId);
        setNeedsOnboarding(false);
      } else {
        setNeedsOnboarding(true);
      }

      setIdentityReady(true);
      refreshLanInfo();
    }

    bootstrap();

    return () => {
      unmountedRef.current = true;
    };
  }, [refreshLanInfo]);

  const ensureDmKey = useCallback(async (peer: PeerInfo) => {
    const existing = dmKeysRef.current.get(peer.peerId);
    if (existing) return existing;
    if (!identityRef.current) return null;

    const session = await deriveDmSessionAsync(
      identityRef.current.privateKeyHex,
      peer.publicKeyHex,
      identityRef.current.publicKeyHex
    );
    const entry = { aesKey: session.aesKey, safetyCode: session.safetyCode };
    dmKeysRef.current.set(peer.peerId, entry);
    setDmSafetyCodes((prev) => ({ ...prev, [peer.peerId]: session.safetyCode }));
    return entry;
  }, []);

  const ensureRoomKeyLocal = useCallback(async (roomId: string) => {
    const existing = roomKeysRef.current.get(roomId);
    if (existing) return existing;
    const created = await generateRoomKeyAsync();
    const entry = {
      aesKey: created.keyBytes,
      rawBase64: created.rawBase64,
      safetyCode: created.safetyCode,
    };
    roomKeysRef.current.set(roomId, entry);
    await saveRoomKeyRecord(roomId, created.rawBase64, created.safetyCode);
    setRoomSafetyCodes((prev) => ({ ...prev, [roomId]: created.safetyCode }));
    return entry;
  }, []);

  const appendMessageIdempotent = useCallback(
    async (msg: ChatMessageRecord, countUnread = true) => {
      let inserted = false;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        inserted = true;
        return [...prev, msg].sort((a, b) => a.timestamp - b.timestamp);
      });

      await saveMessageRecord(msg);

      if (countUnread && inserted) {
        const activeConvId = makeConversationId(
          activeTargetRef.current.type,
          activeTargetRef.current.id
        );
        if (msg.conversationId !== activeConvId && msg.senderId !== identityRef.current?.peerId) {
          setUnreadCounts((prev) => ({
            ...prev,
            [msg.conversationId]: (prev[msg.conversationId] || 0) + 1,
          }));
        }
      }
    },
    []
  );

  const updateFileMessage = useCallback(
    async (transferId: string, updater: (msg: ChatMessageRecord) => ChatMessageRecord) => {
      let updatedRecord: ChatMessageRecord | null = null;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.kind === 'file' && m.file?.transferId === transferId) {
            updatedRecord = updater(m);
            return updatedRecord;
          }
          return m;
        })
      );
      if (updatedRecord) {
        await saveMessageRecord(updatedRecord);
      }
    },
    []
  );

  const sendJsonRaw = useCallback((payload: unknown): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const getConversationKey = useCallback(
    async (conversationType: 'room' | 'dm', peerOrRoomId: string): Promise<Uint8Array | null> => {
      if (conversationType === 'room') {
        const existing = roomKeysRef.current.get(peerOrRoomId);
        if (existing) return existing.aesKey;
        const created = await ensureRoomKeyLocal(peerOrRoomId);
        return created.aesKey;
      }

      const peer = peersRef.current.find((p) => p.peerId === peerOrRoomId);
      if (!peer) return null;
      const entry = await ensureDmKey(peer);
      return entry?.aesKey || null;
    },
    [ensureDmKey, ensureRoomKeyLocal]
  );

  const flushQueuedMessages = useCallback(async () => {
    if (!identityRef.current) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (outgoingQueueRef.current.length === 0) return;

    const remaining: typeof outgoingQueueRef.current = [];
    for (const item of outgoingQueueRef.current) {
      const aesKey = await getConversationKey(item.conversationType, item.targetId);
      if (!aesKey) {
        remaining.push(item);
        continue;
      }
      const encryptedPayload = await encryptTextAsync(aesKey, item.text);
      const sent = sendJsonRaw({
        type: 'chat:message',
        id: item.id,
        conversationType: item.conversationType,
        targetId: item.targetId,
        senderName: identityRef.current.displayName,
        timestamp: item.timestamp,
        encryptedPayload,
        verifiedAtSend: true,
      });

      if (!sent) {
        remaining.push(item);
      } else {
        setMessages((prev) =>
          prev.map((m) => (m.id === item.id ? { ...m, pendingSync: false } : m))
        );
      }
    }

    outgoingQueueRef.current = remaining;
    setTelemetry((prev) => ({ ...prev, queuedCount: remaining.length }));
  }, [getConversationKey, sendJsonRaw]);

  const handleIncomingBinaryChunk = useCallback(
    async (arrayBuffer: ArrayBuffer) => {
      if (arrayBuffer.byteLength < 8) return;
      const view = new DataView(arrayBuffer);
      const headerLen = view.getUint32(0, false);
      if (headerLen <= 0 || headerLen > 16384 || arrayBuffer.byteLength < 4 + headerLen) return;

      const headerBytes = new Uint8Array(arrayBuffer, 4, headerLen);
      const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
        transferId: string;
        conversationType: 'room' | 'dm';
        targetId: string;
        senderId: string;
        chunkIndex: number;
        totalChunks: number;
        iv: string;
      };

      const transfer = incomingTransfersRef.current.get(header.transferId);
      if (!transfer) return;

      const keyTargetId =
        header.conversationType === 'dm' ? header.senderId : header.targetId;
      const aesKey = await getConversationKey(header.conversationType, keyTargetId);
      if (!aesKey) return;

      const encryptedBytes = new Uint8Array(arrayBuffer, 4 + headerLen);
      let plainBuffer: ArrayBuffer;
      try {
        plainBuffer = await decryptBinaryChunkAsync(aesKey, header.iv, encryptedBytes);
      } catch {
        return;
      }

      if (transfer.chunks[header.chunkIndex] === null) {
        transfer.chunks[header.chunkIndex] = plainBuffer;
        transfer.receivedCount += 1;
        transfer.bytesReceived += plainBuffer.byteLength;
      }

      const now = performance.now();
      const progress = Math.min(
        99,
        Math.round((transfer.receivedCount / Math.max(1, transfer.totalChunks)) * 100)
      );
      const elapsedSec = Math.max(0.05, (now - transfer.startTime) / 1000);
      const speedBps = transfer.bytesReceived / elapsedSec;

      if (now - transfer.lastUiUpdate > 120 || transfer.receivedCount === transfer.totalChunks) {
        transfer.lastUiUpdate = now;
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === 'file' && m.file?.transferId === header.transferId
              ? {
                  ...m,
                  file: {
                    ...m.file,
                    receivedChunks: transfer.receivedCount,
                    progress,
                    speedBps,
                  },
                }
              : m
          )
        );
      }

      if (
        transfer.receivedCount === transfer.totalChunks &&
        !transfer.completedHandled
      ) {
        transfer.completedHandled = true;
        const validParts = transfer.chunks.filter((c): c is ArrayBuffer => c !== null);
        const blob = new Blob(validParts, {
          type: transfer.mimeType || 'application/octet-stream',
        });

        await saveFileBlob(
          transfer.transferId,
          blob,
          transfer.fileName,
          transfer.mimeType || 'application/octet-stream'
        );
        const url = URL.createObjectURL(blob);
        setFileUrls((prev) => ({ ...prev, [transfer.transferId]: url }));

        await updateFileMessage(transfer.transferId, (m) => ({
          ...m,
          file: m.file
            ? {
                ...m.file,
                receivedChunks: transfer.totalChunks,
                status: 'completed',
                progress: 100,
                speedBps,
                blobStored: true,
              }
            : undefined,
        }));

        incomingTransfersRef.current.delete(header.transferId);
      }
    },
    [getConversationKey, updateFileMessage]
  );

  useEffect(() => {
    if (!identityReady || !identity) return;

    let cancelled = false;

    const connect = () => {
      if (cancelled || unmountedRef.current) return;

      const wsUrl = buildWsEndpoint(hostUrl);

      setTelemetry((prev) => ({
        ...prev,
        quality: reconnectAttemptRef.current > 0 ? 'reconnecting' : prev.quality,
        wsEndpoint: wsUrl,
      }));

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        reconnectAttemptRef.current = 0;

        ws.send(
          JSON.stringify({
            type: 'hello',
            peerId: identity.peerId,
            displayName: identity.displayName,
            deviceLabel: detectDeviceLabel(),
            publicKeyHex: identity.publicKeyHex,
          })
        );

        setTelemetry((prev) => ({
          ...prev,
          quality: 'connected',
          wsEndpoint: wsUrl,
        }));

        if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
        const sendPing = () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const now = performance.now();
          if (lastPingSentAtRef.current !== null && now - lastPingSentAtRef.current > 6000) {
            setTelemetry((prev) => ({ ...prev, quality: 'degraded' }));
          }
          lastPingSentAtRef.current = now;
          ws.send(JSON.stringify({ type: 'ping', clientTs: now }));
        };
        sendPing();
        pingIntervalRef.current = window.setInterval(sendPing, 2500);
      };

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          await handleIncomingBinaryChunk(event.data);
          return;
        }

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }

        const type = msg.type as string;

        if (type === 'pong') {
          const clientTs = Number(msg.clientTs);
          const rtt = Math.max(1, Math.round(performance.now() - clientTs));
          lastPingSentAtRef.current = null;
          setTelemetry((prev) => {
            const nextSamples = [...prev.samples, { t: Date.now(), ms: rtt }].slice(-24);
            const avg = Math.round(
              nextSamples.reduce((acc, s) => acc + s.ms, 0) / nextSamples.length
            );
            let jitter = 0;
            if (nextSamples.length > 1) {
              let diffs = 0;
              for (let i = 1; i < nextSamples.length; i++) {
                diffs += Math.abs(nextSamples[i].ms - nextSamples[i - 1].ms);
              }
              jitter = Math.round(diffs / (nextSamples.length - 1));
            }
            const quality: ConnectionQuality = rtt >= 150 ? 'degraded' : 'connected';
            return {
              ...prev,
              quality,
              latencyMs: rtt,
              avgLatencyMs: avg,
              jitterMs: jitter,
              samples: nextSamples,
              lastPongAt: Date.now(),
            };
          });
          return;
        }

        if (type === 'init') {
          const incomingPeers = (msg.peers as PeerInfo[]) || [];
          const incomingRooms = (msg.rooms as RoomInfo[]) || [];

          setPeers(incomingPeers);
          setRooms(incomingRooms);
          await saveCachedRooms(incomingRooms);

          for (const p of incomingPeers) {
            if (p.peerId !== identity.peerId) {
              await ensureDmKey(p);
            }
          }

          for (const r of incomingRooms) {
            if (r.memberIds.includes(identity.peerId)) {
              const hasKey = roomKeysRef.current.has(r.roomId);
              if (!hasKey) {
                const otherOnlineMembers = r.memberIds.filter(
                  (id) =>
                    id !== identity.peerId &&
                    incomingPeers.some((p) => p.peerId === id && p.online)
                );
                if (otherOnlineMembers.length > 0) {
                  ws.send(JSON.stringify({ type: 'room:key_request', roomId: r.roomId }));
                  window.setTimeout(async () => {
                    if (!roomKeysRef.current.has(r.roomId)) {
                      const allSorted = [identity.peerId, ...otherOnlineMembers].sort();
                      if (allSorted[0] === identity.peerId) {
                        const created = await ensureRoomKeyLocal(r.roomId);
                        for (const mId of otherOnlineMembers) {
                          const memberPeer = peersRef.current.find((p) => p.peerId === mId);
                          if (!memberPeer) continue;
                          const dmEntry = await ensureDmKey(memberPeer);
                          if (!dmEntry) continue;
                          const wrapped = await encryptTextAsync(dmEntry.aesKey, created.rawBase64);
                          sendJsonRaw({
                            type: 'room:key_share',
                            roomId: r.roomId,
                            targetPeerId: mId,
                            encryptedKeyPayload: wrapped,
                          });
                        }
                      }
                    }
                  }, 900);
                } else {
                  await ensureRoomKeyLocal(r.roomId);
                }
              }
            }
          }

          await flushQueuedMessages();
          return;
        }

        if (type === 'peer:joined' || type === 'peer:updated') {
          const peer = msg.peer as PeerInfo;
          setPeers((prev) => {
            const exists = prev.some((p) => p.peerId === peer.peerId);
            if (exists) return prev.map((p) => (p.peerId === peer.peerId ? peer : p));
            return [...prev, peer];
          });
          if (peer.peerId !== identity.peerId) {
            await ensureDmKey(peer);
          }
          return;
        }

        if (type === 'peer:left') {
          const leftId = String(msg.peerId);
          setPeers((prev) => prev.filter((p) => p.peerId !== leftId));
          return;
        }

        if (type === 'room:created' || type === 'room:updated') {
          const room = msg.room as RoomInfo;
          setRooms((prev) => {
            const exists = prev.some((r) => r.roomId === room.roomId);
            const next = exists
              ? prev.map((r) => (r.roomId === room.roomId ? room : r))
              : [...prev, room];
            saveCachedRooms(next);
            return next;
          });
          return;
        }

        if (type === 'room:key_request') {
          const roomId = String(msg.roomId);
          const requesterPeerId = String(msg.requesterPeerId);
          const roomKeyEntry = roomKeysRef.current.get(roomId);
          const requesterPeer = peersRef.current.find((p) => p.peerId === requesterPeerId);
          if (!roomKeyEntry || !requesterPeer) return;

          const dmEntry = await ensureDmKey(requesterPeer);
          if (!dmEntry) return;
          const wrapped = await encryptTextAsync(dmEntry.aesKey, roomKeyEntry.rawBase64);
          sendJsonRaw({
            type: 'room:key_share',
            roomId,
            targetPeerId: requesterPeerId,
            encryptedKeyPayload: wrapped,
          });
          return;
        }

        if (type === 'room:key_share') {
          const roomId = String(msg.roomId);
          const fromPeerId = String(msg.fromPeerId);
          const encryptedKeyPayload = msg.encryptedKeyPayload as EncryptedPayload;
          const fromPeer = peersRef.current.find((p) => p.peerId === fromPeerId);
          if (!fromPeer) return;

          try {
            const dmEntry = await ensureDmKey(fromPeer);
            if (!dmEntry) return;
            const rawBase64 = await decryptTextAsync(dmEntry.aesKey, encryptedKeyPayload);
            const { keyBytes, safetyCode } = await importRoomKeyFromBase64Async(rawBase64);
            roomKeysRef.current.set(roomId, {
              aesKey: keyBytes,
              rawBase64,
              safetyCode,
            });
            await saveRoomKeyRecord(roomId, rawBase64, safetyCode);
            setRoomSafetyCodes((prev) => ({ ...prev, [roomId]: safetyCode }));
          } catch {
            // ignore failed unwrap
          }
          return;
        }

        if (type === 'chat:ack') {
          const ackId = String(msg.id);
          setMessages((prev) =>
            prev.map((m) => (m.id === ackId ? { ...m, pendingSync: false } : m))
          );
          return;
        }

        if (type === 'chat:message') {
          const conversationType = msg.conversationType as 'room' | 'dm';
          const senderId = String(msg.senderId);
          const targetId = String(msg.targetId);
          const convTargetId = conversationType === 'dm' ? senderId : targetId;
          const conversationId = makeConversationId(conversationType, convTargetId);

          const aesKey = await getConversationKey(conversationType, convTargetId);
          let decryptedText = '[Pesan terenkripsi tidak dapat didekripsi]';
          let encryptedOk = false;

          if (aesKey && msg.encryptedPayload) {
            try {
              decryptedText = await decryptTextAsync(
                aesKey,
                msg.encryptedPayload as EncryptedPayload
              );
              encryptedOk = true;
            } catch {
              decryptedText = '[Kunci enkripsi berbeda — verifikasi ulang kode keamanan]';
            }
          }

          await appendMessageIdempotent(
            {
              id: String(msg.id),
              conversationId,
              conversationType,
              senderId,
              senderName: String(msg.senderName || 'Perangkat'),
              timestamp: Number(msg.timestamp || Date.now()),
              kind: 'text',
              text: decryptedText,
              encrypted: encryptedOk,
              verifiedAtSend: Boolean(msg.verifiedAtSend),
            },
            true
          );
          return;
        }

        if (type === 'file:offer') {
          const conversationType = msg.conversationType as 'room' | 'dm';
          const senderId = String(msg.senderId);
          const targetId = String(msg.targetId);
          const convTargetId = conversationType === 'dm' ? senderId : targetId;
          const conversationId = makeConversationId(conversationType, convTargetId);
          const transferId = String(msg.transferId);
          const totalChunks = Number(msg.totalChunks || 1);

          incomingTransfersRef.current.set(transferId, {
            transferId,
            conversationId,
            conversationType,
            senderId,
            senderName: String(msg.senderName || 'Perangkat'),
            fileName: String(msg.fileName || 'file'),
            mimeType: String(msg.mimeType || 'application/octet-stream'),
            size: Number(msg.size || 0),
            totalChunks,
            chunks: new Array(totalChunks).fill(null),
            receivedCount: 0,
            bytesReceived: 0,
            startTime: performance.now(),
            lastUiUpdate: 0,
            completedHandled: false,
          });

          await appendMessageIdempotent(
            {
              id: `file-${transferId}`,
              conversationId,
              conversationType,
              senderId,
              senderName: String(msg.senderName || 'Perangkat'),
              timestamp: Number(msg.timestamp || Date.now()),
              kind: 'file',
              encrypted: true,
              file: {
                transferId,
                fileName: String(msg.fileName || 'file'),
                mimeType: String(msg.mimeType || 'application/octet-stream'),
                size: Number(msg.size || 0),
                totalChunks,
                receivedChunks: 0,
                status: 'receiving',
                progress: 0,
                speedBps: 0,
                blobStored: false,
              },
            },
            true
          );
          return;
        }

        if (type === 'file:cancel') {
          const transferId = String(msg.transferId);
          incomingTransfersRef.current.delete(transferId);
          await updateFileMessage(transferId, (m) => ({
            ...m,
            file: m.file
              ? {
                  ...m.file,
                  status: 'cancelled',
                  errorMessage: 'Pengiriman dibatalkan pengirim',
                }
              : undefined,
          }));
          return;
        }
      };

      ws.onclose = () => {
        if (pingIntervalRef.current) {
          window.clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        wsRef.current = null;
        if (cancelled || unmountedRef.current) return;

        reconnectAttemptRef.current += 1;
        const delay = Math.min(8000, 1000 * Math.pow(2, reconnectAttemptRef.current - 1));
        setTelemetry((prev) => ({
          ...prev,
          quality: 'reconnecting',
          latencyMs: null,
        }));
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        setTelemetry((prev) => ({
          ...prev,
          quality: 'disconnected',
        }));
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [
    identityReady,
    identity,
    hostUrl,
    appendMessageIdempotent,
    ensureDmKey,
    ensureRoomKeyLocal,
    flushQueuedMessages,
    getConversationKey,
    handleIncomingBinaryChunk,
    sendJsonRaw,
    updateFileMessage,
  ]);

  const switchHostUrl = useCallback(
    (nextUrl: string) => {
      const saved = saveHostUrl(nextUrl);
      reconnectAttemptRef.current = 0;
      setPeers([]);
      setHostUrl(saved);
      hostUrlRef.current = saved;
      window.setTimeout(() => {
        refreshLanInfo();
      }, 100);
      return saved;
    },
    [refreshLanInfo]
  );

  const resetHostToLocal = useCallback(() => {
    const saved = saveHostUrl('');
    reconnectAttemptRef.current = 0;
    setPeers([]);
    setHostUrl(saved);
    hostUrlRef.current = saved;
    window.setTimeout(() => {
      refreshLanInfo();
    }, 100);
    return saved;
  }, [refreshLanInfo]);

  const completeOnboarding = useCallback(async (displayName: string) => {
    const trimmed = displayName.trim().slice(0, 40) || 'Perangkat Lokal';
    const pair = await generateIdentityKeyPairAsync();
    const newIdentity: StoredDeviceIdentity = {
      peerId: randomUuid(),
      displayName: trimmed,
      privateKeyHex: pair.privateKeyHex,
      publicKeyHex: pair.publicKeyHex,
      createdAt: Date.now(),
    };
    identityRef.current = newIdentity;
    await saveDeviceIdentity(newIdentity);
    setIdentity(newIdentity);
    setNeedsOnboarding(false);
  }, []);

  const renameSelf = useCallback(
    async (newName: string) => {
      const trimmed = newName.trim().slice(0, 40);
      if (!trimmed || !identityRef.current) return;
      const updated = { ...identityRef.current, displayName: trimmed };
      identityRef.current = updated;
      setIdentity(updated);
      await saveDeviceIdentity(updated);
      sendJsonRaw({ type: 'peer:rename', displayName: trimmed });
    },
    [sendJsonRaw]
  );

  const createRoom = useCallback(
    async (roomName: string) => {
      const trimmed = roomName.trim().slice(0, 48);
      if (!trimmed || !identityRef.current) return null;
      const roomId = `ruang-${randomUuid().slice(0, 8)}`;
      await ensureRoomKeyLocal(roomId);
      sendJsonRaw({
        type: 'room:create',
        roomId,
        name: trimmed,
      });
      setActiveTarget({ type: 'room', id: roomId });
      return roomId;
    },
    [ensureRoomKeyLocal, sendJsonRaw]
  );

  const joinRoom = useCallback(
    (roomId: string) => {
      if (!identityRef.current) return;
      sendJsonRaw({ type: 'room:join', roomId });
      if (!roomKeysRef.current.has(roomId)) {
        sendJsonRaw({ type: 'room:key_request', roomId });
      }
      setActiveTarget({ type: 'room', id: roomId });
    },
    [sendJsonRaw]
  );

  const sendTextMessage = useCallback(
    async (target: ChatTarget, text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !identityRef.current) return;

      const msgId = randomUuid();
      const timestamp = Date.now();
      const conversationId = makeConversationId(target.type, target.id);

      const optimistic: ChatMessageRecord = {
        id: msgId,
        conversationId,
        conversationType: target.type,
        senderId: identityRef.current.peerId,
        senderName: identityRef.current.displayName,
        timestamp,
        kind: 'text',
        text: trimmed,
        encrypted: true,
        pendingSync: true,
      };

      await appendMessageIdempotent(optimistic, false);

      const aesKey = await getConversationKey(target.type, target.id);
      const isOpen = wsRef.current && wsRef.current.readyState === WebSocket.OPEN;

      if (!aesKey || !isOpen) {
        outgoingQueueRef.current.push({
          id: msgId,
          conversationType: target.type,
          targetId: target.id,
          text: trimmed,
          timestamp,
        });
        setTelemetry((prev) => ({
          ...prev,
          queuedCount: outgoingQueueRef.current.length,
        }));
        return;
      }

      const encryptedPayload = await encryptTextAsync(aesKey, trimmed);
      sendJsonRaw({
        type: 'chat:message',
        id: msgId,
        conversationType: target.type,
        targetId: target.id,
        senderName: identityRef.current.displayName,
        timestamp,
        encryptedPayload,
        verifiedAtSend:
          target.type === 'dm'
            ? Boolean(verifiedPeers[target.id])
            : Boolean(verifiedRooms[target.id]),
      });
    },
    [appendMessageIdempotent, getConversationKey, sendJsonRaw, verifiedPeers, verifiedRooms]
  );

  const sendFiles = useCallback(
    async (target: ChatTarget, files: File[]) => {
      if (!identityRef.current || files.length === 0) return;
      const aesKey = await getConversationKey(target.type, target.id);
      if (!aesKey) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const conversationId = makeConversationId(target.type, target.id);

      for (const file of files) {
        const transferId = randomUuid();
        const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        const timestamp = Date.now();
        const mimeType = file.type || 'application/octet-stream';

        await saveFileBlob(transferId, file, file.name, mimeType);
        const localUrl = URL.createObjectURL(file);
        setFileUrls((prev) => ({ ...prev, [transferId]: localUrl }));

        await appendMessageIdempotent(
          {
            id: `file-${transferId}`,
            conversationId,
            conversationType: target.type,
            senderId: identityRef.current.peerId,
            senderName: identityRef.current.displayName,
            timestamp,
            kind: 'file',
            encrypted: true,
            file: {
              transferId,
              fileName: file.name,
              mimeType,
              size: file.size,
              totalChunks,
              receivedChunks: 0,
              status: 'sending',
              progress: 0,
              speedBps: 0,
              blobStored: true,
            },
          },
          false
        );

        sendJsonRaw({
          type: 'file:offer',
          transferId,
          conversationType: target.type,
          targetId: target.id,
          senderName: identityRef.current.displayName,
          timestamp,
          fileName: file.name,
          mimeType,
          size: file.size,
          totalChunks,
        });

        const startTime = performance.now();
        let bytesSent = 0;
        let lastUiUpdate = 0;

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          if (cancelledTransfersRef.current.has(transferId)) {
            cancelledTransfersRef.current.delete(transferId);
            sendJsonRaw({
              type: 'file:cancel',
              transferId,
              conversationType: target.type,
              targetId: target.id,
            });
            await updateFileMessage(transferId, (m) => ({
              ...m,
              file: m.file
                ? { ...m.file, status: 'cancelled', errorMessage: 'Dibatalkan' }
                : undefined,
            }));
            break;
          }

          if (ws.readyState !== WebSocket.OPEN) {
            await updateFileMessage(transferId, (m) => ({
              ...m,
              file: m.file
                ? { ...m.file, status: 'failed', errorMessage: 'Koneksi Wi-Fi terputus' }
                : undefined,
            }));
            break;
          }

          while (ws.bufferedAmount > 2 * 1024 * 1024 && ws.readyState === WebSocket.OPEN) {
            await new Promise((r) => setTimeout(r, 25));
          }

          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(file.size, start + CHUNK_SIZE);
          const sliceBuffer = await file.slice(start, end).arrayBuffer();
          const { ivBase64, encryptedBytes } = await encryptBinaryChunkAsync(aesKey, sliceBuffer);

          const headerObj = {
            transferId,
            conversationType: target.type,
            targetId: target.id,
            senderId: identityRef.current.peerId,
            chunkIndex,
            totalChunks,
            iv: ivBase64,
          };
          const headerBytes = new TextEncoder().encode(JSON.stringify(headerObj));
          const packet = new Uint8Array(4 + headerBytes.length + encryptedBytes.length);
          const dv = new DataView(packet.buffer);
          dv.setUint32(0, headerBytes.length, false);
          packet.set(headerBytes, 4);
          packet.set(encryptedBytes, 4 + headerBytes.length);

          ws.send(packet.buffer);
          bytesSent += sliceBuffer.byteLength;

          const now = performance.now();
          const elapsedSec = Math.max(0.05, (now - startTime) / 1000);
          const speedBps = bytesSent / elapsedSec;
          const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);

          if (now - lastUiUpdate > 120 || chunkIndex === totalChunks - 1) {
            lastUiUpdate = now;
            setMessages((prev) =>
              prev.map((m) =>
                m.kind === 'file' && m.file?.transferId === transferId
                  ? {
                      ...m,
                      file: {
                        ...m.file,
                        receivedChunks: chunkIndex + 1,
                        progress: chunkIndex === totalChunks - 1 ? 100 : Math.min(99, progress),
                        speedBps,
                        status: chunkIndex === totalChunks - 1 ? 'completed' : 'sending',
                      },
                    }
                  : m
              )
            );
          }

          if (chunkIndex === totalChunks - 1) {
            await updateFileMessage(transferId, (m) => ({
              ...m,
              file: m.file
                ? {
                    ...m.file,
                    receivedChunks: totalChunks,
                    status: 'completed',
                    progress: 100,
                    speedBps,
                    blobStored: true,
                  }
                : undefined,
            }));
          }
        }
      }
    },
    [appendMessageIdempotent, getConversationKey, sendJsonRaw, updateFileMessage]
  );

  const cancelTransfer = useCallback((transferId: string) => {
    cancelledTransfersRef.current.add(transferId);
  }, []);

  const markPeerVerified = useCallback(
    async (peerId: string, verified: boolean) => {
      if (verified) {
        const safetyCode = dmSafetyCodes[peerId] || '';
        const rec: VerifiedPeerRecord = {
          peerId,
          safetyCode,
          verifiedAt: Date.now(),
        };
        await saveVerifiedPeer(rec);
        setVerifiedPeers((prev) => ({ ...prev, [peerId]: rec }));
      } else {
        await removeVerifiedPeer(peerId);
        setVerifiedPeers((prev) => {
          const next = { ...prev };
          delete next[peerId];
          return next;
        });
      }
    },
    [dmSafetyCodes]
  );

  const markRoomVerified = useCallback(
    async (roomId: string, verified: boolean) => {
      if (verified) {
        const safetyCode = roomSafetyCodes[roomId] || '';
        const rec: VerifiedRoomRecord = {
          roomId,
          safetyCode,
          verifiedAt: Date.now(),
        };
        await saveVerifiedRoom(rec);
        setVerifiedRooms((prev) => ({ ...prev, [roomId]: rec }));
      } else {
        await removeVerifiedRoom(roomId);
        setVerifiedRooms((prev) => {
          const next = { ...prev };
          delete next[roomId];
          return next;
        });
      }
    },
    [roomSafetyCodes]
  );

  const clearActiveConversation = useCallback(async (target: ChatTarget) => {
    const convId = makeConversationId(target.type, target.id);
    await clearConversationHistory(convId);
    setMessages((prev) => prev.filter((m) => m.conversationId !== convId));
  }, []);

  const clearAllHistory = useCallback(async () => {
    await clearAllChatData();
    setMessages([]);
    setFileUrls({});
  }, []);

  const activeConversationId = useMemo(
    () => makeConversationId(activeTarget.type, activeTarget.id),
    [activeTarget]
  );

  const activeMessages = useMemo(
    () => messages.filter((m) => m.conversationId === activeConversationId),
    [messages, activeConversationId]
  );

  const otherPeers = useMemo(
    () => peers.filter((p) => p.peerId !== identity?.peerId),
    [peers, identity]
  );

  const lastMessages = useMemo(() => {
    const map: Record<string, ChatMessageRecord> = {};
    for (const m of messages) {
      map[m.conversationId] = m;
    }
    return map;
  }, [messages]);

  return {
    identity,
    identityReady,
    needsOnboarding,
    completeOnboarding,
    renameSelf,
    peers: otherPeers,
    allPeers: peers,
    rooms,
    activeTarget,
    setActiveTarget,
    activeMessages,
    lastMessages,
    unreadCounts,
    telemetry,
    lanInfo,
    refreshLanInfo,
    roomSafetyCodes,
    dmSafetyCodes,
    verifiedPeers,
    verifiedRooms,
    markPeerVerified,
    markRoomVerified,
    fileUrls,
    createRoom,
    joinRoom,
    sendTextMessage,
    sendFiles,
    cancelTransfer,
    clearActiveConversation,
    clearAllHistory,
    hostUrl,
    isTauriApp,
    switchHostUrl,
    resetHostToLocal,
  };
}
