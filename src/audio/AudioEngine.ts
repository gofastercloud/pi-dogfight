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

  private readonly rawBuffers = new Map<string, ArrayBuffer>();
  private readonly decodedBuffers = new Map<string, AudioBuffer>();

  private musicSource: AudioBufferSourceNode | null = null;
  private engineSource: AudioBufferSourceNode | null = null;
  private lockOsc: OscillatorNode | null = null;
  private lockLfo: OscillatorNode | null = null;
  private lockGain: GainNode | null = null;

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
      compressor.connect(this.ctx.destination);

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
