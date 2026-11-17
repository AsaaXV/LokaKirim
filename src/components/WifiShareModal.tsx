import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  Copy,
  GitMerge,
  KeyRound,
  Link2,
  Power,
  QrCode,
  Shield,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import { LOCAL_HOST_KEY, normalizeHostUrl } from '../lib/hostConfig';
import type { RustHostProbeResultDto } from '../lib/tauriBridge';
import type {
  HostBridgeInfo,
  HostConfigInfo,
  HostConnectionMode,
  HostConnectionRuntime,
  LanNetworkInfo,
} from '../types/chat';

interface WifiShareModalProps {
  open: boolean;
  onClose: () => void;
  lanInfo: LanNetworkInfo | null;
  onRefresh: () => void;
  hostUrl: string;
  isTauriApp: boolean;
  onProbeHost?: (targetUrl: string) => Promise<RustHostProbeResultDto>;
  onSwitchHost: (nextUrl: string) => string;
  onResetHost: () => string;
  localHostConfig: HostConfigInfo | null;
  hostRuntimes: HostConnectionRuntime[];
  hostBridges: HostBridgeInfo[];
  onRefreshHostManagement: () => Promise<void>;
  onUpdateLocalHostConfig: (
    hostLabel?: string,
    accessCode?: string
  ) => Promise<HostConfigInfo | null>;
  onAddRemoteHost: (rawUrl: string, accessCode?: string, label?: string) => unknown;
  onRemoveRemoteHost: (hostKey: string) => void;
  onToggleHostEnabled: (hostKey: string) => void;
  onUpdateHostAccessCode: (hostKey: string, nextCode: string) => void;
  onAddHostBridge: (targetUrl: string, accessCode?: string) => Promise<HostBridgeInfo>;
  onRemoveHostBridge: (bridgeId: string) => Promise<void>;
}

export const WifiShareModal: React.FC<WifiShareModalProps> = ({
  open,
  onClose,
  lanInfo,
  onRefresh,
  isTauriApp,
  onProbeHost,
  localHostConfig,
  hostRuntimes,
  hostBridges,
  onRefreshHostManagement,
  onUpdateLocalHostConfig,
  onAddRemoteHost,
  onRemoveRemoteHost,
  onToggleHostEnabled,
  onUpdateHostAccessCode,
  onAddHostBridge,
  onRemoveHostBridge,
}) => {
  const [selectedUrl, setSelectedUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedHostId, setCopiedHostId] = useState(false);

  // Local host settings (Host ID + optional Access Code)
  const [editingHostConfig, setEditingHostConfig] = useState(false);
  const [hostLabelInput, setHostLabelInput] = useState('');
  const [hostPinInput, setHostPinInput] = useState('');
  const [savingHostConfig, setSavingHostConfig] = useState(false);

  // Remote host / Bridge connection form
  const [connectMode, setConnectMode] = useState<HostConnectionMode>('client');
  const [remoteInput, setRemoteInput] = useState('');
  const [remotePinInput, setRemotePinInput] = useState('');
  const [hostError, setHostError] = useState('');
  const [hostSuccess, setHostSuccess] = useState('');
  const [probing, setProbing] = useState(false);

  // Inline PIN retry for auth_error hosts
  const [retryPinHostKey, setRetryPinHostKey] = useState<string | null>(null);
  const [retryPinValue, setRetryPinValue] = useState('');

  useEffect(() => {
    if (!open) return;
    onRefresh();
    void onRefreshHostManagement();
    setHostError('');
    setHostSuccess('');
    const poll = window.setInterval(() => {
      void onRefreshHostManagement();
    }, 3000);
    return () => window.clearInterval(poll);
  }, [open, onRefresh, onRefreshHostManagement]);

  useEffect(() => {
    if (localHostConfig && !editingHostConfig) {
      setHostLabelInput(localHostConfig.hostLabel || '');
      setHostPinInput(localHostConfig.accessCode || '');
    }
  }, [localHostConfig, editingHostConfig]);

  useEffect(() => {
    if (lanInfo?.primaryUrl) {
      setSelectedUrl(lanInfo.primaryUrl);
    } else if (typeof window !== 'undefined') {
      setSelectedUrl(window.location.origin);
    }
  }, [lanInfo]);

  useEffect(() => {
    if (!open || !selectedUrl) return;
    let active = true;
    QRCode.toDataURL(selectedUrl, {
      width: 220,
      margin: 2,
      color: {
        dark: '#0F172A',
        light: '#FFFFFF',
      },
    })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [open, selectedUrl]);

  if (!open) return null;

  const displayedHostId = localHostConfig?.hostId || lanInfo?.hostId || 'LK-LOKAL';
  const displayedHostLabel =
    localHostConfig?.hostLabel || lanInfo?.hostLabel || (isTauriApp ? 'Host HP Ini' : 'Host Wi-Fi');
  const requiresPin = Boolean(
    localHostConfig?.requiresAccessCode ?? lanInfo?.requiresAccessCode
  );

  const handleCopyUrl = async () => {
    if (!selectedUrl) return;
    try {
      await navigator.clipboard.writeText(selectedUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // ignore
    }
  };

  const handleCopyHostId = async () => {
    if (!displayedHostId) return;
    try {
      await navigator.clipboard.writeText(displayedHostId);
      setCopiedHostId(true);
      setTimeout(() => setCopiedHostId(false), 1800);
    } catch {
      // ignore
    }
  };

  const handleSaveHostConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingHostConfig(true);
    try {
      await onUpdateLocalHostConfig(hostLabelInput.trim(), hostPinInput.trim());
      setEditingHostConfig(false);
    } finally {
      setSavingHostConfig(false);
    }
  };

  const handleConnectRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeHostUrl(remoteInput);
    if (!normalized) {
      setHostError('Masukkan alamat IP atau URL host Wi-Fi yang valid (mis. 192.168.43.1:3000)');
      setHostSuccess('');
      return;
    }
    setHostError('');
    setHostSuccess('');

    let remoteLabel: string | undefined;
    let remoteHostId: string | undefined;

    if (onProbeHost) {
      setProbing(true);
      const probe = await onProbeHost(normalized);
      setProbing(false);
      if (!probe.ok) {
        setHostError(
          probe.error ||
            `Tidak dapat menjangkau ${normalized}. Pastikan LokaKirim Host aktif dan satu Wi-Fi/hotspot.`
        );
        return;
      }
      if (probe.requiresAccessCode && !remotePinInput.trim()) {
        setHostError(
          `Host ${probe.hostLabel || normalized} (${probe.hostId || 'PIN'}) meminta Kode Akses.`
        );
        return;
      }
      remoteLabel = probe.hostLabel || undefined;
      remoteHostId = probe.hostId || undefined;
    }

    if (connectMode === 'client') {
      onAddRemoteHost(normalized, remotePinInput.trim() || undefined, remoteLabel);
      setHostSuccess(
        `Tersambung sebagai Multi-Host ke ${remoteLabel || normalized}${
          remoteHostId ? ` (${remoteHostId})` : ''
        }`
      );
      setRemoteInput('');
      setRemotePinInput('');
    } else {
      try {
        await onAddHostBridge(normalized, remotePinInput.trim() || undefined);
        setHostSuccess(
          `Bridge ke ${remoteLabel || normalized} dibuat. Peserta host ini & host tujuan kini saling terhubung.`
        );
        setRemoteInput('');
        setRemotePinInput('');
      } catch (err) {
        setHostError(err instanceof Error ? err.message : 'Gagal membuat jembatan Host Bridge');
      }
    }
  };

  const formatRuntimeStatus = (rt: HostConnectionRuntime) => {
    if (!rt.enabled || rt.status === 'disabled') return 'Nonaktif';
    if (rt.status === 'connected') {
      return rt.latencyMs !== null ? `Terhubung · ${rt.latencyMs} ms` : 'Terhubung';
    }
    if (rt.status === 'degraded') {
      return rt.latencyMs !== null ? `Melambat · ${rt.latencyMs} ms` : 'Melambat';
    }
    if (rt.status === 'auth_error') return 'Kode Akses Ditolak';
    if (rt.status === 'reconnecting') return 'Menyambung...';
    return 'Terputus';
  };

  const formatBridgeStatus = (br: HostBridgeInfo) => {
    if (br.status === 'connected') return 'Terhubung';
    if (br.status === 'handshaking') return 'Jabat tangan...';
    if (br.status === 'auth_error') return 'Kode ditolak';
    return 'Menyambung ulang...';
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wifi-share-title"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-2xl sm:rounded-xl border-t sm:border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#202C33] p-5 sm:p-6 pb-safe-modal sm:pb-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 dark:bg-[#3B4A54] sm:hidden" />
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00A884]/15 text-[#008069] dark:text-[#00A884]">
              <QrCode className="h-5 w-5" />
            </div>
            <div>
              <h3
                id="wifi-share-title"
                className="text-base font-semibold text-slate-900 dark:text-[#E9EDEF]"
              >
                Host Wi-Fi, Multi-Host & Bridge
              </h3>
              <p className="text-xs text-slate-500 dark:text-[#8696A0]">
                Bagikan ID Host Anda atau sambungkan beberapa host (A–B–C)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup modal akses Wi-Fi"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-400 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Local Host Identity & Optional Access Code */}
        <div className="rounded-xl border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-3.5 mb-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-[#8696A0]">
                ID Host Perangkat Ini
              </p>
              <div className="mt-0.5 flex items-center gap-2 flex-wrap">
                <span className="font-mono text-base font-bold tabular-nums text-[#008069] dark:text-[#00A884]">
                  {displayedHostId}
                </span>
                <span className="text-xs text-slate-600 dark:text-[#AEBAC1] truncate">
                  · {displayedHostLabel} · {requiresPin ? 'PIN Aktif' : 'Terbuka (Tanpa PIN)'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={handleCopyHostId}
                title="Salin ID Host"
                className="min-h-[44px] inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#202C33] px-2.5 text-xs font-medium text-slate-700 dark:text-[#E9EDEF] hover:bg-slate-100 dark:hover:bg-[#2A3942] whitespace-nowrap cursor-pointer"
              >
                {copiedHostId ? (
                  <Check className="h-3.5 w-3.5 text-[#00A884]" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copiedHostId ? 'Disalin' : 'ID'}</span>
              </button>
              <button
                type="button"
                onClick={() => setEditingHostConfig((v) => !v)}
                className="min-h-[44px] inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#202C33] px-2.5 text-xs font-medium text-slate-700 dark:text-[#E9EDEF] hover:bg-slate-100 dark:hover:bg-[#2A3942] whitespace-nowrap cursor-pointer"
              >
                <KeyRound className="h-3.5 w-3.5 text-[#00A884]" />
                <span>Atur PIN</span>
              </button>
            </div>
          </div>

          {editingHostConfig && (
            <form
              onSubmit={handleSaveHostConfig}
              className="mt-3 pt-3 border-t border-slate-200 dark:border-[#2A3942] space-y-2"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-[#8696A0] mb-1">
                    Nama Host Anda
                  </label>
                  <input
                    type="text"
                    maxLength={36}
                    value={hostLabelInput}
                    onChange={(e) => setHostLabelInput(e.target.value)}
                    placeholder="Host HP Ini"
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 dark:border-[#3B4A54] bg-white dark:bg-[#2A3942] px-3 py-2 text-xs text-slate-900 dark:text-[#E9EDEF] focus:border-[#00A884] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-[#8696A0] mb-1">
                    Kode Akses / PIN (kosongkan jika bebas)
                  </label>
                  <input
                    type="text"
                    maxLength={24}
                    value={hostPinInput}
                    onChange={(e) => setHostPinInput(e.target.value)}
                    placeholder="Contoh: 4821"
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 dark:border-[#3B4A54] bg-white dark:bg-[#2A3942] px-3 py-2 font-mono text-xs text-slate-900 dark:text-[#E9EDEF] focus:border-[#00A884] focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingHostConfig(false)}
                  className="min-h-[44px] rounded-lg px-3 text-xs text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingHostConfig}
                  className="min-h-[44px] rounded-lg bg-[#00A884] hover:bg-[#008F72] px-4 text-xs font-semibold text-[#111B21] whitespace-nowrap cursor-pointer"
                >
                  {savingHostConfig ? 'Menyimpan...' : 'Simpan Pengaturan Host'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* QR Display & Local Address */}
        <div className="flex flex-col sm:flex-row items-center gap-4 rounded-xl border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-4 mb-4">
          <div className="shrink-0">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="QR Code alamat Wi-Fi lokal LokaKirim"
                className="h-28 w-28 rounded-lg bg-white p-1.5"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center text-xs text-slate-400">
                QR...
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 w-full">
            <p className="text-xs font-medium text-slate-700 dark:text-[#E9EDEF] mb-1.5">
              Alamat Host Wi-Fi Ini
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={selectedUrl}
                className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-[#3B4A54] bg-white dark:bg-[#2A3942] px-3 py-2 font-mono text-xs text-slate-800 dark:text-[#E9EDEF] select-all"
              />
              <button
                type="button"
                onClick={handleCopyUrl}
                className="min-h-[44px] inline-flex items-center gap-1.5 rounded-lg bg-[#00A884] hover:bg-[#008F72] px-3.5 text-xs font-semibold text-[#111B21] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedUrl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copiedUrl ? 'Disalin' : 'Salin'}</span>
              </button>
            </div>
            {lanInfo && lanInfo.addresses.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {lanInfo.addresses.map((addr) => (
                  <button
                    key={addr.url}
                    type="button"
                    onClick={() => setSelectedUrl(addr.url)}
                    className={`min-h-[36px] inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-mono cursor-pointer ${
                      selectedUrl === addr.url
                        ? 'border-[#00A884] bg-[#00A884]/15 text-[#008069] dark:text-[#00A884]'
                        : 'border-slate-200 dark:border-[#3B4A54] text-slate-600 dark:text-[#AEBAC1]'
                    }`}
                  >
                    <Wifi className="h-3 w-3" />
                    {addr.address}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Connect Remote Host (Multi-Host or Bridge A-B-C) */}
        <div className="border-t border-slate-200 dark:border-[#2A3942] pt-4 mb-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-[#E9EDEF] mb-2">
            <Link2 className="h-3.5 w-3.5 text-[#00A884]" />
            <span>Tambah Host Teman (Multi-Host / Bridge A–B–C)</span>
          </div>

          <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] p-1 mb-2.5">
            <button
              type="button"
              onClick={() => setConnectMode('client')}
              className={`min-h-[40px] rounded-lg px-2.5 text-xs font-medium transition-colors cursor-pointer ${
                connectMode === 'client'
                  ? 'bg-white dark:bg-[#2A3942] text-slate-900 dark:text-[#E9EDEF] shadow-xs'
                  : 'text-slate-600 dark:text-[#8696A0]'
              }`}
            >
              Gabung Klien (Multi-Host)
            </button>
            <button
              type="button"
              onClick={() => setConnectMode('bridge')}
              className={`min-h-[40px] rounded-lg px-2.5 text-xs font-medium transition-colors cursor-pointer ${
                connectMode === 'bridge'
                  ? 'bg-white dark:bg-[#2A3942] text-slate-900 dark:text-[#E9EDEF] shadow-xs'
                  : 'text-slate-600 dark:text-[#8696A0]'
              }`}
            >
              Jembatani Host (Bridge)
            </button>
          </div>

          <p className="text-[11px] text-slate-500 dark:text-[#8696A0] mb-2.5 leading-relaxed">
            {connectMode === 'client'
              ? 'Anda terhubung ke host teman dan host ini sekaligus; perangkat di kedua host tetap terpisah.'
              : 'Host Anda & host teman saling terhubung sehingga peserta di Host A, Host B, dan Host C bisa saling chat.'}
          </p>

          <form onSubmit={handleConnectRemote} className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={remoteInput}
                onChange={(e) => {
                  setRemoteInput(e.target.value);
                  if (hostError) setHostError('');
                }}
                placeholder="IP Host, mis. 192.168.43.1:3000"
                className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-[#3B4A54] bg-slate-50 dark:bg-[#2A3942] px-3 py-2 font-mono text-xs text-slate-900 dark:text-[#E9EDEF] placeholder:text-slate-400 focus:border-[#00A884] focus:outline-none"
              />
              <input
                type="text"
                value={remotePinInput}
                onChange={(e) => setRemotePinInput(e.target.value)}
                placeholder="PIN (opsional)"
                className="min-h-[44px] sm:w-32 rounded-lg border border-slate-200 dark:border-[#3B4A54] bg-slate-50 dark:bg-[#2A3942] px-3 py-2 font-mono text-xs text-slate-900 dark:text-[#E9EDEF] placeholder:text-slate-400 focus:border-[#00A884] focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={probing}
              className="w-full min-h-[44px] rounded-lg bg-[#00A884] hover:bg-[#008F72] disabled:opacity-60 px-4 text-xs font-semibold text-[#111B21] transition-colors whitespace-nowrap cursor-pointer"
            >
              {probing
                ? 'Menguji Jangkauan Host...'
                : connectMode === 'bridge'
                ? 'Uji & Buat Bridge Host'
                : 'Uji & Sambung Multi-Host'}
            </button>
          </form>

          {hostSuccess && (
            <p className="mt-2 text-xs text-[#008069] dark:text-[#00A884]">{hostSuccess}</p>
          )}
          {hostError && <p className="mt-2 text-xs text-rose-500">{hostError}</p>}
        </div>

        {/* Active Client Connections List */}
        <div className="border-t border-slate-200 dark:border-[#2A3942] pt-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-slate-800 dark:text-[#E9EDEF] mb-2">
              Koneksi Host Klien ({hostRuntimes.length})
            </p>
            <div className="space-y-2">
              {hostRuntimes.map((rt) => {
                const dotClass =
                  !rt.enabled || rt.status === 'disabled'
                    ? 'bg-slate-400'
                    : rt.status === 'connected'
                    ? 'bg-[#00A884]'
                    : rt.status === 'auth_error'
                    ? 'bg-rose-500'
                    : 'bg-amber-500';
                return (
                  <div
                    key={rt.key}
                    className="rounded-lg border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} />
                          <p className="truncate text-xs font-semibold text-slate-900 dark:text-[#E9EDEF]">
                            {rt.hostLabel || rt.label}
                            {rt.hostId ? (
                              <span className="font-mono font-normal text-slate-500 dark:text-[#8696A0]">
                                {' '}
                                · {rt.hostId}
                              </span>
                            ) : null}
                          </p>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-slate-500 dark:text-[#8696A0]">
                          {formatRuntimeStatus(rt)} · {rt.peersOnline} peer
                        </p>
                        {rt.errorMessage && (
                          <p className="mt-0.5 text-[11px] text-rose-500">{rt.errorMessage}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {rt.status === 'auth_error' && (
                          <button
                            type="button"
                            onClick={() => {
                              setRetryPinHostKey(rt.key);
                              setRetryPinValue('');
                            }}
                            className="min-h-[40px] rounded-md border border-rose-500/40 px-2.5 text-[11px] font-medium text-rose-600 dark:text-rose-400 whitespace-nowrap cursor-pointer"
                          >
                            Isi PIN
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onToggleHostEnabled(rt.key)}
                          title={rt.enabled ? 'Putuskan sementara' : 'Aktifkan kembali'}
                          aria-label={rt.enabled ? 'Nonaktifkan host' : 'Aktifkan host'}
                          className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md text-slate-500 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                        >
                          <Power
                            className={`h-4 w-4 ${rt.enabled ? 'text-[#00A884]' : 'text-slate-400'}`}
                          />
                        </button>
                        {rt.key !== LOCAL_HOST_KEY && (
                          <button
                            type="button"
                            onClick={() => onRemoveRemoteHost(rt.key)}
                            title="Hapus host"
                            aria-label="Hapus host"
                            className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md text-slate-500 hover:text-rose-500 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {retryPinHostKey === rt.key && (
                      <form
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          onUpdateHostAccessCode(rt.key, retryPinValue);
                          setRetryPinHostKey(null);
                        }}
                        className="mt-2 flex items-center gap-2 pt-2 border-t border-slate-200 dark:border-[#2A3942]"
                      >
                        <input
                          type="text"
                          value={retryPinValue}
                          onChange={(e) => setRetryPinValue(e.target.value)}
                          placeholder="Masukkan Kode Akses host"
                          className="min-h-[40px] min-w-0 flex-1 rounded-md border border-slate-300 dark:border-[#3B4A54] bg-white dark:bg-[#2A3942] px-2.5 font-mono text-xs text-slate-900 dark:text-[#E9EDEF]"
                        />
                        <button
                          type="submit"
                          className="min-h-[40px] rounded-md bg-[#00A884] px-3 text-xs font-semibold text-[#111B21] whitespace-nowrap cursor-pointer"
                        >
                          Kirim PIN
                        </button>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Host-to-Host Bridges List */}
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-[#E9EDEF] mb-2">
              <GitMerge className="h-3.5 w-3.5 text-[#00A884]" />
              <span>Jembatan Host Bridge ({hostBridges.length})</span>
            </div>
            {hostBridges.length === 0 ? (
              <p className="text-[11px] text-slate-500 dark:text-[#8696A0]">
                Belum ada bridge aktif. Gunakan mode “Jembatani Host (Bridge)” di atas untuk
                menghubungkan dua host agar peserta A–B–C saling melihat.
              </p>
            ) : (
              <div className="space-y-2">
                {hostBridges.map((br) => (
                  <div
                    key={br.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-slate-900 dark:text-[#E9EDEF]">
                        {br.targetHostLabel || br.targetUrl}
                        {br.targetHostId ? (
                          <span className="font-mono font-normal text-slate-500 dark:text-[#8696A0]">
                            {' '}
                            · {br.targetHostId}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500 dark:text-[#8696A0]">
                        {br.direction === 'inbound' ? 'Bridge Masuk' : 'Bridge Keluar'} ·{' '}
                        {formatBridgeStatus(br)}
                      </p>
                      {br.error && <p className="mt-0.5 text-[11px] text-rose-500">{br.error}</p>}
                    </div>
                    <button
                      type="button"
                      onClick={() => void onRemoveHostBridge(br.id)}
                      title="Putus Bridge"
                      aria-label="Putus Bridge"
                      className="flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-md text-slate-500 hover:text-rose-500 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-[11px] text-slate-500 dark:text-[#8696A0]">
          <Shield className="h-3.5 w-3.5 shrink-0 text-[#00A884]" />
          <span>Seluruh pesan, file, dan panggilan melalui bridge tetap terenkripsi End-to-End.</span>
        </div>
      </div>
    </div>
  );
};
