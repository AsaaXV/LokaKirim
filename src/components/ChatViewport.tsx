import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCheck,
  Clock,
  Download,
  FileText,
  Image as ImageIcon,
  Lock,
  Paperclip,
  Phone,
  Send,
  UploadCloud,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import {
  formatBytes,
  formatDateDivider,
  formatSpeed,
  formatTime,
  isPreviewableImage,
} from '../lib/format';
import type { ChatMessageRecord } from '../types/chat';

interface ChatViewportProps {
  messages: ChatMessageRecord[];
  selfPeerId: string;
  fileUrls: Record<string, string>;
  isTargetOffline?: boolean;
  isGroupChat: boolean;
  onOpenVerification: () => void;
  onSendText: (text: string) => Promise<void>;
  onSendFiles: (files: File[]) => Promise<void>;
  onCancelTransfer: (transferId: string) => void;
}

const SENDER_NAME_COLORS = [
  'text-emerald-600 dark:text-[#53BDEB]',
  'text-amber-600 dark:text-[#F5B041]',
  'text-pink-600 dark:text-[#FF7EB6]',
  'text-violet-600 dark:text-[#A594F9]',
  'text-cyan-600 dark:text-[#00A884]',
];

function getSenderColor(senderId: string): string {
  let hash = 0;
  for (let i = 0; i < senderId.length; i++) {
    hash = (hash * 31 + senderId.charCodeAt(i)) | 0;
  }
  return SENDER_NAME_COLORS[Math.abs(hash) % SENDER_NAME_COLORS.length];
}

export const ChatViewport: React.FC<ChatViewportProps> = ({
  messages,
  selfPeerId,
  fileUrls,
  isTargetOffline = false,
  isGroupChat,
  onOpenVerification,
  onSendText,
  onSendFiles,
  onCancelTransfer,
}) => {
  const [text, setText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ url: string; name: string } | null>(
    null
  );
  const dragCounterRef = useRef(0);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const docInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    await onSendText(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    setAttachSheetOpen(false);
    if (selected.length > 0) {
      await onSendFiles(selected);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) {
      await onSendFiles(dropped);
    }
  };

  let lastDateLabel = '';

  return (
    <div
      className="relative flex flex-1 flex-col min-h-0 wa-chat-bg"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-4 z-30 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#00A884] bg-[#0B141A]/80 backdrop-blur-xs pointer-events-none">
          <UploadCloud className="h-12 w-12 text-[#00A884] mb-3" />
          <p className="text-base font-semibold text-white">
            Lepaskan file untuk mengirim via Wi-Fi lokal
          </p>
          <p className="text-xs text-[#AEBAC1] mt-1">
            Gambar atau dokumen besar dienkripsi End-to-End per blok
          </p>
        </div>
      )}

      {/* Message Stream */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-8 lg:px-14 py-4">
        <div className="mx-auto max-w-4xl space-y-2">
          {/* Classic WhatsApp E2EE Notice Banner */}
          <div className="flex justify-center mb-3">
            <button
              type="button"
              onClick={onOpenVerification}
              className="max-w-lg rounded-lg bg-[#FFEECD] dark:bg-[#182229] px-4 py-2 text-center text-xs leading-relaxed text-[#54656F] dark:text-[#FFD279] shadow-xs hover:opacity-90 transition-opacity cursor-pointer"
            >
              <Lock className="inline h-3 w-3 mr-1.5 -mt-0.5" />
              Pesan dan file di obrolan Wi-Fi lokal ini dilindungi enkripsi End-to-End
              (AES-256-GCM). Ketuk untuk melihat kode verifikasi keamanan.
            </button>
          </div>

          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="rounded-2xl bg-white/95 dark:bg-[#182229]/95 px-6 py-5 max-w-sm shadow-xs border border-black/5 dark:border-white/5">
                <p className="text-sm font-medium text-slate-800 dark:text-[#E9EDEF] mb-1">
                  Belum ada pesan di obrolan ini
                </p>
                <p className="text-xs text-slate-500 dark:text-[#8696A0] mb-4">
                  Mulai mengobrol atau kirim foto, kamera, dan dokumen besar tanpa internet.
                </p>
                <button
                  type="button"
                  onClick={() => setAttachSheetOpen(true)}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[#00A884] hover:bg-[#008F72] px-5 py-2 text-xs font-semibold text-[#111B21] transition-colors cursor-pointer"
                >
                  <Paperclip className="h-4 w-4" />
                  Kirim Foto / Dokumen
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const dateLabel = formatDateDivider(msg.timestamp);
              const showDateDivider = dateLabel !== lastDateLabel;
              lastDateLabel = dateLabel;

              const isSelf = msg.senderId === selfPeerId;
              const prevMsg = idx > 0 ? messages[idx - 1] : null;
              const isFirstInBurst =
                showDateDivider || !prevMsg || prevMsg.senderId !== msg.senderId;

              const file = msg.file;
              const fileUrl = file ? fileUrls[file.transferId] : undefined;
              const isImage =
                file && isPreviewableImage(file.mimeType, file.fileName) && Boolean(fileUrl);

              return (
                <React.Fragment key={msg.id}>
                  {showDateDivider && (
                    <div className="flex items-center justify-center my-3">
                      <span className="rounded-lg bg-white/95 dark:bg-[#182229] px-3 py-1 text-[11px] font-medium text-slate-600 dark:text-[#8696A0] shadow-xs">
                        {dateLabel}
                      </span>
                    </div>
                  )}

                  {msg.kind === 'system' ? (
                    <div className="flex items-center justify-center my-2">
                      <div className="inline-flex items-center gap-2 rounded-lg bg-white/90 dark:bg-[#182229] border border-slate-200/80 dark:border-[#2A3942] px-3 py-1.5 text-xs text-slate-700 dark:text-[#AEBAC1] shadow-xs">
                        {msg.text?.toLowerCase().includes('video') ? (
                          <Video className="h-3.5 w-3.5 text-[#00A884] shrink-0" />
                        ) : (
                          <Phone className="h-3.5 w-3.5 text-[#00A884] shrink-0" />
                        )}
                        <span>{msg.text}</span>
                        <span className="font-mono tabular-nums text-[11px] text-slate-400 dark:text-[#8696A0]">
                          · {formatTime(msg.timestamp)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div
                      className={`flex ${isSelf ? 'justify-end' : 'justify-start'} ${
                        isFirstInBurst ? 'mt-2.5' : 'mt-0.5'
                      }`}
                    >
                    <div
                      className={`relative max-w-[86%] sm:max-w-[70%] rounded-lg shadow-xs ${
                        isSelf
                          ? `bg-[#D9FDD3] dark:bg-[#005C4B] text-[#111B21] dark:text-[#E9EDEF] ${
                              isFirstInBurst ? 'rounded-tr-none' : ''
                            }`
                          : `bg-white dark:bg-[#202C33] text-[#111B21] dark:text-[#E9EDEF] ${
                              isFirstInBurst ? 'rounded-tl-none' : ''
                            }`
                      }`}
                    >
                      {!isSelf && isGroupChat && isFirstInBurst && (
                        <p
                          className={`px-3 pt-1.5 text-xs font-semibold ${getSenderColor(
                            msg.senderId
                          )}`}
                        >
                          {msg.senderName}
                        </p>
                      )}

                      {msg.kind === 'text' && (
                        <div className="px-3 py-1.5 text-[14.5px] leading-[1.38] whitespace-pre-wrap break-words">
                          <span>{msg.text}</span>
                          <span className="inline-flex items-center gap-1 float-right ml-3 mt-1.5 text-[11px] font-mono tabular-nums text-slate-500 dark:text-[#8696A0]">
                            <span>{formatTime(msg.timestamp)}</span>
                            {isSelf &&
                              (msg.pendingSync ? (
                                <Clock className="h-3 w-3 text-slate-400" />
                              ) : (
                                <CheckCheck className="h-3.5 w-3.5 text-[#53BDEB]" />
                              ))}
                          </span>
                        </div>
                      )}

                      {msg.kind === 'file' && file && (
                        <div className="p-1.5 w-[260px] sm:w-[320px]">
                          {isImage && fileUrl ? (
                            <div className="relative overflow-hidden rounded-md mb-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  setLightboxImage({ url: fileUrl, name: file.fileName })
                                }
                                className="block w-full cursor-zoom-in"
                              >
                                <img
                                  src={fileUrl}
                                  alt={file.fileName}
                                  className="max-h-72 w-full object-cover"
                                />
                              </button>
                              <a
                                href={fileUrl}
                                download={file.fileName}
                                title="Unduh gambar"
                                className="absolute top-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 hover:bg-black/75 text-white transition-colors"
                              >
                                <Download className="h-4 w-4" />
                              </a>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2.5 rounded-md bg-black/5 dark:bg-black/20 p-2.5 mb-1.5">
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#00A884]/15 text-[#008069] dark:text-[#00A884]">
                                {isPreviewableImage(file.mimeType, file.fileName) ? (
                                  <ImageIcon className="h-5 w-5" />
                                ) : (
                                  <FileText className="h-5 w-5" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs sm:text-sm font-medium">
                                  {file.fileName}
                                </p>
                                <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-[#8696A0]">
                                  {formatBytes(file.size)}
                                  {file.status === 'sending' || file.status === 'receiving'
                                    ? ` · ${formatSpeed(file.speedBps)}`
                                    : ''}
                                </p>
                              </div>

                              {file.status === 'completed' && fileUrl && (
                                <a
                                  href={fileUrl}
                                  download={file.fileName}
                                  title="Unduh file"
                                  className="flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-full border border-slate-300 dark:border-[#3B4A54] hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                                >
                                  <Download className="h-4 w-4" />
                                </a>
                              )}

                              {file.status === 'sending' && (
                                <button
                                  type="button"
                                  onClick={() => onCancelTransfer(file.transferId)}
                                  title="Batalkan"
                                  className="flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-red-500 cursor-pointer"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          )}

                          {(file.status === 'sending' || file.status === 'receiving') && (
                            <div className="px-1 pb-1 space-y-1">
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/15 dark:bg-black/30">
                                <div
                                  className="h-full bg-[#00A884] transition-all duration-150"
                                  style={{ width: `${file.progress}%` }}
                                />
                              </div>
                              <div className="flex justify-between text-[11px] font-mono tabular-nums text-slate-500 dark:text-[#8696A0]">
                                <span>
                                  {file.status === 'sending' ? 'Mengirim' : 'Menerima'} ·{' '}
                                  {file.receivedChunks}/{file.totalChunks}
                                </span>
                                <span>{file.progress}%</span>
                              </div>
                            </div>
                          )}

                          <div className="flex items-center justify-between px-1 pb-0.5 text-[11px] text-slate-500 dark:text-[#8696A0]">
                            <span className="truncate">
                              {file.status === 'failed' || file.status === 'cancelled' ? (
                                <span className="inline-flex items-center gap-1 text-red-500">
                                  <XCircle className="h-3 w-3" />
                                  {file.errorMessage || 'Gagal'}
                                </span>
                              ) : isImage ? (
                                `${file.fileName} · ${formatBytes(file.size)}`
                              ) : (
                                'Terenkripsi E2E'
                              )}
                            </span>
                            <span className="inline-flex items-center gap-1 font-mono tabular-nums shrink-0 ml-2">
                              <span>{formatTime(msg.timestamp)}</span>
                              {isSelf && <CheckCheck className="h-3.5 w-3.5 text-[#53BDEB]" />}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                    </div>
                  )}
                </React.Fragment>
              );
            })
          )}
          <div ref={scrollEndRef} />
        </div>
      </div>

      {/* Offline DM notice */}
      {isTargetOffline && (
        <div className="bg-amber-500/15 border-t border-amber-500/20 px-4 py-2 text-center text-xs text-amber-800 dark:text-amber-300">
          Perangkat tujuan sedang tidak terhubung ke Wi-Fi. Pesan akan diantrekan otomatis.
        </div>
      )}

      {/* WhatsApp-Style Attachment Bottom Sheet / Popover */}
      {attachSheetOpen && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/40 lg:bg-transparent"
            onClick={() => setAttachSheetOpen(false)}
          />
          <div className="relative z-40 mx-2 mb-2 lg:mx-4 rounded-2xl border border-slate-200 dark:border-[#2A3942] bg-white dark:bg-[#233138] p-4 shadow-2xl lg:max-w-sm">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 dark:bg-[#3B4A54] sm:hidden" />
            <div className="grid grid-cols-3 gap-3 text-center">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-xl p-2 hover:bg-slate-100 dark:hover:bg-[#182229] active:scale-95 transition-transform cursor-pointer"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-500 text-white shadow-sm">
                  <Camera className="h-6 w-6" />
                </span>
                <span className="text-xs font-medium text-slate-700 dark:text-[#E9EDEF]">
                  Kamera
                </span>
              </button>

              <button
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-xl p-2 hover:bg-slate-100 dark:hover:bg-[#182229] active:scale-95 transition-transform cursor-pointer"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-purple-600 text-white shadow-sm">
                  <ImageIcon className="h-6 w-6" />
                </span>
                <span className="text-xs font-medium text-slate-700 dark:text-[#E9EDEF]">
                  Galeri
                </span>
              </button>

              <button
                type="button"
                onClick={() => docInputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-xl p-2 hover:bg-slate-100 dark:hover:bg-[#182229] active:scale-95 transition-transform cursor-pointer"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-sm">
                  <FileText className="h-6 w-6" />
                </span>
                <span className="text-xs font-medium text-slate-700 dark:text-[#E9EDEF]">
                  Dokumen
                </span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* Hidden Specialized File Inputs for Android */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileChange}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      <input
        ref={docInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* WhatsApp-style Bottom Composer Bar (with safe-area padding & 44px+ buttons) */}
      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2 bg-[#F0F2F5] dark:bg-[#202C33] px-2.5 sm:px-4 pt-2 pb-safe border-t border-slate-200 dark:border-[#222E35]"
      >
        <button
          type="button"
          onClick={() => setAttachSheetOpen((v) => !v)}
          disabled={isTargetOffline}
          title="Lampirkan kamera, galeri, atau dokumen"
          aria-label="Lampirkan file"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-600 dark:text-[#AEBAC1] hover:bg-black/5 dark:hover:bg-white/10 active:bg-black/10 disabled:opacity-45 transition-colors cursor-pointer"
        >
          <Paperclip className="h-5 w-5" />
        </button>

        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ketik pesan"
          className="min-h-[44px] max-h-32 flex-1 resize-none rounded-2xl bg-white dark:bg-[#2A3942] px-4 py-2.5 text-[15px] text-slate-900 dark:text-[#E9EDEF] placeholder:text-slate-500 dark:placeholder:text-[#8696A0] focus:outline-none"
        />

        <button
          type="submit"
          disabled={!text.trim()}
          aria-label="Kirim pesan"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#00A884] hover:bg-[#008F72] active:scale-95 disabled:opacity-45 text-[#111B21] transition-all cursor-pointer"
        >
          <Send className="h-4 w-4 ml-0.5" />
        </button>
      </form>

      {/* Lightbox Image Modal */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] flex flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightboxImage.url}
              alt={lightboxImage.name}
              className="max-h-[78vh] max-w-full rounded-lg object-contain"
            />
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#E9EDEF] truncate max-w-[180px]">
                {lightboxImage.name}
              </span>
              <a
                href={lightboxImage.url}
                download={lightboxImage.name}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-[#00A884] hover:bg-[#008F72] px-4 py-2 text-xs font-semibold text-[#111B21]"
              >
                <Download className="h-3.5 w-3.5" />
                Unduh
              </a>
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                className="min-h-[40px] rounded-full bg-[#202C33] hover:bg-[#2A3942] px-4 py-2 text-xs text-[#E9EDEF] cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
