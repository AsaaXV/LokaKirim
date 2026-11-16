import React from 'react';
import { Activity, X } from 'lucide-react';
import type { NetworkTelemetry } from '../types/chat';

interface NetworkStatusModalProps {
  open: boolean;
  onClose: () => void;
  telemetry: NetworkTelemetry;
  isTauriApp?: boolean;
  hostUrl?: string;
}

export const NetworkStatusModal: React.FC<NetworkStatusModalProps> = ({
  open,
  onClose,
  telemetry,
  isTauriApp,
  hostUrl,
}) => {
  if (!open) return null;

  const samples = telemetry.samples;
  const maxMs = Math.max(20, ...samples.map((s) => s.ms));

  const points =
    samples.length > 1
      ? samples
          .map((s, idx) => {
            const x = (idx / (samples.length - 1)) * 320;
            const y = 72 - (s.ms / maxMs) * 60;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ')
      : '';

  const statusText = {
    connected: 'Koneksi Wi-Fi Lokal Stabil',
    degraded: 'Koneksi Wi-Fi Lokal Melambat',
    reconnecting: 'Sedang Menyambung Ulang ke Host Lokal',
    disconnected: 'Terputus dari Host Lokal',
  }[telemetry.quality];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="network-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl border-t sm:border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#202C33] p-5 sm:p-6 pb-safe-modal sm:pb-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 dark:bg-[#3B4A54] sm:hidden" />
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00A884]/15 text-[#008069] dark:text-[#00A884]">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h3
                id="network-modal-title"
                className="text-base font-semibold text-slate-900 dark:text-[#E9EDEF]"
              >
                Kestabilan Jaringan Real-Time
              </h3>
              <p className="text-xs text-slate-500 dark:text-[#8696A0]">{statusText}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup detail jaringan"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-400 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Measured RTT Metrics */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-lg border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-3">
            <p className="text-xs text-slate-500 dark:text-[#8696A0]">Latensi Saat Ini</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-[#E9EDEF]">
              {telemetry.latencyMs !== null ? `${telemetry.latencyMs} ms` : '—'}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-3">
            <p className="text-xs text-slate-500 dark:text-[#8696A0]">Rata-rata</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-[#E9EDEF]">
              {telemetry.avgLatencyMs !== null ? `${telemetry.avgLatencyMs} ms` : '—'}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-3">
            <p className="text-xs text-slate-500 dark:text-[#8696A0]">Jitter</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-[#E9EDEF]">
              {telemetry.jitterMs !== null ? `${telemetry.jitterMs} ms` : '—'}
            </p>
          </div>
        </div>

        {/* Real Latency Sparkline */}
        <div className="rounded-lg border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-3.5 mb-4">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-[#8696A0] mb-2">
            <span>Riwayat Ping WebSocket Nyata (24 sampel terakhir)</span>
            <span className="font-mono tabular-nums">Maks {maxMs} ms</span>
          </div>
          {samples.length > 1 ? (
            <svg viewBox="0 0 320 80" className="h-20 w-full overflow-visible">
              <polyline
                fill="none"
                stroke="#00A884"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={points}
              />
            </svg>
          ) : (
            <div className="flex h-20 items-center justify-center text-xs text-slate-400">
              Mengumpulkan sampel latensi...
            </div>
          )}
        </div>

        <div className="space-y-1.5 text-xs text-slate-500 dark:text-[#8696A0] border-t border-slate-200 dark:border-[#2A3942] pt-3">
          <div className="flex items-center justify-between">
            <span>Antrean pesan tertunda</span>
            <span className="font-mono tabular-nums text-slate-700 dark:text-[#E9EDEF]">
              {telemetry.queuedCount}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span>Mesin & Mode Host</span>
            <span className="font-mono text-slate-700 dark:text-[#E9EDEF]">
              {isTauriApp
                ? hostUrl && hostUrl !== 'http://127.0.0.1:3000'
                  ? 'Rust E2EE · Klien Wi-Fi'
                  : 'Rust Native (Host + E2EE)'
                : 'Relay Wi-Fi Lokal'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span>Endpoint lokal</span>
            <span className="font-mono truncate text-slate-700 dark:text-[#E9EDEF]">
              {telemetry.wsEndpoint || '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
