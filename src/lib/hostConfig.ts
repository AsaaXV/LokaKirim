import type { HostConnectionConfig } from '../types/chat';
import { isTauriRuntime } from './tauriBridge';

const HOST_STORAGE_KEY = 'lokakirim_host_url';
const MULTI_HOST_STORAGE_KEY = 'lokakirim_hosts_v2';
export const LOCAL_HOST_KEY = 'local';
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

export function makeRemoteHostKey(normalizedUrl: string): string {
  const cleaned = normalizedUrl
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 48);
  return `remote_${cleaned || 'host'}`;
}

export function getPrimaryHostUrl(isTauri = isTauriRuntime()): string {
  if (isTauri) return LOCAL_RUST_HOST_URL;
  if (typeof window !== 'undefined') return window.location.origin;
  return LOCAL_RUST_HOST_URL;
}

export function loadSavedHostConfigs(isTauri = isTauriRuntime()): HostConnectionConfig[] {
  const primaryUrl = getPrimaryHostUrl(isTauri);
  const defaultLocal: HostConnectionConfig = {
    key: LOCAL_HOST_KEY,
    url: primaryUrl,
    label: isTauri ? 'Host HP Ini' : 'Host Wi-Fi Ini',
    enabled: true,
    isLocal: true,
  };

  try {
    const raw = localStorage.getItem(MULTI_HOST_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as HostConnectionConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const hasLocal = parsed.some((h) => h.key === LOCAL_HOST_KEY);
        const list = hasLocal
          ? parsed.map((h) =>
              h.key === LOCAL_HOST_KEY
                ? { ...h, url: primaryUrl, isLocal: true }
                : { ...h, url: normalizeHostUrl(h.url) || h.url }
            )
          : [defaultLocal, ...parsed];
        return list;
      }
    }

    // Migrate legacy single external host URL if configured previously
    const legacy = localStorage.getItem(HOST_STORAGE_KEY) || '';
    const normLegacy = normalizeHostUrl(legacy);
    if (normLegacy && normLegacy !== primaryUrl && normLegacy !== LOCAL_RUST_HOST_URL) {
      const migrated: HostConnectionConfig[] = [
        defaultLocal,
        {
          key: makeRemoteHostKey(normLegacy),
          url: normLegacy,
          label: normLegacy.replace(/^https?:\/\//i, ''),
          enabled: true,
          isLocal: false,
        },
      ];
      saveHostConfigs(migrated);
      return migrated;
    }
  } catch {
    // ignore storage failures
  }

  return [defaultLocal];
}

export function saveHostConfigs(configs: HostConnectionConfig[]): void {
  try {
    localStorage.setItem(MULTI_HOST_STORAGE_KEY, JSON.stringify(configs));
  } catch {
    // ignore
  }
}

export function makeScopedRoomTargetId(hostKey: string, wireRoomId: string): string {
  if (!hostKey || hostKey === LOCAL_HOST_KEY) {
    return wireRoomId;
  }
  return `${hostKey}::${wireRoomId}`;
}

export function parseScopedRoomTargetId(targetId: string): {
  hostKey: string;
  wireRoomId: string;
} {
  const sepIdx = targetId.indexOf('::');
  if (sepIdx > 0) {
    return {
      hostKey: targetId.slice(0, sepIdx),
      wireRoomId: targetId.slice(sepIdx + 2),
    };
  }
  return {
    hostKey: LOCAL_HOST_KEY,
    wireRoomId: targetId,
  };
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

export function buildApiUrl(hostUrl: string, apiPath: string): string {
  const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (!hostUrl) return cleanPath;
  if (typeof window !== 'undefined' && hostUrl === window.location.origin) {
    return cleanPath;
  }
  return `${hostUrl}${cleanPath}`;
}
