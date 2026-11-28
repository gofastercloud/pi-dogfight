const AUDIO_MANIFEST: Record<string, string> = {
  music: './audio/music.mp3',
  sfx_afterburner: './audio/sfx_afterburner.mp3',
  sfx_flyby: './audio/sfx_flyby.mp3',
  sfx_vulcan: './audio/sfx_vulcan.mp3',
  sfx_missile: './audio/sfx_missile.mp3',
  sfx_explosion: './audio/sfx_explosion.mp3',
  sfx_supernova: './audio/sfx_supernova.mp3',
  sfx_flares: './audio/sfx_flares.mp3',
  radio_01: './audio/radio_01.mp3',
  radio_02: './audio/radio_02.mp3',
  radio_03: './audio/radio_03.mp3',
  radio_04: './audio/radio_04.mp3',
  radio_05: './audio/radio_05.mp3',
  radio_06: './audio/radio_06.mp3',
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private radioGain: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freqBins: Uint8Array<ArrayBuffer> | null = null;

  private readonly rawBuffers = new Map<string, ArrayBuffer>();
  private readonly decodedBuffers = new Map<string, AudioBuffer>();

  private musicSource: AudioBufferSourceNode | null = null;
  private engineSource: AudioBufferSourceNode | null = null;
  private lockOsc: OscillatorNode | null = null;
  private lockLfo: OscillatorNode | null = null;
  private lockGain: GainNode | null = null;

  // Real-time FFT reactive telemetry (0..1), updated with zero per-frame allocations
  public bassEnergy = 0;
  public midEnergy = 0;
  public beatPulse = 0;

  private bassRunningAvg = 0;
  private prevBass = 0;
  private beatCooldown = 0;

  public isMuted = false;
  public isLoaded = false;
  public loadedCount = 0;
  public readonly totalCount = Object.keys(AUDIO_MANIFEST).length;

  public async preloadAll(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const entries = Object.entries(AUDIO_MANIFEST);
    await Promise.all(
      entries.map(async ([key, url]) => {
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = await resp.arrayBuffer();
          this.rawBuffers.set(key, buf);
        } catch (err) {
          console.warn(`[AudioEngine] Failed to fetch ${url}:`, err);
        } finally {
          this.loadedCount++;
          onProgress?.(this.loadedCount, this.totalCount);
        }
      }),
    );
    this.isLoaded = true;
  }

  public async unlockAndInit(): Promise<void> {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();

      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -10;
      compressor.knee.value = 14;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.16;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.isMuted ? 0 : 0.92;
      this.masterGain.connect(compressor);

      // Passive FFT analyser inline on the mastered bus so every browser pulls live bins
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.72;
      this.analyser.minDecibels = -88;
      this.analyser.maxDecibels = -18;
      this.freqBins = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));

      compressor.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.72;
      this.musicGain.connect(this.masterGain);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.95;
      this.sfxGain.connect(this.masterGain);

      this.radioGain = this.ctx.createGain();
      this.radioGain.gain.value = 1.15;
      this.radioGain.connect(this.masterGain);

      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0.24;
      this.engineGain.connect(this.masterGain);

      // Procedural AIM-9 Sidewinder seeker lock-on tone synth
      this.lockGain = this.ctx.createGain();
      this.lockGain.gain.value = 0;
      this.lockGain.connect(this.masterGain);

      this.lockOsc = this.ctx.createOscillator();
      this.lockOsc.type = 'sawtooth';
      this.lockOsc.frequency.value = 1040;

      const lockFilter = this.ctx.createBiquadFilter();
      lockFilter.type = 'bandpass';
      lockFilter.frequency.value = 1250;
      lockFilter.Q.value = 4.0;

      this.lockLfo = this.ctx.createOscillator();
      this.lockLfo.frequency.value = 18;
      const lfoDepth = this.ctx.createGain();
      lfoDepth.gain.value = 160;
      this.lockLfo.connect(lfoDepth);
      lfoDepth.connect(this.lockOsc.frequency);

      this.lockOsc.connect(lockFilter);
      lockFilter.connect(this.lockGain);
      this.lockOsc.start();
      this.lockLfo.start();
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // Decode any fetched audio buffers not yet decoded
    const decodePromises: Promise<void>[] = [];
    for (const [key, raw] of this.rawBuffers.entries()) {
      if (this.decodedBuffers.has(key)) continue;
      const copy = raw.slice(0);
      decodePromises.push(
        this.ctx
          .decodeAudioData(copy)
          .then((decoded) => {
            this.decodedBuffers.set(key, decoded);
          })
          .catch((err) => {
            console.warn(`[AudioEngine] Decode failed for ${key}:`, err);
          }),
      );
    }
    await Promise.all(decodePromises);
  }

  public startPlayback(offsetSeconds = 0): void {
    if (!this.ctx || !this.musicGain || !this.engineGain) return;
    this.stopMusicAndEngine();
    this.beatCooldown = 0;

    const musicBuf = this.decodedBuffers.get('music');
    if (musicBuf && offsetSeconds < musicBuf.duration - 0.1) {
      const src = this.ctx.createBufferSource();
      src.buffer = musicBuf;
      src.connect(this.musicGain);
      src.start(0, Math.max(0, offsetSeconds));
      this.musicSource = src;
    }

    const engBuf = this.decodedBuffers.get('sfx_afterburner');
    if (engBuf) {
      const src = this.ctx.createBufferSource();
      src.buffer = engBuf;
      src.loop = true;
      src.connect(this.engineGain);
      src.start(0);
      this.engineSource = src;
    }
  }

  public stopMusicAndEngine(): void {
    if (this.musicSource) {
      try {
        this.musicSource.stop();
      } catch {
        // ignore
      }
      this.musicSource.disconnect();
      this.musicSource = null;
    }
    if (this.engineSource) {
      try {
        this.engineSource.stop();
      } catch {
        // ignore
      }
      this.engineSource.disconnect();
      this.engineSource = null;
    }
    this.setMissileLock(false);
  }

  public playSfx(key: string, volume = 0.9, pan = 0): void {
    if (!this.ctx || !this.sfxGain) return;
    const buf = this.decodedBuffers.get(key);
    if (!buf) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const gain = this.ctx.createGain();
    gain.gain.value = volume;

    if (typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(gain);
      gain.connect(panner);
      panner.connect(this.sfxGain);
    } else {
      src.connect(gain);
      gain.connect(this.sfxGain);
    }
    src.start(0);
  }

  public playRadio(key: string): void {
    if (!this.ctx || !this.radioGain || !this.musicGain) return;
    const buf = this.decodedBuffers.get(key);
    if (!buf) return;

    const now = this.ctx.currentTime;
    // Play crisp PTT squelch click before voice
    this.playSquelchClick(now);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.radioGain);
    src.start(now + 0.05);

    // Subtle music ducking during pilot radio comms
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setTargetAtTime(0.46, now, 0.08);
    this.musicGain.gain.setTargetAtTime(0.72, now + buf.duration + 0.15, 0.25);

    // Closing squelch click
    this.playSquelchClick(now + buf.duration + 0.08);
  }

  private playSquelchClick(atTime: number): void {
    if (!this.ctx || !this.radioGain) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1650, atTime);
    osc.frequency.exponentialRampToValueAtTime(420, atTime + 0.045);
    g.gain.setValueAtTime(0.08, atTime);
    g.gain.exponentialRampToValueAtTime(0.0001, atTime + 0.05);
    osc.connect(g);
    g.connect(this.radioGain);
    osc.start(atTime);
    osc.stop(atTime + 0.055);
  }

  public setMissileLock(locked: boolean): void {
    if (!this.ctx || !this.lockGain) return;
    const now = this.ctx.currentTime;
    this.lockGain.gain.cancelScheduledValues(now);
    this.lockGain.gain.setTargetAtTime(locked ? 0.075 : 0.0, now, 0.04);
  }

  /**
   * Samples the Web Audio AnalyserNode into pre-allocated bins and updates
   * smoothed bassEnergy, midEnergy, and beatPulse (0..1) with zero heap allocations.
   */
  public updateAnalysis(dt: number, isPlaying: boolean): void {
    const safeDt = Math.min(Math.max(Number.isFinite(dt) ? dt : 0.016, 0.001), 0.08);

    if (
      !isPlaying ||
      this.isMuted ||
      !this.ctx ||
      this.ctx.state !== 'running' ||
      !this.analyser ||
      !this.freqBins
    ) {
      const decay = Math.exp(-safeDt * 8.0);
      this.bassEnergy = this.bassEnergy * decay < 1e-4 ? 0 : this.bassEnergy * decay;
      this.midEnergy = this.midEnergy * decay < 1e-4 ? 0 : this.midEnergy * decay;
      this.beatPulse = this.beatPulse * decay < 1e-4 ? 0 : this.beatPulse * decay;
      this.bassRunningAvg *= decay;
      this.prevBass *= decay;
      this.beatCooldown = Math.max(0, this.beatCooldown - safeDt);
      return;
    }

    const bins = this.freqBins;
    this.analyser.getByteFrequencyData(bins);

    const len = bins.length;
    const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
    const bassStart = Math.max(1, Math.floor(35 / hzPerBin));
    const bassEnd = Math.min(len - 1, Math.max(bassStart + 1, Math.ceil(220 / hzPerBin)));
    const midStart = Math.min(len - 1, Math.max(bassEnd + 1, Math.floor(250 / hzPerBin)));
    const midEnd = Math.min(len - 1, Math.max(midStart + 1, Math.ceil(2400 / hzPerBin)));

    let bassSum = 0;
    for (let i = bassStart; i <= bassEnd; i++) {
      bassSum += bins[i];
    }
    const rawBass = bassSum / ((bassEnd - bassStart + 1) * 255);

    let midSum = 0;
    for (let i = midStart; i <= midEnd; i++) {
      midSum += bins[i];
    }
    const rawMid = midSum / ((midEnd - midStart + 1) * 255);

    const targetBass = Math.min(1, Math.pow(Math.max(rawBass, 0), 1.15) * 1.28);
    const targetMid = Math.min(1, Math.pow(Math.max(rawMid, 0), 1.1) * 1.22);

    const attackAlpha = 1 - Math.exp(-safeDt * 22);
    const releaseAlpha = 1 - Math.exp(-safeDt * 6.5);

    this.bassEnergy +=
      (targetBass - this.bassEnergy) * (targetBass > this.bassEnergy ? attackAlpha : releaseAlpha);
    this.midEnergy +=
      (targetMid - this.midEnergy) * (targetMid > this.midEnergy ? attackAlpha : releaseAlpha);

    // Beat onset detection comparing instantaneous bass flux against a slow running baseline
    const avgAlpha = 1 - Math.exp(-safeDt * 2.2);
    this.bassRunningAvg += (targetBass - this.bassRunningAvg) * avgAlpha;
    this.beatCooldown = Math.max(0, this.beatCooldown - safeDt);

    const bassFlux = targetBass - this.prevBass;
    if (
      this.beatCooldown <= 0 &&
      targetBass > 0.22 &&
      (targetBass > this.bassRunningAvg * 1.22 + 0.05 || bassFlux > 0.14)
    ) {
      const onsetStrength = Math.min(1, 0.55 + Math.max(0, targetBass - this.bassRunningAvg) * 1.8);
      if (onsetStrength > this.beatPulse) {
        this.beatPulse = onsetStrength;
      }
      this.beatCooldown = 0.24;
    }

    this.beatPulse *= Math.exp(-safeDt * 6.2);
    if (this.beatPulse < 1e-4) this.beatPulse = 0;

    this.bassEnergy = Math.max(0, Math.min(1, this.bassEnergy));
    this.midEnergy = Math.max(0, Math.min(1, this.midEnergy));
    this.beatPulse = Math.max(0, Math.min(1, this.beatPulse));
    this.prevBass = targetBass;
  }

  public updateContinuous(throttle: number, timeScale: number, isPlaying: boolean): void {
    if (!this.ctx || !this.engineGain) return;
    const now = this.ctx.currentTime;
    const targetGain = isPlaying ? Math.min(0.46, 0.16 + throttle * 0.18) : 0.0;
    this.engineGain.gain.setTargetAtTime(targetGain, now, 0.08);
    if (this.engineSource) {
      this.engineSource.playbackRate.setTargetAtTime(
        0.75 + throttle * 0.24 * Math.max(0.55, timeScale),
        now,
        0.1,
      );
    }
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.92, this.ctx.currentTime, 0.04);
    }
  }
}
