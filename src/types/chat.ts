export type ConversationType = 'room' | 'dm';

export interface PeerInfo {
  peerId: string;
  displayName: string;
  publicKeyHex: string;
  deviceLabel: string;
  connectedAt: number;
  online: boolean;
}

export interface RoomInfo {
  roomId: string;
  name: string;
  createdBy: string;
  createdAt: number;
  isDefault?: boolean;
  memberIds: string[];
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
