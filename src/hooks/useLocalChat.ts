import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  base64ToBytes,
  bytesToBase64,
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
import {
  getRustLanInfo,
  isTauriRuntime,
  rustGetCallCapabilities,
  rustProbeHost,
  rustWsConnect,
  rustWsDisconnect,
  rustWsSendBinary,
  rustWsSendText,
  subscribeRustWsEvents,
  type RustCallCapabilitiesDto,
  type RustHostProbeResultDto,
} from '../lib/tauriBridge';
import { CallMediaEngine } from '../lib/callEngine';
import { ringtone } from '../lib/ringtone';
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
  CallSessionState,
  CallTransportMode,
  CallType,
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

  const [callSession, setCallSession] = useState<CallSessionState | null>(null);
  const [localCallStream, setLocalCallStream] = useState<MediaStream | null>(null);
  const [remoteCallStream, setRemoteCallStream] = useState<MediaStream | null>(null);
  const [callAudioLevels, setCallAudioLevels] = useState<{ local: number; remote: number }>({
    local: 0,
    remote: 0,
  });
  const [rustCallCapabilities, setRustCallCapabilities] =
    useState<RustCallCapabilitiesDto | null>(null);

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
  const rustWsConnectedRef = useRef<boolean>(false);
  const rustActiveConnIdRef = useRef<number>(0);
  const hostUrlRef = useRef<string>(hostUrl);
  const identityRef = useRef<StoredDeviceIdentity | null>(null);
  const peersRef = useRef<PeerInfo[]>([]);
  const roomsRef = useRef<RoomInfo[]>([]);
  const activeTargetRef = useRef<ChatTarget>(activeTarget);
  const callSessionRef = useRef<CallSessionState | null>(null);
  const callEngineRef = useRef<CallMediaEngine | null>(null);
  const callRemoteCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const callRingTimeoutRef = useRef<number | null>(null);
  const callEndedTimerRef = useRef<number | null>(null);
  const dmKeysRef = useRef<Map<string, { aesKey: Uint8Array; safetyCode: string }>>(new Map());
  const roomKeysRef = useRef<
    Map<string, { aesKey: Uint8Array; rawBase64: string; safetyCode: string }>
  >(new Map());
  const syncedRoomForHostRef = useRef<Set<string>>(new Set());
  const undecryptedPayloadsRef = useRef<
    Map<
      string,
      {
        conversationType: 'room' | 'dm';
        convTargetId: string;
        encryptedPayload: EncryptedPayload;
      }
    >
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
  const queueSweepTimerRef = useRef<number | null>(null);
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

  useEffect(() => {
    callSessionRef.current = callSession;
  }, [callSession]);

  useEffect(() => {
    if (isTauriApp) {
      rustGetCallCapabilities()
        .then((caps) => setRustCallCapabilities(caps))
        .catch(() => {});
    }
    return () => {
      ringtone.stop();
      if (callRingTimeoutRef.current) window.clearTimeout(callRingTimeoutRef.current);
      if (callEndedTimerRef.current) window.clearTimeout(callEndedTimerRef.current);
      callEngineRef.current?.destroy();
    };
  }, [isTauriApp]);

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

  const isSocketOpen = useCallback((): boolean => {
    if (isTauriApp) {
      return rustWsConnectedRef.current;
    }
    const ws = wsRef.current;
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }, [isTauriApp]);

  const sendJsonRaw = useCallback(
    (payload: unknown): boolean => {
      const encoded = JSON.stringify(payload);
      if (isTauriApp) {
        if (!rustWsConnectedRef.current) return false;
        void rustWsSendText(encoded).catch(() => {});
        return true;
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoded);
        return true;
      }
      return false;
    },
    [isTauriApp]
  );

  const sendJsonReliable = useCallback(
    async (payload: unknown): Promise<boolean> => {
      const encoded = JSON.stringify(payload);
      if (isTauriApp) {
        if (!rustWsConnectedRef.current) return false;
        try {
          return await rustWsSendText(encoded);
        } catch {
          return false;
        }
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(encoded);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },
    [isTauriApp]
  );

  const sendBinaryRaw = useCallback(
    (packet: ArrayBuffer): boolean => {
      if (isTauriApp) {
        if (!rustWsConnectedRef.current) return false;
        const b64 = bytesToBase64(new Uint8Array(packet));
        void rustWsSendBinary(b64).catch(() => {});
        return true;
      }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512 * 1024) {
        ws.send(packet);
        return true;
      }
      return false;
    },
    [isTauriApp]
  );

  const sendBinaryReliable = useCallback(
    async (packet: ArrayBuffer): Promise<boolean> => {
      if (isTauriApp) {
        if (!rustWsConnectedRef.current) return false;
        try {
          const b64 = bytesToBase64(new Uint8Array(packet));
          return await rustWsSendBinary(b64);
        } catch {
          return false;
        }
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      while (ws.bufferedAmount > 2 * 1024 * 1024 && ws.readyState === WebSocket.OPEN) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(packet);
      return true;
    },
    [isTauriApp]
  );

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

  const ensureCallEngine = useCallback(() => {
    if (callEngineRef.current) return callEngineRef.current;
    const engine = new CallMediaEngine({
      sendJson: sendJsonRaw,
      sendBinary: sendBinaryRaw,
      getDmAesKey: (peerId) => getConversationKey('dm', peerId),
      onTransportModeChange: (mode: CallTransportMode) => {
        setCallSession((prev) => (prev ? { ...prev, transportMode: mode } : prev));
      },
      onLocalStream: (stream) => {
        setLocalCallStream(stream);
      },
      onRemoteStream: (stream) => {
        setRemoteCallStream(stream);
      },
      onStatusNote: (note) => {
        setCallSession((prev) => (prev ? { ...prev, statusNote: note } : prev));
      },
      onAudioLevel: (local, remote) => {
        setCallAudioLevels({ local, remote });
      },
    });
    engine.setRemoteCanvas(callRemoteCanvasRef.current);
    callEngineRef.current = engine;
    return engine;
  }, [getConversationKey, sendBinaryRaw, sendJsonRaw]);

  const formatDurationLabel = useCallback((ms: number) => {
    const totalSec = Math.max(1, Math.round(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, []);

  const finalizeCallCleanup = useCallback(
    async (reasonText: string, recordLog = true) => {
      ringtone.stop();
      if (callRingTimeoutRef.current) {
        window.clearTimeout(callRingTimeoutRef.current);
        callRingTimeoutRef.current = null;
      }

      const snapshot = callSessionRef.current;
      callEngineRef.current?.destroy();
      callEngineRef.current = null;
      setLocalCallStream(null);
      setRemoteCallStream(null);
      setCallAudioLevels({ local: 0, remote: 0 });

      if (snapshot && recordLog && identityRef.current) {
        const labelPrefix =
          snapshot.callType === 'video' ? 'Panggilan video' : 'Panggilan suara';
        const durationPart =
          snapshot.connectedAt !== null
            ? formatDurationLabel(Date.now() - snapshot.connectedAt)
            : reasonText;
        await appendMessageIdempotent(
          {
            id: `call-log-${snapshot.callId}-${Date.now()}`,
            conversationId: makeConversationId('dm', snapshot.peerId),
            conversationType: 'dm',
            senderId: snapshot.peerId,
            senderName: snapshot.peerName,
            timestamp: Date.now(),
            kind: 'system',
            text: `${labelPrefix} · ${durationPart}`,
            encrypted: true,
          },
          false
        );
      }

      if (snapshot) {
        setCallSession({
          ...snapshot,
          status: 'ended',
          endReason: reasonText,
          minimized: false,
        });
        if (callEndedTimerRef.current) window.clearTimeout(callEndedTimerRef.current);
        callEndedTimerRef.current = window.setTimeout(() => {
          setCallSession((curr) => (curr?.status === 'ended' ? null : curr));
        }, 1400);
      } else {
        setCallSession(null);
      }
    },
    [appendMessageIdempotent, formatDurationLabel]
  );

  const flushQueuedMessages = useCallback(async () => {
    if (!identityRef.current) return;
    if (!isSocketOpen()) return;
    if (outgoingQueueRef.current.length === 0) return;

    const remaining: typeof outgoingQueueRef.current = [];
    for (const item of outgoingQueueRef.current) {
      try {
        const aesKey = await getConversationKey(item.conversationType, item.targetId);
        if (!aesKey) {
          remaining.push(item);
          continue;
        }
        const encryptedPayload = await encryptTextAsync(aesKey, item.text);
        const sent = await sendJsonReliable({
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
        }
      } catch {
        remaining.push(item);
      }
    }

    outgoingQueueRef.current = remaining;
    setTelemetry((prev) => ({ ...prev, queuedCount: remaining.length }));
  }, [getConversationKey, isSocketOpen, sendJsonReliable]);

  const handleIncomingBinaryChunk = useCallback(
    async (arrayBuffer: ArrayBuffer) => {
      if (arrayBuffer.byteLength < 8) return;
      const view = new DataView(arrayBuffer);
      const headerLen = view.getUint32(0, false);
      if (headerLen <= 0 || headerLen > 16384 || arrayBuffer.byteLength < 4 + headerLen) return;

      const headerBytes = new Uint8Array(arrayBuffer, 4, headerLen);
      const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
        kind?: 'call_audio' | 'call_video';
        callId?: string;
        sampleRate?: number;
        transferId: string;
        conversationType: 'room' | 'dm';
        targetId: string;
        senderId: string;
        chunkIndex: number;
        totalChunks: number;
        iv: string;
      };

      if (header.kind === 'call_audio' || header.kind === 'call_video') {
        const encryptedBytes = new Uint8Array(arrayBuffer, 4 + headerLen);
        if (callEngineRef.current && header.callId) {
          void callEngineRef.current.handleIncomingMediaPacket(
            {
              kind: header.kind,
              callId: header.callId,
              senderId: header.senderId,
              iv: header.iv,
              sampleRate: header.sampleRate,
            },
            encryptedBytes
          );
        }
        return;
      }

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
    let unlistenRustWs: (() => void) | null = null;

    const retryDecryptRoomMessages = async (roomId: string, aesKey: Uint8Array) => {
      const entries = Array.from(undecryptedPayloadsRef.current.entries());
      for (const [msgId, info] of entries) {
        if (info.conversationType !== 'room' || info.convTargetId !== roomId) continue;
        try {
          const text = await decryptTextAsync(aesKey, info.encryptedPayload);
          undecryptedPayloadsRef.current.delete(msgId);
          let updatedMsg: ChatMessageRecord | null = null;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === msgId) {
                updatedMsg = { ...m, text, encrypted: true };
                return updatedMsg;
              }
              return m;
            })
          );
          if (updatedMsg) {
            await saveMessageRecord(updatedMsg);
          }
        } catch {
          // still mismatch
        }
      }
    };

    const handleSocketOpen = (wsUrl: string) => {
      if (cancelled) return;
      reconnectAttemptRef.current = 0;

      void sendJsonReliable({
        type: 'hello',
        peerId: identity.peerId,
        displayName: identity.displayName,
        deviceLabel: detectDeviceLabel(),
        publicKeyHex: identity.publicKeyHex,
      });

      setTelemetry((prev) => ({
        ...prev,
        quality: 'connected',
        wsEndpoint: wsUrl,
      }));

      if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
      const sendPing = () => {
        if (!isSocketOpen()) return;
        const now = performance.now();
        if (lastPingSentAtRef.current !== null && now - lastPingSentAtRef.current > 6000) {
          setTelemetry((prev) => ({ ...prev, quality: 'degraded' }));
        }
        lastPingSentAtRef.current = now;
        void sendJsonReliable({ type: 'ping', clientTs: now });
      };
      sendPing();
      pingIntervalRef.current = window.setInterval(sendPing, 2500);

      if (queueSweepTimerRef.current) window.clearInterval(queueSweepTimerRef.current);
      queueSweepTimerRef.current = window.setInterval(() => {
        if (!cancelled && outgoingQueueRef.current.length > 0 && isSocketOpen()) {
          void flushQueuedMessages();
        }
      }, 2000);
    };

    const handleSocketClose = () => {
      if (pingIntervalRef.current) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (queueSweepTimerRef.current) {
        window.clearInterval(queueSweepTimerRef.current);
        queueSweepTimerRef.current = null;
      }
      rustWsConnectedRef.current = false;
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

    const handleIncomingJsonText = async (rawText: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawText);
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

        // Synchronously update refs before async key derivations or room:key_request
        peersRef.current = incomingPeers;
        roomsRef.current = incomingRooms;
        setPeers(incomingPeers);
        setRooms(incomingRooms);
        await saveCachedRooms(incomingRooms);

        // If activeTarget points to a custom room missing on the host, ensure it exists or switch cleanly
        if (
          activeTargetRef.current.type === 'room' &&
          activeTargetRef.current.id !== DEFAULT_ROOM_ID &&
          !incomingRooms.some((r) => r.roomId === activeTargetRef.current.id)
        ) {
          setActiveTarget({ type: 'room', id: DEFAULT_ROOM_ID });
        } else if (activeTargetRef.current.type === 'room') {
          void sendJsonReliable({ type: 'room:join', roomId: activeTargetRef.current.id });
        }

        for (const p of incomingPeers) {
          if (p.peerId !== identity.peerId) {
            await ensureDmKey(p);
          }
        }

        const currentHostKey = hostUrl || LOCAL_RUST_HOST_URL;
        for (const r of incomingRooms) {
          if (r.memberIds.includes(identity.peerId) || r.roomId === DEFAULT_ROOM_ID) {
            const syncMarker = `${currentHostKey}::${r.roomId}`;
            const otherOnlineMembers = r.memberIds.filter(
              (id) =>
                id !== identity.peerId &&
                incomingPeers.some((p) => p.peerId === id && p.online)
            );
            const hasKey = roomKeysRef.current.has(r.roomId);
            const alreadySyncedOnThisHost = syncedRoomForHostRef.current.has(syncMarker);

            if (otherOnlineMembers.length > 0 && (!hasKey || !alreadySyncedOnThisHost)) {
              await sendJsonReliable({ type: 'room:key_request', roomId: r.roomId });
              window.setTimeout(async () => {
                if (!roomKeysRef.current.has(r.roomId)) {
                  const allSorted = [identity.peerId, ...otherOnlineMembers].sort();
                  if (allSorted[0] === identity.peerId) {
                    const created = await ensureRoomKeyLocal(r.roomId);
                    syncedRoomForHostRef.current.add(syncMarker);
                    for (const mId of otherOnlineMembers) {
                      const memberPeer = peersRef.current.find((p) => p.peerId === mId);
                      if (!memberPeer) continue;
                      const dmEntry = await ensureDmKey(memberPeer);
                      if (!dmEntry) continue;
                      const wrapped = await encryptTextAsync(dmEntry.aesKey, created.rawBase64);
                      void sendJsonReliable({
                        type: 'room:key_share',
                        roomId: r.roomId,
                        targetPeerId: mId,
                        encryptedKeyPayload: wrapped,
                      });
                    }
                  }
                }
              }, 800);
            } else if (!hasKey) {
              await ensureRoomKeyLocal(r.roomId);
              syncedRoomForHostRef.current.add(syncMarker);
            }
          }
        }

        await flushQueuedMessages();
        return;
      }

      if (type === 'peer:joined' || type === 'peer:updated') {
        const peer = msg.peer as PeerInfo;
        const currentPeers = peersRef.current;
        const nextPeers = currentPeers.some((p) => p.peerId === peer.peerId)
          ? currentPeers.map((p) => (p.peerId === peer.peerId ? peer : p))
          : [...currentPeers, peer];
        peersRef.current = nextPeers;
        setPeers(nextPeers);

        if (peer.peerId !== identity.peerId) {
          await ensureDmKey(peer);
          await flushQueuedMessages();
        }
        return;
      }

      if (type === 'peer:left') {
        const leftId = String(msg.peerId);
        const nextPeers = peersRef.current.filter((p) => p.peerId !== leftId);
        peersRef.current = nextPeers;
        setPeers(nextPeers);
        return;
      }

      if (type === 'room:created' || type === 'room:updated') {
        const room = msg.room as RoomInfo;
        const currentRooms = roomsRef.current;
        const nextRooms = currentRooms.some((r) => r.roomId === room.roomId)
          ? currentRooms.map((r) => (r.roomId === room.roomId ? room : r))
          : [...currentRooms, room];
        roomsRef.current = nextRooms;
        setRooms(nextRooms);
        void saveCachedRooms(nextRooms);
        return;
      }

      if (type === 'room:key_request') {
        const roomId = String(msg.roomId);
        const requesterPeerId = String(msg.requesterPeerId);
        let roomKeyEntry = roomKeysRef.current.get(roomId);
        if (!roomKeyEntry && roomId === DEFAULT_ROOM_ID) {
          roomKeyEntry = await ensureRoomKeyLocal(roomId);
        }
        const requesterPeer = peersRef.current.find((p) => p.peerId === requesterPeerId);
        if (!roomKeyEntry || !requesterPeer) return;

        const dmEntry = await ensureDmKey(requesterPeer);
        if (!dmEntry) return;
        const wrapped = await encryptTextAsync(dmEntry.aesKey, roomKeyEntry.rawBase64);
        void sendJsonReliable({
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
          const currentHostKey = hostUrl || LOCAL_RUST_HOST_URL;
          syncedRoomForHostRef.current.add(`${currentHostKey}::${roomId}`);
          await saveRoomKeyRecord(roomId, rawBase64, safetyCode);
          setRoomSafetyCodes((prev) => ({ ...prev, [roomId]: safetyCode }));
          await retryDecryptRoomMessages(roomId, keyBytes);
          await flushQueuedMessages();
        } catch {
          // ignore failed unwrap
        }
        return;
      }

      if (type === 'chat:ack') {
        const ackId = String(msg.id);
        let ackedMsg: ChatMessageRecord | null = null;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === ackId && m.pendingSync) {
              ackedMsg = { ...m, pendingSync: false };
              return ackedMsg;
            }
            return m;
          })
        );
        if (ackedMsg) {
          await saveMessageRecord(ackedMsg);
        }
        return;
      }

      if (type === 'chat:message') {
        const conversationType = msg.conversationType as 'room' | 'dm';
        const senderId = String(msg.senderId);
        const targetId = String(msg.targetId);
        const convTargetId = conversationType === 'dm' ? senderId : targetId;
        const conversationId = makeConversationId(conversationType, convTargetId);
        const msgId = String(msg.id);

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
            decryptedText = '[Menyelaraskan kunci ruang enkripsi...]';
            if (conversationType === 'room') {
              undecryptedPayloadsRef.current.set(msgId, {
                conversationType,
                convTargetId,
                encryptedPayload: msg.encryptedPayload as EncryptedPayload,
              });
              void sendJsonReliable({ type: 'room:key_request', roomId: convTargetId });
            }
          }
        }

        await appendMessageIdempotent(
          {
            id: msgId,
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

      if (type === 'call:invite') {
        const callId = String(msg.callId || '');
        const callerId = String(msg.callerId || '');
        const callType: CallType = msg.callType === 'video' ? 'video' : 'audio';
        const callerPeer = peersRef.current.find((p) => p.peerId === callerId);
        const callerName = String(msg.callerName || callerPeer?.displayName || 'Perangkat Lokal');
        if (!callId || !callerId) return;

        if (callSessionRef.current && callSessionRef.current.status !== 'ended') {
          void sendJsonReliable({
            type: 'call:reject',
            callId,
            targetPeerId: callerId,
            reason: 'busy',
          });
          return;
        }

        if (callEndedTimerRef.current) {
          window.clearTimeout(callEndedTimerRef.current);
          callEndedTimerRef.current = null;
        }

        setCallSession({
          callId,
          callType,
          status: 'incoming',
          direction: 'incoming',
          peerId: callerId,
          peerName: callerName,
          peerDeviceLabel: callerPeer?.deviceLabel,
          transportMode: 'webrtc',
          audioMuted: false,
          videoMuted: false,
          remoteAudioMuted: false,
          remoteVideoMuted: false,
          speakerMuted: false,
          facingMode: 'user',
          connectedAt: null,
          minimized: false,
        });
        ringtone.startIncomingRingtone();
        return;
      }

      if (type === 'call:accept') {
        const callId = String(msg.callId || '');
        const current = callSessionRef.current;
        if (!current || current.callId !== callId) return;
        if (callRingTimeoutRef.current) {
          window.clearTimeout(callRingTimeoutRef.current);
          callRingTimeoutRef.current = null;
        }
        ringtone.stop();
        setCallSession((prev) =>
          prev
            ? {
                ...prev,
                status: 'active',
                connectedAt: Date.now(),
              }
            : prev
        );
        const engine = ensureCallEngine();
        await engine.startSession({
          callId,
          selfPeerId: identity.peerId,
          remotePeerId: current.peerId,
          callType: current.callType,
          isCaller: true,
        });
        return;
      }

      if (type === 'call:reject' || type === 'call:busy' || type === 'call:unavailable') {
        const callId = String(msg.callId || '');
        const current = callSessionRef.current;
        if (!current || current.callId !== callId) return;
        const label =
          type === 'call:busy'
            ? 'Sedang sibuk'
            : type === 'call:unavailable'
            ? 'Perangkat offline'
            : 'Ditolak';
        ringtone.playEndChime();
        await finalizeCallCleanup(label, true);
        return;
      }

      if (type === 'call:cancel' || type === 'call:hangup') {
        const callId = String(msg.callId || '');
        const current = callSessionRef.current;
        if (!current || current.callId !== callId) return;
        const reason = String(msg.reason || '');
        const label =
          type === 'call:cancel'
            ? 'Panggilan tak terjawab'
            : reason === 'peer_disconnected'
            ? 'Koneksi terputus'
            : 'Panggilan berakhir';
        ringtone.playEndChime();
        await finalizeCallCleanup(label, true);
        return;
      }

      if (type === 'call:rtc_signal') {
        const callId = String(msg.callId || '');
        const current = callSessionRef.current;
        if (!current || current.callId !== callId) return;
        await callEngineRef.current?.handleRtcSignal(msg);
        return;
      }

      if (type === 'call:media_state') {
        const callId = String(msg.callId || '');
        setCallSession((prev) => {
          if (!prev || prev.callId !== callId) return prev;
          return {
            ...prev,
            remoteAudioMuted:
              typeof msg.audioMuted === 'boolean' ? msg.audioMuted : prev.remoteAudioMuted,
            remoteVideoMuted:
              typeof msg.videoMuted === 'boolean' ? msg.videoMuted : prev.remoteVideoMuted,
          };
        });
        return;
      }

      if (type === 'call:switch_type') {
        const callId = String(msg.callId || '');
        const nextType: CallType = msg.callType === 'video' ? 'video' : 'audio';
        setCallSession((prev) =>
          prev && prev.callId === callId ? { ...prev, callType: nextType } : prev
        );
        return;
      }
    };

    const connect = () => {
      if (cancelled || unmountedRef.current) return;

      const wsUrl = buildWsEndpoint(hostUrl);

      setTelemetry((prev) => ({
        ...prev,
        quality: reconnectAttemptRef.current > 0 ? 'reconnecting' : prev.quality,
        wsEndpoint: wsUrl,
      }));

      if (isTauriApp) {
        rustWsConnectedRef.current = false;
        void rustWsConnect(wsUrl)
          .then((connId) => {
            if (!cancelled) {
              rustActiveConnIdRef.current = connId;
            }
          })
          .catch(() => {
            handleSocketClose();
          });
        return;
      }

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        handleSocketOpen(wsUrl);
      };

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          await handleIncomingBinaryChunk(event.data);
          return;
        }
        await handleIncomingJsonText(String(event.data));
      };

      ws.onclose = () => {
        handleSocketClose();
      };

      ws.onerror = () => {
        setTelemetry((prev) => ({
          ...prev,
          quality: 'disconnected',
        }));
      };
    };

    const boot = async () => {
      if (isTauriApp) {
        unlistenRustWs = await subscribeRustWsEvents({
          onOpen: (payload) => {
            if (cancelled || payload.connId !== rustActiveConnIdRef.current) return;
            rustWsConnectedRef.current = true;
            handleSocketOpen(payload.url);
          },
          onText: (payload) => {
            if (cancelled || payload.connId !== rustActiveConnIdRef.current) return;
            void handleIncomingJsonText(payload.data);
          },
          onBinary: (payload) => {
            if (cancelled || payload.connId !== rustActiveConnIdRef.current) return;
            const bytes = base64ToBytes(payload.dataBase64);
            const buf = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ) as ArrayBuffer;
            void handleIncomingBinaryChunk(buf);
          },
          onClose: (payload) => {
            if (cancelled || payload.connId !== rustActiveConnIdRef.current) return;
            handleSocketClose();
          },
        });
      }
      connect();
    };

    void boot();

    return () => {
      cancelled = true;
      if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
      if (queueSweepTimerRef.current) window.clearInterval(queueSweepTimerRef.current);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (unlistenRustWs) unlistenRustWs();
      if (isTauriApp) {
        rustWsConnectedRef.current = false;
        void rustWsDisconnect().catch(() => {});
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [
    identityReady,
    identity,
    hostUrl,
    isTauriApp,
    appendMessageIdempotent,
    ensureCallEngine,
    ensureDmKey,
    ensureRoomKeyLocal,
    finalizeCallCleanup,
    flushQueuedMessages,
    getConversationKey,
    handleIncomingBinaryChunk,
    isSocketOpen,
    sendJsonReliable,
    updateFileMessage,
  ]);

  const probeHost = useCallback(
    async (targetUrl: string): Promise<RustHostProbeResultDto> => {
      if (isTauriApp) {
        return rustProbeHost(targetUrl);
      }
      const started = performance.now();
      try {
        const res = await fetch(`${targetUrl}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          peersOnline?: number;
          activeCalls?: number;
          engine?: string;
        };
        return {
          ok: Boolean(data.ok),
          latencyMs: Math.max(1, Math.round(performance.now() - started)),
          peersOnline: data.peersOnline ?? 0,
          activeCalls: data.activeCalls ?? 0,
          engine: data.engine || 'node-ws',
          error: data.ok ? null : 'Host tidak merespons sebagai server LokaKirim',
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - started),
          peersOnline: 0,
          activeCalls: 0,
          engine: 'fetch',
          error: err instanceof Error ? err.message : 'Host tidak dapat dijangkau',
        };
      }
    },
    [isTauriApp]
  );

  const switchHostUrl = useCallback(
    (nextUrl: string) => {
      const saved = saveHostUrl(nextUrl);
      reconnectAttemptRef.current = 0;
      syncedRoomForHostRef.current.clear();
      peersRef.current = [];
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
    syncedRoomForHostRef.current.clear();
    peersRef.current = [];
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

      const queueForRetry = () => {
        if (!outgoingQueueRef.current.some((q) => q.id === msgId)) {
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
        }
      };

      try {
        const aesKey = await getConversationKey(target.type, target.id);
        if (!aesKey || !isSocketOpen()) {
          queueForRetry();
          return;
        }

        const encryptedPayload = await encryptTextAsync(aesKey, trimmed);
        const sent = await sendJsonReliable({
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

        if (!sent) {
          queueForRetry();
        }
      } catch {
        queueForRetry();
      }
    },
    [
      appendMessageIdempotent,
      getConversationKey,
      isSocketOpen,
      sendJsonReliable,
      verifiedPeers,
      verifiedRooms,
    ]
  );

  const sendFiles = useCallback(
    async (target: ChatTarget, files: File[]) => {
      if (!identityRef.current || files.length === 0) return;
      const aesKey = await getConversationKey(target.type, target.id);
      if (!aesKey || !isSocketOpen()) return;

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

          if (!isSocketOpen()) {
            await updateFileMessage(transferId, (m) => ({
              ...m,
              file: m.file
                ? { ...m.file, status: 'failed', errorMessage: 'Koneksi Wi-Fi terputus' }
                : undefined,
            }));
            break;
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

          const chunkSent = await sendBinaryReliable(packet.buffer);
          if (!chunkSent) {
            await updateFileMessage(transferId, (m) => ({
              ...m,
              file: m.file
                ? { ...m.file, status: 'failed', errorMessage: 'Gagal mengirim blok file' }
                : undefined,
            }));
            break;
          }
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

  const startCall = useCallback(
    async (peerId: string, callType: CallType) => {
      if (!identityRef.current) return;
      if (callSessionRef.current && callSessionRef.current.status !== 'ended') return;
      const peer = peersRef.current.find((p) => p.peerId === peerId);
      if (!peer) return;
      if (!isSocketOpen()) return;

      await ensureDmKey(peer);
      if (callEndedTimerRef.current) {
        window.clearTimeout(callEndedTimerRef.current);
        callEndedTimerRef.current = null;
      }

      const callId = `call-${randomUuid()}`;
      setCallSession({
        callId,
        callType,
        status: 'outgoing',
        direction: 'outgoing',
        peerId: peer.peerId,
        peerName: peer.displayName,
        peerDeviceLabel: peer.deviceLabel,
        transportMode: 'webrtc',
        audioMuted: false,
        videoMuted: false,
        remoteAudioMuted: false,
        remoteVideoMuted: false,
        speakerMuted: false,
        facingMode: 'user',
        connectedAt: null,
        minimized: false,
      });

      ringtone.startOutgoingRingback();

      const engine = ensureCallEngine();
      await engine.prepareMedia(callType);

      sendJsonRaw({
        type: 'call:invite',
        callId,
        targetPeerId: peer.peerId,
        callType,
        callerName: identityRef.current.displayName,
      });

      if (callRingTimeoutRef.current) window.clearTimeout(callRingTimeoutRef.current);
      callRingTimeoutRef.current = window.setTimeout(async () => {
        const curr = callSessionRef.current;
        if (curr && curr.callId === callId && curr.status === 'outgoing') {
          sendJsonRaw({
            type: 'call:cancel',
            callId,
            targetPeerId: curr.peerId,
            reason: 'timeout',
          });
          ringtone.playEndChime();
          await finalizeCallCleanup('Tidak dijawab', true);
        }
      }, 40000);
    },
    [ensureCallEngine, ensureDmKey, finalizeCallCleanup, sendJsonRaw]
  );

  const acceptCall = useCallback(async () => {
    const current = callSessionRef.current;
    if (!current || current.status !== 'incoming' || !identityRef.current) return;

    ringtone.stop();
    const peer = peersRef.current.find((p) => p.peerId === current.peerId);
    if (peer) {
      await ensureDmKey(peer);
    }

    setCallSession((prev) =>
      prev
        ? {
            ...prev,
            status: 'active',
            connectedAt: Date.now(),
          }
        : prev
    );

    const engine = ensureCallEngine();
    await engine.startSession({
      callId: current.callId,
      selfPeerId: identityRef.current.peerId,
      remotePeerId: current.peerId,
      callType: current.callType,
      isCaller: false,
    });

    sendJsonRaw({
      type: 'call:accept',
      callId: current.callId,
      targetPeerId: current.peerId,
    });
  }, [ensureCallEngine, ensureDmKey, sendJsonRaw]);

  const rejectCall = useCallback(async () => {
    const current = callSessionRef.current;
    if (!current) return;
    sendJsonRaw({
      type: 'call:reject',
      callId: current.callId,
      targetPeerId: current.peerId,
      reason: 'rejected',
    });
    ringtone.playEndChime();
    await finalizeCallCleanup('Ditolak', true);
  }, [finalizeCallCleanup, sendJsonRaw]);

  const hangupCall = useCallback(async () => {
    const current = callSessionRef.current;
    if (!current) return;
    const msgType = current.status === 'outgoing' ? 'call:cancel' : 'call:hangup';
    sendJsonRaw({
      type: msgType,
      callId: current.callId,
      targetPeerId: current.peerId,
      reason: 'ended_by_user',
    });
    ringtone.playEndChime();
    await finalizeCallCleanup(
      current.status === 'outgoing' ? 'Dibatalkan' : 'Panggilan selesai',
      true
    );
  }, [finalizeCallCleanup, sendJsonRaw]);

  const toggleCallAudioMute = useCallback(() => {
    const muted = callEngineRef.current?.toggleAudioMute() ?? false;
    setCallSession((prev) => (prev ? { ...prev, audioMuted: muted } : prev));
  }, []);

  const toggleCallVideoMute = useCallback(() => {
    const muted = callEngineRef.current?.toggleVideoMute() ?? false;
    setCallSession((prev) => (prev ? { ...prev, videoMuted: muted } : prev));
  }, []);

  const toggleCallSpeakerMute = useCallback(() => {
    const muted = callEngineRef.current?.toggleSpeakerMute() ?? false;
    setCallSession((prev) => (prev ? { ...prev, speakerMuted: muted } : prev));
  }, []);

  const switchCallCamera = useCallback(async () => {
    if (!callEngineRef.current) return;
    const facingMode = await callEngineRef.current.switchCamera();
    setCallSession((prev) => (prev ? { ...prev, facingMode } : prev));
  }, []);

  const toggleCallMinimized = useCallback(() => {
    setCallSession((prev) => (prev ? { ...prev, minimized: !prev.minimized } : prev));
  }, []);

  const setCallRemoteCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    callRemoteCanvasRef.current = canvas;
    callEngineRef.current?.setRemoteCanvas(canvas);
  }, []);

  const forceRustCallRelay = useCallback(() => {
    callEngineRef.current?.activateRustRelayFallback(
      'Mode Tunnel Rust E2EE aktif (ADPCM 4:1)'
    );
  }, []);

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
    probeHost,
    switchHostUrl,
    resetHostToLocal,
    callSession,
    localCallStream,
    remoteCallStream,
    callAudioLevels,
    rustCallCapabilities,
    startCall,
    acceptCall,
    rejectCall,
    hangupCall,
    toggleCallAudioMute,
    toggleCallVideoMute,
    toggleCallSpeakerMute,
    switchCallCamera,
    toggleCallMinimized,
    setCallRemoteCanvas,
    forceRustCallRelay,
  };
}
