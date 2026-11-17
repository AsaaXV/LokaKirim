import React from 'react';
import { Phone, Users, Video, X } from 'lucide-react';
import type { CallType, PeerInfo } from '../types/chat';

interface RoomCallPickerModalProps {
  open: boolean;
  initialCallType: CallType;
  roomName: string;
  peers: PeerInfo[];
  onClose: () => void;
  onStartCall: (peerId: string, callType: CallType) => void;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase() || 'LK';
}

export const RoomCallPickerModal: React.FC<RoomCallPickerModalProps> = ({
  open,
  initialCallType,
  roomName,
  peers,
  onClose,
  onStartCall,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl bg-white dark:bg-[#202C33] border border-slate-200 dark:border-[#2A3942] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-[#2A3942] px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900 dark:text-[#E9EDEF] truncate">
              {initialCallType === 'video' ? 'Mulai Video Call Wi-Fi' : 'Mulai Telepon Wi-Fi'}
            </h3>
            <p className="text-xs text-slate-500 dark:text-[#8696A0] truncate">
              Pilih perangkat aktif di {roomName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-[#2A3942] cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto p-3">
          {peers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-[#111B21] text-slate-400 mb-3">
                <Users className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-slate-700 dark:text-[#E9EDEF]">
                Belum ada perangkat lain online
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-[#8696A0]">
                Sambungkan perangkat kedua ke Wi-Fi yang sama untuk mulai menelepon atau VC.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {peers.map((peer) => (
                <div
                  key={peer.peerId}
                  className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-[#182229]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00A884]/15 text-xs font-semibold text-[#008069] dark:text-[#00A884]">
                      {getInitials(peer.displayName)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900 dark:text-[#E9EDEF]">
                        {peer.displayName}
                      </p>
                      <p className="truncate text-xs text-slate-500 dark:text-[#8696A0]">
                        {peer.deviceLabel} · Online
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onStartCall(peer.peerId, 'audio');
                      }}
                      aria-label={`Telepon ${peer.displayName}`}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-slate-100 dark:bg-[#2A3942] text-slate-700 dark:text-[#E9EDEF] hover:bg-[#00A884] hover:text-white transition-colors cursor-pointer"
                    >
                      <Phone className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onStartCall(peer.peerId, 'video');
                      }}
                      aria-label={`Video Call ${peer.displayName}`}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-[#00A884]/15 text-[#008069] dark:text-[#00A884] hover:bg-[#00A884] hover:text-white transition-colors cursor-pointer"
                    >
                      <Video className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
