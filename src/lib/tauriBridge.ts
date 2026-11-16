import { invoke } from '@tauri-apps/api/core';
import type { EncryptedPayload, LanNetworkInfo } from '../types/chat';

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
