import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Lock,
  Moon,
  MoreVertical,
  QrCode,
  ShieldCheck,
  Sun,
  Trash2,
  Users,
} from 'lucide-react';
import type { ChatTarget, NetworkTelemetry, PeerInfo, RoomInfo } from '../types/chat';

interface TopBarProps {
  onMobileBack: () => void;
  activeTarget: ChatTarget;
  activeRoom?: RoomInfo;
  activePeer?: PeerInfo;
  isVerified: boolean;
  telemetry: NetworkTelemetry;
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenVerification: () => void;
  onOpenNetworkStatus: () => void;
  onOpenWifiShare: () => void;
  onClearActiveHistory: () => void;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase() || 'LK';
}

export const TopBar: React.FC<TopBarProps> = ({
  onMobileBack,
  activeTarget,
  activeRoom,
  activePeer,
  isVerified,
  telemetry,
  isDark,
  onToggleTheme,
  onOpenVerification,
  onOpenNetworkStatus,
  onOpenWifiShare,
  onClearActiveHistory,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [menuOpen]);

  const title =
    activeTarget.type === 'room'
      ? activeRoom?.name || 'Ruang Lokal'
      : activePeer?.displayName || 'Perangkat Offline';

  const subtitle =
    activeTarget.type === 'room'
      ? `${activeRoom?.memberIds.length || 0} perangkat di Wi-Fi ini`
      : activePeer
      ? `online · ${activePeer.deviceLabel}`
      : 'tidak tersambung';

  const statusConfig = {
    connected: {
      label: 'Stabil',
      dotClass: 'bg-[#00A884]',
      textClass: 'text-[#008069] dark:text-[#00A884]',
    },
    degraded: {
      label: 'Melambat',
      dotClass: 'bg-amber-500',
      textClass: 'text-amber-600 dark:text-amber-400',
    },
    reconnecting: {
      label: 'Menyambung',
      dotClass: 'bg-amber-500 animate-pulse',
      textClass: 'text-amber-600 dark:text-amber-400',
    },
    disconnected: {
      label: 'Terputus',
      dotClass: 'bg-red-500',
      textClass: 'text-red-600 dark:text-red-400',
    },
  }[telemetry.quality];

  return (
    <header className="relative z-20 flex h-14 lg:h-16 shrink-0 items-center justify-between gap-2 border-b border-slate-200 dark:border-[#222E35] bg-[#F0F2F5] dark:bg-[#202C33] px-1.5 sm:px-4">
      {/* Left: Android Back Button + Avatar + Contact/Room Info */}
      <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 flex-1">
        <button
          type="button"
          onClick={onMobileBack}
          aria-label="Kembali ke daftar obrolan"
          className="lg:hidden flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full text-slate-700 dark:text-[#E9EDEF] hover:bg-black/5 dark:hover:bg-white/10 active:bg-black/10 cursor-pointer"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>

        <div className="flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-full bg-slate-300/70 dark:bg-[#6B7C85]/35 text-xs sm:text-sm font-semibold text-slate-700 dark:text-[#E9EDEF]">
          {activeTarget.type === 'room' ? (
            <Users className="h-4 w-4 sm:h-5 sm:w-5" />
          ) : (
            getInitials(title)
          )}
        </div>

        <button
          type="button"
          onClick={onOpenVerification}
          className="min-w-0 flex-1 text-left py-1 cursor-pointer"
        >
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-sm sm:text-[15px] font-semibold text-slate-900 dark:text-[#E9EDEF]">
              {title}
            </h2>
            {isVerified && (
              <ShieldCheck
                className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-[#00A884]"
                aria-label="Terenkripsi & terverifikasi"
              />
            )}
          </div>
          <p className="truncate text-[11px] sm:text-xs text-slate-500 dark:text-[#8696A0]">
            {subtitle}
          </p>
        </button>
      </div>

      {/* Right: Real-Time Network Telemetry + Actions */}
      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onOpenNetworkStatus}
          title="Lihat statistik kestabilan jaringan Wi-Fi real-time"
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-white/80 dark:bg-[#111B21]/70 hover:bg-white dark:hover:bg-[#111B21] border border-slate-200 dark:border-[#2A3942] px-2.5 py-1 text-[11px] sm:text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <span className={`h-2 w-2 rounded-full shrink-0 ${statusConfig.dotClass}`} />
          <span className={`hidden xs:inline ${statusConfig.textClass}`}>
            {statusConfig.label}
          </span>
          {telemetry.latencyMs !== null ? (
            <span className="font-mono tabular-nums text-slate-600 dark:text-[#AEBAC1]">
              {telemetry.latencyMs} ms
            </span>
          ) : (
            <Activity className="h-3 w-3 text-slate-400" />
          )}
        </button>

        {/* Desktop Direct Action Buttons */}
        <div className="hidden md:flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenVerification}
            title="Info Enkripsi & Kode Verifikasi"
            className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              isVerified
                ? 'bg-[#00A884]/15 text-[#008069] dark:text-[#00A884]'
                : 'text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            {isVerified ? <ShieldCheck className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            <span>{isVerified ? 'Terverifikasi' : 'Kode Enkripsi'}</span>
          </button>

          <button
            type="button"
            onClick={onOpenWifiShare}
            title="Bagikan QR & IP Wi-Fi Lokal"
            aria-label="Bagikan QR Wi-Fi"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <QrCode className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={onClearActiveHistory}
            title="Bersihkan pesan di obrolan ini"
            aria-label="Bersihkan obrolan"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-600 dark:text-[#AEBAC1] hover:text-red-600 dark:hover:text-red-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            title={isDark ? 'Beralih ke Mode Terang' : 'Beralih ke Mode Gelap'}
            aria-label={isDark ? 'Mode Terang' : 'Mode Gelap'}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            {isDark ? <Sun className="h-5 w-5 text-amber-400" /> : <Moon className="h-5 w-5" />}
          </button>
        </div>

        {/* Mobile Overflow Menu (keeps narrow 360px Android header clean) */}
        <div className="relative md:hidden" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Menu obrolan"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-700 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
          >
            <MoreVertical className="h-5 w-5" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-12 z-40 w-56 rounded-xl border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#233138] py-1.5 shadow-xl">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenVerification();
                }}
                className="w-full min-h-[44px] flex items-center gap-3 px-4 py-2 text-left text-sm text-slate-800 dark:text-[#E9EDEF] hover:bg-slate-100 dark:hover:bg-[#182229] cursor-pointer"
              >
                {isVerified ? (
                  <ShieldCheck className="h-4 w-4 text-[#00A884]" />
                ) : (
                  <Lock className="h-4 w-4 text-[#00A884]" />
                )}
                <span>{isVerified ? 'Enkripsi Terverifikasi' : 'Kode Verifikasi E2E'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenWifiShare();
                }}
                className="w-full min-h-[44px] flex items-center gap-3 px-4 py-2 text-left text-sm text-slate-800 dark:text-[#E9EDEF] hover:bg-slate-100 dark:hover:bg-[#182229] cursor-pointer"
              >
                <QrCode className="h-4 w-4" />
                <span>Bagikan QR Wi-Fi</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onToggleTheme();
                }}
                className="w-full min-h-[44px] flex items-center gap-3 px-4 py-2 text-left text-sm text-slate-800 dark:text-[#E9EDEF] hover:bg-slate-100 dark:hover:bg-[#182229] cursor-pointer"
              >
                {isDark ? (
                  <Sun className="h-4 w-4 text-amber-400" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
                <span>{isDark ? 'Mode Terang' : 'Mode Gelap'}</span>
              </button>

              <div className="my-1 border-t border-slate-100 dark:border-[#2A3942]" />

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onClearActiveHistory();
                }}
                className="w-full min-h-[44px] flex items-center gap-3 px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-slate-100 dark:hover:bg-[#182229] cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
                <span>Bersihkan Obrolan Ini</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
