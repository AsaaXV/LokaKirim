import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  EncryptedPayload,
  HostBridgeInfo,
  HostConfigInfo,
  LanNetworkInfo,
} from '../types/chat';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface RustKeyPairDto {
  privateKeyHex: string;
  publicKeyHex: string;
}

export interface RustDmSessionDto {
  aesKeyBase64: string;
  safetyCode: string;
}

export interface RustRoomKeyDto {
  rawBase64: string;
  safetyCode: string;
}

export interface RustEncryptedChunkDto {
  ivBase64: string;
  encryptedBase64: string;
}

export async function rustGenerateKeyPair(): Promise<RustKeyPairDto> {
  return invoke<RustKeyPairDto>('rust_generate_keypair');
}

export async function rustDeriveDmSession(
  myPrivateKeyHex: string,
  peerPublicKeyHex: string,
  myPublicKeyHex: string
): Promise<RustDmSessionDto> {
  return invoke<RustDmSessionDto>('rust_derive_dm_session', {
    myPrivateKeyHex,
    peerPublicKeyHex,
    myPublicKeyHex,
  });
}

export async function rustGenerateRoomKey(): Promise<RustRoomKeyDto> {
  return invoke<RustRoomKeyDto>('rust_generate_room_key');
}

export async function rustImportRoomKey(rawBase64: string): Promise<RustRoomKeyDto> {
  return invoke<RustRoomKeyDto>('rust_import_room_key', { rawBase64 });
}

export async function rustEncryptText(
  aesKeyBase64: string,
  plaintext: string
): Promise<EncryptedPayload> {
  return invoke<EncryptedPayload>('rust_encrypt_text', {
    aesKeyBase64,
    plaintext,
  });
}

export async function rustDecryptText(
  aesKeyBase64: string,
  ivBase64: string,
  ciphertextBase64: string
): Promise<string> {
  return invoke<string>('rust_decrypt_text', {
    aesKeyBase64,
    ivBase64,
    ciphertextBase64,
  });
}

export async function rustEncryptChunk(
  aesKeyBase64: string,
  plainBase64: string
): Promise<RustEncryptedChunkDto> {
  return invoke<RustEncryptedChunkDto>('rust_encrypt_chunk', {
    aesKeyBase64,
    plainBase64,
  });
}

export async function rustDecryptChunk(
  aesKeyBase64: string,
  ivBase64: string,
  encryptedBase64: string
): Promise<string> {
  return invoke<string>('rust_decrypt_chunk', {
    aesKeyBase64,
    ivBase64,
    encryptedBase64,
  });
}

export async function getRustLanInfo(): Promise<LanNetworkInfo> {
  return invoke<LanNetworkInfo>('get_rust_lan_info');
}

export interface RustEncodedMediaFrameDto {
  ivBase64: string;
  payloadBase64: string;
  rawBytes: number;
  compressedBytes: number;
}

export interface RustCallCapabilitiesDto {
  engine: string;
  audioSampleRate: number;
  adpcmCompressionRatio: number;
  videoMaxWidth: number;
  videoTargetFps: number;
  activeServerCalls: number;
}

export async function rustEncodeAudioFrame(
  aesKeyBase64: string,
  pcmI16Base64: string
): Promise<RustEncodedMediaFrameDto> {
  return invoke<RustEncodedMediaFrameDto>('rust_encode_audio_frame', {
    aesKeyBase64,
    pcmI16Base64,
  });
}

export async function rustDecodeAudioFrame(
  aesKeyBase64: string,
  ivBase64: string,
  payloadBase64: string
): Promise<string> {
  return invoke<string>('rust_decode_audio_frame', {
    aesKeyBase64,
    ivBase64,
    payloadBase64,
  });
}

export async function rustEncryptMediaFrame(
  aesKeyBase64: string,
  rawBase64: string
): Promise<RustEncryptedChunkDto> {
  return invoke<RustEncryptedChunkDto>('rust_encrypt_media_frame', {
    aesKeyBase64,
    rawBase64,
  });
}

export async function rustDecryptMediaFrame(
  aesKeyBase64: string,
  ivBase64: string,
  encryptedBase64: string
): Promise<string> {
  return invoke<string>('rust_decrypt_media_frame', {
    aesKeyBase64,
    ivBase64,
    encryptedBase64,
  });
}

export async function rustGetCallCapabilities(): Promise<RustCallCapabilitiesDto> {
  return invoke<RustCallCapabilitiesDto>('rust_get_call_capabilities');
}

export interface RustWsOpenPayload {
  hostKey: string;
  connId: number;
  url: string;
}

export interface RustWsTextPayload {
  hostKey: string;
  connId: number;
  data: string;
}

export interface RustWsBinaryPayload {
  hostKey: string;
  connId: number;
  dataBase64: string;
}

export interface RustWsClosePayload {
  hostKey: string;
  connId: number;
  reason: string;
}

export interface RustHostProbeResultDto {
  ok: boolean;
  latencyMs: number;
  peersOnline: number;
  activeCalls: number;
  engine: string;
  hostId?: string | null;
  hostLabel?: string | null;
  requiresAccessCode?: boolean;
  bridgeCount?: number;
  error?: string | null;
}

export interface RustClientStatusDto {
  hostKey: string;
  connected: boolean;
  connId?: number | null;
  url?: string | null;
  engine: string;
}

export async function rustWsConnect(
  hostKey: string,
  wsUrl: string,
  clientConnId?: number
): Promise<number> {
  return invoke<number>('rust_ws_connect', {
    hostKey,
    wsUrl,
    clientConnId: clientConnId ?? null,
  });
}

export async function rustWsDisconnect(hostKey?: string): Promise<void> {
  return invoke<void>('rust_ws_disconnect', { hostKey: hostKey ?? null });
}

export async function rustWsSendText(hostKey: string, payload: string): Promise<boolean> {
  return invoke<boolean>('rust_ws_send_text', { hostKey, payload });
}

export async function rustWsSendBinary(hostKey: string, dataBase64: string): Promise<boolean> {
  return invoke<boolean>('rust_ws_send_binary', { hostKey, dataBase64 });
}

export async function rustWsStatus(hostKey?: string): Promise<RustClientStatusDto[]> {
  return invoke<RustClientStatusDto[]>('rust_ws_status', { hostKey: hostKey ?? null });
}

export async function rustProbeHost(hostUrl: string): Promise<RustHostProbeResultDto> {
  return invoke<RustHostProbeResultDto>('rust_probe_host', { hostUrl });
}

export async function rustGetHostConfig(): Promise<HostConfigInfo> {
  return invoke<HostConfigInfo>('rust_get_host_config');
}

export async function rustSetHostConfig(
  hostLabel?: string,
  accessCode?: string
): Promise<HostConfigInfo> {
  return invoke<HostConfigInfo>('rust_set_host_config', {
    hostLabel: hostLabel ?? null,
    accessCode: accessCode ?? null,
  });
}

export async function rustListBridges(): Promise<HostBridgeInfo[]> {
  return invoke<HostBridgeInfo[]>('rust_list_bridges');
}

export async function rustAddBridge(
  targetUrl: string,
  accessCode?: string
): Promise<HostBridgeInfo> {
  return invoke<HostBridgeInfo>('rust_add_bridge', {
    targetUrl,
    accessCode: accessCode ?? null,
  });
}

export async function rustRemoveBridge(bridgeId: string): Promise<void> {
  return invoke<void>('rust_remove_bridge', { bridgeId });
}

export async function subscribeRustWsEvents(handlers: {
  onOpen: (payload: RustWsOpenPayload) => void;
  onText: (payload: RustWsTextPayload) => void;
  onBinary: (payload: RustWsBinaryPayload) => void;
  onClose: (payload: RustWsClosePayload) => void;
}): Promise<() => void> {
  const unlisteners: UnlistenFn[] = await Promise.all([
    listen<RustWsOpenPayload>('rust-ws-open', (ev) => handlers.onOpen(ev.payload)),
    listen<RustWsTextPayload>('rust-ws-text', (ev) => handlers.onText(ev.payload)),
    listen<RustWsBinaryPayload>('rust-ws-binary', (ev) => handlers.onBinary(ev.payload)),
    listen<RustWsClosePayload>('rust-ws-close', (ev) => handlers.onClose(ev.payload)),
  ]);
  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}

export interface RustPacketTraceEntryDto {
  seq: number;
  tsMs: number;
  level: string;
  target: string;
  event: string;
  msgId?: string | null;
  convId?: string | null;
  details: string;
}

export async function rustLogPacketTrace(params: {
  level: string;
  target: string;
  event: string;
  msgId?: string;
  convId?: string;
  details: string;
}): Promise<void> {
  return invoke<void>('rust_log_packet_trace', {
    level: params.level,
    target: params.target,
    event: params.event,
    msgId: params.msgId ?? null,
    convId: params.convId ?? null,
    details: params.details,
  });
}

export async function rustGetPacketTraces(): Promise<RustPacketTraceEntryDto[]> {
  return invoke<RustPacketTraceEntryDto[]>('rust_get_packet_traces');
}
