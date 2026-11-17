use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand_core::{OsRng, RngCore};
use serde::Serialize;

const IMA_INDEX_TABLE: [i32; 16] = [
    -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
];

const IMA_STEP_TABLE: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
    10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustEncodedMediaFrame {
    pub iv_base64: String,
    pub payload_base64: String,
    pub raw_bytes: usize,
    pub compressed_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustEncryptedMediaDto {
    pub iv_base64: String,
    pub encrypted_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustCallCapabilities {
    pub engine: String,
    pub audio_sample_rate: u32,
    pub adpcm_compression_ratio: u8,
    pub video_max_width: u32,
    pub video_target_fps: u8,
    pub active_server_calls: usize,
}

fn decode_key_32(aes_key_base64: &str) -> Result<[u8; 32], String> {
    let bytes = B64
        .decode(aes_key_base64.trim())
        .map_err(|e| format!("Base64 kunci AES tidak valid: {e}"))?;
    bytes
        .try_into()
        .map_err(|_| "Panjang kunci AES harus tepat 32 byte".to_string())
}

pub fn encode_ima_adpcm(samples: &[i16]) -> Vec<u8> {
    if samples.is_empty() {
        return Vec::new();
    }

    let mut predictor = samples[0] as i32;
    let mut step_index: i32 = 0;

    let remaining = &samples[1..];
    let has_odd_tail = (remaining.len() % 2) as u8;
    let nibble_bytes = remaining.len().div_ceil(2);
    let mut out = Vec::with_capacity(4 + nibble_bytes);

    out.extend_from_slice(&(predictor as i16).to_le_bytes());
    out.push(step_index as u8);
    out.push(has_odd_tail);

    let mut current_byte: u8 = 0;
    let mut low_nibble = true;

    for &sample in remaining {
        let step = IMA_STEP_TABLE[step_index as usize];
        let mut diff = sample as i32 - predictor;
        let mut nibble: i32 = 0;
        if diff < 0 {
            nibble = 8;
            diff = -diff;
        }

        let mut delta = step >> 3;
        if diff >= step {
            nibble |= 4;
            diff -= step;
            delta += step;
        }
        if diff >= (step >> 1) {
            nibble |= 2;
            diff -= step >> 1;
            delta += step >> 1;
        }
        if diff >= (step >> 2) {
            nibble |= 1;
            delta += step >> 2;
        }

        if (nibble & 8) != 0 {
            predictor -= delta;
        } else {
            predictor += delta;
        }
        predictor = predictor.clamp(-32768, 32767);

        step_index = (step_index + IMA_INDEX_TABLE[(nibble & 0x0f) as usize]).clamp(0, 88);

        if low_nibble {
            current_byte = (nibble as u8) & 0x0f;
            low_nibble = false;
        } else {
            current_byte |= ((nibble as u8) & 0x0f) << 4;
            out.push(current_byte);
            low_nibble = true;
        }
    }

    if !low_nibble {
        out.push(current_byte);
    }

    out
}

pub fn decode_ima_adpcm(encoded: &[u8]) -> Result<Vec<i16>, String> {
    if encoded.len() < 4 {
        return Err("Header frame ADPCM tidak lengkap".to_string());
    }

    let mut predictor = i16::from_le_bytes([encoded[0], encoded[1]]) as i32;
    let mut step_index = (encoded[2] as i32).clamp(0, 88);
    let has_odd_tail = encoded[3] == 1;

    let body = &encoded[4..];
    let total_nibbles = if body.is_empty() {
        0
    } else if has_odd_tail {
        body.len() * 2 - 1
    } else {
        body.len() * 2
    };

    let mut samples = Vec::with_capacity(1 + total_nibbles);
    samples.push(predictor as i16);

    for idx in 0..total_nibbles {
        let byte = body[idx / 2];
        let nibble = if idx % 2 == 0 {
            (byte & 0x0f) as i32
        } else {
            ((byte >> 4) & 0x0f) as i32
        };

        let step = IMA_STEP_TABLE[step_index as usize];
        let mut delta = step >> 3;
        if (nibble & 4) != 0 {
            delta += step;
        }
        if (nibble & 2) != 0 {
            delta += step >> 1;
        }
        if (nibble & 1) != 0 {
            delta += step >> 2;
        }

        if (nibble & 8) != 0 {
            predictor -= delta;
        } else {
            predictor += delta;
        }
        predictor = predictor.clamp(-32768, 32767);
        samples.push(predictor as i16);

        step_index = (step_index + IMA_INDEX_TABLE[(nibble & 0x0f) as usize]).clamp(0, 88);
    }

    Ok(samples)
}

#[tauri::command]
pub fn rust_encode_audio_frame(
    aes_key_base64: String,
    pcm_i16_base64: String,
) -> Result<RustEncodedMediaFrame, String> {
    let key_bytes = decode_key_32(&aes_key_base64)?;
    let raw_pcm = B64
        .decode(pcm_i16_base64.trim())
        .map_err(|e| format!("Base64 PCM audio tidak valid: {e}"))?;

    if raw_pcm.len() < 2 || raw_pcm.len() % 2 != 0 {
        return Err("Panjang byte PCM 16-bit harus genap".to_string());
    }

    let mut samples = Vec::with_capacity(raw_pcm.len() / 2);
    for pair in raw_pcm.chunks_exact(2) {
        samples.push(i16::from_le_bytes([pair[0], pair[1]]));
    }

    let compressed = encode_ima_adpcm(&samples);

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Inisialisasi AES-256-GCM audio gagal: {e}"))?;
    let mut iv_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let encrypted = cipher
        .encrypt(nonce, compressed.as_ref())
        .map_err(|e| format!("Enkripsi frame audio gagal: {e}"))?;

    Ok(RustEncodedMediaFrame {
        iv_base64: B64.encode(iv_bytes),
        payload_base64: B64.encode(encrypted),
        raw_bytes: raw_pcm.len(),
        compressed_bytes: compressed.len(),
    })
}

#[tauri::command]
pub fn rust_decode_audio_frame(
    aes_key_base64: String,
    iv_base64: String,
    payload_base64: String,
) -> Result<String, String> {
    let key_bytes = decode_key_32(&aes_key_base64)?;
    let iv_bytes = B64
        .decode(iv_base64.trim())
        .map_err(|e| format!("IV audio base64 tidak valid: {e}"))?;
    if iv_bytes.len() != 12 {
        return Err("Panjang IV audio harus 12 byte".to_string());
    }
    let encrypted = B64
        .decode(payload_base64.trim())
        .map_err(|e| format!("Payload audio terenkripsi tidak valid: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Inisialisasi AES-256-GCM audio gagal: {e}"))?;
    let nonce = Nonce::from_slice(&iv_bytes);

    let compressed = cipher
        .decrypt(nonce, encrypted.as_ref())
        .map_err(|_| "Dekripsi frame audio gagal".to_string())?;

    let samples = decode_ima_adpcm(&compressed)?;
    let mut pcm_bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        pcm_bytes.extend_from_slice(&s.to_le_bytes());
    }

    Ok(B64.encode(pcm_bytes))
}

#[tauri::command]
pub fn rust_encrypt_media_frame(
    aes_key_base64: String,
    raw_base64: String,
) -> Result<RustEncryptedMediaDto, String> {
    let key_bytes = decode_key_32(&aes_key_base64)?;
    let raw_bytes = B64
        .decode(raw_base64.trim())
        .map_err(|e| format!("Frame media base64 tidak valid: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Inisialisasi AES-256-GCM media gagal: {e}"))?;
    let mut iv_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let encrypted = cipher
        .encrypt(nonce, raw_bytes.as_ref())
        .map_err(|e| format!("Enkripsi frame media gagal: {e}"))?;

    Ok(RustEncryptedMediaDto {
        iv_base64: B64.encode(iv_bytes),
        encrypted_base64: B64.encode(encrypted),
    })
}

#[tauri::command]
pub fn rust_decrypt_media_frame(
    aes_key_base64: String,
    iv_base64: String,
    encrypted_base64: String,
) -> Result<String, String> {
    let key_bytes = decode_key_32(&aes_key_base64)?;
    let iv_bytes = B64
        .decode(iv_base64.trim())
        .map_err(|e| format!("IV media tidak valid: {e}"))?;
    if iv_bytes.len() != 12 {
        return Err("Panjang IV media harus 12 byte".to_string());
    }
    let encrypted = B64
        .decode(encrypted_base64.trim())
        .map_err(|e| format!("Data frame media tidak valid: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Inisialisasi AES-256-GCM media gagal: {e}"))?;
    let nonce = Nonce::from_slice(&iv_bytes);

    let plain = cipher
        .decrypt(nonce, encrypted.as_ref())
        .map_err(|_| "Dekripsi frame media gagal".to_string())?;

    Ok(B64.encode(plain))
}

#[tauri::command]
pub fn rust_get_call_capabilities() -> RustCallCapabilities {
    RustCallCapabilities {
        engine: "rust-adpcm-e2ee-relay+webrtc".to_string(),
        audio_sample_rate: 16000,
        adpcm_compression_ratio: 4,
        video_max_width: 420,
        video_target_fps: 12,
        active_server_calls: crate::lan_server::active_call_count_sync(),
    }
}
