use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hkdf::Hkdf;
use p256::{ecdh::diffie_hellman, elliptic_curve::sec1::ToEncodedPoint, PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};

const HKDF_SALT: &[u8] = b"LokaKirim-E2EE-LAN-v1";
const HKDF_INFO: &[u8] = b"AES-256-GCM-Session";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPairDto {
    pub private_key_hex: String,
    pub public_key_hex: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmSessionDto {
    pub aes_key_base64: String,
    pub safety_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomKeyDto {
    pub raw_base64: String,
    pub safety_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedPayloadDto {
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedChunkDto {
    pub iv_base64: String,
    pub encrypted_base64: String,
}

fn format_hash_as_safety_code(digest: &[u8]) -> String {
    let mut groups = Vec::with_capacity(6);
    for i in 0..6 {
        let val = (((digest[i * 2] as u32) << 8) | (digest[i * 2 + 1] as u32)) % 100_000;
        groups.push(format!("{:05}", val));
    }
    groups.join(" · ")
}

fn derive_shared_key_bytes(my_private_hex: &str, peer_public_hex: &str) -> Result<[u8; 32], String> {
    let priv_bytes = hex::decode(my_private_hex.trim())
        .map_err(|e| format!("Kunci privat tidak valid: {e}"))?;
    let pub_bytes = hex::decode(peer_public_hex.trim())
        .map_err(|e| format!("Kunci publik tidak valid: {e}"))?;

    let secret = SecretKey::from_slice(&priv_bytes)
        .map_err(|e| format!("Gagal memuat SecretKey P-256: {e}"))?;
    let public = PublicKey::from_sec1_bytes(&pub_bytes)
        .map_err(|e| format!("Gagal memuat PublicKey P-256: {e}"))?;

    let shared = diffie_hellman(secret.to_nonzero_scalar(), public.as_affine());
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared.raw_secret_bytes().as_slice());
    let mut aes_key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut aes_key)
        .map_err(|e| format!("Gagal menurunkan kunci HKDF: {e}"))?;

    Ok(aes_key)
}

fn decode_aes_key(aes_key_base64: &str) -> Result<[u8; 32], String> {
    let bytes = B64
        .decode(aes_key_base64.trim())
        .map_err(|e| format!("Base64 kunci AES tidak valid: {e}"))?;
    bytes
        .try_into()
        .map_err(|_| "Panjang kunci AES harus tepat 32 byte".to_string())
}

#[tauri::command]
pub fn rust_generate_keypair() -> Result<KeyPairDto, String> {
    let secret = SecretKey::random(&mut OsRng);
    let public = secret.public_key();
    let encoded_pub = public.to_encoded_point(true);

    Ok(KeyPairDto {
        private_key_hex: hex::encode(secret.to_bytes()),
        public_key_hex: hex::encode(encoded_pub.as_bytes()),
    })
}

#[tauri::command]
pub fn rust_derive_dm_session(
    my_private_key_hex: String,
    peer_public_key_hex: String,
    my_public_key_hex: String,
) -> Result<DmSessionDto, String> {
    let aes_key = derive_shared_key_bytes(&my_private_key_hex, &peer_public_key_hex)?;

    let mut pair = [
        my_public_key_hex.trim().to_lowercase(),
        peer_public_key_hex.trim().to_lowercase(),
    ];
    pair.sort();
    let joined = pair.join("|");
    let digest = Sha256::digest(joined.as_bytes());
    let safety_code = format_hash_as_safety_code(&digest);

    Ok(DmSessionDto {
        aes_key_base64: B64.encode(aes_key),
        safety_code,
    })
}

#[tauri::command]
pub fn rust_generate_room_key() -> Result<RoomKeyDto, String> {
    let mut key_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut key_bytes);
    let digest = Sha256::digest(key_bytes);

    Ok(RoomKeyDto {
        raw_base64: B64.encode(key_bytes),
        safety_code: format_hash_as_safety_code(&digest),
    })
}

#[tauri::command]
pub fn rust_import_room_key(raw_base64: String) -> Result<RoomKeyDto, String> {
    let key_bytes = B64
        .decode(raw_base64.trim())
        .map_err(|e| format!("Kunci grup base64 tidak valid: {e}"))?;
    if key_bytes.len() != 32 {
        return Err("Panjang kunci grup harus 32 byte".to_string());
    }
    let digest = Sha256::digest(&key_bytes);

    Ok(RoomKeyDto {
        raw_base64: raw_base64.trim().to_string(),
        safety_code: format_hash_as_safety_code(&digest),
    })
}

#[tauri::command]
pub fn rust_encrypt_text(
    aes_key_base64: String,
    plaintext: String,
) -> Result<EncryptedPayloadDto, String> {
    let key_bytes = decode_aes_key(&aes_key_base64)?;
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Inisialisasi AES-256-GCM gagal: {e}"))?;

    let mut iv_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Enkripsi teks gagal: {e}"))?;

    Ok(EncryptedPayloadDto {
        iv: B64.encode(iv_bytes),
        ciphertext: B64.encode(ciphertext),
    })
}

#[tauri::command]
pub fn rust_decrypt_text(
    aes_key_base64: String,
    iv_base64: String,
    ciphertext_base64: String,
) -> Result<String, String> {
    let key_bytes = decode_aes_key(&aes_key_base64)?;
    let iv_bytes = B64
        .decode(iv_base64.trim())
        .map_err(|e| format!("IV base64 tidak valid: {e}"))?;
    if iv_bytes.len() != 12 {
        return Err("Panjang IV harus 12 byte".to_string());
    }
    let ciphertext = B64
        .decode(ciphertext_base64.trim())
        .map_err(|e| format!("Ciphertext base64 tidak valid: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Inisialisasi AES-256-GCM gagal: {e}"))?;
    let nonce = Nonce::from_slice(&iv_bytes);

    let plain = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Dekripsi gagal: kunci atau integritas pesan tidak cocok".to_string())?;

    String::from_utf8(plain).map_err(|e| format!("Payload UTF-8 tidak valid: {e}"))
}

#[tauri::command]
pub fn rust_encrypt_chunk(
    aes_key_base64: String,
    plain_base64: String,
) -> Result<EncryptedChunkDto, String> {
    let key_bytes = decode_aes_key(&aes_key_base64)?;
    let plain_bytes = B64
        .decode(plain_base64.trim())
        .map_err(|e| format!("Data chunk base64 tidak valid: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Inisialisasi AES-256-GCM gagal: {e}"))?;

    let mut iv_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let encrypted = cipher
        .encrypt(nonce, plain_bytes.as_ref())
        .map_err(|e| format!("Enkripsi chunk gagal: {e}"))?;

    Ok(EncryptedChunkDto {
        iv_base64: B64.encode(iv_bytes),
        encrypted_base64: B64.encode(encrypted),
    })
}

#[tauri::command]
pub fn rust_decrypt_chunk(
    aes_key_base64: String,
    iv_base64: String,
    encrypted_base64: String,
) -> Result<String, String> {
    let key_bytes = decode_aes_key(&aes_key_base64)?;
    let iv_bytes = B64
        .decode(iv_base64.trim())
        .map_err(|e| format!("IV chunk tidak valid: {e}"))?;
    if iv_bytes.len() != 12 {
        return Err("Panjang IV harus 12 byte".to_string());
    }
    let encrypted = B64
        .decode(encrypted_base64.trim())
        .map_err(|e| format!("Data terenkripsi chunk tidak valid: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Inisialisasi AES-256-GCM gagal: {e}"))?;
    let nonce = Nonce::from_slice(&iv_bytes);

    let plain = cipher
        .decrypt(nonce, encrypted.as_ref())
        .map_err(|_| "Dekripsi chunk gagal".to_string())?;

    Ok(B64.encode(plain))
}
