import React, { useEffect, useRef, useState } from 'react';
import {
  Lock,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneOff,
  Radio,
  SwitchCamera,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { CallSessionState } from '../types/chat';

interface CallOverlayProps {
  session: CallSessionState | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  audioLevels: { local: number; remote: number };
  isTauriApp: boolean;
  onAccept: () => void;
  onReject: () => void;
  onHangup: () => void;
  onToggleAudioMute: () => void;
  onToggleVideoMute: () => void;
  onToggleSpeakerMute: () => void;
  onSwitchCamera: () => void;
  onToggleMinimized: () => void;
  onBindRemoteCanvas: (canvas: HTMLCanvasElement | null) => void;
  onForceRustRelay: () => void;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase() || 'LK';
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const CallOverlay: React.FC<CallOverlayProps> = ({
  session,
  localStream,
  remoteStream,
  audioLevels,
  isTauriApp,
  onAccept,
  onReject,
  onHangup,
  onToggleAudioMute,
  onToggleVideoMute,
  onToggleSpeakerMute,
  onSwitchCamera,
  onToggleMinimized,
  onBindRemoteCanvas,
  onForceRustRelay,
}) => {
  const [elapsedMs, setElapsedMs] = useState(0);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!session || session.status !== 'active' || !session.connectedAt) {
      setElapsedMs(0);
      return;
    }
    const update = () => {
      if (session.connectedAt) {
        setElapsedMs(Date.now() - session.connectedAt);
      }
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [session?.callId, session?.status, session?.connectedAt]);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, session?.callType, session?.minimized, session?.status]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.muted = Boolean(session?.speakerMuted);
      if (remoteStream) {
        remoteAudioRef.current.play().catch(() => {});
      }
    }
  }, [remoteStream, session?.speakerMuted, session?.callType, session?.minimized, session?.status]);

  useEffect(() => {
    onBindRemoteCanvas(remoteCanvasRef.current);
    return () => onBindRemoteCanvas(null);
  }, [onBindRemoteCanvas, session?.callId, session?.callType, session?.minimized, session?.status]);

  if (!session || session.status === 'idle') return null;

  const hasRemoteVideoTrack =
    Boolean(remoteStream && remoteStream.getVideoTracks().length > 0) &&
    !session.remoteVideoMuted;
  const hasLocalVideoTrack =
    Boolean(localStream && localStream.getVideoTracks().length > 0) &&
    !session.videoMuted;

  const transportLabel =
    session.transportMode === 'rust-relay'
      ? isTauriApp
        ? 'Tunnel Rust ADPCM 4:1 · E2EE'
        : 'Tunnel Relay E2EE'
      : 'WebRTC Wi-Fi Langsung · E2EE';

  const statusText =
    session.status === 'outgoing'
      ? 'Memanggil di Wi-Fi lokal...'
      : session.status === 'incoming'
      ? session.callType === 'video'
        ? 'Panggilan video Wi-Fi masuk'
        : 'Panggilan suara Wi-Fi masuk'
      : session.status === 'ended'
      ? session.endReason || 'Panggilan berakhir'
      : formatElapsed(elapsedMs);

  // Incoming Call Screen
  if (session.status === 'incoming') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-between bg-[#0B141A] text-[#E9EDEF] px-6 py-10">
        <div className="flex flex-col items-center text-center pt-6">
          <div className="flex items-center gap-1.5 text-xs text-[#00A884] font-medium mb-6">
            <Lock className="h-3.5 w-3.5" />
            <span>Terenkripsi End-to-End · Jaringan Lokal</span>
          </div>

          <div className="flex h-28 w-28 items-center justify-center rounded-full bg-[#202C33] border border-[#2A3942] text-3xl font-bold text-[#E9EDEF] shadow-xl mb-5">
            {getInitials(session.peerName)}
          </div>

          <h2 className="text-2xl font-semibold tracking-tight text-white">
            {session.peerName}
          </h2>
          <p className="mt-2 text-sm text-[#8696A0]">
            {statusText}
            {session.peerDeviceLabel ? ` · ${session.peerDeviceLabel}` : ''}
          </p>
        </div>

        <div className="mx-auto flex w-full max-w-xs items-center justify-around pb-8">
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={onReject}
              aria-label="Tolak panggilan"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 hover:bg-red-500 active:scale-95 text-white shadow-lg transition-transform cursor-pointer"
            >
              <PhoneOff className="h-7 w-7" />
            </button>
            <span className="text-xs font-medium text-[#AEBAC1]">Tolak</span>
          </div>

          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={onAccept}
              aria-label="Terima panggilan"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-[#00A884] hover:bg-[#06CF9C] active:scale-95 text-[#0B141A] shadow-lg transition-transform cursor-pointer"
            >
              {session.callType === 'video' ? (
                <Video className="h-7 w-7" />
              ) : (
                <Phone className="h-7 w-7" />
              )}
            </button>
            <span className="text-xs font-medium text-[#AEBAC1]">Terima</span>
          </div>
        </div>
      </div>
    );
  }

  // Minimized Top Call Bar so user can keep chatting during a live call
  if (session.minimized) {
    return (
      <>
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-16px)] max-w-md rounded-2xl bg-[#005C4B] text-white shadow-xl border border-[#00A884]/40 px-3.5 py-2.5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onToggleMinimized}
            className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15">
              {session.callType === 'video' ? (
                <Video className="h-4 w-4" />
              ) : (
                <Phone className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{session.peerName}</p>
              <p className="text-xs font-mono tabular-nums text-emerald-100">
                {statusText}
              </p>
            </div>
          </button>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onToggleAudioMute}
              aria-label={session.audioMuted ? 'Nyalakan mikrofon' : 'Bisukan mikrofon'}
              className={`flex h-10 w-10 items-center justify-center rounded-full cursor-pointer ${
                session.audioMuted ? 'bg-white text-[#111B21]' : 'bg-white/15 hover:bg-white/25'
              }`}
            >
              {session.audioMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onToggleMinimized}
              aria-label="Perbesar layar panggilan"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 hover:bg-white/25 cursor-pointer"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onHangup}
              aria-label="Akhiri panggilan"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600 hover:bg-red-500 cursor-pointer"
            >
              <PhoneOff className="h-4 w-4" />
            </button>
          </div>
        </div>
      </>
    );
  }

  const reactiveRingScale = 1 + Math.min(0.28, (audioLevels.remote + audioLevels.local) * 0.2);

  // Full-Screen Active / Outgoing Call Overlay
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-between bg-[#0B141A] text-[#E9EDEF] select-none overflow-hidden">
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Video Call Canvas / Streams Background */}
      {session.callType === 'video' && (
        <div className="absolute inset-0 bg-[#0B141A]">
          {session.transportMode === 'rust-relay' ? (
            <canvas
              ref={remoteCanvasRef}
              className={`h-full w-full object-cover ${
                session.remoteVideoMuted ? 'opacity-0' : 'opacity-100'
              }`}
            />
          ) : (
            <video
              ref={remoteVideoRef}
              autoPlay
              muted
              playsInline
              className={`h-full w-full object-cover ${
                hasRemoteVideoTrack ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}

          {((session.transportMode === 'webrtc' && !hasRemoteVideoTrack) ||
            session.remoteVideoMuted) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0B141A]">
              <div className="flex h-28 w-28 items-center justify-center rounded-full bg-[#202C33] border border-[#2A3942] text-3xl font-bold text-[#E9EDEF]">
                {getInitials(session.peerName)}
              </div>
              <p className="mt-4 text-sm text-[#8696A0]">
                {session.remoteVideoMuted
                  ? 'Kamera lawan bicara dimatikan'
                  : session.status === 'outgoing'
                  ? 'Menunggu jawaban...'
                  : 'Menyiapkan aliran video lokal...'}
              </p>
            </div>
          )}

          {/* Local Camera Self-Preview PiP */}
          <div className="absolute right-4 top-20 z-20 h-36 w-26 sm:h-44 sm:w-32 overflow-hidden rounded-2xl border border-white/20 bg-[#182229] shadow-2xl">
            {hasLocalVideoTrack ? (
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className={`h-full w-full object-cover ${
                  session.facingMode === 'user' ? 'scale-x-[-1]' : ''
                }`}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-[#8696A0]">
                <VideoOff className="h-5 w-5" />
                <span className="text-[10px]">Kamera mati</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Top Info Header with contrast scrim */}
      <div
        className={`relative z-20 flex items-start justify-between gap-3 px-4 pt-5 pb-8 ${
          session.callType === 'video'
            ? 'bg-gradient-to-b from-black/80 via-black/40 to-transparent'
            : ''
        }`}
      >
        <button
          type="button"
          onClick={onToggleMinimized}
          aria-label="Kecilkan layar panggilan"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white cursor-pointer"
        >
          <Minimize2 className="h-5 w-5" />
        </button>

        <div className="flex flex-col items-center text-center min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#00A884]">
            <Lock className="h-3 w-3 shrink-0" />
            <span className="truncate">{transportLabel}</span>
          </div>
          {session.callType === 'video' && (
            <>
              <h2 className="mt-1 truncate text-lg font-semibold text-white">
                {session.peerName}
              </h2>
              <p className="text-xs font-mono tabular-nums text-white/80">
                {statusText}
                {session.remoteAudioMuted ? ' · Mikrofon lawan bisu' : ''}
              </p>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onForceRustRelay}
          disabled={session.transportMode === 'rust-relay' || session.status !== 'active'}
          title="Alihkan ke jalur Tunnel Rust ADPCM E2EE"
          className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-xs cursor-pointer ${
            session.transportMode === 'rust-relay'
              ? 'bg-[#00A884]/25 text-[#00A884]'
              : 'bg-white/10 hover:bg-white/20 text-white/85'
          } disabled:opacity-60`}
        >
          <Radio className="h-4 w-4" />
        </button>
      </div>

      {/* Center Stage for Voice Call */}
      {session.callType === 'audio' && (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="relative flex items-center justify-center mb-7">
            <div
              className="absolute h-36 w-36 rounded-full bg-[#00A884]/20 transition-transform duration-100"
              style={{ transform: `scale(${reactiveRingScale})` }}
            />
            <div className="relative flex h-32 w-32 items-center justify-center rounded-full bg-[#202C33] border-2 border-[#00A884]/60 text-4xl font-bold text-white shadow-2xl">
              {getInitials(session.peerName)}
            </div>
          </div>

          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">
            {session.peerName}
          </h2>
          <p className="mt-2 text-base font-mono tabular-nums text-[#AEBAC1]">
            {statusText}
          </p>
          {session.remoteAudioMuted && (
            <p className="mt-2 text-xs text-amber-400">Mikrofon lawan bicara sedang dibisukan</p>
          )}
          {session.statusNote && (
            <p className="mt-3 max-w-xs text-xs text-[#8696A0]">{session.statusNote}</p>
          )}
        </div>
      )}

      {/* Video mode note banner if present */}
      {session.callType === 'video' && session.statusNote && (
        <div className="relative z-20 mx-auto mb-2 px-4 py-1 text-center text-xs text-white/80">
          {session.statusNote}
        </div>
      )}

      {/* Bottom Thumb-Zone Call Controls */}
      <div
        className={`relative z-20 px-4 pt-8 pb-8 ${
          session.callType === 'video'
            ? 'bg-gradient-to-t from-black/85 via-black/50 to-transparent'
            : ''
        }`}
      >
        <div className="mx-auto flex w-full max-w-md items-center justify-around gap-2 rounded-3xl bg-[#202C33]/90 backdrop-blur-md border border-[#2A3942] px-4 py-3.5 shadow-2xl">
          {session.callType === 'video' && (
            <>
              <button
                type="button"
                onClick={onToggleVideoMute}
                aria-label={session.videoMuted ? 'Nyalakan kamera' : 'Matikan kamera'}
                className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors cursor-pointer ${
                  session.videoMuted
                    ? 'bg-white text-[#111B21]'
                    : 'bg-[#2A3942] text-white hover:bg-[#374854]'
                }`}
              >
                {session.videoMuted ? (
                  <VideoOff className="h-5 w-5" />
                ) : (
                  <Video className="h-5 w-5" />
                )}
              </button>

              <button
                type="button"
                onClick={onSwitchCamera}
                aria-label="Putar kamera depan/belakang"
                className="flex h-12 w-12 items-center justify-center rounded-full bg-[#2A3942] text-white hover:bg-[#374854] transition-colors cursor-pointer"
              >
                <SwitchCamera className="h-5 w-5" />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onToggleSpeakerMute}
            aria-label={session.speakerMuted ? 'Nyalakan suara lawan' : 'Bisukan suara lawan'}
            className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors cursor-pointer ${
              session.speakerMuted
                ? 'bg-white text-[#111B21]'
                : 'bg-[#2A3942] text-white hover:bg-[#374854]'
            }`}
          >
            {session.speakerMuted ? (
              <VolumeX className="h-5 w-5" />
            ) : (
              <Volume2 className="h-5 w-5" />
            )}
          </button>

          <button
            type="button"
            onClick={onToggleAudioMute}
            aria-label={session.audioMuted ? 'Nyalakan mikrofon' : 'Bisukan mikrofon'}
            className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors cursor-pointer ${
              session.audioMuted
                ? 'bg-white text-[#111B21]'
                : 'bg-[#2A3942] text-white hover:bg-[#374854]'
            }`}
          >
            {session.audioMuted ? (
              <MicOff className="h-5 w-5" />
            ) : (
              <Mic className="h-5 w-5" />
            )}
          </button>

          <button
            type="button"
            onClick={onHangup}
            aria-label="Akhiri panggilan"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 hover:bg-red-500 active:scale-95 text-white shadow-lg transition-transform cursor-pointer"
          >
            <PhoneOff className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  );
};
