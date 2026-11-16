import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { EncryptedPayload } from '../types/chat';
import {
  isTauriRuntime,
  rustDecryptChunk,
  rustDecryptText,
  rustDeriveDmSession,
  rustEncryptChunk,
  rustEncryptText,
  rustGenerateKeyPair,
  rustGenerateRoomKey,
  rustImportRoomKey,
} from './tauriBridge';

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function generateIdentityKeyPair(): {
  privateKeyHex: string;
  publicKeyHex: string;
} {
  const { secretKey, publicKey } = p256.keygen();
  return {
    privateKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
  };
}

export async function generateIdentityKeyPairAsync(): Promise<{
  privateKeyHex: string;
  publicKeyHex: string;
}> {
  if (isTauriRuntime()) {
    try {
      return await rustGenerateKeyPair();
    } catch {
      // Fallback to JS implementation
    }
  }
  return generateIdentityKeyPair();
}

export function deriveSharedAesKey(
  myPrivateKeyHex: string,
  peerPublicKeyHex: string
): Uint8Array {
  const privBytes = hexToBytes(myPrivateKeyHex);
  const pubBytes = hexToBytes(peerPublicKeyHex);
  const sharedPoint = p256.getSharedSecret(privBytes, pubBytes);
  const sharedX = sharedPoint.slice(1); // 32-byte x-coordinate

  const salt = new TextEncoder().encode('LokaKirim-E2EE-LAN-v1');
  const info = new TextEncoder().encode('AES-256-GCM-Session');
  return hkdf(sha256, sharedX, salt, info, 32);
}

function formatHashAsSafetyCode(digest: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    const val = ((digest[i * 2] << 8) | digest[i * 2 + 1]) % 100000;
    groups.push(String(val).padStart(5, '0'));
  }
  return groups.join(' · ');
}

export function computePairSafetyCode(pubHexA: string, pubHexB: string): string {
  const sorted = [pubHexA.toLowerCase(), pubHexB.toLowerCase()].sort().join('|');
  const digest = sha256(new TextEncoder().encode(sorted));
  return formatHashAsSafetyCode(digest);
}

export async function deriveDmSessionAsync(
  myPrivateKeyHex: string,
  peerPublicKeyHex: string,
  myPublicKeyHex: string
): Promise<{ aesKey: Uint8Array; safetyCode: string }> {
  if (isTauriRuntime()) {
    try {
      const res = await rustDeriveDmSession(
        myPrivateKeyHex,
        peerPublicKeyHex,
        myPublicKeyHex
      );
      return {
        aesKey: base64ToBytes(res.aesKeyBase64),
        safetyCode: res.safetyCode,
      };
    } catch {
      // Fallback to JS implementation
    }
  }
  return {
    aesKey: deriveSharedAesKey(myPrivateKeyHex, peerPublicKeyHex),
    safetyCode: computePairSafetyCode(myPublicKeyHex, peerPublicKeyHex),
  };
}

export function generateRoomKey(): {
  keyBytes: Uint8Array;
  rawBase64: string;
  safetyCode: string;
} {
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const rawBase64 = bytesToBase64(keyBytes);
  const digest = sha256(keyBytes);
  const safetyCode = formatHashAsSafetyCode(digest);
  return { keyBytes, rawBase64, safetyCode };
}

export async function generateRoomKeyAsync(): Promise<{
  keyBytes: Uint8Array;
  rawBase64: string;
  safetyCode: string;
}> {
  if (isTauriRuntime()) {
    try {
      const res = await rustGenerateRoomKey();
      return {
        keyBytes: base64ToBytes(res.rawBase64),
        rawBase64: res.rawBase64,
        safetyCode: res.safetyCode,
      };
    } catch {
      // Fallback to JS
    }
  }
  return generateRoomKey();
}

export function importRoomKeyFromBase64(rawBase64: string): {
  keyBytes: Uint8Array;
  safetyCode: string;
} {
  const keyBytes = base64ToBytes(rawBase64);
  const digest = sha256(keyBytes);
  const safetyCode = formatHashAsSafetyCode(digest);
  return { keyBytes, safetyCode };
}

export async function importRoomKeyFromBase64Async(rawBase64: string): Promise<{
  keyBytes: Uint8Array;
  safetyCode: string;
}> {
  if (isTauriRuntime()) {
    try {
      const res = await rustImportRoomKey(rawBase64);
      return {
        keyBytes: base64ToBytes(res.rawBase64),
        safetyCode: res.safetyCode,
      };
    } catch {
      // Fallback to JS
    }
  }
  return importRoomKeyFromBase64(rawBase64);
}

export function encryptText(aesKey: Uint8Array, plaintext: string): EncryptedPayload {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = gcm(aesKey, iv).encrypt(encoded);
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function encryptTextAsync(
  aesKey: Uint8Array,
  plaintext: string
): Promise<EncryptedPayload> {
  if (isTauriRuntime()) {
    try {
      return await rustEncryptText(bytesToBase64(aesKey), plaintext);
    } catch {
      // Fallback to JS
    }
  }
  return encryptText(aesKey, plaintext);
}

export function decryptText(aesKey: Uint8Array, payload: EncryptedPayload): string {
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const plainBytes = gcm(aesKey, iv).decrypt(ciphertext);
  return new TextDecoder().decode(plainBytes);
}

export async function decryptTextAsync(
  aesKey: Uint8Array,
  payload: EncryptedPayload
): Promise<string> {
  if (isTauriRuntime()) {
    try {
      return await rustDecryptText(
        bytesToBase64(aesKey),
        payload.iv,
        payload.ciphertext
      );
    } catch {
      // Fallback to JS
    }
  }
  return decryptText(aesKey, payload);
}

export function encryptBinaryChunk(
  aesKey: Uint8Array,
  chunkBuffer: ArrayBuffer
): { ivBase64: string; encryptedBytes: Uint8Array } {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encryptedBytes = gcm(aesKey, iv).encrypt(new Uint8Array(chunkBuffer));
  return {
    ivBase64: bytesToBase64(iv),
    encryptedBytes,
  };
}

export async function encryptBinaryChunkAsync(
  aesKey: Uint8Array,
  chunkBuffer: ArrayBuffer
): Promise<{ ivBase64: string; encryptedBytes: Uint8Array }> {
  if (isTauriRuntime()) {
    try {
      const res = await rustEncryptChunk(
        bytesToBase64(aesKey),
        bytesToBase64(new Uint8Array(chunkBuffer))
      );
      return {
        ivBase64: res.ivBase64,
        encryptedBytes: base64ToBytes(res.encryptedBase64),
      };
    } catch {
      // Fallback to JS
    }
  }
  return encryptBinaryChunk(aesKey, chunkBuffer);
}

export function decryptBinaryChunk(
  aesKey: Uint8Array,
  ivBase64: string,
  encryptedBytes: Uint8Array
): ArrayBuffer {
  const iv = base64ToBytes(ivBase64);
  const plainBytes = gcm(aesKey, iv).decrypt(encryptedBytes);
  return plainBytes.buffer.slice(
    plainBytes.byteOffset,
    plainBytes.byteOffset + plainBytes.byteLength
  ) as ArrayBuffer;
}

export async function decryptBinaryChunkAsync(
  aesKey: Uint8Array,
  ivBase64: string,
  encryptedBytes: Uint8Array
): Promise<ArrayBuffer> {
  if (isTauriRuntime()) {
    try {
      const plainBase64 = await rustDecryptChunk(
        bytesToBase64(aesKey),
        ivBase64,
        bytesToBase64(encryptedBytes)
      );
      const plainBytes = base64ToBytes(plainBase64);
      return plainBytes.buffer.slice(
        plainBytes.byteOffset,
        plainBytes.byteOffset + plainBytes.byteLength
      ) as ArrayBuffer;
    } catch {
      // Fallback to JS
    }
  }
  return decryptBinaryChunk(aesKey, ivBase64, encryptedBytes);
}
