import { isTauriRuntime } from './tauriBridge';

const HOST_STORAGE_KEY = 'lokakirim_host_url';
export const LOCAL_RUST_HOST_URL = 'http://127.0.0.1:3000';

export function normalizeHostUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (!parsed.port && parsed.protocol === 'http:') {
      parsed.port = '3000';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

export function getSavedHostUrl(): string {
  try {
    const saved = localStorage.getItem(HOST_STORAGE_KEY) || '';
    if (saved) return normalizeHostUrl(saved);
  } catch {
    // ignore storage failures
  }
  return isTauriRuntime() ? LOCAL_RUST_HOST_URL : '';
}

export function saveHostUrl(url: string): string {
  const normalized = normalizeHostUrl(url);
  try {
    if (!normalized) {
      localStorage.removeItem(HOST_STORAGE_KEY);
    } else {
      localStorage.setItem(HOST_STORAGE_KEY, normalized);
    }
  } catch {
    // ignore
  }
  return normalized || (isTauriRuntime() ? LOCAL_RUST_HOST_URL : '');
}

export function buildWsEndpoint(hostUrl: string): string {
  if (!hostUrl && typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }
  const parsed = new URL(hostUrl || LOCAL_RUST_HOST_URL);
  const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${parsed.host}/ws`;
}

export function buildNetworkInfoUrl(hostUrl: string): string {
  if (!hostUrl) return '/api/network-info';
  return `${hostUrl}/api/network-info`;
}
