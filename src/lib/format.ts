export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, exp);
  return `${val >= 100 || exp === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[exp]}`;
}

export function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return '0 MB/s';
  const mbps = bps / (1024 * 1024);
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  const kbps = bps / 1024;
  return `${kbps.toFixed(0)} KB/s`;
}

export function formatTime(ts: number): string {
  return new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

export function formatDateDivider(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Hari ini';
  if (date.toDateString() === yesterday.toDateString()) return 'Kemarin';

  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export function makeConversationId(type: 'room' | 'dm', id: string): string {
  return `${type}:${id}`;
}

export function detectDeviceLabel(): string {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return isTauri ? 'Android APK' : 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return isTauri ? 'iOS App' : 'iOS';
  if (/Mac OS X/i.test(ua)) return isTauri ? 'macOS App' : 'macOS';
  if (/Windows/i.test(ua)) return isTauri ? 'Windows App' : 'Windows';
  if (/Linux/i.test(ua)) return isTauri ? 'Linux App' : 'Linux';
  return isTauri ? 'Aplikasi Lokal' : 'Perangkat Web';
}

export function isPreviewableImage(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith('image/')) {
    return !mimeType.includes('svg');
  }
  return /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(fileName);
}
