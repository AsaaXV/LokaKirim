import React, { useState } from 'react';
import { Hash, X } from 'lucide-react';

interface CreateRoomModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (roomName: string) => Promise<void>;
}

export const CreateRoomModal: React.FC<CreateRoomModalProps> = ({
  open,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(name.trim());
      setName('');
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-room-title"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-xl border-t sm:border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#202C33] p-5 sm:p-6 pb-safe-modal sm:pb-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 dark:bg-[#3B4A54] sm:hidden" />
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#00A884]/15 text-[#008069] dark:text-[#00A884]">
              <Hash className="h-4 w-4" />
            </div>
            <h3
              id="create-room-title"
              className="text-base font-semibold text-slate-900 dark:text-[#E9EDEF]"
            >
              Buat Ruang Grup Lokal
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-400 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="room-name-input"
              className="block text-xs font-medium text-slate-600 dark:text-[#AEBAC1] mb-1.5"
            >
              Nama Ruang Grup
            </label>
            <input
              id="room-name-input"
              type="text"
              autoFocus
              maxLength={48}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: Tim Desain, Berbagi Foto, Kelas A"
              className="min-h-[44px] w-full rounded-lg border border-slate-300 dark:border-[#3B4A54] bg-slate-50 dark:bg-[#2A3942] px-3.5 py-2 text-sm text-slate-900 dark:text-[#E9EDEF] placeholder:text-slate-400 dark:placeholder:text-[#8696A0] focus:outline-none focus:ring-2 focus:ring-[#00A884]"
            />
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-full border border-slate-200 dark:border-[#3B4A54] px-5 py-2 text-xs font-medium text-slate-700 dark:text-[#E9EDEF] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              className="min-h-[44px] rounded-full bg-[#00A884] hover:bg-[#008F72] disabled:opacity-50 px-5 py-2 text-xs font-semibold text-[#111B21] cursor-pointer"
            >
              Buat Ruang
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
