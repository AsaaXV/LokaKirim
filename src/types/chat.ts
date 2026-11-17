export type ConversationType = 'room' | 'dm';

export interface PeerInfo {
  peerId: string;
  displayName: string;
  publicKeyHex: string;
  deviceLabel: string;
  connectedAt: number;
  online: boolean;
  originHostId?: string;
  originHostLabel?: string;
  hops?: number;
  routeHostKey?: string;
  routeHostLabel?: string;
  viaBridgeLabel?: string;
}

export interface RoomInfo {
  roomId: string;
  name: string;
  createdBy: string;
  createdAt: number;
  isDefault?: boolean;
  memberIds: string[];
  originHostId?: string;
  originHostLabel?: string;
  routeHostKey?: string;
  routeHostLabel?: string;
  wireRoomId?: string;
}

export interface ChatTarget {
  type: ConversationType;
  id: string;
}

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
}

export interface FileMetadata {
  transferId: string;
  fileName: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  receivedChunks: number;
  status: 'sending' | 'receiving' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  speedBps: number;
  blobStored?: boolean;
  errorMessage?: string;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  conversationType: ConversationType;
  senderId: string;
  senderName: string;
  timestamp: number;
  kind: 'text' | 'file' | 'system';
  text?: string;
  encrypted: boolean;
  verifiedAtSend?: boolean;
  file?: FileMetadata;
  pendingSync?: boolean;
}

export type ConnectionQuality = 'connected' | 'degraded' | 'reconnecting' | 'disconnected';

export interface LatencySample {
  t: number;
  ms: number;
}

export interface NetworkTelemetry {
  quality: ConnectionQuality;
  latencyMs: number | null;
  avgLatencyMs: number | null;
  jitterMs: number | null;
  samples: LatencySample[];
  queuedCount: number;
  lastPongAt: number | null;
  wsEndpoint: string;
}

export interface LanAddress {
  name: string;
  address: string;
  url: string;
}

export interface LanNetworkInfo {
  port: number;
  hostname: string;
  addresses: LanAddress[];
  primaryUrl: string;
  hostId?: string;
  hostLabel?: string;
  requiresAccessCode?: boolean;
}

export interface HostConfigInfo {
  hostId: string;
  hostLabel: string;
  requiresAccessCode: boolean;
  accessCode?: string | null;
  bridgeCount: number;
}

export interface HostBridgeInfo {
  id: string;
  targetUrl: string;
  targetHostId?: string | null;
  targetHostLabel?: string | null;
  direction: 'outbound' | 'inbound' | string;
  status: 'connected' | 'handshaking' | 'reconnecting' | 'auth_error' | string;
  error?: string | null;
  connectedAt?: number | null;
}

export type HostConnectionMode = 'client' | 'bridge';

export type HostConnectionStatus =
  | 'connected'
  | 'degraded'
  | 'reconnecting'
  | 'auth_error'
  | 'disconnected'
  | 'disabled';

export interface HostConnectionConfig {
  key: string;
  url: string;
  label: string;
  accessCode?: string;
  enabled: boolean;
  isLocal?: boolean;
}

export interface HostConnectionRuntime {
  key: string;
  url: string;
  label: string;
  hostId?: string;
  hostLabel?: string;
  status: HostConnectionStatus;
  latencyMs: number | null;
  peersOnline: number;
  errorMessage?: string;
  enabled: boolean;
  isLocal: boolean;
}

export interface VerifiedPeerRecord {
  peerId: string;
  safetyCode: string;
  verifiedAt: number;
}

export interface VerifiedRoomRecord {
  roomId: string;
  safetyCode: string;
  verifiedAt: number;
}

export interface StoredDeviceIdentity {
  peerId: string;
  displayName: string;
  privateKeyHex: string;
  publicKeyHex: string;
  createdAt: number;
}

export type CallType = 'audio' | 'video';

export type CallStatus =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'connecting'
  | 'active'
  | 'ended';

export type CallTransportMode = 'webrtc' | 'rust-relay';

export interface CallSessionState {
  callId: string;
  callType: CallType;
  status: CallStatus;
  direction: 'outgoing' | 'incoming';
  peerId: string;
  peerName: string;
  peerDeviceLabel?: string;
  transportMode: CallTransportMode;
  audioMuted: boolean;
  videoMuted: boolean;
  remoteAudioMuted: boolean;
  remoteVideoMuted: boolean;
  speakerMuted: boolean;
  facingMode: 'user' | 'environment';
  connectedAt: number | null;
  statusNote?: string;
  endReason?: string;
  minimized: boolean;
}
