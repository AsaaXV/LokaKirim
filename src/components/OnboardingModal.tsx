import React, { useState } from 'react';
import { Lock, ShieldCheck, Wifi } from 'lucide-react';
import { detectDeviceLabel } from '../lib/format';

interface OnboardingModalProps {
  open: boolean;
  onComplete: (displayName: string) => Promise<void>;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({ open, onComplete }) => {
  const defaultSuggestion = `Perangkat ${detectDeviceLabel()}`;
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await onComplete(name.trim() || defaultSuggestion);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#202C33] p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00A884]/15 text-[#008069] dark:text-[#00A884]">
            <Wifi className="h-5 w-5" />
          </div>
          <div>
            <h1
              id="onboarding-title"
              className="text-lg font-semibold text-slate-900 dark:text-[#E9EDEF]"
            >
              Selamat datang di LokaKirim
            </h1>
            <p className="text-xs text-slate-500 dark:text-[#8696A0]">
              Chat &amp; transfer file jaringan Wi-Fi lokal tanpa internet
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="device-name-input"
              className="block text-sm font-medium text-slate-700 dark:text-[#E9EDEF] mb-1.5"
            >
              Nama perangkat Anda di jaringan ini
            </label>
            <input
              id="device-name-input"
              type="text"
              autoFocus
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`Contoh: ${defaultSuggestion} atau Laptop Budi`}
              className="w-full rounded-lg border border-slate-300 dark:border-[#3B4A54] bg-slate-50 dark:bg-[#2A3942] px-3.5 py-2.5 text-sm text-slate-900 dark:text-[#E9EDEF] placeholder:text-slate-400 dark:placeholder:text-[#8696A0] focus:outline-none focus:ring-2 focus:ring-[#00A884]"
            />
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 dark:border-[#2A3942] bg-slate-50 dark:bg-[#111B21] p-3.5 text-xs text-slate-600 dark:text-[#AEBAC1]">
            <div className="flex items-start gap-2.5">
              <Lock className="h-4 w-4 shrink-0 text-[#008069] dark:text-[#00A884] mt-0.5" />
              <span>
                Pasangan kunci enkripsi <strong>ECDH P-256 &amp; AES-256-GCM</strong> dibuat
                otomatis langsung di browser Anda.
              </span>
            </div>
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="h-4 w-4 shrink-0 text-[#008069] dark:text-[#00A884] mt-0.5" />
              <span>
                Riwayat percakapan dan file disimpan lokal di perangkat ini tanpa dikirim ke
                internet.
              </span>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-full bg-[#00A884] hover:bg-[#008F72] disabled:opacity-60 px-4 py-2.5 text-sm font-semibold text-[#111B21] transition-colors cursor-pointer"
          >
            {submitting ? 'Menyiapkan Kunci Enkripsi...' : 'Masuk ke Jaringan Wi-Fi'}
          </button>
        </form>
      </div>
    </div>
  );
};
