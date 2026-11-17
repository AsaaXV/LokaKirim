import {
  decodeAudioFrameAsync,
  decryptMediaFrameAsync,
  encodeAudioFrameAsync,
  encryptMediaFrameAsync,
} from './crypto';
import type { CallTransportMode, CallType } from '../types/chat';

export interface CallEngineCallbacks {
  sendJson: (payload: unknown) => boolean;
  sendBinary: (packet: ArrayBuffer) => boolean;
  getDmAesKey: (peerId: string) => Promise<Uint8Array | null>;
  onTransportModeChange: (mode: CallTransportMode) => void;
  onLocalStream: (stream: MediaStream | null) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onStatusNote: (note: string | undefined) => void;
  onAudioLevel: (localLevel: number, remoteLevel: number) => void;
}

const TARGET_SAMPLE_RATE = 16000;

function resampleFloatToInt16(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return out;
  }
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = Math.min(input.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, input[srcIdx]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function buildCallBinaryPacket(headerObj: Record<string, unknown>, encryptedBytes: Uint8Array): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(headerObj));
  const packet = new Uint8Array(4 + headerBytes.length + encryptedBytes.length);
  const dv = new DataView(packet.buffer);
  dv.setUint32(0, headerBytes.length, false);
  packet.set(headerBytes, 4);
  packet.set(encryptedBytes, 4 + headerBytes.length);
  return packet.buffer;
}

export class CallMediaEngine {
  private callbacks: CallEngineCallbacks;
  private callId = '';
  private selfPeerId = '';
  private remotePeerId = '';
  private callType: CallType = 'audio';
  private transportMode: CallTransportMode = 'webrtc';
  private relayActive = false;

  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private webrtcFallbackTimer: number | null = null;

  private audioCtx: AudioContext | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;

  private pcmAccumulator: number[] = [];
  private nextPlaybackTime = 0;
  private videoFrameTimer: number | null = null;
  private hiddenVideoEl: HTMLVideoElement | null = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private remoteCanvasEl: HTMLCanvasElement | null = null;

  private audioMuted = false;
  private videoMuted = false;
  private speakerMuted = false;
  private facingMode: 'user' | 'environment' = 'user';
  private destroyed = false;

  constructor(callbacks: CallEngineCallbacks) {
    this.callbacks = callbacks;
  }

  setRemoteCanvas(canvas: HTMLCanvasElement | null) {
    this.remoteCanvasEl = canvas;
  }

  async prepareMedia(callType: CallType) {
    this.destroyed = false;
    this.callType = callType;
    if (!this.localStream) {
      await this.acquireMedia(callType, this.facingMode);
      this.setupAudioLevelMonitor();
    }
  }

  async startSession(params: {
    callId: string;
    selfPeerId: string;
    remotePeerId: string;
    callType: CallType;
    isCaller: boolean;
  }) {
    this.destroyed = false;
    this.callId = params.callId;
    this.selfPeerId = params.selfPeerId;
    this.remotePeerId = params.remotePeerId;
    this.callType = params.callType;
    this.transportMode = 'webrtc';
    this.relayActive = false;
    this.audioMuted = false;
    this.videoMuted = false;
    this.speakerMuted = false;

    if (!this.localStream) {
      await this.acquireMedia(params.callType, this.facingMode);
      this.setupAudioLevelMonitor();
    }
    this.setupWebRtc(params.isCaller);
  }

  private async acquireMedia(callType: CallType, facingMode: 'user' | 'environment') {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.callbacks.onStatusNote('Perangkat tidak mendukung akses media langsung · Mode dengar');
      return;
    }

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video:
          callType === 'video'
            ? {
                facingMode,
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 20, max: 24 },
              }
            : false,
      });
      this.localStream = stream;
      this.callbacks.onLocalStream(stream);
      return;
    } catch {
      if (callType === 'video') {
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false,
          });
          this.localStream = audioOnly;
          this.callbacks.onLocalStream(audioOnly);
          this.callbacks.onStatusNote('Kamera tidak tersedia · Melanjutkan dengan mikrofon');
          return;
        } catch {
          // Fall through to listen-only
        }
      }
      this.localStream = null;
      this.callbacks.onLocalStream(null);
      this.callbacks.onStatusNote('Izin mikrofon ditolak/tidak tersedia · Mode dengar saja');
    }
  }

  private setupAudioLevelMonitor() {
    if (this.levelTimer) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      if (this.localStream && this.localStream.getAudioTracks().length > 0) {
        const src = this.audioCtx.createMediaStreamSource(this.localStream);
        this.localAnalyser = this.audioCtx.createAnalyser();
        this.localAnalyser.fftSize = 256;
        src.connect(this.localAnalyser);
      }

      const buf = new Uint8Array(128);
      this.levelTimer = window.setInterval(() => {
        if (this.destroyed) return;
        let localLvl = 0;
        let remoteLvl = 0;
        if (this.localAnalyser && !this.audioMuted) {
          this.localAnalyser.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i];
          localLvl = Math.min(1, sum / (buf.length * 90));
        }
        if (this.remoteAnalyser && !this.speakerMuted) {
          this.remoteAnalyser.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i];
          remoteLvl = Math.min(1, sum / (buf.length * 90));
        }
        this.callbacks.onAudioLevel(localLvl, remoteLvl);
      }, 100);
    } catch {
      // ignore audio metering errors
    }
  }

  private setupWebRtc(isCaller: boolean) {
    if (typeof RTCPeerConnection === 'undefined') {
      this.activateRustRelayFallback('WebRTC tidak tersedia · Aktifkan Relay Rust E2EE');
      return;
    }

    // Zero STUN servers so offline local Wi-Fi / hotspot never stalls waiting on internet DNS
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    this.pendingIceCandidates = [];

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    // Ensure transceiver exists even in listen-only mode
    if (!this.localStream || this.localStream.getAudioTracks().length === 0) {
      try {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      } catch {
        // ignore
      }
    }
    if (
      this.callType === 'video' &&
      (!this.localStream || this.localStream.getVideoTracks().length === 0)
    ) {
      try {
        pc.addTransceiver('video', { direction: 'recvonly' });
      } catch {
        // ignore
      }
    }

    pc.ontrack = (event) => {
      if (this.destroyed) return;
      let stream = event.streams[0];
      if (!stream) {
        if (!this.remoteStream) {
          this.remoteStream = new MediaStream();
        }
        this.remoteStream.addTrack(event.track);
        stream = this.remoteStream;
      } else {
        this.remoteStream = stream;
      }
      this.callbacks.onRemoteStream(stream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && !this.destroyed) {
        this.callbacks.sendJson({
          type: 'call:rtc_signal',
          callId: this.callId,
          targetPeerId: this.remotePeerId,
          signalType: 'ice',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.destroyed) return;
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        if (this.webrtcFallbackTimer) {
          window.clearTimeout(this.webrtcFallbackTimer);
          this.webrtcFallbackTimer = null;
        }
        if (!this.relayActive) {
          this.transportMode = 'webrtc';
          this.callbacks.onTransportModeChange('webrtc');
        }
      } else if (st === 'failed') {
        this.activateRustRelayFallback('Jalur LAN dibatasi · Beralih ke Tunnel Rust E2EE');
      }
    };

    // Automatic Rust E2EE ADPCM + Video Relay fallback if direct P2P ICE doesn't connect within 3.5s
    if (this.webrtcFallbackTimer) window.clearTimeout(this.webrtcFallbackTimer);
    this.webrtcFallbackTimer = window.setTimeout(() => {
      if (this.destroyed || this.relayActive) return;
      const state = this.pc?.iceConnectionState;
      if (state !== 'connected' && state !== 'completed') {
        this.activateRustRelayFallback('Mode Tunnel Rust E2EE aktif (ADPCM 4:1)');
      }
    }, 3500);

    if (isCaller) {
      pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.callType === 'video',
      })
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => {
          if (this.destroyed) return;
          this.callbacks.sendJson({
            type: 'call:rtc_signal',
            callId: this.callId,
            targetPeerId: this.remotePeerId,
            signalType: 'offer',
            sdp: offer,
          });
        })
        .catch(() => {
          this.activateRustRelayFallback('Mode Tunnel Rust E2EE aktif (ADPCM 4:1)');
        });
    }
  }

  async handleRtcSignal(msg: Record<string, unknown>) {
    if (this.destroyed) return;
    if (!this.pc) {
      this.setupWebRtc(false);
    }
    const pc = this.pc;
    if (!pc) return;

    const signalType = String(msg.signalType || '');
    try {
      if (signalType === 'offer' && msg.sdp) {
        await pc.setRemoteDescription(
          new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit)
        );
        for (const cand of this.pendingIceCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        this.pendingIceCandidates = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.callbacks.sendJson({
          type: 'call:rtc_signal',
          callId: this.callId,
          targetPeerId: this.remotePeerId,
          signalType: 'answer',
          sdp: answer,
        });
      } else if (signalType === 'answer' && msg.sdp) {
        await pc.setRemoteDescription(
          new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit)
        );
        for (const cand of this.pendingIceCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        this.pendingIceCandidates = [];
      } else if (signalType === 'ice' && msg.candidate) {
        const cand = msg.candidate as RTCIceCandidateInit;
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        } else {
          this.pendingIceCandidates.push(cand);
        }
      }
    } catch {
      this.activateRustRelayFallback('Mode Tunnel Rust E2EE aktif (ADPCM 4:1)');
    }
  }

  activateRustRelayFallback(note?: string) {
    if (this.destroyed || this.relayActive) return;
    this.relayActive = true;
    this.transportMode = 'rust-relay';
    this.callbacks.onTransportModeChange('rust-relay');
    if (note) {
      this.callbacks.onStatusNote(note);
    }

    // Close stalled WebRTC RTCPeerConnection cleanly so we don't double-play audio
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }
    this.remoteStream = null;
    this.callbacks.onRemoteStream(null);

    this.callbacks.sendJson({
      type: 'call:media_state',
      callId: this.callId,
      targetPeerId: this.remotePeerId,
      audioMuted: this.audioMuted,
      videoMuted: this.videoMuted,
      transportMode: 'rust-relay',
    });

    this.startRustRelayAudioTx();
    if (this.callType === 'video') {
      this.startRustRelayVideoTx();
    }
  }

  private startRustRelayAudioTx() {
    if (!this.localStream || this.localStream.getAudioTracks().length === 0) return;
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        this.audioCtx = new AudioCtx();
      }
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      this.captureSource = ctx.createMediaStreamSource(this.localStream);
      // ScriptProcessorNode remains universally supported on Android WebView & desktop browsers
      this.captureProcessor = ctx.createScriptProcessor(2048, 1, 1);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      this.captureProcessor.onaudioprocess = (ev) => {
        if (this.destroyed || !this.relayActive || this.audioMuted) return;
        const input = ev.inputBuffer.getChannelData(0);
        const resampled = resampleFloatToInt16(input, ctx.sampleRate);
        for (let i = 0; i < resampled.length; i++) {
          this.pcmAccumulator.push(resampled[i]);
        }
        while (this.pcmAccumulator.length >= 1024) {
          const frame = new Int16Array(this.pcmAccumulator.splice(0, 1024));
          void this.sendRustAudioFrame(frame);
        }
      };

      this.captureSource.connect(this.captureProcessor);
      this.captureProcessor.connect(silentGain);
      silentGain.connect(ctx.destination);
    } catch {
      // ignore capture processor error
    }
  }

  private async sendRustAudioFrame(samples: Int16Array) {
    if (this.destroyed || !this.relayActive) return;
    const aesKey = await this.callbacks.getDmAesKey(this.remotePeerId);
    if (!aesKey) return;
    const { ivBase64, encryptedBytes } = await encodeAudioFrameAsync(aesKey, samples);
    const packet = buildCallBinaryPacket(
      {
        kind: 'call_audio',
        callId: this.callId,
        conversationType: 'dm',
        targetId: this.remotePeerId,
        senderId: this.selfPeerId,
        iv: ivBase64,
        sampleRate: TARGET_SAMPLE_RATE,
      },
      encryptedBytes
    );
    this.callbacks.sendBinary(packet);
  }

  private startRustRelayVideoTx() {
    if (this.videoFrameTimer) {
      window.clearInterval(this.videoFrameTimer);
      this.videoFrameTimer = null;
    }
    if (!this.localStream || this.localStream.getVideoTracks().length === 0) return;

    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.srcObject = this.localStream;
    videoEl.play().catch(() => {});
    this.hiddenVideoEl = videoEl;

    const canvas = document.createElement('canvas');
    this.captureCanvas = canvas;

    let busy = false;
    this.videoFrameTimer = window.setInterval(async () => {
      if (this.destroyed || !this.relayActive || this.videoMuted || busy) return;
      if (!videoEl.videoWidth || !videoEl.videoHeight) return;
      busy = true;
      try {
        const maxW = 360;
        const scale = Math.min(1, maxW / videoEl.videoWidth);
        const w = Math.max(160, Math.round(videoEl.videoWidth * scale));
        const h = Math.max(120, Math.round(videoEl.videoHeight * scale));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) return;
        ctx2d.drawImage(videoEl, 0, 0, w, h);

        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.55)
        );
        if (!blob || this.destroyed) return;
        const rawBytes = new Uint8Array(await blob.arrayBuffer());
        const aesKey = await this.callbacks.getDmAesKey(this.remotePeerId);
        if (!aesKey) return;
        const { ivBase64, encryptedBytes } = await encryptMediaFrameAsync(aesKey, rawBytes);
        const packet = buildCallBinaryPacket(
          {
            kind: 'call_video',
            callId: this.callId,
            conversationType: 'dm',
            targetId: this.remotePeerId,
            senderId: this.selfPeerId,
            iv: ivBase64,
            width: w,
            height: h,
          },
          encryptedBytes
        );
        this.callbacks.sendBinary(packet);
      } finally {
        busy = false;
      }
    }, 90);
  }

  async handleIncomingMediaPacket(
    header: {
      kind: 'call_audio' | 'call_video';
      callId: string;
      senderId: string;
      iv: string;
      sampleRate?: number;
    },
    encryptedBytes: Uint8Array
  ) {
    if (this.destroyed || header.callId !== this.callId) return;
    if (!this.relayActive) {
      // Peer switched to Rust E2EE tunnel — follow automatically
      this.activateRustRelayFallback('Terhubung via Tunnel Rust E2EE');
    }

    const aesKey = await this.callbacks.getDmAesKey(header.senderId);
    if (!aesKey) return;

    if (header.kind === 'call_audio') {
      if (this.speakerMuted) return;
      try {
        const samples = await decodeAudioFrameAsync(aesKey, header.iv, encryptedBytes);
        this.scheduleDecodedPcmPlayback(samples, header.sampleRate || TARGET_SAMPLE_RATE);
      } catch {
        // ignore corrupted frame
      }
      return;
    }

    if (header.kind === 'call_video') {
      try {
        const jpegBytes = await decryptMediaFrameAsync(aesKey, header.iv, encryptedBytes);
        this.renderRemoteVideoBytes(jpegBytes);
      } catch {
        // ignore corrupted frame
      }
    }
  }

  private scheduleDecodedPcmPlayback(samples: Int16Array, sampleRate: number) {
    if (samples.length === 0) return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioCtx();
    }
    const ctx = this.audioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      channel[i] = samples[i] / 32768;
    }

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    if (this.nextPlaybackTime < now || this.nextPlaybackTime > now + 0.35) {
      this.nextPlaybackTime = now + 0.04;
    }
    src.start(this.nextPlaybackTime);
    this.nextPlaybackTime += audioBuffer.duration;
  }

  private renderRemoteVideoBytes(jpegBytes: Uint8Array) {
    const canvas = this.remoteCanvasEl;
    if (!canvas) return;
    const safeBuffer = jpegBytes.buffer.slice(
      jpegBytes.byteOffset,
      jpegBytes.byteOffset + jpegBytes.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([safeBuffer], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'function') {
      createImageBitmap(blob)
        .then((bmp) => {
          if (this.destroyed || !this.remoteCanvasEl) {
            bmp.close();
            return;
          }
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(bmp, 0, 0);
          bmp.close();
        })
        .catch(() => {
          this.drawBlobViaImage(blob, canvas);
        });
      return;
    }
    this.drawBlobViaImage(blob, canvas);
  }

  private drawBlobViaImage(blob: Blob, canvas: HTMLCanvasElement) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      if (!this.destroyed && this.remoteCanvasEl) {
        if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
        }
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  toggleAudioMute(): boolean {
    this.audioMuted = !this.audioMuted;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !this.audioMuted;
      }
    }
    this.callbacks.sendJson({
      type: 'call:media_state',
      callId: this.callId,
      targetPeerId: this.remotePeerId,
      audioMuted: this.audioMuted,
      videoMuted: this.videoMuted,
      transportMode: this.transportMode,
    });
    return this.audioMuted;
  }

  toggleVideoMute(): boolean {
    this.videoMuted = !this.videoMuted;
    if (this.localStream) {
      for (const track of this.localStream.getVideoTracks()) {
        track.enabled = !this.videoMuted;
      }
    }
    this.callbacks.sendJson({
      type: 'call:media_state',
      callId: this.callId,
      targetPeerId: this.remotePeerId,
      audioMuted: this.audioMuted,
      videoMuted: this.videoMuted,
      transportMode: this.transportMode,
    });
    return this.videoMuted;
  }

  toggleSpeakerMute(): boolean {
    this.speakerMuted = !this.speakerMuted;
    return this.speakerMuted;
  }

  async switchCamera(): Promise<'user' | 'environment'> {
    const nextFacing: 'user' | 'environment' =
      this.facingMode === 'user' ? 'environment' : 'user';
    if (!navigator.mediaDevices?.getUserMedia) return this.facingMode;

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: nextFacing,
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 20, max: 24 },
        },
      });
      const nextTrack = nextStream.getVideoTracks()[0];
      if (!nextTrack) return this.facingMode;

      nextTrack.enabled = !this.videoMuted;
      if (this.localStream) {
        for (const oldTrack of this.localStream.getVideoTracks()) {
          oldTrack.stop();
          this.localStream.removeTrack(oldTrack);
        }
        this.localStream.addTrack(nextTrack);
      } else {
        this.localStream = nextStream;
      }

      if (this.pc) {
        const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(nextTrack);
        }
      }
      if (this.hiddenVideoEl) {
        this.hiddenVideoEl.srcObject = this.localStream;
        this.hiddenVideoEl.play().catch(() => {});
      }

      this.facingMode = nextFacing;
      this.callbacks.onLocalStream(this.localStream);
      return nextFacing;
    } catch {
      return this.facingMode;
    }
  }

  destroy() {
    this.destroyed = true;
    this.relayActive = false;

    if (this.webrtcFallbackTimer) {
      window.clearTimeout(this.webrtcFallbackTimer);
      this.webrtcFallbackTimer = null;
    }
    if (this.levelTimer) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    if (this.videoFrameTimer) {
      window.clearInterval(this.videoFrameTimer);
      this.videoFrameTimer = null;
    }
    if (this.captureProcessor) {
      try {
        this.captureProcessor.disconnect();
      } catch {
        // ignore
      }
      this.captureProcessor = null;
    }
    if (this.captureSource) {
      try {
        this.captureSource.disconnect();
      } catch {
        // ignore
      }
      this.captureSource = null;
    }
    if (this.hiddenVideoEl) {
      this.hiddenVideoEl.srcObject = null;
      this.hiddenVideoEl = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        t.stop();
      }
      this.localStream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.remoteStream = null;
    this.pcmAccumulator = [];
    this.callbacks.onLocalStream(null);
    this.callbacks.onRemoteStream(null);
  }
}
