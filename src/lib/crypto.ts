import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { EncryptedPayload } from '../types/chat';
import {
  isTauriRuntime,
  rustDecodeAudioFrame,
  rustDecryptChunk,
  rustDecryptMediaFrame,
  rustDecryptText,
  rustDeriveDmSession,
  rustEncodeAudioFrame,
  rustEncryptChunk,
  rustEncryptMediaFrame,
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

const IMA_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
  494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
  2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

function clampI16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

export function encodeImaAdpcmJs(samples: Int16Array): Uint8Array {
  if (samples.length === 0) return new Uint8Array(0);
  let predictor = samples[0];
  let stepIndex = 0;
  const remaining = samples.length - 1;
  const hasOddTail = remaining % 2;
  const out = new Uint8Array(4 + Math.ceil(remaining / 2));

  out[0] = predictor & 0xff;
  out[1] = (predictor >> 8) & 0xff;
  out[2] = stepIndex;
  out[3] = hasOddTail;

  let outIdx = 4;
  let curByte = 0;
  let lowNibble = true;

  for (let i = 1; i < samples.length; i++) {
    const step = IMA_STEP_TABLE[stepIndex];
    let diff = samples[i] - predictor;
    let nibble = 0;
    if (diff < 0) {
      nibble = 8;
      diff = -diff;
    }

    let delta = step >> 3;
    if (diff >= step) {
      nibble |= 4;
      diff -= step;
      delta += step;
    }
    if (diff >= step >> 1) {
      nibble |= 2;
      diff -= step >> 1;
      delta += step >> 1;
    }
    if (diff >= step >> 2) {
      nibble |= 1;
      delta += step >> 2;
    }

    predictor = clampI16((nibble & 8) !== 0 ? predictor - delta : predictor + delta);
    stepIndex = Math.max(0, Math.min(88, stepIndex + IMA_INDEX_TABLE[nibble & 0x0f]));

    if (lowNibble) {
      curByte = nibble & 0x0f;
      lowNibble = false;
    } else {
      curByte |= (nibble & 0x0f) << 4;
      out[outIdx++] = curByte;
      lowNibble = true;
    }
  }
  if (!lowNibble) {
    out[outIdx++] = curByte;
  }
  return out;
}

export function decodeImaAdpcmJs(encoded: Uint8Array): Int16Array {
  if (encoded.length < 4) return new Int16Array(0);
  const rawPred = encoded[0] | (encoded[1] << 8);
  let predictor = rawPred >= 0x8000 ? rawPred - 0x10000 : rawPred;
  let stepIndex = Math.max(0, Math.min(88, encoded[2]));
  const hasOddTail = encoded[3] === 1;
  const bodyLen = encoded.length - 4;
  const totalNibbles = bodyLen === 0 ? 0 : hasOddTail ? bodyLen * 2 - 1 : bodyLen * 2;
  const samples = new Int16Array(1 + totalNibbles);
  samples[0] = predictor;

  for (let idx = 0; idx < totalNibbles; idx++) {
    const byte = encoded[4 + (idx >> 1)];
    const nibble = (idx & 1) === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
    const step = IMA_STEP_TABLE[stepIndex];
    let delta = step >> 3;
    if ((nibble & 4) !== 0) delta += step;
    if ((nibble & 2) !== 0) delta += step >> 1;
    if ((nibble & 1) !== 0) delta += step >> 2;

    predictor = clampI16((nibble & 8) !== 0 ? predictor - delta : predictor + delta);
    samples[1 + idx] = predictor;
    stepIndex = Math.max(0, Math.min(88, stepIndex + IMA_INDEX_TABLE[nibble & 0x0f]));
  }
  return samples;
}

export async function encodeAudioFrameAsync(
  aesKey: Uint8Array,
  pcmSamples: Int16Array
): Promise<{ ivBase64: string; encryptedBytes: Uint8Array }> {
  const pcmBytes = new Uint8Array(
    pcmSamples.buffer,
    pcmSamples.byteOffset,
    pcmSamples.byteLength
  );
  if (isTauriRuntime()) {
    try {
      const res = await rustEncodeAudioFrame(
        bytesToBase64(aesKey),
        bytesToBase64(pcmBytes)
      );
      return {
        ivBase64: res.ivBase64,
        encryptedBytes: base64ToBytes(res.payloadBase64),
      };
    } catch {
      // Fallback to JS
    }
  }
  const adpcm = encodeImaAdpcmJs(pcmSamples);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encryptedBytes = gcm(aesKey, iv).encrypt(adpcm);
  return {
    ivBase64: bytesToBase64(iv),
    encryptedBytes,
  };
}

export async function decodeAudioFrameAsync(
  aesKey: Uint8Array,
  ivBase64: string,
  encryptedBytes: Uint8Array
): Promise<Int16Array> {
  if (isTauriRuntime()) {
    try {
      const pcmBase64 = await rustDecodeAudioFrame(
        bytesToBase64(aesKey),
        ivBase64,
        bytesToBase64(encryptedBytes)
      );
      const raw = base64ToBytes(pcmBase64);
      const samples = new Int16Array(Math.floor(raw.byteLength / 2));
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = dv.getInt16(i * 2, true);
      }
      return samples;
    } catch {
      // Fallback to JS
    }
  }
  const iv = base64ToBytes(ivBase64);
  const adpcm = gcm(aesKey, iv).decrypt(encryptedBytes);
  return decodeImaAdpcmJs(adpcm);
}

export async function encryptMediaFrameAsync(
  aesKey: Uint8Array,
  rawBytes: Uint8Array
): Promise<{ ivBase64: string; encryptedBytes: Uint8Array }> {
  if (isTauriRuntime()) {
    try {
      const res = await rustEncryptMediaFrame(
        bytesToBase64(aesKey),
        bytesToBase64(rawBytes)
      );
      return {
        ivBase64: res.ivBase64,
        encryptedBytes: base64ToBytes(res.encryptedBase64),
      };
    } catch {
      // Fallback to JS
    }
  }
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encryptedBytes = gcm(aesKey, iv).encrypt(rawBytes);
  return {
    ivBase64: bytesToBase64(iv),
    encryptedBytes,
  };
}

export async function decryptMediaFrameAsync(
  aesKey: Uint8Array,
  ivBase64: string,
  encryptedBytes: Uint8Array
): Promise<Uint8Array> {
  if (isTauriRuntime()) {
    try {
      const plainB64 = await rustDecryptMediaFrame(
        bytesToBase64(aesKey),
        ivBase64,
        bytesToBase64(encryptedBytes)
      );
      return base64ToBytes(plainB64);
    } catch {
      // Fallback to JS
    }
  }
  const iv = base64ToBytes(ivBase64);
  return gcm(aesKey, iv).decrypt(encryptedBytes);
}

