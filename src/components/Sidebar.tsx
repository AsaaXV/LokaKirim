import React, { useMemo, useState } from 'react';
import {
  Check,
  Edit2,
  MessageSquarePlus,
  Moon,
  QrCode,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { formatTime, makeConversationId } from '../lib/format';
import type {
  ChatMessageRecord,
  ChatTarget,
  NetworkTelemetry,
  PeerInfo,
  RoomInfo,
  StoredDeviceIdentity,
  VerifiedPeerRecord,
} from '../types/chat';

interface SidebarProps {
  visibleOnMobile: boolean;
  identity: StoredDeviceIdentity | null;
  onRenameSelf: (name: string) => Promise<void>;
  rooms: RoomInfo[];
  peers: PeerInfo[];
  activeTarget: ChatTarget;
  onSelectTarget: (target: ChatTarget) => void;
  onJoinRoom: (roomId: string) => void;
  lastMessages: Record<string, ChatMessageRecord>;
  unreadCounts: Record<string, number>;
  telemetry: NetworkTelemetry;
  verifiedPeers: Record<string, VerifiedPeerRecord>;
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenNetworkStatus: () => void;
  onOpenCreateRoom: () => void;
  onOpenWifiShare: () => void;
  onClearAllHistory: () => void;
}

type FilterTab = 'all' | 'rooms' | 'peers';

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || 'LK';
}

function formatPreview(msg: ChatMessageRecord | undefined, selfId: string): string {
  if (!msg) return 'Belum ada pesan · Terenkripsi E2E';
  const prefix = msg.senderId === selfId ? 'Anda: ' : '';
  if (msg.kind === 'file' && msg.file) {
    return `${prefix}📎 ${msg.file.fileName}`;
  }
  return `${prefix}${msg.text || ''}`;
}

export const Sidebar: React.FC<SidebarProps> = ({
  visibleOnMobile,
  identity,
  onRenameSelf,
  rooms,
  peers,
  activeTarget,
  onSelectTarget,
  onJoinRoom,
  lastMessages,
  unreadCounts,
  telemetry,
  verifiedPeers,
  isDark,
  onToggleTheme,
  onOpenNetworkStatus,
  onOpenCreateRoom,
  onOpenWifiShare,
  onClearAllHistory,
}) => {
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  const handleStartEdit = () => {
    setNameInput(identity?.displayName || '');
    setEditingName(true);
  };

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameInput.trim()) {
      await onRenameSelf(nameInput.trim());
    }
    setEditingName(false);
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredRooms = useMemo(() => {
    if (filterTab === 'peers') return [];
    return rooms.filter((r) => r.name.toLowerCase().includes(normalizedQuery));
  }, [rooms, filterTab, normalizedQuery]);

  const filteredPeers = useMemo(() => {
    if (filterTab === 'rooms') return [];
    return peers.filter(
      (p) =>
        p.displayName.toLowerCase().includes(normalizedQuery) ||
        p.deviceLabel.toLowerCase().includes(normalizedQuery)
    );
  }, [peers, filterTab, normalizedQuery]);

  const statusDot = {
    connected: 'bg-[#00A884]',
    degraded: 'bg-amber-500',
    reconnecting: 'bg-amber-500 animate-pulse',
    disconnected: 'bg-red-500',
  }[telemetry.quality];

  const statusLabel = {
    connected: 'Stabil',
    degraded: 'Melambat',
    reconnecting: 'Menyambung',
    disconnected: 'Terputus',
  }[telemetry.quality];

  return (
    <aside
      className={`${
        visibleOnMobile ? 'flex' : 'hidden lg:flex'
      } relative h-full w-full lg:w-[350px] shrink-0 flex-col border-r border-slate-200 dark:border-[#222E35] bg-white dark:bg-[#111B21]`}
    >
      {/* WhatsApp-style Top Header */}
      <div className="flex h-14 lg:h-16 shrink-0 items-center justify-between gap-2 bg-[#F0F2F5] dark:bg-[#202C33] px-3 sm:px-4">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {identity ? (
            editingName ? (
              <form onSubmit={handleSaveName} className="flex items-center gap-1.5 flex-1">
                <input
                  type="text"
                  autoFocus
                  maxLength={40}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 dark:border-[#3B4A54] bg-white dark:bg-[#2A3942] px-3 py-2 text-sm text-slate-900 dark:text-[#E9EDEF] focus:outline-none focus:ring-2 focus:ring-[#00A884]"
                />
                <button
                  type="submit"
                  aria-label="Simpan nama"
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-[#00A884] text-[#111B21] hover:bg-[#008F72] cursor-pointer"
                >
                  <Check className="h-4 w-4" />
                </button>
              </form>
            ) : (
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00A884] text-sm font-semibold text-[#111B21]">
                  {getInitials(identity.displayName)}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <p className="truncate text-[15px] font-semibold text-slate-900 dark:text-[#E9EDEF]">
                      {identity.displayName}
                    </p>
                    <button
                      type="button"
                      onClick={handleStartEdit}
                      title="Ubah nama perangkat"
                      aria-label="Ubah nama perangkat"
                      className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full text-slate-500 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-[#8696A0] truncate">
                    LokaKirim Wi-Fi
                  </p>
                </div>
              </div>
            )
          ) : (
            <span className="text-lg font-bold text-[#008069] dark:text-[#E9EDEF]">
              LokaKirim
            </span>
          )}
        </div>

        {/* Header Action Icons (44px+ hitboxes) */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={onOpenNetworkStatus}
            title="Status koneksi Wi-Fi lokal"
            className="lg:hidden inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-white/80 dark:bg-[#111B21]/70 border border-slate-200 dark:border-[#2A3942] px-2.5 py-1 text-[11px] font-medium cursor-pointer"
          >
            <span className={`h-2 w-2 rounded-full ${statusDot}`} />
            <span className="text-slate-700 dark:text-[#E9EDEF]">
              {telemetry.latencyMs !== null ? `${telemetry.latencyMs} ms` : statusLabel}
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenWifiShare}
            title="QR & Alamat Wi-Fi Lokal"
            aria-label="Bagikan QR Wi-Fi"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <QrCode className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={onOpenCreateRoom}
            title="Buat ruang grup baru"
            aria-label="Buat ruang grup baru"
            className="hidden lg:flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            <MessageSquarePlus className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            title={isDark ? 'Mode Terang' : 'Mode Gelap'}
            aria-label={isDark ? 'Beralih ke Mode Terang' : 'Beralih ke Mode Gelap'}
            className="flex lg:hidden min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
          >
            {isDark ? <Sun className="h-5 w-5 text-amber-400" /> : <Moon className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Search Input & Filter Tabs */}
      <div className="px-3 pt-2.5 pb-2 space-y-2 border-b border-slate-100 dark:border-[#222E35]">
        <div className="flex items-center gap-2.5 rounded-xl bg-[#F0F2F5] dark:bg-[#202C33] px-3.5 py-2">
          <Search className="h-4 w-4 shrink-0 text-slate-500 dark:text-[#8696A0]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari ruang atau perangkat di Wi-Fi"
            className="w-full bg-transparent text-sm text-slate-900 dark:text-[#E9EDEF] placeholder:text-slate-500 dark:placeholder:text-[#8696A0] focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Bersihkan pencarian"
              className="flex min-h-[32px] min-w-[32px] items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto">
          {(
            [
              { id: 'all', label: 'Semua' },
              { id: 'rooms', label: `Grup (${rooms.length})` },
              { id: 'peers', label: `Perangkat (${peers.length})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterTab(tab.id)}
              className={`min-h-[36px] rounded-full px-3.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filterTab === tab.id
                  ? 'bg-[#00A884]/15 text-[#008069] dark:bg-[#00A884]/20 dark:text-[#00A884]'
                  : 'bg-[#F0F2F5] dark:bg-[#202C33] text-slate-600 dark:text-[#8696A0] hover:text-slate-900 dark:hover:text-[#E9EDEF]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Unified WhatsApp Chat List */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-[#222E35]/70 pb-20 lg:pb-2">
        {filteredRooms.map((room) => {
          const isSelected = activeTarget.type === 'room' && activeTarget.id === room.roomId;
          const isMember = identity ? room.memberIds.includes(identity.peerId) : true;
          const convId = makeConversationId('room', room.roomId);
          const unread = unreadCounts[convId] || 0;
          const lastMsg = lastMessages[convId];

          return (
            <button
              key={room.roomId}
              type="button"
              onClick={() => {
                if (!isMember) {
                  onJoinRoom(room.roomId);
                } else {
                  onSelectTarget({ type: 'room', id: room.roomId });
                }
              }}
              className={`w-full min-h-[68px] flex items-center gap-3.5 px-4 py-3 text-left transition-colors active:bg-[#E9EDEF] dark:active:bg-[#2A3942] cursor-pointer ${
                isSelected
                  ? 'lg:bg-[#F0F2F5] lg:dark:bg-[#2A3942]'
                  : 'hover:bg-[#F5F6F6] dark:hover:bg-[#202C33]'
              }`}
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-200 dark:bg-[#6B7C85]/30 text-slate-700 dark:text-[#D1D7DB]">
                <Users className="h-5 w-5" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[15px] font-medium text-slate-900 dark:text-[#E9EDEF]">
                    {room.name}
                  </p>
                  <span
                    className={`shrink-0 font-mono text-[11px] tabular-nums ${
                      unread > 0
                        ? 'text-[#00A884] font-semibold'
                        : 'text-slate-500 dark:text-[#8696A0]'
                    }`}
                  >
                    {lastMsg ? formatTime(lastMsg.timestamp) : `${room.memberIds.length} aktif`}
                  </span>
                </div>

                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="truncate text-[13px] text-slate-500 dark:text-[#8696A0]">
                    {isMember
                      ? formatPreview(lastMsg, identity?.peerId || '')
                      : 'Ketuk untuk bergabung ke ruang Wi-Fi'}
                  </p>
                  {unread > 0 && (
                    <span className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[#00A884] px-1.5 font-mono text-[11px] font-semibold tabular-nums text-[#111B21]">
                      {unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}

        {filteredPeers.map((peer) => {
          const isSelected = activeTarget.type === 'dm' && activeTarget.id === peer.peerId;
          const convId = makeConversationId('dm', peer.peerId);
          const unread = unreadCounts[convId] || 0;
          const isVerified = Boolean(verifiedPeers[peer.peerId]);
          const lastMsg = lastMessages[convId];

          return (
            <button
              key={peer.peerId}
              type="button"
              onClick={() => onSelectTarget({ type: 'dm', id: peer.peerId })}
              className={`w-full min-h-[68px] flex items-center gap-3.5 px-4 py-3 text-left transition-colors active:bg-[#E9EDEF] dark:active:bg-[#2A3942] cursor-pointer ${
                isSelected
                  ? 'lg:bg-[#F0F2F5] lg:dark:bg-[#2A3942]'
                  : 'hover:bg-[#F5F6F6] dark:hover:bg-[#202C33]'
              }`}
            >
              <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#008069]/15 dark:bg-[#00A884]/20 text-sm font-semibold text-[#008069] dark:text-[#00A884]">
                {getInitials(peer.displayName)}
                <span
                  className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white dark:border-[#111B21] bg-[#00A884]"
                  title="Online di Wi-Fi"
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-center gap-1 min-w-0">
                    <p className="truncate text-[15px] font-medium text-slate-900 dark:text-[#E9EDEF]">
                      {peer.displayName}
                    </p>
                    {isVerified && (
                      <ShieldCheck
                        className="h-3.5 w-3.5 shrink-0 text-[#00A884]"
                        aria-label="Terverifikasi"
                      />
                    )}
                  </div>
                  <span
                    className={`shrink-0 font-mono text-[11px] tabular-nums ${
                      unread > 0
                        ? 'text-[#00A884] font-semibold'
                        : 'text-slate-500 dark:text-[#8696A0]'
                    }`}
                  >
                    {lastMsg ? formatTime(lastMsg.timestamp) : peer.deviceLabel}
                  </span>
                </div>

                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="truncate text-[13px] text-slate-500 dark:text-[#8696A0]">
                    {lastMsg
                      ? formatPreview(lastMsg, identity?.peerId || '')
                      : `${peer.deviceLabel} · Tersambung di Wi-Fi`}
                  </p>
                  {unread > 0 && (
                    <span className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[#00A884] px-1.5 font-mono text-[11px] font-semibold tabular-nums text-[#111B21]">
                      {unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}

        {peers.length === 0 && filterTab !== 'rooms' && !normalizedQuery && (
          <div className="px-5 py-6 text-center">
            <div className="mx-auto mb-2.5 flex h-11 w-11 items-center justify-center rounded-full bg-[#00A884]/15 text-[#00A884]">
              <Wifi className="h-5 w-5" />
            </div>
            <p className="text-xs text-slate-600 dark:text-[#8696A0] leading-relaxed mb-3">
              Belum ada perangkat lain di Wi-Fi ini. Bagikan QR agar HP atau laptop lain bisa
              langsung chat.
            </p>
            <button
              type="button"
              onClick={onOpenWifiShare}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[#00A884] hover:bg-[#008F72] px-5 py-2 text-xs font-semibold text-[#111B21] transition-colors cursor-pointer"
            >
              <QrCode className="h-4 w-4" />
              Bagikan QR Wi-Fi
            </button>
          </div>
        )}
      </div>

      {/* WhatsApp Android Floating Action Button (Mobile thumb zone) */}
      <button
        type="button"
        onClick={onOpenCreateRoom}
        aria-label="Buat ruang grup baru"
        title="Buat ruang grup lokal"
        className="lg:hidden fixed bottom-16 right-4 z-20 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#00A884] hover:bg-[#008F72] active:scale-95 text-[#111B21] shadow-lg transition-transform cursor-pointer"
      >
        <MessageSquarePlus className="h-6 w-6" />
      </button>

      {/* Bottom Clear History Footer */}
      <div className="border-t border-slate-200 dark:border-[#222E35] bg-[#F0F2F5]/60 dark:bg-[#111B21] px-3 py-2 pb-safe">
        {confirmClearAll ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5">
            <span className="text-xs text-red-600 dark:text-red-400 font-medium">
              Hapus semua riwayat?
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  onClearAllHistory();
                  setConfirmClearAll(false);
                }}
                className="min-h-[36px] rounded px-3 py-1 text-xs font-semibold bg-red-600 text-white hover:bg-red-500 cursor-pointer"
              >
                Ya
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearAll(false)}
                className="min-h-[36px] rounded px-3 py-1 text-xs text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
              >
                Batal
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClearAll(true)}
            className="w-full min-h-[40px] flex items-center justify-center gap-2 rounded-lg py-1.5 text-xs font-medium text-slate-500 dark:text-[#8696A0] hover:text-red-600 dark:hover:text-red-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Hapus Semua Riwayat Lokal</span>
          </button>
        )}
      </div>
    </aside>
  );
};
