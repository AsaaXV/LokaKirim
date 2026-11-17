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
  buildApiUrl,
  buildNetworkInfoUrl,
  buildWsEndpoint,
  getPrimaryHostUrl,
  getSavedHostUrl,
  loadSavedHostConfigs,
  LOCAL_HOST_KEY,
  LOCAL_RUST_HOST_URL,
  makeRemoteHostKey,
  makeScopedRoomTargetId,
  normalizeHostUrl,
  parseScopedRoomTargetId,
  saveHostConfigs,
  saveHostUrl,
} from '../lib/hostConfig';
import {
  getRustLanInfo,
  isTauriRuntime,
  rustAddBridge,
  rustGetCallCapabilities,
  rustGetHostConfig,
  rustGetPacketTraces,
  rustListBridges,
  rustLogPacketTrace,
  rustProbeHost,
  rustRemoveBridge,
  rustSetHostConfig,
  rustWsConnect,
  rustWsDisconnect,
  rustWsSendBinary,
  rustWsSendText,
  subscribeRustWsEvents,
  type RustCallCapabilitiesDto,
  type RustHostProbeResultDto,
  type RustPacketTraceEntryDto,
} from '../lib/tauriBridge';
import {
  err,
  ok,
  PacketErrorCode,
  PacketTracer,
  TraceTarget,
  type PacketResult,
  type PacketTraceEntry,
} from '../lib/packetTracer';
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
  loadOutgoingQueue,
  loadVerifiedPeers,
  loadVerifiedRooms,
  removeOutgoingQueueItem,
  removeVerifiedPeer,
  removeVerifiedRoom,
  saveCachedRooms,
  saveDeviceIdentity,
  saveFileBlob,
  saveMessageRecord,
  saveOutgoingQueueItem,
  saveRoomKeyRecord,
  saveVerifiedPeer,
  saveVerifiedRoom,
  type QueuedOutgoingMessage,
} from '../lib/storage';
import type {
  CallSessionState,
  CallTransportMode,
  CallType,
  ChatMessageRecord,
  ChatTarget,
  ConnectionQuality,
  EncryptedPayload,
  HostBridgeInfo,
  HostConfigInfo,
  HostConnectionConfig,
  HostConnectionRuntime,
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
  const isTauriApp = useMemo(() => isTauriRuntime(), []);

  const [identity, setIdentity] = useState<StoredDeviceIdentity | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  const [savedHosts, setSavedHosts] = useState<HostConnectionConfig[]>(() =>
    loadSavedHostConfigs(isTauriApp)
  );
  const [hostRuntimes, setHostRuntimes] = useState<HostConnectionRuntime[]>(() =>
    loadSavedHostConfigs(isTauriApp).map((cfg) => ({
      key: cfg.key,
      url: cfg.url,
      label: cfg.label,
      status: cfg.enabled ? 'reconnecting' : 'disabled',
      latencyMs: null,
      peersOnline: 0,
      enabled: cfg.enabled,
      isLocal: Boolean(cfg.isLocal),
    }))
  );
  const [localHostConfig, setLocalHostConfig] = useState<HostConfigInfo | null>(null);
  const [hostBridges, setHostBridges] = useState<HostBridgeInfo[]>([]);

  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [rooms, setRooms] = useState<RoomInfo[]>([
    {
      roomId: DEFAULT_ROOM_ID,
      wireRoomId: DEFAULT_ROOM_ID,
      routeHostKey: LOCAL_HOST_KEY,
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
  const [packetTraces, setPacketTraces] = useState<PacketTraceEntry[]>([]);
  const [lastSyncFailure, setLastSyncFailure] = useState<PacketTraceEntry | null>(null);

  // Multi-host socket & data maps keyed by hostKey
  const savedHostsRef = useRef<HostConnectionConfig[]>(savedHosts);
  const hostRuntimesRef = useRef<HostConnectionRuntime[]>(hostRuntimes);
  const wsMapRef = useRef<Map<string, WebSocket>>(new Map());
  const rustWsConnectedMapRef = useRef<Map<string, boolean>>(new Map());
  const rustActiveConnIdMapRef = useRef<Map<string, number>>(new Map());
  const rustClientConnSeqRef = useRef<number>(0);
  const authRejectedHostsRef = useRef<Set<string>>(new Set());
  const peersByHostRef = useRef<Map<string, PeerInfo[]>>(new Map());
  const roomsByHostRef = useRef<Map<string, RoomInfo[]>>(new Map());
  const reconnectTimersRef = useRef<Map<string, number>>(new Map());
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map());
  const lastPingSentByHostRef = useRef<Map<string, number>>(new Map());
  const hostMetaByKeyRef = useRef<Map<string, { hostId?: string; hostLabel?: string }>>(new Map());

  const hostUrlRef = useRef<string>(hostUrl);
  const fileUrlsRef = useRef<Record<string, string>>({});
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
        hostKey: string;
        wireTargetId: string;
      }
    >
  >(new Map());
  const incomingTransfersRef = useRef<Map<string, IncomingTransferState>>(new Map());
  const cancelledTransfersRef = useRef<Set<string>>(new Set());
  const outgoingQueueRef = useRef<QueuedOutgoingMessage[]>([]);
  const pingIntervalRef = useRef<number | null>(null);
  const queueSweepTimerRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  const tracerRef = useRef<PacketTracer | null>(null);
  const connectHostFnRef = useRef<((cfg: HostConnectionConfig) => void) | null>(null);

  if (!tracerRef.current) {
    tracerRef.current = new PacketTracer({
      onRustForward: (entry) => {
        if (!isTauriApp) return;
        const fieldPairs = entry.fields
          ? Object.entries(entry.fields)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => `${k}=${String(v)}`)
          : [];
        const details = [
          entry.errorCode ? `err=${entry.errorCode}` : null,
          entry.elapsedMs !== undefined ? `elapsed_ms=${entry.elapsedMs}` : null,
          ...fieldPairs,
        ]
          .filter(Boolean)
          .join(' ');
        void rustLogPacketTrace({
          level: entry.level,
          target: entry.target,
          event: entry.event,
          msgId: entry.msgId,
          convId: entry.convId,
          details,
        }).catch(() => {});
      },
      onUpdate: (entries, failure) => {
        if (unmountedRef.current) return;
        setPacketTraces(entries);
        setLastSyncFailure(failure);
      },
    });
  }

  useEffect(() => {
    savedHostsRef.current = savedHosts;
  }, [savedHosts]);

  useEffect(() => {
    hostRuntimesRef.current = hostRuntimes;
  }, [hostRuntimes]);

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
    fileUrlsRef.current = fileUrls;
  }, [fileUrls]);

  useEffect(() => {
    if (isTauriApp) {
      rustGetCallCapabilities()
        .then((caps) => setRustCallCapabilities(caps))
        .catch(() => {});
    }
    const debugHandle = {
      getReport: (limit = 60) => tracerRef.current?.formatReport(limit) || '',
      getEntries: () => tracerRef.current?.snapshot() || [],
      getLastFailure: () => tracerRef.current?.getLastFailure() || null,
      getRustEntries: async () => (isTauriApp ? rustGetPacketTraces() : []),
      clear: () => tracerRef.current?.clear(),
    };
    const win = window as unknown as Record<string, unknown>;
    win.__LOKAKIRIM_TRACE__ = debugHandle;

    return () => {
      ringtone.stop();
      if (callRingTimeoutRef.current) window.clearTimeout(callRingTimeoutRef.current);
      if (callEndedTimerRef.current) window.clearTimeout(callEndedTimerRef.current);
      callEngineRef.current?.destroy();
      tracerRef.current?.destroy();
      for (const u of Object.values(fileUrlsRef.current)) {
        try {
          URL.revokeObjectURL(u);
        } catch {
          // ignore
        }
      }
      if (win.__LOKAKIRIM_TRACE__ === debugHandle) {
        delete win.__LOKAKIRIM_TRACE__;
      }
    };
  }, [isTauriApp]);

  const refreshLanInfo = useCallback(async () => {
    const activeHost = getPrimaryHostUrl(isTauriApp);
    if (isTauriApp) {
      try {
        const rustInfo = await getRustLanInfo();
        setLanInfo(rustInfo);
        return;
      } catch {
        // Fallback to HTTP endpoint below
      }
    }
    try {
      const res = await fetch(buildNetworkInfoUrl(isTauriApp ? activeHost : ''));
      if (res.ok) {
        const data = (await res.json()) as LanNetworkInfo;
        setLanInfo(data);
      }
    } catch {
      // Ignore if temporarily offline
    }
  }, [isTauriApp]);

  const refreshHostManagement = useCallback(async () => {
    if (isTauriApp) {
      try {
        const [cfg, bridges] = await Promise.all([rustGetHostConfig(), rustListBridges()]);
        setLocalHostConfig(cfg);
        setHostBridges(bridges);
        return;
      } catch {
        // Fallback HTTP if needed
      }
    }
    try {
      const [cfgRes, brRes] = await Promise.all([
        fetch(buildApiUrl('', '/api/host-config')),
        fetch(buildApiUrl('', '/api/bridges')),
      ]);
      if (cfgRes.ok) {
        const cfg = (await cfgRes.json()) as HostConfigInfo;
        setLocalHostConfig(cfg);
      }
      if (brRes.ok) {
        const bridges = (await brRes.json()) as HostBridgeInfo[];
        setHostBridges(bridges);
      }
    } catch {
      // ignore if offline
    }
  }, [isTauriApp]);

  const updateHostRuntime = useCallback(
    (
      hostKey: string,
      updater: (prev: HostConnectionRuntime) => HostConnectionRuntime
    ) => {
      setHostRuntimes((prev) => {
        const idx = prev.findIndex((r) => r.key === hostKey);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = updater(prev[idx]);
        hostRuntimesRef.current = next;
        return next;
      });
    },
    []
  );

  // Sync top-level NetworkTelemetry whenever hostRuntimes changes
  useEffect(() => {
    const enabledRuntimes = hostRuntimes.filter((r) => r.enabled);
    const connectedOnes = enabledRuntimes.filter(
      (r) => r.status === 'connected' || r.status === 'degraded'
    );

    let overallQuality: ConnectionQuality = 'disconnected';
    if (connectedOnes.some((r) => r.status === 'connected')) {
      overallQuality = 'connected';
    } else if (connectedOnes.some((r) => r.status === 'degraded')) {
      overallQuality = 'degraded';
    } else if (enabledRuntimes.some((r) => r.status === 'reconnecting')) {
      overallQuality = 'reconnecting';
    }

    const activeEndpoints = connectedOnes
      .map((r) => r.hostLabel || r.label || r.url)
      .filter(Boolean);
    const endpointLabel =
      activeEndpoints.length > 1
        ? `${activeEndpoints.length} Host Aktif (${activeEndpoints.join(', ')})`
        : connectedOnes[0]?.url || enabledRuntimes[0]?.url || '';

    setTelemetry((prev) => ({
      ...prev,
      quality: overallQuality,
      wsEndpoint: endpointLabel,
    }));
  }, [hostRuntimes]);

  // Recompute unified deduplicated peers + scoped rooms across all connected hosts
  const recomputeUnifiedTopology = useCallback(() => {
    const selfId = identityRef.current?.peerId;
    const orderedHosts = [...savedHostsRef.current].sort((a, b) =>
      a.key === LOCAL_HOST_KEY ? -1 : b.key === LOCAL_HOST_KEY ? 1 : 0
    );

    const bestPeers = new Map<string, PeerInfo>();
    for (const h of orderedHosts) {
      if (!h.enabled) continue;
      const hostPeers = peersByHostRef.current.get(h.key) || [];
      const meta = hostMetaByKeyRef.current.get(h.key);
      const rtLabel = meta?.hostLabel || h.label;

      for (const p of hostPeers) {
        if (!p.peerId) continue;
        const hops = p.hops ?? 0;
        const existing = bestPeers.get(p.peerId);
        const shouldReplace =
          !existing ||
          hops < (existing.hops ?? 99) ||
          (hops === (existing.hops ?? 99) &&
            h.key === LOCAL_HOST_KEY &&
            existing.routeHostKey !== LOCAL_HOST_KEY);

        if (shouldReplace) {
          const viaLabel =
            hops > 0
              ? p.originHostLabel
                ? `${p.originHostLabel} · via ${rtLabel}`
                : `via ${rtLabel}`
              : undefined;
          bestPeers.set(p.peerId, {
            ...p,
            hops,
            routeHostKey: h.key,
            routeHostLabel: rtLabel,
            viaBridgeLabel: viaLabel,
          });
        }
      }
    }

    const unifiedPeers = Array.from(bestPeers.values());
    peersRef.current = unifiedPeers;
    setPeers(unifiedPeers);

    // Build unified rooms list
    const multiHostActive = orderedHosts.filter((h) => h.enabled).length > 1;
    const unifiedRooms: RoomInfo[] = [];
    const seenIds = new Set<string>();

    for (const h of orderedHosts) {
      if (!h.enabled) continue;
      const hostRooms = roomsByHostRef.current.get(h.key) || [];
      const meta = hostMetaByKeyRef.current.get(h.key);
      const rtLabel = meta?.hostLabel || h.label;

      for (const r of hostRooms) {
        const scopedId = makeScopedRoomTargetId(h.key, r.roomId);
        if (seenIds.has(scopedId)) continue;
        seenIds.add(scopedId);

        const displayName =
          r.isDefault && h.key !== LOCAL_HOST_KEY && multiHostActive
            ? `${r.name} · ${rtLabel}`
            : r.name;

        unifiedRooms.push({
          ...r,
          roomId: scopedId,
          wireRoomId: r.roomId,
          name: displayName,
          routeHostKey: h.key,
          routeHostLabel: rtLabel,
          originHostId: r.originHostId || meta?.hostId,
          originHostLabel: r.originHostLabel || rtLabel,
        });
      }
    }

    if (unifiedRooms.length === 0) {
      unifiedRooms.push({
        roomId: DEFAULT_ROOM_ID,
        wireRoomId: DEFAULT_ROOM_ID,
        routeHostKey: LOCAL_HOST_KEY,
        name: 'Ruang Utama Wi-Fi',
        createdBy: selfId || 'system',
        createdAt: Date.now(),
        isDefault: true,
        memberIds: selfId ? [selfId] : [],
      });
    }

    roomsRef.current = unifiedRooms;
    setRooms(unifiedRooms);
    void saveCachedRooms(unifiedRooms);
  }, []);

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

  const ensureRoomKeyLocal = useCallback(async (scopedRoomId: string) => {
    const existing = roomKeysRef.current.get(scopedRoomId);
    if (existing) return existing;
    const created = await generateRoomKeyAsync();
    const entry = {
      aesKey: created.keyBytes,
      rawBase64: created.rawBase64,
      safetyCode: created.safetyCode,
    };
    roomKeysRef.current.set(scopedRoomId, entry);
    await saveRoomKeyRecord(scopedRoomId, created.rawBase64, created.safetyCode);
    setRoomSafetyCodes((prev) => ({ ...prev, [scopedRoomId]: created.safetyCode }));
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

  const isHostSocketOpen = useCallback(
    (hostKey: string): boolean => {
      if (isTauriApp) {
        return Boolean(rustWsConnectedMapRef.current.get(hostKey));
      }
      const ws = wsMapRef.current.get(hostKey);
      return Boolean(ws && ws.readyState === WebSocket.OPEN);
    },
    [isTauriApp]
  );

  const getFallbackConnectedHostKey = useCallback((): string => {
    if (isHostSocketOpen(LOCAL_HOST_KEY)) return LOCAL_HOST_KEY;
    for (const h of savedHostsRef.current) {
      if (h.enabled && isHostSocketOpen(h.key)) return h.key;
    }
    return savedHostsRef.current.find((h) => h.enabled)?.key || LOCAL_HOST_KEY;
  }, [isHostSocketOpen]);

  const isAnySocketOpen = useCallback((): boolean => {
    for (const h of savedHostsRef.current) {
      if (h.enabled && isHostSocketOpen(h.key)) return true;
    }
    return false;
  }, [isHostSocketOpen]);

  const resolvePeerHostKey = useCallback(
    (peerId: string): string => {
      const p = peersRef.current.find((item) => item.peerId === peerId);
      if (p?.routeHostKey && isHostSocketOpen(p.routeHostKey)) {
        return p.routeHostKey;
      }
      if (p?.routeHostKey) return p.routeHostKey;
      return getFallbackConnectedHostKey();
    },
    [getFallbackConnectedHostKey, isHostSocketOpen]
  );

  const sendJsonRawToHost = useCallback(
    (hostKey: string, payload: unknown): boolean => {
      const encoded = JSON.stringify(payload);
      if (isTauriApp) {
        if (!rustWsConnectedMapRef.current.get(hostKey)) return false;
        void rustWsSendText(hostKey, encoded).catch(() => {});
        return true;
      }
      const ws = wsMapRef.current.get(hostKey);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoded);
        return true;
      }
      return false;
    },
    [isTauriApp]
  );

  const sendJsonReliableToHost = useCallback(
    async (hostKey: string, payload: unknown): Promise<boolean> => {
      const encoded = JSON.stringify(payload);
      if (isTauriApp) {
        if (!rustWsConnectedMapRef.current.get(hostKey)) return false;
        try {
          return await rustWsSendText(hostKey, encoded);
        } catch (ipcErr) {
          tracerRef.current?.error(
            TraceTarget.TransportRustWs,
            'rust_ipc_send_text_failed',
            PacketErrorCode.RustIpcError,
            {
              host_key: hostKey,
              bytes: encoded.length,
              err_msg: ipcErr instanceof Error ? ipcErr.message : String(ipcErr),
            }
          );
          return false;
        }
      }
      const ws = wsMapRef.current.get(hostKey);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(encoded);
          return true;
        } catch (wsErr) {
          tracerRef.current?.error(
            TraceTarget.TransportBrowserWs,
            'browser_ws_send_failed',
            PacketErrorCode.SendRejected,
            {
              host_key: hostKey,
              bytes: encoded.length,
              err_msg: wsErr instanceof Error ? wsErr.message : String(wsErr),
            }
          );
          return false;
        }
      }
      return false;
    },
    [isTauriApp]
  );

  const sendBinaryRawToHost = useCallback(
    (hostKey: string, packet: ArrayBuffer): boolean => {
      if (isTauriApp) {
        if (!rustWsConnectedMapRef.current.get(hostKey)) return false;
        const b64 = bytesToBase64(new Uint8Array(packet));
        void rustWsSendBinary(hostKey, b64).catch(() => {});
        return true;
      }
      const ws = wsMapRef.current.get(hostKey);
      if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512 * 1024) {
        ws.send(packet);
        return true;
      }
      return false;
    },
    [isTauriApp]
  );

  const sendBinaryReliableToHost = useCallback(
    async (hostKey: string, packet: ArrayBuffer): Promise<boolean> => {
      if (isTauriApp) {
        if (!rustWsConnectedMapRef.current.get(hostKey)) return false;
        try {
          const b64 = bytesToBase64(new Uint8Array(packet));
          return await rustWsSendBinary(hostKey, b64);
        } catch {
          return false;
        }
      }
      const ws = wsMapRef.current.get(hostKey);
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

  const resolveConversationKeyResult = useCallback(
    async (
      conversationType: 'room' | 'dm',
      peerOrRoomId: string,
      msgId?: string
    ): Promise<PacketResult<Uint8Array>> => {
      const convId = makeConversationId(conversationType, peerOrRoomId);
      const aesKey = await getConversationKey(conversationType, peerOrRoomId);
      if (!aesKey) {
        const onlinePeerIds = peersRef.current
          .filter((p) => p.online)
          .map((p) => p.peerId)
          .slice(0, 5)
          .join(',');
        const failure = {
          code: PacketErrorCode.KeyMissing,
          message:
            conversationType === 'dm'
              ? `Peer key unavailable for DM target ${peerOrRoomId}`
              : `Room AES key unavailable for ${peerOrRoomId}`,
          fields: {
            conv_type: conversationType,
            target_id: peerOrRoomId,
            peers_online: peersRef.current.length,
            online_peers: onlinePeerIds || 'none',
          },
        };
        tracerRef.current?.warn(
          TraceTarget.SyncKey,
          'conversation_key_missing',
          failure.code,
          failure.fields,
          { msgId, convId }
        );
        return err(failure);
      }
      return ok(aesKey);
    },
    [getConversationKey]
  );

  const ensureCallEngine = useCallback(() => {
    if (callEngineRef.current) return callEngineRef.current;
    const engine = new CallMediaEngine({
      sendJson: (payload: unknown) => {
        const obj = (payload || {}) as Record<string, unknown>;
        const targetPeerId = String(
          obj.targetPeerId || callSessionRef.current?.peerId || ''
        ).trim();
        const hostKey = targetPeerId
          ? resolvePeerHostKey(targetPeerId)
          : getFallbackConnectedHostKey();
        return sendJsonRawToHost(hostKey, payload);
      },
      sendBinary: (packet: ArrayBuffer) => {
        let targetPeerId = callSessionRef.current?.peerId || '';
        if (!targetPeerId && packet.byteLength >= 8) {
          try {
            const view = new DataView(packet);
            const hLen = view.getUint32(0, false);
            if (hLen > 0 && hLen <= 16384 && packet.byteLength >= 4 + hLen) {
              const header = JSON.parse(
                new TextDecoder().decode(new Uint8Array(packet, 4, hLen))
              ) as { targetId?: string };
              if (header.targetId) targetPeerId = header.targetId;
            }
          } catch {
            // ignore
          }
        }
        const hostKey = targetPeerId
          ? resolvePeerHostKey(targetPeerId)
          : getFallbackConnectedHostKey();
        return sendBinaryRawToHost(hostKey, packet);
      },
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
  }, [
    getConversationKey,
    getFallbackConnectedHostKey,
    resolvePeerHostKey,
    sendBinaryRawToHost,
    sendJsonRawToHost,
  ]);

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
    if (!isAnySocketOpen()) return;
    if (outgoingQueueRef.current.length === 0) return;

    const transport = isTauriApp ? 'rust-ws' : 'browser-ws';
    tracerRef.current?.info(TraceTarget.SyncQueue, 'queue_flush_begin', {
      queued_count: outgoingQueueRef.current.length,
      transport,
      peers_online: peersRef.current.length,
    });

    const remaining: typeof outgoingQueueRef.current = [];
    let sentCount = 0;

    for (const item of outgoingQueueRef.current) {
      const convId = makeConversationId(item.conversationType, item.targetId);
      const routeInfo =
        item.conversationType === 'room'
          ? parseScopedRoomTargetId(item.targetId)
          : {
              hostKey: item.hostKey || resolvePeerHostKey(item.targetId),
              wireRoomId: item.targetId,
            };

      if (!isHostSocketOpen(routeInfo.hostKey)) {
        remaining.push(item);
        continue;
      }

      try {
        const keyRes = await resolveConversationKeyResult(
          item.conversationType,
          item.targetId,
          item.id
        );
        if (!keyRes.ok) {
          remaining.push(item);
          continue;
        }
        const encStarted = performance.now();
        const encryptedPayload = await encryptTextAsync(keyRes.value, item.text);
        const encElapsed = Math.round(performance.now() - encStarted);
        const sent = await sendJsonReliableToHost(routeInfo.hostKey, {
          type: 'chat:message',
          id: item.id,
          conversationType: item.conversationType,
          targetId: routeInfo.wireRoomId,
          senderName: identityRef.current.displayName,
          timestamp: item.timestamp,
          encryptedPayload,
          verifiedAtSend: true,
        });

        if (!sent) {
          tracerRef.current?.warn(
            TraceTarget.SyncQueue,
            'queued_packet_send_rejected',
            PacketErrorCode.SendRejected,
            {
              transport,
              host_key: routeInfo.hostKey,
              enc_ms: encElapsed,
            },
            { msgId: item.id, convId }
          );
          remaining.push(item);
        } else {
          sentCount += 1;
          void removeOutgoingQueueItem(item.id).catch(() => {});
          tracerRef.current?.info(
            TraceTarget.SyncQueue,
            'queued_packet_dispatched',
            {
              transport,
              host_key: routeInfo.hostKey,
              enc_ms: encElapsed,
            },
            { msgId: item.id, convId }
          );
        }
      } catch (flushErr) {
        tracerRef.current?.error(
          TraceTarget.SyncEncrypt,
          'queued_packet_encrypt_failed',
          PacketErrorCode.EncryptFailed,
          {
            err_msg: flushErr instanceof Error ? flushErr.message : String(flushErr),
          },
          { msgId: item.id, convId }
        );
        remaining.push(item);
      }
    }

    outgoingQueueRef.current = remaining;
    setTelemetry((prev) => ({ ...prev, queuedCount: remaining.length }));
    tracerRef.current?.info(TraceTarget.SyncQueue, 'queue_flush_done', {
      sent_count: sentCount,
      remaining_count: remaining.length,
    });
  }, [
    isAnySocketOpen,
    isHostSocketOpen,
    isTauriApp,
    resolveConversationKeyResult,
    resolvePeerHostKey,
    sendJsonReliableToHost,
  ]);

  const handleIncomingBinaryChunk = useCallback(
    async (hostKey: string, arrayBuffer: ArrayBuffer) => {
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
        header.conversationType === 'dm'
          ? header.senderId
          : makeScopedRoomTargetId(hostKey, header.targetId);
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

  // Bootstrap persistent state
  useEffect(() => {
    unmountedRef.current = false;

    async function bootstrap() {
      const [storedId, storedMessages, storedRoomKeys, storedRooms, vPeers, vRooms, storedQueue] =
        await Promise.all([
          loadDeviceIdentity(),
          loadAllMessages(),
          loadAllRoomKeyRecords(),
          loadCachedRooms(),
          loadVerifiedPeers(),
          loadVerifiedRooms(),
          loadOutgoingQueue(),
        ]);

      if (unmountedRef.current) return;

      outgoingQueueRef.current = storedQueue;
      if (storedQueue.length > 0) {
        setTelemetry((prev) => ({ ...prev, queuedCount: storedQueue.length }));
      }

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

      fileUrlsRef.current = urls;
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
      void refreshLanInfo();
      void refreshHostManagement();
    }

    void bootstrap();

    return () => {
      unmountedRef.current = true;
    };
  }, [refreshHostManagement, refreshLanInfo]);

  // Multi-Host WebSocket orchestrator
  useEffect(() => {
    if (!identityReady || !identity) return;

    let cancelled = false;
    let unlistenRustWs: (() => void) | null = null;

    const retryDecryptRoomMessages = async (scopedRoomId: string, aesKey: Uint8Array) => {
      const entries = Array.from(undecryptedPayloadsRef.current.entries());
      for (const [msgId, info] of entries) {
        if (info.conversationType !== 'room' || info.convTargetId !== scopedRoomId) continue;
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

    const transportTarget = isTauriApp
      ? TraceTarget.TransportRustWs
      : TraceTarget.TransportBrowserWs;

    const handleSocketOpen = (hostKey: string, wsUrl: string) => {
      if (cancelled) return;
      reconnectAttemptsRef.current.set(hostKey, 0);
      authRejectedHostsRef.current.delete(hostKey);

      const hostCfg = savedHostsRef.current.find((h) => h.key === hostKey);

      tracerRef.current?.info(transportTarget, 'socket_open_sending_hello', {
        host_key: hostKey,
        ws_url: wsUrl,
        peer_id: identity.peerId,
        queued_count: outgoingQueueRef.current.length,
      });

      void sendJsonReliableToHost(hostKey, {
        type: 'hello',
        peerId: identity.peerId,
        displayName: identity.displayName,
        deviceLabel: detectDeviceLabel(),
        publicKeyHex: identity.publicKeyHex,
        accessCode: hostCfg?.accessCode || undefined,
      });

      updateHostRuntime(hostKey, (prev) => ({
        ...prev,
        status: 'connected',
        errorMessage: undefined,
      }));
    };

    const handleSocketClose = (hostKey: string, reason = 'closed') => {
      if (isTauriApp) {
        rustWsConnectedMapRef.current.set(hostKey, false);
      } else {
        wsMapRef.current.delete(hostKey);
      }

      if (cancelled || unmountedRef.current) return;

      // Remove peers from this host while disconnected
      peersByHostRef.current.delete(hostKey);
      recomputeUnifiedTopology();

      const hostCfg = savedHostsRef.current.find((h) => h.key === hostKey);
      if (!hostCfg || !hostCfg.enabled) {
        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          status: 'disabled',
          latencyMs: null,
          peersOnline: 0,
        }));
        return;
      }

      if (authRejectedHostsRef.current.has(hostKey)) {
        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          status: 'auth_error',
          latencyMs: null,
        }));
        return;
      }

      const prevTimer = reconnectTimersRef.current.get(hostKey);
      if (prevTimer) window.clearTimeout(prevTimer);

      const attempt = (reconnectAttemptsRef.current.get(hostKey) || 0) + 1;
      reconnectAttemptsRef.current.set(hostKey, attempt);
      const delay = Math.min(8000, 1000 * Math.pow(2, attempt - 1));

      tracerRef.current?.warn(
        transportTarget,
        'socket_disconnected_scheduling_reconnect',
        PacketErrorCode.SocketClosed,
        {
          host_key: hostKey,
          attempt,
          delay_ms: delay,
          reason,
        }
      );

      updateHostRuntime(hostKey, (prev) => ({
        ...prev,
        status: 'reconnecting',
        latencyMs: null,
      }));

      const timer = window.setTimeout(() => {
        const latestCfg = savedHostsRef.current.find((h) => h.key === hostKey);
        if (!cancelled && latestCfg && latestCfg.enabled && !authRejectedHostsRef.current.has(hostKey)) {
          connectHost(latestCfg);
        }
      }, delay);
      reconnectTimersRef.current.set(hostKey, timer);
    };

    const handleIncomingJsonText = async (hostKey: string, rawText: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawText);
      } catch {
        return;
      }

      const type = msg.type as string;

      if (type === 'auth:rejected') {
        const reason = String(msg.reason || 'Kode akses host diperlukan atau tidak cocok');
        authRejectedHostsRef.current.add(hostKey);
        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          status: 'auth_error',
          hostId: msg.hostId ? String(msg.hostId) : prev.hostId,
          hostLabel: msg.hostLabel ? String(msg.hostLabel) : prev.hostLabel,
          errorMessage: reason,
          latencyMs: null,
        }));
        tracerRef.current?.warn(
          transportTarget,
          'host_auth_rejected',
          PacketErrorCode.SendRejected,
          { host_key: hostKey, reason }
        );
        return;
      }

      if (type === 'pong') {
        const clientTs = Number(msg.clientTs);
        const rtt = Math.max(1, Math.round(performance.now() - clientTs));
        lastPingSentByHostRef.current.delete(hostKey);

        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          status: rtt >= 150 ? 'degraded' : 'connected',
          latencyMs: rtt,
          errorMessage: undefined,
        }));

        // Update sparkline from primary / best host
        const isPrimaryHost =
          hostKey === LOCAL_HOST_KEY || !isHostSocketOpen(LOCAL_HOST_KEY);
        if (isPrimaryHost) {
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
            return {
              ...prev,
              latencyMs: rtt,
              avgLatencyMs: avg,
              jitterMs: jitter,
              samples: nextSamples,
              lastPongAt: Date.now(),
            };
          });
        }
        return;
      }

      if (type === 'init') {
        const incomingPeers = (msg.peers as PeerInfo[]) || [];
        const incomingRooms = (msg.rooms as RoomInfo[]) || [];
        const serverHostId = msg.hostId ? String(msg.hostId) : undefined;
        const serverHostLabel = msg.hostLabel ? String(msg.hostLabel) : undefined;

        hostMetaByKeyRef.current.set(hostKey, {
          hostId: serverHostId,
          hostLabel: serverHostLabel,
        });

        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          status: 'connected',
          hostId: serverHostId || prev.hostId,
          hostLabel: serverHostLabel || prev.hostLabel,
          peersOnline: incomingPeers.filter((p) => p.peerId !== identity.peerId && p.online).length,
          errorMessage: undefined,
        }));

        peersByHostRef.current.set(hostKey, incomingPeers);
        roomsByHostRef.current.set(hostKey, incomingRooms);
        recomputeUnifiedTopology();

        tracerRef.current?.info(TraceTarget.SyncKey, 'host_init_synced', {
          host_key: hostKey,
          host_id: serverHostId || '-',
          peers_online: incomingPeers.filter((p) => p.online).length,
          rooms_count: incomingRooms.length,
        });

        // Rejoin custom rooms on this host
        const joinedWireRoomIds = new Set<string>();
        for (const r of incomingRooms) {
          if (r.roomId !== DEFAULT_ROOM_ID && r.memberIds.includes(identity.peerId)) {
            joinedWireRoomIds.add(r.roomId);
            void sendJsonReliableToHost(hostKey, { type: 'room:join', roomId: r.roomId });
          }
        }

        const activeRoute = parseScopedRoomTargetId(activeTargetRef.current.id);
        if (
          activeTargetRef.current.type === 'room' &&
          activeRoute.hostKey === hostKey &&
          activeRoute.wireRoomId !== DEFAULT_ROOM_ID &&
          !incomingRooms.some((r) => r.roomId === activeRoute.wireRoomId)
        ) {
          setActiveTarget({ type: 'room', id: DEFAULT_ROOM_ID });
        } else if (
          activeTargetRef.current.type === 'room' &&
          activeRoute.hostKey === hostKey &&
          !joinedWireRoomIds.has(activeRoute.wireRoomId)
        ) {
          void sendJsonReliableToHost(hostKey, {
            type: 'room:join',
            roomId: activeRoute.wireRoomId,
          });
        }

        for (const p of incomingPeers) {
          if (p.peerId !== identity.peerId) {
            await ensureDmKey(p);
          }
        }

        for (const r of incomingRooms) {
          const scopedRoomId = makeScopedRoomTargetId(hostKey, r.roomId);
          if (r.memberIds.includes(identity.peerId) || r.roomId === DEFAULT_ROOM_ID) {
            const syncMarker = `${hostKey}::${r.roomId}`;
            const otherOnlineMembers = r.memberIds.filter(
              (id) =>
                id !== identity.peerId &&
                incomingPeers.some((p) => p.peerId === id && p.online)
            );
            const hasKey = roomKeysRef.current.has(scopedRoomId);
            const alreadySyncedOnThisHost = syncedRoomForHostRef.current.has(syncMarker);

            if (otherOnlineMembers.length > 0 && (!hasKey || !alreadySyncedOnThisHost)) {
              const sortedOthers = [...otherOnlineMembers].sort();
              if (hasKey && identity.peerId < sortedOthers[0]) {
                const authoritative = roomKeysRef.current.get(scopedRoomId)!;
                syncedRoomForHostRef.current.add(syncMarker);
                tracerRef.current?.info(TraceTarget.SyncKey, 'room_key_authority_push', {
                  host_key: hostKey,
                  room_id: r.roomId,
                  peer_count: sortedOthers.length,
                  safety_code: authoritative.safetyCode,
                });
                for (const mId of sortedOthers) {
                  const memberPeer = incomingPeers.find((p) => p.peerId === mId);
                  if (!memberPeer) continue;
                  const dmEntry = await ensureDmKey(memberPeer);
                  if (!dmEntry) continue;
                  const wrapped = await encryptTextAsync(dmEntry.aesKey, authoritative.rawBase64);
                  void sendJsonReliableToHost(hostKey, {
                    type: 'room:key_share',
                    roomId: r.roomId,
                    targetPeerId: mId,
                    encryptedKeyPayload: wrapped,
                  });
                }
              } else {
                await sendJsonReliableToHost(hostKey, {
                  type: 'room:key_request',
                  roomId: r.roomId,
                });
                window.setTimeout(async () => {
                  if (!roomKeysRef.current.has(scopedRoomId)) {
                    const currentHostPeers = peersByHostRef.current.get(hostKey) || [];
                    const currentHostRoom = (roomsByHostRef.current.get(hostKey) || []).find(
                      (rm) => rm.roomId === r.roomId
                    );
                    const stillOthers =
                      currentHostRoom?.memberIds.filter(
                        (id) =>
                          id !== identity.peerId &&
                          currentHostPeers.some((p) => p.peerId === id && p.online)
                      ) || sortedOthers;
                    const allSorted = [identity.peerId, ...stillOthers].sort();
                    if (allSorted[0] === identity.peerId) {
                      const created = await ensureRoomKeyLocal(scopedRoomId);
                      syncedRoomForHostRef.current.add(syncMarker);
                      for (const mId of stillOthers) {
                        const memberPeer = currentHostPeers.find((p) => p.peerId === mId);
                        if (!memberPeer) continue;
                        const dmEntry = await ensureDmKey(memberPeer);
                        if (!dmEntry) continue;
                        const wrapped = await encryptTextAsync(dmEntry.aesKey, created.rawBase64);
                        void sendJsonReliableToHost(hostKey, {
                          type: 'room:key_share',
                          roomId: r.roomId,
                          targetPeerId: mId,
                          encryptedKeyPayload: wrapped,
                        });
                      }
                    }
                  }
                }, 1500);
              }
            } else if (!hasKey) {
              await ensureRoomKeyLocal(scopedRoomId);
              syncedRoomForHostRef.current.add(syncMarker);
            }
          }
        }

        if (hostKey === LOCAL_HOST_KEY) {
          void refreshHostManagement();
        }
        await flushQueuedMessages();
        return;
      }

      if (type === 'peer:joined' || type === 'peer:updated') {
        const peer = msg.peer as PeerInfo;
        const currentList = peersByHostRef.current.get(hostKey) || [];
        const nextList = currentList.some((p) => p.peerId === peer.peerId)
          ? currentList.map((p) => (p.peerId === peer.peerId ? peer : p))
          : [...currentList, peer];
        peersByHostRef.current.set(hostKey, nextList);
        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          peersOnline: nextList.filter((p) => p.peerId !== identity.peerId && p.online).length,
        }));
        recomputeUnifiedTopology();

        tracerRef.current?.debug(TraceTarget.SyncKey, 'peer_presence_updated', {
          host_key: hostKey,
          peer_id: peer.peerId,
          hops: peer.hops ?? 0,
        });

        if (peer.peerId !== identity.peerId) {
          await ensureDmKey(peer);
          await flushQueuedMessages();
        }
        return;
      }

      if (type === 'peer:left') {
        const leftId = String(msg.peerId);
        const currentList = peersByHostRef.current.get(hostKey) || [];
        const nextList = currentList.filter((p) => p.peerId !== leftId);
        peersByHostRef.current.set(hostKey, nextList);
        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          peersOnline: nextList.filter((p) => p.peerId !== identity.peerId && p.online).length,
        }));
        recomputeUnifiedTopology();
        tracerRef.current?.debug(TraceTarget.SyncKey, 'peer_left', {
          host_key: hostKey,
          peer_id: leftId,
        });
        return;
      }

      if (type === 'room:created' || type === 'room:updated') {
        const room = msg.room as RoomInfo;
        const currentRooms = roomsByHostRef.current.get(hostKey) || [];
        const nextRooms = currentRooms.some((r) => r.roomId === room.roomId)
          ? currentRooms.map((r) => (r.roomId === room.roomId ? room : r))
          : [...currentRooms, room];
        roomsByHostRef.current.set(hostKey, nextRooms);
        recomputeUnifiedTopology();
        return;
      }

      if (type === 'room:key_request') {
        const wireRoomId = String(msg.roomId);
        const scopedRoomId = makeScopedRoomTargetId(hostKey, wireRoomId);
        const requesterPeerId = String(msg.requesterPeerId);
        let roomKeyEntry = roomKeysRef.current.get(scopedRoomId);
        if (!roomKeyEntry && wireRoomId === DEFAULT_ROOM_ID) {
          roomKeyEntry = await ensureRoomKeyLocal(scopedRoomId);
        }
        const hostPeers = peersByHostRef.current.get(hostKey) || [];
        const requesterPeer =
          hostPeers.find((p) => p.peerId === requesterPeerId) ||
          peersRef.current.find((p) => p.peerId === requesterPeerId);
        if (!roomKeyEntry || !requesterPeer) {
          tracerRef.current?.warn(
            TraceTarget.SyncKey,
            'room_key_request_ignored',
            PacketErrorCode.KeyMissing,
            {
              host_key: hostKey,
              room_id: wireRoomId,
              requester: requesterPeerId,
              has_room_key: Boolean(roomKeyEntry),
              has_requester_peer: Boolean(requesterPeer),
            }
          );
          return;
        }

        const dmEntry = await ensureDmKey(requesterPeer);
        if (!dmEntry) return;
        const wrapped = await encryptTextAsync(dmEntry.aesKey, roomKeyEntry.rawBase64);
        void sendJsonReliableToHost(hostKey, {
          type: 'room:key_share',
          roomId: wireRoomId,
          targetPeerId: requesterPeerId,
          encryptedKeyPayload: wrapped,
        });
        tracerRef.current?.debug(TraceTarget.SyncKey, 'room_key_shared_to_peer', {
          host_key: hostKey,
          room_id: wireRoomId,
          target_peer: requesterPeerId,
        });
        return;
      }

      if (type === 'room:key_share') {
        const wireRoomId = String(msg.roomId);
        const scopedRoomId = makeScopedRoomTargetId(hostKey, wireRoomId);
        const fromPeerId = String(msg.fromPeerId);
        const encryptedKeyPayload = msg.encryptedKeyPayload as EncryptedPayload;
        const hostPeers = peersByHostRef.current.get(hostKey) || [];
        const fromPeer =
          hostPeers.find((p) => p.peerId === fromPeerId) ||
          peersRef.current.find((p) => p.peerId === fromPeerId);
        if (!fromPeer) {
          tracerRef.current?.warn(
            TraceTarget.SyncKey,
            'room_key_share_unknown_sender',
            PacketErrorCode.KeyMissing,
            { host_key: hostKey, room_id: wireRoomId, from_peer: fromPeerId }
          );
          return;
        }

        const syncMarker = `${hostKey}::${wireRoomId}`;
        const hasKey = roomKeysRef.current.has(scopedRoomId);
        const alreadySynced = syncedRoomForHostRef.current.has(syncMarker);
        const hasUndecryptedForRoom = Array.from(undecryptedPayloadsRef.current.values()).some(
          (v) => v.conversationType === 'room' && v.convTargetId === scopedRoomId
        );

        const shouldAcceptShare =
          !hasKey || (!alreadySynced && fromPeerId < identity.peerId) || hasUndecryptedForRoom;
        if (!shouldAcceptShare) {
          return;
        }

        try {
          const dmEntry = await ensureDmKey(fromPeer);
          if (!dmEntry) return;
          const rawBase64 = await decryptTextAsync(dmEntry.aesKey, encryptedKeyPayload);
          const { keyBytes, safetyCode } = await importRoomKeyFromBase64Async(rawBase64);
          roomKeysRef.current.set(scopedRoomId, {
            aesKey: keyBytes,
            rawBase64,
            safetyCode,
          });
          syncedRoomForHostRef.current.add(syncMarker);
          await saveRoomKeyRecord(scopedRoomId, rawBase64, safetyCode);
          setRoomSafetyCodes((prev) => ({ ...prev, [scopedRoomId]: safetyCode }));
          tracerRef.current?.info(TraceTarget.SyncKey, 'room_key_synchronized', {
            host_key: hostKey,
            room_id: wireRoomId,
            from_peer: fromPeerId,
            safety_code: safetyCode,
          });
          await retryDecryptRoomMessages(scopedRoomId, keyBytes);
          await flushQueuedMessages();
        } catch (unwrapErr) {
          tracerRef.current?.warn(
            TraceTarget.SyncDecrypt,
            'room_key_unwrap_failed',
            PacketErrorCode.DecryptMismatch,
            {
              host_key: hostKey,
              room_id: wireRoomId,
              from_peer: fromPeerId,
              err_msg: unwrapErr instanceof Error ? unwrapErr.message : String(unwrapErr),
            }
          );
        }
        return;
      }

      if (type === 'chat:ack') {
        const ackId = String(msg.id);
        const recipientCount =
          typeof msg.recipientCount === 'number' ? msg.recipientCount : undefined;
        tracerRef.current?.finishMessageSpan(ackId, recipientCount, {
          host_key: hostKey,
          transport: isTauriApp ? 'rust-ws' : 'browser-ws',
        });

        const prevLen = outgoingQueueRef.current.length;
        if (prevLen > 0) {
          const nextQueue = outgoingQueueRef.current.filter((q) => q.id !== ackId);
          if (nextQueue.length !== prevLen) {
            outgoingQueueRef.current = nextQueue;
            setTelemetry((prev) => ({ ...prev, queuedCount: nextQueue.length }));
            void removeOutgoingQueueItem(ackId).catch(() => {});
          }
        }

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
        const wireTargetId = String(msg.targetId);
        const convTargetId =
          conversationType === 'dm'
            ? senderId
            : makeScopedRoomTargetId(hostKey, wireTargetId);
        const conversationId = makeConversationId(conversationType, convTargetId);
        const msgId = String(msg.id);

        const aesKey = await getConversationKey(conversationType, convTargetId);
        let decryptedText = '[Pesan terenkripsi tidak dapat didekripsi]';
        let encryptedOk = false;

        if (!aesKey) {
          tracerRef.current?.warn(
            TraceTarget.SyncDecrypt,
            'incoming_key_missing',
            PacketErrorCode.KeyMissing,
            {
              host_key: hostKey,
              conv_type: conversationType,
              from_peer: senderId,
              target_id: convTargetId,
            },
            { msgId, convId: conversationId }
          );
        } else if (msg.encryptedPayload) {
          try {
            decryptedText = await decryptTextAsync(
              aesKey,
              msg.encryptedPayload as EncryptedPayload
            );
            encryptedOk = true;
            tracerRef.current?.debug(
              TraceTarget.SyncDecrypt,
              'incoming_packet_decrypted',
              { host_key: hostKey, conv_type: conversationType, from_peer: senderId },
              msgId
            );
          } catch (decErr) {
            decryptedText = '[Menyelaraskan kunci ruang enkripsi...]';
            tracerRef.current?.warn(
              TraceTarget.SyncDecrypt,
              'incoming_decrypt_mismatch',
              PacketErrorCode.DecryptMismatch,
              {
                host_key: hostKey,
                conv_type: conversationType,
                from_peer: senderId,
                target_id: convTargetId,
                err_msg: decErr instanceof Error ? decErr.message : String(decErr),
              },
              { msgId, convId: conversationId }
            );
            if (conversationType === 'room') {
              undecryptedPayloadsRef.current.set(msgId, {
                conversationType,
                convTargetId,
                encryptedPayload: msg.encryptedPayload as EncryptedPayload,
                hostKey,
                wireTargetId,
              });
              void sendJsonReliableToHost(hostKey, {
                type: 'room:key_request',
                roomId: wireTargetId,
              });
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
        const wireTargetId = String(msg.targetId);
        const convTargetId =
          conversationType === 'dm'
            ? senderId
            : makeScopedRoomTargetId(hostKey, wireTargetId);
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
        const callerPeer =
          (peersByHostRef.current.get(hostKey) || []).find((p) => p.peerId === callerId) ||
          peersRef.current.find((p) => p.peerId === callerId);
        const callerName = String(msg.callerName || callerPeer?.displayName || 'Perangkat Lokal');
        if (!callId || !callerId) return;

        if (callSessionRef.current && callSessionRef.current.status !== 'ended') {
          void sendJsonReliableToHost(hostKey, {
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

    const connectHost = (hostCfg: HostConnectionConfig) => {
      if (cancelled || unmountedRef.current || !hostCfg.enabled) return;

      const wsUrl = buildWsEndpoint(
        hostCfg.isLocal && !isTauriApp ? '' : hostCfg.url
      );

      tracerRef.current?.info(transportTarget, 'socket_connecting', {
        host_key: hostCfg.key,
        ws_url: wsUrl,
        attempt: (reconnectAttemptsRef.current.get(hostCfg.key) || 0) + 1,
      });

      updateHostRuntime(hostCfg.key, (prev) => ({
        ...prev,
        status: prev.status === 'connected' ? prev.status : 'reconnecting',
      }));

      if (isTauriApp) {
        rustWsConnectedMapRef.current.set(hostCfg.key, false);
        const nextConnId = ++rustClientConnSeqRef.current;
        rustActiveConnIdMapRef.current.set(hostCfg.key, nextConnId);
        void rustWsConnect(hostCfg.key, wsUrl, nextConnId)
          .then((connId) => {
            if (!cancelled) {
              rustActiveConnIdMapRef.current.set(hostCfg.key, connId);
            }
          })
          .catch((connErr) => {
            tracerRef.current?.error(
              TraceTarget.TransportRustWs,
              'rust_ws_connect_invoke_failed',
              PacketErrorCode.RustIpcError,
              {
                host_key: hostCfg.key,
                ws_url: wsUrl,
                err_msg: connErr instanceof Error ? connErr.message : String(connErr),
              }
            );
            handleSocketClose(hostCfg.key, 'rust_ws_connect_invoke_failed');
          });
        return;
      }

      const prevWs = wsMapRef.current.get(hostCfg.key);
      if (prevWs) {
        try {
          prevWs.close();
        } catch {
          // ignore
        }
      }

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsMapRef.current.set(hostCfg.key, ws);

      ws.onopen = () => {
        if (wsMapRef.current.get(hostCfg.key) !== ws) return;
        handleSocketOpen(hostCfg.key, wsUrl);
      };

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          await handleIncomingBinaryChunk(hostCfg.key, event.data);
          return;
        }
        await handleIncomingJsonText(hostCfg.key, String(event.data));
      };

      ws.onclose = (ev) => {
        if (wsMapRef.current.get(hostCfg.key) !== ws) return;
        handleSocketClose(hostCfg.key, `code=${ev.code}`);
      };

      ws.onerror = () => {
        tracerRef.current?.error(
          TraceTarget.TransportBrowserWs,
          'browser_ws_transport_error',
          PacketErrorCode.SocketClosed,
          { host_key: hostCfg.key, ws_url: wsUrl }
        );
      };
    };

    connectHostFnRef.current = connectHost;

    const disconnectHostSocket = (hostKey: string) => {
      const timer = reconnectTimersRef.current.get(hostKey);
      if (timer) {
        window.clearTimeout(timer);
        reconnectTimersRef.current.delete(hostKey);
      }
      peersByHostRef.current.delete(hostKey);
      roomsByHostRef.current.delete(hostKey);
      if (isTauriApp) {
        rustWsConnectedMapRef.current.set(hostKey, false);
        void rustWsDisconnect(hostKey).catch(() => {});
      } else {
        const ws = wsMapRef.current.get(hostKey);
        if (ws) {
          wsMapRef.current.delete(hostKey);
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      }
    };

    const boot = async () => {
      if (isTauriApp) {
        unlistenRustWs = await subscribeRustWsEvents({
          onOpen: (payload) => {
            if (cancelled) return;
            const expected = rustActiveConnIdMapRef.current.get(payload.hostKey);
            if (payload.connId !== expected) return;
            rustWsConnectedMapRef.current.set(payload.hostKey, true);
            handleSocketOpen(payload.hostKey, payload.url);
          },
          onText: (payload) => {
            if (cancelled) return;
            const expected = rustActiveConnIdMapRef.current.get(payload.hostKey);
            if (payload.connId !== expected) return;
            void handleIncomingJsonText(payload.hostKey, payload.data);
          },
          onBinary: (payload) => {
            if (cancelled) return;
            const expected = rustActiveConnIdMapRef.current.get(payload.hostKey);
            if (payload.connId !== expected) return;
            const bytes = base64ToBytes(payload.dataBase64);
            const buf = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ) as ArrayBuffer;
            void handleIncomingBinaryChunk(payload.hostKey, buf);
          },
          onClose: (payload) => {
            if (cancelled) return;
            const expected = rustActiveConnIdMapRef.current.get(payload.hostKey);
            if (payload.connId !== expected) return;
            handleSocketClose(payload.hostKey, payload.reason);
          },
        });
      }

      for (const hostCfg of savedHostsRef.current) {
        if (hostCfg.enabled) {
          connectHost(hostCfg);
        }
      }

      if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = window.setInterval(() => {
        if (cancelled) return;
        const now = performance.now();
        for (const h of savedHostsRef.current) {
          if (!h.enabled || !isHostSocketOpen(h.key)) continue;
          const lastSent = lastPingSentByHostRef.current.get(h.key);
          if (lastSent !== undefined && now - lastSent > 6000) {
            updateHostRuntime(h.key, (prev) => ({ ...prev, status: 'degraded' }));
          }
          lastPingSentByHostRef.current.set(h.key, now);
          void sendJsonReliableToHost(h.key, { type: 'ping', clientTs: now });
        }
      }, 2500);

      if (queueSweepTimerRef.current) window.clearInterval(queueSweepTimerRef.current);
      queueSweepTimerRef.current = window.setInterval(() => {
        if (!cancelled && outgoingQueueRef.current.length > 0 && isAnySocketOpen()) {
          void flushQueuedMessages();
        }
      }, 2000);
    };

    void boot();

    return () => {
      cancelled = true;
      connectHostFnRef.current = null;
      if (pingIntervalRef.current) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (queueSweepTimerRef.current) {
        window.clearInterval(queueSweepTimerRef.current);
        queueSweepTimerRef.current = null;
      }
      if (unlistenRustWs) unlistenRustWs();
      for (const timer of reconnectTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      reconnectTimersRef.current.clear();
      const keys = Array.from(
        new Set([
          ...wsMapRef.current.keys(),
          ...rustWsConnectedMapRef.current.keys(),
          ...savedHostsRef.current.map((h) => h.key),
        ])
      );
      for (const key of keys) {
        disconnectHostSocket(key);
      }
    };
  }, [
    identityReady,
    identity,
    isTauriApp,
    appendMessageIdempotent,
    ensureCallEngine,
    ensureDmKey,
    ensureRoomKeyLocal,
    finalizeCallCleanup,
    flushQueuedMessages,
    getConversationKey,
    handleIncomingBinaryChunk,
    isAnySocketOpen,
    isHostSocketOpen,
    recomputeUnifiedTopology,
    refreshHostManagement,
    sendJsonReliableToHost,
    updateFileMessage,
    updateHostRuntime,
  ]);

  // Helper to disconnect a single host immediately when user removes or disables it
  const closeSingleHost = useCallback(
    (hostKey: string) => {
      const timer = reconnectTimersRef.current.get(hostKey);
      if (timer) {
        window.clearTimeout(timer);
        reconnectTimersRef.current.delete(hostKey);
      }
      peersByHostRef.current.delete(hostKey);
      roomsByHostRef.current.delete(hostKey);
      lastPingSentByHostRef.current.delete(hostKey);
      if (isTauriApp) {
        rustWsConnectedMapRef.current.set(hostKey, false);
        void rustWsDisconnect(hostKey).catch(() => {});
      } else {
        const ws = wsMapRef.current.get(hostKey);
        if (ws) {
          wsMapRef.current.delete(hostKey);
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      }
      recomputeUnifiedTopology();
    },
    [isTauriApp, recomputeUnifiedTopology]
  );

  const probeHost = useCallback(
    async (targetUrl: string): Promise<RustHostProbeResultDto> => {
      let result: RustHostProbeResultDto;
      if (isTauriApp) {
        result = await rustProbeHost(targetUrl);
      } else {
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
            hostId?: string;
            hostLabel?: string;
            requiresAccessCode?: boolean;
            bridgeCount?: number;
          };
          result = {
            ok: Boolean(data.ok),
            latencyMs: Math.max(1, Math.round(performance.now() - started)),
            peersOnline: data.peersOnline ?? 0,
            activeCalls: data.activeCalls ?? 0,
            engine: data.engine || 'node-ws',
            hostId: data.hostId ?? null,
            hostLabel: data.hostLabel ?? null,
            requiresAccessCode: Boolean(data.requiresAccessCode),
            bridgeCount: data.bridgeCount ?? 0,
            error: data.ok ? null : 'Host tidak merespons sebagai server LokaKirim',
          };
        } catch (probeErr) {
          result = {
            ok: false,
            latencyMs: Math.round(performance.now() - started),
            peersOnline: 0,
            activeCalls: 0,
            engine: 'fetch',
            error: probeErr instanceof Error ? probeErr.message : 'Host tidak dapat dijangkau',
          };
        }
      }

      if (result.ok) {
        tracerRef.current?.info(TraceTarget.HostProbe, 'host_probe_ok', {
          target_url: targetUrl,
          host_id: result.hostId || '-',
          latency_ms: result.latencyMs,
          peers_online: result.peersOnline,
          engine: result.engine,
        });
      } else {
        tracerRef.current?.warn(
          TraceTarget.HostProbe,
          'host_probe_failed',
          PacketErrorCode.SocketClosed,
          {
            target_url: targetUrl,
            latency_ms: result.latencyMs,
            engine: result.engine,
            err_msg: result.error || 'unknown',
          }
        );
      }
      return result;
    },
    [isTauriApp]
  );

  const addRemoteHost = useCallback(
    (rawUrl: string, accessCode?: string, customLabel?: string) => {
      const normalized = normalizeHostUrl(rawUrl);
      if (!normalized) return null;
      const key = makeRemoteHostKey(normalized);
      const label = customLabel?.trim() || normalized.replace(/^https?:\/\//i, '');
      const cleanCode = accessCode?.trim() || undefined;

      authRejectedHostsRef.current.delete(key);
      reconnectAttemptsRef.current.set(key, 0);

      const current = savedHostsRef.current;
      const exists = current.some((h) => h.key === key);
      const nextCfg: HostConnectionConfig = {
        key,
        url: normalized,
        label,
        accessCode: cleanCode,
        enabled: true,
        isLocal: false,
      };
      const nextList = exists
        ? current.map((h) => (h.key === key ? nextCfg : h))
        : [...current, nextCfg];

      savedHostsRef.current = nextList;
      saveHostConfigs(nextList);
      setSavedHosts(nextList);

      setHostRuntimes((prev) => {
        const existsRt = prev.some((r) => r.key === key);
        const entry: HostConnectionRuntime = {
          key,
          url: normalized,
          label,
          status: 'reconnecting',
          latencyMs: null,
          peersOnline: 0,
          enabled: true,
          isLocal: false,
        };
        const updated = existsRt
          ? prev.map((r) => (r.key === key ? { ...r, ...entry } : r))
          : [...prev, entry];
        hostRuntimesRef.current = updated;
        return updated;
      });

      closeSingleHost(key);
      connectHostFnRef.current?.(nextCfg);
      return nextCfg;
    },
    [closeSingleHost]
  );

  const removeRemoteHost = useCallback(
    (hostKey: string) => {
      if (hostKey === LOCAL_HOST_KEY) return;
      closeSingleHost(hostKey);
      authRejectedHostsRef.current.delete(hostKey);
      const nextList = savedHostsRef.current.filter((h) => h.key !== hostKey);
      savedHostsRef.current = nextList;
      saveHostConfigs(nextList);
      setSavedHosts(nextList);

      setHostRuntimes((prev) => {
        const next = prev.filter((r) => r.key !== hostKey);
        hostRuntimesRef.current = next;
        return next;
      });

      const activeRoute = parseScopedRoomTargetId(activeTargetRef.current.id);
      if (activeTargetRef.current.type === 'room' && activeRoute.hostKey === hostKey) {
        setActiveTarget({ type: 'room', id: DEFAULT_ROOM_ID });
      }
    },
    [closeSingleHost]
  );

  const toggleHostEnabled = useCallback(
    (hostKey: string) => {
      const target = savedHostsRef.current.find((h) => h.key === hostKey);
      if (!target) return;
      const nextEnabled = !target.enabled;
      const updatedCfg = { ...target, enabled: nextEnabled };
      const nextList = savedHostsRef.current.map((h) => (h.key === hostKey ? updatedCfg : h));
      savedHostsRef.current = nextList;
      saveHostConfigs(nextList);
      setSavedHosts(nextList);

      if (nextEnabled) {
        authRejectedHostsRef.current.delete(hostKey);
        reconnectAttemptsRef.current.set(hostKey, 0);
        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          enabled: true,
          status: 'reconnecting',
          errorMessage: undefined,
        }));
        connectHostFnRef.current?.(updatedCfg);
      } else {
        closeSingleHost(hostKey);
        updateHostRuntime(hostKey, (prev) => ({
          ...prev,
          enabled: false,
          status: 'disabled',
          latencyMs: null,
          peersOnline: 0,
        }));
      }
    },
    [closeSingleHost, updateHostRuntime]
  );

  const updateHostAccessCode = useCallback(
    (hostKey: string, nextCode: string) => {
      const target = savedHostsRef.current.find((h) => h.key === hostKey);
      if (!target) return;
      const cleanCode = nextCode.trim() || undefined;
      const updatedCfg: HostConnectionConfig = {
        ...target,
        accessCode: cleanCode,
        enabled: true,
      };
      const nextList = savedHostsRef.current.map((h) => (h.key === hostKey ? updatedCfg : h));
      savedHostsRef.current = nextList;
      saveHostConfigs(nextList);
      setSavedHosts(nextList);

      authRejectedHostsRef.current.delete(hostKey);
      reconnectAttemptsRef.current.set(hostKey, 0);
      closeSingleHost(hostKey);
      updateHostRuntime(hostKey, (prev) => ({
        ...prev,
        enabled: true,
        status: 'reconnecting',
        errorMessage: undefined,
      }));
      connectHostFnRef.current?.(updatedCfg);
    },
    [closeSingleHost, updateHostRuntime]
  );

  const updateLocalHostConfig = useCallback(
    async (hostLabelInput?: string, accessCodeInput?: string): Promise<HostConfigInfo | null> => {
      let updated: HostConfigInfo | null = null;
      if (isTauriApp) {
        updated = await rustSetHostConfig(hostLabelInput, accessCodeInput);
      } else {
        const res = await fetch(buildApiUrl('', '/api/host-config'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hostLabel: hostLabelInput,
            accessCode: accessCodeInput,
          }),
        });
        if (res.ok) {
          updated = (await res.json()) as HostConfigInfo;
        }
      }
      if (updated) {
        setLocalHostConfig(updated);
        // Keep local host client access code aligned so local client can always authenticate to itself
        if (accessCodeInput !== undefined) {
          const cleanCode = accessCodeInput.trim() || undefined;
          const nextList = savedHostsRef.current.map((h) =>
            h.key === LOCAL_HOST_KEY ? { ...h, accessCode: cleanCode } : h
          );
          savedHostsRef.current = nextList;
          saveHostConfigs(nextList);
          setSavedHosts(nextList);
        }
        updateHostRuntime(LOCAL_HOST_KEY, (prev) => ({
          ...prev,
          hostId: updated!.hostId,
          hostLabel: updated!.hostLabel,
        }));
        void refreshLanInfo();
      }
      return updated;
    },
    [isTauriApp, refreshLanInfo, updateHostRuntime]
  );

  const addHostBridge = useCallback(
    async (targetUrl: string, accessCodeInput?: string): Promise<HostBridgeInfo> => {
      let created: HostBridgeInfo;
      if (isTauriApp) {
        created = await rustAddBridge(targetUrl, accessCodeInput);
      } else {
        const res = await fetch(buildApiUrl('', '/api/bridges'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl,
            accessCode: accessCodeInput || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Gagal membuat Host Bridge');
        }
        created = data as HostBridgeInfo;
      }
      await refreshHostManagement();
      return created;
    },
    [isTauriApp, refreshHostManagement]
  );

  const removeHostBridge = useCallback(
    async (bridgeId: string): Promise<void> => {
      if (isTauriApp) {
        await rustRemoveBridge(bridgeId);
      } else {
        await fetch(buildApiUrl('', `/api/bridges/${encodeURIComponent(bridgeId)}`), {
          method: 'DELETE',
        });
      }
      await refreshHostManagement();
    },
    [isTauriApp, refreshHostManagement]
  );

  // Backwards-compatible convenience wrappers
  const switchHostUrl = useCallback(
    (nextUrl: string) => {
      const saved = saveHostUrl(nextUrl);
      setHostUrl(saved);
      hostUrlRef.current = saved;
      if (saved && saved !== LOCAL_RUST_HOST_URL) {
        addRemoteHost(saved);
      }
      window.setTimeout(() => {
        void refreshLanInfo();
      }, 100);
      return saved;
    },
    [addRemoteHost, refreshLanInfo]
  );

  const resetHostToLocal = useCallback(() => {
    const saved = saveHostUrl('');
    setHostUrl(saved);
    hostUrlRef.current = saved;
    window.setTimeout(() => {
      void refreshLanInfo();
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
      for (const h of savedHostsRef.current) {
        if (h.enabled && isHostSocketOpen(h.key)) {
          sendJsonRawToHost(h.key, { type: 'peer:rename', displayName: trimmed });
        }
      }
    },
    [isHostSocketOpen, sendJsonRawToHost]
  );

  const createRoom = useCallback(
    async (roomName: string, targetHostKey?: string) => {
      const trimmed = roomName.trim().slice(0, 48);
      if (!trimmed || !identityRef.current) return null;
      const hostKey =
        targetHostKey && isHostSocketOpen(targetHostKey)
          ? targetHostKey
          : getFallbackConnectedHostKey();
      const wireRoomId = `ruang-${randomUuid().slice(0, 8)}`;
      const scopedRoomId = makeScopedRoomTargetId(hostKey, wireRoomId);
      await ensureRoomKeyLocal(scopedRoomId);
      sendJsonRawToHost(hostKey, {
        type: 'room:create',
        roomId: wireRoomId,
        name: trimmed,
      });
      setActiveTarget({ type: 'room', id: scopedRoomId });
      return scopedRoomId;
    },
    [ensureRoomKeyLocal, getFallbackConnectedHostKey, isHostSocketOpen, sendJsonRawToHost]
  );

  const joinRoom = useCallback(
    (scopedRoomId: string) => {
      if (!identityRef.current) return;
      const { hostKey, wireRoomId } = parseScopedRoomTargetId(scopedRoomId);
      sendJsonRawToHost(hostKey, { type: 'room:join', roomId: wireRoomId });
      if (!roomKeysRef.current.has(scopedRoomId)) {
        sendJsonRawToHost(hostKey, { type: 'room:key_request', roomId: wireRoomId });
      }
      setActiveTarget({ type: 'room', id: scopedRoomId });
    },
    [sendJsonRawToHost]
  );

  const sendTextMessage = useCallback(
    async (target: ChatTarget, text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !identityRef.current) return;

      const msgId = randomUuid();
      const timestamp = Date.now();
      const conversationId = makeConversationId(target.type, target.id);
      const transport = isTauriApp ? 'rust-ws' : 'browser-ws';
      const transportTarget = isTauriApp
        ? TraceTarget.TransportRustWs
        : TraceTarget.TransportBrowserWs;

      const routeInfo =
        target.type === 'room'
          ? parseScopedRoomTargetId(target.id)
          : { hostKey: resolvePeerHostKey(target.id), wireRoomId: target.id };

      const hostOpen = isHostSocketOpen(routeInfo.hostKey);

      tracerRef.current?.startMessageSpan(
        msgId,
        conversationId,
        {
          host_key: routeInfo.hostKey,
          transport,
          target_type: target.type,
          target_id: routeInfo.wireRoomId,
          peers_online: peersRef.current.length,
          socket_open: hostOpen,
        },
        (elapsedMs) => ({
          elapsed_ms: elapsedMs,
          socket_open: isHostSocketOpen(routeInfo.hostKey),
          transport,
          host_key: routeInfo.hostKey,
          queued_count: outgoingQueueRef.current.length,
          peers_online: peersRef.current.length,
        })
      );

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

      const queueForRetry = (reasonCode: PacketErrorCode) => {
        if (!outgoingQueueRef.current.some((q) => q.id === msgId)) {
          const queueItem: QueuedOutgoingMessage = {
            id: msgId,
            conversationType: target.type,
            targetId: target.id,
            text: trimmed,
            timestamp,
            hostKey: routeInfo.hostKey,
          };
          outgoingQueueRef.current.push(queueItem);
          void saveOutgoingQueueItem(queueItem).catch(() => {});
          setTelemetry((prev) => ({
            ...prev,
            queuedCount: outgoingQueueRef.current.length,
          }));
          tracerRef.current?.warn(
            TraceTarget.SyncQueue,
            'packet_enqueued_for_retry',
            reasonCode,
            {
              queued_count: outgoingQueueRef.current.length,
              transport,
              host_key: routeInfo.hostKey,
            },
            { msgId, convId: conversationId }
          );
        }
      };

      try {
        const keyResult = await resolveConversationKeyResult(target.type, target.id, msgId);
        if (!keyResult.ok) {
          tracerRef.current?.cancelSpan(msgId);
          queueForRetry(keyResult.error.code);
          return;
        }

        if (!hostOpen) {
          tracerRef.current?.cancelSpan(msgId);
          tracerRef.current?.warn(
            transportTarget,
            'socket_closed_before_dispatch',
            PacketErrorCode.SocketClosed,
            {
              transport,
              host_key: routeInfo.hostKey,
              peers_online: peersRef.current.length,
            },
            { msgId, convId: conversationId }
          );
          queueForRetry(PacketErrorCode.SocketClosed);
          return;
        }

        const encStarted = performance.now();
        const encryptedPayload = await encryptTextAsync(keyResult.value, trimmed);
        const encMs = Math.round(performance.now() - encStarted);
        tracerRef.current?.debug(
          TraceTarget.SyncEncrypt,
          'payload_encrypted',
          { elapsed_ms: encMs, ciphertext_len: encryptedPayload.ciphertext.length },
          msgId
        );

        const sent = await sendJsonReliableToHost(routeInfo.hostKey, {
          type: 'chat:message',
          id: msgId,
          conversationType: target.type,
          targetId: routeInfo.wireRoomId,
          senderName: identityRef.current.displayName,
          timestamp,
          encryptedPayload,
          verifiedAtSend:
            target.type === 'dm'
              ? Boolean(verifiedPeers[target.id])
              : Boolean(verifiedRooms[target.id]),
        });

        if (!sent) {
          tracerRef.current?.cancelSpan(msgId);
          tracerRef.current?.error(
            transportTarget,
            'host_dispatch_rejected',
            PacketErrorCode.SendRejected,
            {
              transport,
              socket_open: isHostSocketOpen(routeInfo.hostKey),
              host_key: routeInfo.hostKey,
            },
            { msgId, convId: conversationId }
          );
          queueForRetry(PacketErrorCode.SendRejected);
          return;
        }

        tracerRef.current?.info(
          transportTarget,
          'packet_dispatched_awaiting_ack',
          {
            transport,
            host_key: routeInfo.hostKey,
            enc_ms: encMs,
          },
          { msgId, convId: conversationId }
        );
      } catch (sendErr) {
        tracerRef.current?.cancelSpan(msgId);
        tracerRef.current?.error(
          TraceTarget.SyncEncrypt,
          'packet_encrypt_or_send_threw',
          PacketErrorCode.EncryptFailed,
          {
            err_msg: sendErr instanceof Error ? sendErr.message : String(sendErr),
            transport,
            host_key: routeInfo.hostKey,
          },
          { msgId, convId: conversationId }
        );
        queueForRetry(PacketErrorCode.EncryptFailed);
      }
    },
    [
      appendMessageIdempotent,
      isHostSocketOpen,
      isTauriApp,
      resolveConversationKeyResult,
      resolvePeerHostKey,
      sendJsonReliableToHost,
      verifiedPeers,
      verifiedRooms,
    ]
  );

  const sendFiles = useCallback(
    async (target: ChatTarget, files: File[]) => {
      if (!identityRef.current || files.length === 0) return;
      const conversationId = makeConversationId(target.type, target.id);
      const routeInfo =
        target.type === 'room'
          ? parseScopedRoomTargetId(target.id)
          : { hostKey: resolvePeerHostKey(target.id), wireRoomId: target.id };

      const keyRes = await resolveConversationKeyResult(target.type, target.id);
      const hostOpen = isHostSocketOpen(routeInfo.hostKey);

      if (!keyRes.ok || !hostOpen) {
        const errCode = !keyRes.ok ? keyRes.error.code : PacketErrorCode.SocketClosed;
        const reasonText = !keyRes.ok
          ? 'Kunci enkripsi belum siap (tunggu perangkat terhubung)'
          : 'Koneksi ke host tujuan terputus';
        tracerRef.current?.warn(
          isTauriApp ? TraceTarget.TransportRustWs : TraceTarget.TransportBrowserWs,
          'file_send_blocked',
          errCode,
          {
            host_key: routeInfo.hostKey,
            target_type: target.type,
            target_id: routeInfo.wireRoomId,
            file_count: files.length,
            socket_open: hostOpen,
          },
          { convId: conversationId }
        );
        for (const file of files) {
          const transferId = randomUuid();
          await appendMessageIdempotent(
            {
              id: `file-${transferId}`,
              conversationId,
              conversationType: target.type,
              senderId: identityRef.current.peerId,
              senderName: identityRef.current.displayName,
              timestamp: Date.now(),
              kind: 'file',
              encrypted: true,
              file: {
                transferId,
                fileName: file.name,
                mimeType: file.type || 'application/octet-stream',
                size: file.size,
                totalChunks: Math.max(1, Math.ceil(file.size / CHUNK_SIZE)),
                receivedChunks: 0,
                status: 'failed',
                progress: 0,
                speedBps: 0,
                blobStored: false,
                errorMessage: reasonText,
              },
            },
            false
          );
        }
        return;
      }
      const aesKey = keyRes.value;

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

        sendJsonRawToHost(routeInfo.hostKey, {
          type: 'file:offer',
          transferId,
          conversationType: target.type,
          targetId: routeInfo.wireRoomId,
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
            sendJsonRawToHost(routeInfo.hostKey, {
              type: 'file:cancel',
              transferId,
              conversationType: target.type,
              targetId: routeInfo.wireRoomId,
            });
            await updateFileMessage(transferId, (m) => ({
              ...m,
              file: m.file
                ? { ...m.file, status: 'cancelled', errorMessage: 'Dibatalkan' }
                : undefined,
            }));
            break;
          }

          if (!isHostSocketOpen(routeInfo.hostKey)) {
            await updateFileMessage(transferId, (m) => ({
              ...m,
              file: m.file
                ? { ...m.file, status: 'failed', errorMessage: 'Koneksi host terputus' }
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
            targetId: routeInfo.wireRoomId,
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

          const chunkSent = await sendBinaryReliableToHost(routeInfo.hostKey, packet.buffer);
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
    [
      appendMessageIdempotent,
      isHostSocketOpen,
      isTauriApp,
      resolveConversationKeyResult,
      resolvePeerHostKey,
      sendBinaryReliableToHost,
      sendJsonRawToHost,
      updateFileMessage,
    ]
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
      const hostKey = resolvePeerHostKey(peerId);
      if (!isHostSocketOpen(hostKey)) return;

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

      sendJsonRawToHost(hostKey, {
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
          sendJsonRawToHost(resolvePeerHostKey(curr.peerId), {
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
    [
      ensureCallEngine,
      ensureDmKey,
      finalizeCallCleanup,
      isHostSocketOpen,
      resolvePeerHostKey,
      sendJsonRawToHost,
    ]
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

    sendJsonRawToHost(resolvePeerHostKey(current.peerId), {
      type: 'call:accept',
      callId: current.callId,
      targetPeerId: current.peerId,
    });
  }, [ensureCallEngine, ensureDmKey, resolvePeerHostKey, sendJsonRawToHost]);

  const rejectCall = useCallback(async () => {
    const current = callSessionRef.current;
    if (!current) return;
    sendJsonRawToHost(resolvePeerHostKey(current.peerId), {
      type: 'call:reject',
      callId: current.callId,
      targetPeerId: current.peerId,
      reason: 'rejected',
    });
    ringtone.playEndChime();
    await finalizeCallCleanup('Ditolak', true);
  }, [finalizeCallCleanup, resolvePeerHostKey, sendJsonRawToHost]);

  const hangupCall = useCallback(async () => {
    const current = callSessionRef.current;
    if (!current) return;
    const msgType = current.status === 'outgoing' ? 'call:cancel' : 'call:hangup';
    sendJsonRawToHost(resolvePeerHostKey(current.peerId), {
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
  }, [finalizeCallCleanup, resolvePeerHostKey, sendJsonRawToHost]);

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
    await clearConversationHistory(convId, target.type, target.id);
    const removedTransferIds: string[] = [];
    setMessages((prev) => {
      for (const m of prev) {
        if (m.conversationId === convId && m.file?.transferId) {
          removedTransferIds.push(m.file.transferId);
        }
      }
      return prev.filter((m) => m.conversationId !== convId);
    });
    if (removedTransferIds.length > 0) {
      setFileUrls((prev) => {
        const next = { ...prev };
        for (const tid of removedTransferIds) {
          if (next[tid]) {
            try {
              URL.revokeObjectURL(next[tid]);
            } catch {
              // ignore
            }
            delete next[tid];
          }
        }
        return next;
      });
    }
    outgoingQueueRef.current = outgoingQueueRef.current.filter(
      (q) => !(q.conversationType === target.type && q.targetId === target.id)
    );
    setTelemetry((prev) => ({ ...prev, queuedCount: outgoingQueueRef.current.length }));
  }, []);

  const clearAllHistory = useCallback(async () => {
    await clearAllChatData();
    setMessages([]);
    setFileUrls((prev) => {
      for (const url of Object.values(prev)) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      return {};
    });
    outgoingQueueRef.current = [];
    setTelemetry((prev) => ({ ...prev, queuedCount: 0 }));
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

  const formatPacketTraceReport = useCallback((limit = 60): string => {
    return tracerRef.current?.formatReport(limit) || '';
  }, []);

  const clearPacketTraces = useCallback(() => {
    tracerRef.current?.clear();
  }, []);

  const getRustPacketTraces = useCallback(async (): Promise<RustPacketTraceEntryDto[]> => {
    if (!isTauriApp) return [];
    return rustGetPacketTraces();
  }, [isTauriApp]);

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
    // Multi-Host + Host ID + Bridge A-B-C management
    savedHosts,
    hostRuntimes,
    localHostConfig,
    hostBridges,
    refreshHostManagement,
    updateLocalHostConfig,
    addRemoteHost,
    removeRemoteHost,
    toggleHostEnabled,
    updateHostAccessCode,
    addHostBridge,
    removeHostBridge,
    // Diagnostics & Calls
    packetTraces,
    lastSyncFailure,
    formatPacketTraceReport,
    clearPacketTraces,
    getRustPacketTraces,
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
