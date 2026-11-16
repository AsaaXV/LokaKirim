import React from 'react';
import { Lock, ShieldCheck, ShieldOff, X } from 'lucide-react';

interface VerificationModalProps {
  open: boolean;
  onClose: () => void;
  targetName: string;
  targetType: 'room' | 'dm';
  safetyCode: string;
  isVerified: boolean;
  onToggleVerify: (verified: boolean) => void;
}

export const VerificationModal: React.FC<VerificationModalProps> = ({
  open,
  onClose,
  targetName,
  targetType,
  safetyCode,
  isVerified,
  onToggleVerify,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="verify-title"
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
              {isVerified ? (
                <ShieldCheck className="h-5 w-5" />
              ) : (
                <Lock className="h-5 w-5" />
              )}
            </div>
            <div>
              <h3
                id="verify-title"
                className="text-base font-semibold text-slate-900 dark:text-[#E9EDEF]"
              >
                Verifikasi Enkripsi E2E
              </h3>
              <p className="text-xs text-slate-500 dark:text-[#8696A0]">
                {targetType === 'room' ? 'Ruang Grup' : 'Chat Pribadi'} · {targetName}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup modal verifikasi"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-slate-400 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm text-slate-600 dark:text-[#AEBAC1] leading-relaxed mb-4">
          Seluruh pesan dan potongan file pada percakapan ini dienkripsi dengan{' '}
          <strong>ECDH P-256 + AES-256-GCM</strong>. Cocokkan kode verifikasi di bawah ini
          dengan perangkat lawan bicara untuk memastikan tidak ada penyadapan di jaringan Wi-Fi.
        </p>

        <div className="rounded-lg border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-4 mb-5 text-center">
          <p className="text-xs font-medium text-slate-500 dark:text-[#8696A0] mb-2">
            Kode Sidik Jari Keamanan
          </p>
          <p className="font-mono text-base sm:text-lg font-semibold tracking-wider tabular-nums text-slate-900 dark:text-[#E9EDEF] select-all">
            {safetyCode || 'Menunggu pertukaran kunci...'}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-full border border-slate-200 dark:border-[#3B4A54] px-5 py-2 text-xs font-medium text-slate-700 dark:text-[#E9EDEF] hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer"
          >
            Tutup
          </button>
          {safetyCode && (
            <button
              type="button"
              onClick={() => onToggleVerify(!isVerified)}
              className={`min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                isVerified
                  ? 'border border-slate-200 dark:border-[#3B4A54] bg-slate-100 dark:bg-[#2A3942] text-slate-700 dark:text-[#E9EDEF] hover:bg-slate-200 dark:hover:bg-[#374650]'
                  : 'bg-[#00A884] hover:bg-[#008F72] text-[#111B21]'
              }`}
            >
              {isVerified ? (
                <>
                  <ShieldOff className="h-3.5 w-3.5" />
                  Cabut Verifikasi
                </>
              ) : (
                <>
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Tandai Terverifikasi
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
