# LokaKirim

**LokaKirim** adalah aplikasi chat dan berbagi file cepat antarperangkat dalam **jaringan Wi-Fi atau hotspot lokal yang sama tanpa memerlukan koneksi internet**. Antarmukanya dirancang menyerupai **WhatsApp Android & WhatsApp Web** dengan **Mode Gelap default** (beserta opsi Mode Terang), enkripsi *End-to-End* (E2EE) otomatis, dan dukungan build **APK Android native berbasis Rust (Tauri v2)** serta rilis otomatis di GitHub.

---

## Untuk Apa Aplikasi Ini Dibuat?

- Berkomunikasi di ruangan, kantor, kelas, perjalanan, atau area tanpa sinyal internet cukup dengan menyambungkan perangkat ke **Wi-Fi atau hotspot HP yang sama**.
- Mengirim **foto, video, dan dokumen berukuran besar** langsung antarperangkat di jaringan lokal secara cepat tanpa batas server cloud.
- Menjaga kerahasiaan percakapan karena server hanya bertindak sebagai relay buta (*zero-knowledge*), sementara kunci enkripsi hanya dimiliki oleh perangkat pengirim dan penerima.

---

## Fitur Utama

1. **Chat Grup Lokal & Chat Pribadi 1-on-1**
   - Mendukung **Ruang Utama Wi-Fi** otomatis, pembuatan ruang grup lokal baru, serta chat pribadi (*Direct Message*) langsung ke perangkat lain yang aktif di jaringan yang sama.
2. **Enkripsi End-to-End (E2EE) + Kode Keamanan**
   - Menggunakan pertukaran kunci **ECDH P-256**, penurunan kunci sesi **HKDF-SHA256**, dan enkripsi **AES-256-GCM** untuk setiap teks maupun *chunk* file.
   - Dilengkapi **Kode Verifikasi Keamanan (30 digit)** untuk memvalidasi integritas enkripsi antarperangkat atau ruang grup.
3. **Transfer File Besar Cepat (Chunk 256 KB Terenkripsi)**
   - File berukuran besar dipecah menjadi *chunk* 256 KB yang dienkripsi satu per satu, lengkap dengan progres waktu nyata, kecepatan transfer, tombol batal, pratinjau gambar langsung di gelembung chat, serta dukungan *Screen Wake Lock* di Android agar transfer tidak terputus.
4. **Indikator Kestabilan Jaringan Real-Time**
   - Mengukur latensi (*ping/pong* WebSocket), rata-rata RTT, *jitter*, grafik riwayat latensi, dan antrean pesan tertunda secara langsung.
5. **Dual Runtime: Web & APK Android Native (Rust + Tauri v2)**
   - **Di dalam APK Android**: Inti **Rust** menjalankan server host Wi-Fi lokal (`axum` pada port `3000`) **sekaligus** mesin kriptografi E2EE native via Tauri IPC. Satu HP Android bisa langsung menjadi Host Wi-Fi bagi HP lain (lewat QR Code atau alamat IP lokal), atau berpindah menjadi Klien ke host teman dengan satu ketukan.
   - **Di Browser / PC**: Berjalan melalui server Node.js/Express + WebSocket dan kompatibel penuh saling berkirim pesan terenkripsi dengan perangkat Android APK.
6. **Mode Gelap Default & Optimalisasi Android**
   - Tata letak dua layar khas WhatsApp Android (Daftar Chat ↔ Ruang Chat dengan sinkronisasi tombol **Back** Android), target sentuh minimal `44px`, lembar lampiran (**Kamera**, **Galeri**, **Dokumen**), dan riwayat tersimpan lokal di `IndexedDB`.

---

## Cara Menggunakan

### Skenario 1: Menggunakan APK Android (Tanpa PC / Tanpa Internet)
1. Pastikan kedua ponsel terhubung ke **Wi-Fi yang sama** (atau salah satu ponsel menyalakan **Hotspot Wi-Fi**).
2. Buka **LokaKirim** di **HP Pertama (Host)**:
   - Ketuk ikon **QR / Bagikan Wi-Fi** untuk melihat alamat IP lokal (contoh: `http://192.168.43.1:3000`) atau kode QR.
3. Di **HP Kedua**:
   - **Jika memakai APK LokaKirim**: Buka ikon **QR / Bagikan Wi-Fi**, masukkan alamat IP HP Pertama di bagian **Gabung ke Host Perangkat Lain**, lalu ketuk **Sambung**.
   - **Jika tidak memasang APK**: Cukup pindai QR Code atau buka alamat `http://<IP-HP-Pertama>:3000` di browser HP/laptop.

### Skenario 2: Menjalankan Server dari PC / Laptop (Node.js)
```bash
npm install
npm run dev
```
Server akan berjalan pada port `3000` (`http://localhost:3000`) dan menampilkan alamat IP Wi-Fi lokal yang dapat dibuka dari perangkat lain di jaringan yang sama.

Untuk build produksi web:
```bash
npm run build
npm start
```

---

## Build APK & Rilis Otomatis di GitHub Actions

Repositori ini sudah dilengkapi workflow GitHub Actions yang berjalan otomatis untuk mengompilasi aplikasi Rust + Tauri v2 menjadi APK Android.

### Pemicu Otomatis
Workflow akan berjalan otomatis setiap kali terjadi:
- **Push ke branch `main` atau `master`**
- **Push tag versi `v*`** (misalnya `v1.2.0`)
- **Pemicu manual** melalui tab **Actions → Run workflow**

### Hasil Rilis Otomatis
Setiap build berhasil akan otomatis menghasilkan:
1. **GitHub Release** baru di menu **Releases** repositori Anda (menggunakan nama tag `v*` jika dipicu oleh tag, atau tag otomatis `v1.0.<run_number>` pada setiap push) lengkap dengan catatan rilis otomatis.
2. **File APK siap pasang** (`LokaKirim-debug.apk`) yang langsung terlampir di halaman **Releases** dan juga tersedia di **Workflow Artifacts**.

### Opsi Release APK Bertanda Tangan (Opsional)
Secara default, **Debug APK** selalu dibuat dan langsung siap dipasang di Android tanpa perlu konfigurasi tambahan. Jika Anda juga ingin workflow otomatis menghasilkan **Release APK** yang ditandatangani dengan keystore pribadi Anda, tambahkan 4 **Repository Secrets** berikut di **Settings → Secrets and variables → Actions**:

| Nama Secret | Keterangan |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Isi file `.jks` / `.keystore` yang telah di-encode ke Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Password keystore Anda |
| `ANDROID_KEY_ALIAS` | Alias kunci di dalam keystore |
| `ANDROID_KEY_PASSWORD` | Password key alias tersebut |

---

## Tumpukan Teknologi

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, IndexedDB, `@noble/curves`, `@noble/ciphers`, `@noble/hashes`
- **APK Android & Core Native**: Tauri v2 Android, **Rust** (`axum` HTTP/WebSocket relay, `tokio`, `p256`, `aes-gcm`, `hkdf`, `sha2`, `include_dir`)
- **Server Web Lokal**: Node.js, Express, `ws`
- **CI/CD**: GitHub Actions (JDK 17, Android SDK/NDK 27, Rust Android targets, auto GitHub Release)
