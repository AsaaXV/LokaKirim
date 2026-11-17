import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Link2, QrCode, RotateCcw, Wifi, X } from 'lucide-react';
import { LOCAL_RUST_HOST_URL, normalizeHostUrl } from '../lib/hostConfig';
import type { RustHostProbeResultDto } from '../lib/tauriBridge';
import type { LanNetworkInfo } from '../types/chat';

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
}

export const WifiShareModal: React.FC<WifiShareModalProps> = ({
  open,
  onClose,
  lanInfo,
  onRefresh,
  hostUrl,
  isTauriApp,
  onProbeHost,
  onSwitchHost,
  onResetHost,
}) => {
  const [selectedUrl, setSelectedUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [remoteInput, setRemoteInput] = useState('');
  const [hostError, setHostError] = useState('');
  const [hostSuccess, setHostSuccess] = useState('');
  const [probing, setProbing] = useState(false);

  const isUsingExternalHost =
    Boolean(hostUrl) &&
    hostUrl !== LOCAL_RUST_HOST_URL &&
    (typeof window === 'undefined' || hostUrl !== window.location.origin);

  useEffect(() => {
    if (open) {
      onRefresh();
      setHostError('');
      setHostSuccess('');
      setRemoteInput(isUsingExternalHost ? hostUrl : '');
    }
  }, [open, onRefresh, isUsingExternalHost, hostUrl]);

  useEffect(() => {
    if (isUsingExternalHost) {
      setSelectedUrl(hostUrl);
    } else if (lanInfo?.primaryUrl) {
      setSelectedUrl(lanInfo.primaryUrl);
    } else if (typeof window !== 'undefined') {
      setSelectedUrl(window.location.origin);
    }
  }, [lanInfo, hostUrl, isUsingExternalHost]);

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

  const handleCopy = async () => {
    if (!selectedUrl) return;
    try {
      await navigator.clipboard.writeText(selectedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
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

    if (onProbeHost) {
      setProbing(true);
      const probe = await onProbeHost(normalized);
      setProbing(false);
      if (!probe.ok) {
        setHostError(
          probe.error ||
            `Tidak dapat menjangkau ${normalized}. Pastikan LokaKirim Host sedang dibuka dan satu Wi-Fi/hotspot.`
        );
        return;
      }
      setHostSuccess(
        `Terhubung ke host (${probe.latencyMs} ms · ${probe.peersOnline} perangkat online)`
      );
    }

    onSwitchHost(normalized);
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
        className="w-full sm:max-w-md max-h-[90dvh] overflow-y-auto rounded-t-2xl sm:rounded-xl border-t sm:border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#202C33] p-5 sm:p-6 pb-safe-modal sm:pb-6 shadow-2xl"
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
                Hubungkan Perangkat di Wi-Fi Ini
              </h3>
              <p className="text-xs text-slate-500 dark:text-[#8696A0]">
                Pindai QR atau sambungkan APK ke alamat IP lokal tanpa internet
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

        {/* QR Display */}
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-4 sm:p-5 mb-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="QR Code alamat Wi-Fi lokal LokaKirim"
              className="h-40 w-40 sm:h-44 sm:w-44 rounded-lg bg-white p-2"
            />
          ) : (
            <div className="flex h-40 w-40 sm:h-44 sm:w-44 items-center justify-center text-xs text-slate-400">
              Membuat QR Code...
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500 dark:text-[#8696A0] text-center">
            {isUsingExternalHost
              ? 'Terhubung sebagai klien ke host Wi-Fi eksternal di bawah ini.'
              : 'Pastikan ponsel atau laptop lain tersambung ke nama Wi-Fi atau hotspot yang sama.'}
          </p>
        </div>

        {/* Address Selector */}
        {!isUsingExternalHost && lanInfo && lanInfo.addresses.length > 1 && (
          <div className="mb-3">
            <label className="block text-xs font-medium text-slate-600 dark:text-[#AEBAC1] mb-1.5">
              Pilih antarmuka jaringan lokal
            </label>
            <div className="flex flex-wrap gap-1.5">
              {lanInfo.addresses.map((addr) => (
                <button
                  key={addr.url}
                  type="button"
                  onClick={() => setSelectedUrl(addr.url)}
                  className={`min-h-[36px] inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-mono cursor-pointer ${
                    selectedUrl === addr.url
                      ? 'border-[#00A884] bg-[#00A884]/15 text-[#008069] dark:text-[#00A884]'
                      : 'border-slate-200 dark:border-[#3B4A54] text-slate-600 dark:text-[#AEBAC1]'
                  }`}
                >
                  <Wifi className="h-3 w-3" />
                  {addr.name} ({addr.address})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Copyable URL */}
        <div className="flex items-center gap-2 mb-4">
          <input
            type="text"
            readOnly
            value={selectedUrl}
            className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-[#3B4A54] bg-slate-50 dark:bg-[#2A3942] px-3 py-2 font-mono text-xs text-slate-800 dark:text-[#E9EDEF] select-all"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="min-h-[44px] inline-flex items-center gap-1.5 rounded-full bg-[#00A884] hover:bg-[#008F72] px-4 py-2 text-xs font-semibold text-[#111B21] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Disalin
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Salin
              </>
            )}
          </button>
        </div>

        {/* Switch Host (Join another phone/laptop host on Wi-Fi) */}
        <div className="border-t border-slate-200 dark:border-[#2A3942] pt-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-[#E9EDEF]">
              <Link2 className="h-3.5 w-3.5 text-[#00A884]" />
              Gabung ke Host Perangkat Lain
            </span>
            {isUsingExternalHost && (
              <button
                type="button"
                onClick={() => {
                  onResetHost();
                  setRemoteInput('');
                  setHostError('');
                }}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[#008069] dark:text-[#00A884] hover:underline cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                {isTauriApp ? 'Host Lokal HP Ini' : 'Host Awal'}
              </button>
            )}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-[#8696A0] mb-2">
            Jika teman Anda sudah membuka ruang di APK atau PC lain, masukkan alamat IP lokalnya.
          </p>
          <form onSubmit={handleConnectRemote} className="flex items-center gap-2">
            <input
              type="text"
              value={remoteInput}
              onChange={(e) => {
                setRemoteInput(e.target.value);
                if (hostError) setHostError('');
              }}
              placeholder="192.168.1.10:3000"
              className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-[#3B4A54] bg-slate-50 dark:bg-[#2A3942] px-3 py-2 font-mono text-xs text-slate-900 dark:text-[#E9EDEF] placeholder:text-slate-400 focus:border-[#00A884] focus:outline-none"
            />
            <button
              type="submit"
              disabled={probing}
              className="min-h-[44px] rounded-full border border-[#00A884] px-4 py-2 text-xs font-semibold text-[#008069] dark:text-[#00A884] hover:bg-[#00A884]/10 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {probing ? 'Menguji...' : 'Sambung'}
            </button>
          </form>
          {hostSuccess && <p className="mt-1.5 text-[11px] text-[#008069] dark:text-[#00A884]">{hostSuccess}</p>}
          {hostError && <p className="mt-1.5 text-[11px] text-rose-500">{hostError}</p>}
        </div>
      </div>
    </div>
  );
};
