class RingtoneController {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  private activeOscillators: OscillatorNode[] = [];

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private playToneBurst(freqs: number[], durationMs: number, volume: number) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.exponentialRampToValueAtTime(volume, now + 0.02);
    masterGain.gain.setValueAtTime(volume, now + durationMs / 1000 - 0.03);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    masterGain.connect(ctx.destination);

    for (const freq of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.connect(masterGain);
      osc.start(now);
      osc.stop(now + durationMs / 1000 + 0.01);
      this.activeOscillators.push(osc);
      osc.onended = () => {
        this.activeOscillators = this.activeOscillators.filter((o) => o !== osc);
      };
    }
  }

  startIncomingRingtone() {
    this.stop();
    const ringOnce = () => {
      this.playToneBurst([523.25, 659.25], 220, 0.07);
      window.setTimeout(() => {
        if (this.timer !== null) {
          this.playToneBurst([659.25, 783.99], 280, 0.07);
        }
      }, 260);
    };
    ringOnce();
    this.timer = window.setInterval(ringOnce, 2000);
  }

  startOutgoingRingback() {
    this.stop();
    const beepOnce = () => {
      this.playToneBurst([425, 450], 650, 0.045);
    };
    beepOnce();
    this.timer = window.setInterval(beepOnce, 2600);
  }

  playEndChime() {
    this.stop();
    this.playToneBurst([392, 329.63], 180, 0.05);
  }

  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const osc of this.activeOscillators) {
      try {
        osc.stop();
      } catch {
        // ignore
      }
    }
    this.activeOscillators = [];
  }
}

export const ringtone = new RingtoneController();
