mod call;
mod client;
mod crypto;
mod lan_server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            tauri::async_runtime::spawn(async move {
                lan_server::start_lan_server(lan_server::LAN_PORT).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crypto::rust_generate_keypair,
            crypto::rust_derive_dm_session,
            crypto::rust_generate_room_key,
            crypto::rust_import_room_key,
            crypto::rust_encrypt_text,
            crypto::rust_decrypt_text,
            crypto::rust_encrypt_chunk,
            crypto::rust_decrypt_chunk,
            lan_server::get_rust_lan_info,
            call::rust_encode_audio_frame,
            call::rust_decode_audio_frame,
            call::rust_encrypt_media_frame,
            call::rust_decrypt_media_frame,
            call::rust_get_call_capabilities,
            client::rust_ws_connect,
            client::rust_ws_disconnect,
            client::rust_ws_send_text,
            client::rust_ws_send_binary,
            client::rust_ws_status,
            client::rust_probe_host,
        ])
        .run(tauri::generate_context!())
        .expect("Gagal menjalankan aplikasi Tauri LokaKirim");
}
