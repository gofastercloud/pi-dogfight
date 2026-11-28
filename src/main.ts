import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WorldEnvironment } from './environment/WorldEnvironment';
import { BayhemVFX } from './vfx/BayhemVFX';
import {
  DogfightChoreography,
  CameraMode,
  TOTAL_DURATION,
  ActInfo,
  RadioCue,
} from './choreography/Choreography';
import { PostPipeline } from './post/PostPipeline';
import { AudioEngine } from './audio/AudioEngine';
import { FighterHUD } from './ui/FighterHUD';

export interface DogfightCanvasStats {
  meanLuminance: number;
  lumVariance: number;
  colourVariance: number;
  nonBlackRatio: number;
  sampleCount: number;
}

export interface DogfightDebugState {
  readonly currentTime: number;
  readonly camMode: CameraMode;
  readonly cameraTag: string;
  readonly cameraPosition: readonly [number, number, number];
  readonly cameraUp: readonly [number, number, number];
  readonly hudEnabled: boolean;
  readonly tripIntensity: number;
  readonly isPlaying: boolean;
  readonly fps: number;
  readonly audioBass: number;
  readonly audioMid: number;
  readonly audioBeat: number;
}

export type DrsMode = 'auto' | 'native';

export interface DogfightPerfStats {
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
  drsMode: DrsMode;
  frameMsP50: number;
  frameMsP95: number;
  frameMsP99: number;
  fps: number;
}

export interface DogfightDebugApi extends DogfightDebugState {
  getState(): DogfightDebugState;
  getPerfStats(): DogfightPerfStats;
  seek(t: number): void;
  setCamera(mode: CameraMode): void;
  sampleCanvasStats(): DogfightCanvasStats;
}

declare global {
  interface Window {
    __DOGFIGHT_DEBUG__?: DogfightDebugApi;
  }
}

const DRS_MIN_DPR = 1.15;
const DRS_MAX_DPR = 2.0;
const DRS_DOWN_THRESHOLD_MS = 10.2; // Sustained > 10.2ms (~98 fps) steps DPR down toward 120 fps target
const DRS_UP_THRESHOLD_MS = 8.75;   // Sustained <= 8.75ms (~114–120 fps) steps DPR back up
const DRS_STEP_DOWN = 0.15;
const DRS_STEP_UP = 0.10;
const DRS_WINDOW_FRAMES = 24;
const DRS_DOWN_COOLDOWN_SEC = 0.65;
const DRS_UP_COOLDOWN_SEC = 1.6;
const DRS_UP_REQUIRED_WINDOWS = 2;

function getNativeDpr(): number {
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), DRS_MAX_DPR);
}

function getMinAutoDpr(nativeDpr: number): number {
  return Math.min(DRS_MIN_DPR, nativeDpr);
}

function quantiseDpr(dpr: number, minDpr: number, maxDpr: number): number {
  const clamped = THREE.MathUtils.clamp(dpr, minDpr, maxDpr);
  return THREE.MathUtils.clamp(Math.round(clamped * 20) / 20, minDpr, maxDpr);
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
  const hudCanvas = document.getElementById('hud-canvas') as HTMLCanvasElement;

  const launchOverlay = document.getElementById('launch-overlay')!;
  const launchStatus = document.getElementById('launch-status')!;
  const btnLaunch = document.getElementById('btn-launch') as HTMLButtonElement;
  const finaleOverlay = document.getElementById('finale-overlay')!;
  const btnReplay = document.getElementById('btn-replay') as HTMLButtonElement;
  const btnFreecam = document.getElementById('btn-freecam') as HTMLButtonElement;
  const controlDock = document.getElementById('control-dock')!;

  const actBanner = document.getElementById('act-banner')!;
  const actEyebrow = document.getElementById('act-eyebrow')!;
  const actTitle = document.getElementById('act-title')!;

  const radioFeed = document.getElementById('radio-feed')!;
  const radioCallsign = document.getElementById('radio-callsign')!;
  const radioText = document.getElementById('radio-text')!;

  const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
  const btnRestart = document.getElementById('btn-restart') as HTMLButtonElement;
  const btnMute = document.getElementById('btn-mute') as HTMLButtonElement;
  const btnHud = document.getElementById('btn-hud') as HTMLButtonElement;
  const btnDrs = document.getElementById('btn-drs') as HTMLButtonElement;
  const scrubber = document.getElementById('scrubber') as HTMLInputElement;
  const timeCurrentEl = document.getElementById('time-current')!;
  const timeTotalEl = document.getElementById('time-total')!;
  const tripSlider = document.getElementById('trip-slider') as HTMLInputElement;
  const tripValueEl = document.getElementById('trip-value')!;
  const perfReadout = document.getElementById('perf-readout')!;
  const camButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.cam-btn'));

  timeTotalEl.textContent = formatTime(TOTAL_DURATION);

  // ------------------------------------------------------------------
  // 1. RENDERER, SCENE, CAMERA & ORBIT CONTROLS
  // ------------------------------------------------------------------
  const initialWidth = Math.max(1, window.innerWidth);
  const initialHeight = Math.max(1, window.innerHeight);
  const initialDpr = getNativeDpr();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // MSAA handled inside HalfFloat EffectComposer render target
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(initialDpr);
  renderer.setSize(initialWidth, initialHeight);
  renderer.toneMapping = THREE.NoToneMapping; // ACES applied in our custom final shader pass
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false; // Manually reset once per composed frame for accurate multi-pass telemetry

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x281c28, 0.00018);

  const camera = new THREE.PerspectiveCamera(64, initialWidth / initialHeight, 0.8, 16000);
  camera.position.set(22, 42, 130);

  const orbitControls = new OrbitControls(camera, canvas);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.06;
  orbitControls.enabled = false;

  // ------------------------------------------------------------------
  // 2. CORE SUBSYSTEMS
  // ------------------------------------------------------------------
  const env = new WorldEnvironment(scene, renderer);
  const vfx = new BayhemVFX(scene);
  const post = new PostPipeline(renderer, scene, camera);
  post.setSize(initialWidth, initialHeight);
  const audio = new AudioEngine();
  const hud = new FighterHUD(hudCanvas);

  // Cache monolith energy conduit ShaderMaterials once for zero-allocation audio pulse
  const monolithConduitMats: THREE.ShaderMaterial[] = [];
  env.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.material instanceof THREE.ShaderMaterial) {
      const uniforms = obj.material.uniforms;
      if (uniforms && 'uReveal' in uniforms && 'uLightning' in uniforms) {
        if (!monolithConduitMats.includes(obj.material)) {
          monolithConduitMats.push(obj.material);
        }
      }
    }
  });

  let actHideTimer: number | null = null;
  let radioHideTimer: number | null = null;

  const showActBanner = (act: ActInfo) => {
    actEyebrow.textContent = act.eyebrow;
    actTitle.textContent = act.title;
    actBanner.classList.remove('hidden');
    if (actHideTimer) window.clearTimeout(actHideTimer);
    actHideTimer = window.setTimeout(() => actBanner.classList.add('hidden'), 3200);
  };

  const showRadioCue = (cue: RadioCue) => {
    radioCallsign.textContent = cue.callsign;
    radioText.textContent = `"${cue.text}"`;
    radioFeed.classList.remove('hidden');
    audio.playRadio(cue.audioKey);
    if (radioHideTimer) window.clearTimeout(radioHideTimer);
    radioHideTimer = window.setTimeout(() => radioFeed.classList.add('hidden'), cue.duration * 1000);
  };

  const choreography = new DogfightChoreography(scene, vfx, env, {
    onActChange: showActBanner,
    onRadio: showRadioCue,
    onSfx: (key, vol, pan) => audio.playSfx(key, vol, pan),
    onLockState: (locked) => audio.setMissileLock(locked),
  });

  // ------------------------------------------------------------------
  // 3. STATE & INTERACTIVE CONTROLS
  // ------------------------------------------------------------------
  let hasLaunched = false;
  let isPlaying = false;
  let isScrubbing = false;
  let camMode: CameraMode = 'auto';
  let userTripOverride: number | null = null;
  let lastTripIntensity = 0;
  let currentFps = 60;
  let finaleShown = false;
  let lastDisplayedSec = -1;
  let lastScrubberVal = -1;

  // Pre-allocated scratch vectors & frame-delta ring buffer (zero per-frame heap allocations)
  const orbitOffset = new THREE.Vector3(42, 18, 46);
  const prevOrbitHeroPos = new THREE.Vector3();
  const heroDelta = new THREE.Vector3();
  const heroForward = new THREE.Vector3(0, 0, -1);

  const FRAME_RING_CAPACITY = 120;
  const frameDeltaRing = new Float64Array(FRAME_RING_CAPACITY);
  const frameSortScratch = new Float64Array(FRAME_RING_CAPACITY);
  let frameRingHead = 0;
  let frameRingCount = 0;

  // Hysteresis-guarded Dynamic Resolution Scaler (AUTO: [1.15, native], NATIVE: locked)
  let drsMode: DrsMode = 'auto';
  let appliedWidth = initialWidth;
  let appliedHeight = initialHeight;
  let appliedDpr = initialDpr;
  let drsAccumMs = 0;
  let drsSampleCount = 0;
  let drsCooldownUntilSec = 0;
  let drsGoodWindows = 0;
  let lastPerfText = '';

  const updatePerfReadout = (force = false) => {
    const text = `${currentFps} FPS · ${appliedDpr.toFixed(2)}×`;
    if (force || text !== lastPerfText) {
      lastPerfText = text;
      perfReadout.textContent = text;
    }
  };

  const resetDrsWindow = (cooldownSec = 0.5) => {
    drsAccumMs = 0;
    drsSampleCount = 0;
    drsGoodWindows = 0;
    drsCooldownUntilSec = performance.now() / 1000 + cooldownSec;
  };

  const applyViewportResolution = (w: number, h: number, targetDpr: number) => {
    const safeW = Math.max(1, Math.round(w));
    const safeH = Math.max(1, Math.round(h));
    const safeDpr = Math.round(targetDpr * 100) / 100;

    const sizeChanged = safeW !== appliedWidth || safeH !== appliedHeight;
    const dprChanged = Math.abs(safeDpr - appliedDpr) >= 0.005;
    if (!sizeChanged && !dprChanged) return;

    appliedWidth = safeW;
    appliedHeight = safeH;
    appliedDpr = safeDpr;

    if (sizeChanged) {
      camera.aspect = safeW / safeH;
      camera.updateProjectionMatrix();
    }
    if (dprChanged) {
      renderer.setPixelRatio(safeDpr);
      // Sync EffectComposer's internal pixel ratio before a single post.setSize() call
      // so simultaneous viewport + DPR changes never trigger double FBO reallocations.
      const composerInternal = post.composer as unknown as { _pixelRatio?: number };
      if (typeof composerInternal._pixelRatio === 'number') {
        composerInternal._pixelRatio = safeDpr;
      } else {
        post.composer.setPixelRatio(safeDpr);
      }
    }
    if (sizeChanged) {
      renderer.setSize(safeW, safeH);
    }
    // Single pass resize (RenderTarget.setSize is a no-op when dimensions already match)
    post.setSize(safeW, safeH);
    if (sizeChanged) {
      hud.resize();
    }
    updatePerfReadout(true);
  };

  const updateDrs = (frameMs: number, nowSec: number) => {
    if (drsMode !== 'auto' || !hasLaunched || !isPlaying || isScrubbing) return;
    const nativeDpr = getNativeDpr();
    const minDpr = getMinAutoDpr(nativeDpr);
    if (nativeDpr <= minDpr + 0.005) return; // Nothing to scale on 1× displays
    if (nowSec < drsCooldownUntilSec) return;
    if (frameMs <= 0 || frameMs > 100) return; // Ignore tab backgrounding / pause gaps

    drsAccumMs += frameMs;
    drsSampleCount++;
    if (drsSampleCount < DRS_WINDOW_FRAMES) return;

    const avgMs = drsAccumMs / drsSampleCount;
    drsAccumMs = 0;
    drsSampleCount = 0;

    if (avgMs > DRS_DOWN_THRESHOLD_MS) {
      drsGoodWindows = 0;
      if (appliedDpr > minDpr + 0.01) {
        const nextDpr = quantiseDpr(appliedDpr - DRS_STEP_DOWN, minDpr, nativeDpr);
        if (Math.abs(nextDpr - appliedDpr) >= 0.04) {
          applyViewportResolution(window.innerWidth, window.innerHeight, nextDpr);
          drsCooldownUntilSec = nowSec + DRS_DOWN_COOLDOWN_SEC;
        }
      }
    } else if (avgMs <= DRS_UP_THRESHOLD_MS) {
      drsGoodWindows++;
      if (drsGoodWindows >= DRS_UP_REQUIRED_WINDOWS && appliedDpr < nativeDpr - 0.01) {
        const nextDpr = quantiseDpr(appliedDpr + DRS_STEP_UP, minDpr, nativeDpr);
        if (Math.abs(nextDpr - appliedDpr) >= 0.04) {
          applyViewportResolution(window.innerWidth, window.innerHeight, nextDpr);
          drsGoodWindows = 0;
          drsCooldownUntilSec = nowSec + DRS_UP_COOLDOWN_SEC;
        }
      }
    } else {
      // Inside hysteresis deadband [8.75ms, 10.2ms]: hold DPR steady without oscillating
      drsGoodWindows = 0;
    }
  };

  // Cache scene PointLights once and pad with zero-intensity PointLights to keep
  // Three.js NUM_POINT_LIGHTS constant across bandit kills & detonations (zero mid-flight recompile).
  const TARGET_POINT_LIGHTS = 6;
  const scenePointLights: THREE.PointLight[] = [];
  scene.traverse((obj) => {
    if (obj instanceof THREE.PointLight) {
      scenePointLights.push(obj);
    }
  });
  const padPointLights: THREE.PointLight[] = [];
  for (let i = 0; i < TARGET_POINT_LIGHTS; i++) {
    const pad = new THREE.PointLight(0x000000, 0, 1);
    pad.visible = false;
    scene.add(pad);
    padPointLights.push(pad);
  }

  const syncConstantPointLightCount = () => {
    let activeCount = 0;
    for (let i = 0; i < scenePointLights.length; i++) {
      let cur: THREE.Object3D | null = scenePointLights[i];
      let vis = true;
      while (cur) {
        if (!cur.visible) {
          vis = false;
          break;
        }
        cur = cur.parent;
      }
      if (vis) activeCount++;
    }
    const neededPads = Math.max(0, TARGET_POINT_LIGHTS - activeCount);
    for (let i = 0; i < padPointLights.length; i++) {
      padPointLights[i].visible = i < neededPads;
    }
  };

  const renderPostFrame = () => {
    syncConstantPointLightCount();
    renderer.info.reset();
    post.render();
  };

  const syncTimelineDom = (sec: number, force = false) => {
    const wholeSec = Math.max(0, Math.floor(sec));
    if (force || wholeSec !== lastDisplayedSec) {
      lastDisplayedSec = wholeSec;
      timeCurrentEl.textContent = formatTime(sec);
    }
    if (force || Math.abs(sec - lastScrubberVal) >= 0.05) {
      lastScrubberVal = sec;
      scrubber.value = sec.toFixed(2);
    }
  };

  const renderHudNow = (realTime: number, tripIntensity: number) => {
    hud.render(
      realTime,
      choreography.hero,
      choreography.bandits,
      choreography.lockedTarget,
      choreography.isMissileLocked,
      camera,
      choreography.activeCameraTag,
      tripIntensity,
      choreography.timeScale,
      isPlaying ? audio.beatPulse : 0,
    );
  };

  const setCameraMode = (mode: CameraMode) => {
    camMode = mode;
    orbitControls.enabled = mode === 'orbit';
    const nowSec = performance.now() / 1000;
    if (mode === 'orbit') {
      camera.up.set(0, 1, 0);
      const heroPos = choreography.hero.group.position;
      orbitControls.target.copy(heroPos);
      camera.position.copy(heroPos).add(orbitOffset);
      camera.position.y = Math.max(12, camera.position.y);
      prevOrbitHeroPos.copy(heroPos);
      camera.fov = 60;
      camera.updateProjectionMatrix();
      orbitControls.update();
      choreography.updateCamera(0.016, nowSec, camera, 'orbit', true);
    } else {
      choreography.updateCamera(0.016, nowSec, camera, mode, true);
    }
    camButtons.forEach((b) => b.classList.toggle('active', b.dataset.cam === mode));
    if (hasLaunched) {
      const activeTrip = userTripOverride !== null ? userTripOverride : lastTripIntensity;
      renderHudNow(nowSec, activeTrip);
    }
  };

  const syncPlayButton = () => {
    btnPlay.textContent = isPlaying ? '❚❚' : '▶';
    btnPlay.setAttribute('aria-pressed', String(isPlaying));
  };

  const toggleMute = () => {
    audio.setMuted(!audio.isMuted);
    btnMute.textContent = audio.isMuted ? '🔇' : '🔊';
    btnMute.classList.toggle('active', audio.isMuted);
    btnMute.setAttribute('aria-pressed', String(audio.isMuted));
  };

  const toggleHud = () => {
    hud.enabled = !hud.enabled;
    btnHud.classList.toggle('active', hud.enabled);
    btnHud.setAttribute('aria-pressed', String(hud.enabled));
    if (hasLaunched) {
      const activeTrip = userTripOverride !== null ? userTripOverride : lastTripIntensity;
      renderHudNow(performance.now() / 1000, activeTrip);
    }
  };

  const syncDrsButton = () => {
    const isAuto = drsMode === 'auto';
    btnDrs.textContent = isAuto ? 'DRS: AUTO' : 'DRS: NATIVE';
    btnDrs.classList.toggle('active', isAuto);
    btnDrs.classList.toggle('drs-native', !isAuto);
    btnDrs.setAttribute('aria-pressed', String(isAuto));
  };

  const toggleDrsMode = () => {
    drsMode = drsMode === 'auto' ? 'native' : 'auto';
    syncDrsButton();
    if (drsMode === 'native') {
      applyViewportResolution(window.innerWidth, window.innerHeight, getNativeDpr());
    }
    resetDrsWindow(0.4);
    updatePerfReadout(true);
    if (hasLaunched && !isPlaying) {
      applySceneFrame(0.016, performance.now() / 1000, false, false);
    }
  };

  syncDrsButton();
  updatePerfReadout(true);

  const startDemoFrom = async (startTime = 0) => {
    hasLaunched = true;
    finaleShown = false;
    isScrubbing = false;
    launchOverlay.classList.add('hidden');
    finaleOverlay.classList.add('hidden');
    actBanner.classList.add('hidden');
    radioFeed.classList.add('hidden');
    if (actHideTimer) {
      window.clearTimeout(actHideTimer);
      actHideTimer = null;
    }
    if (radioHideTimer) {
      window.clearTimeout(radioHideTimer);
      radioHideTimer = null;
    }
    document.body.classList.remove('no-letterbox');
    controlDock.classList.remove('hidden');

    const clampedStart = THREE.MathUtils.clamp(startTime, 0, TOTAL_DURATION);
    choreography.reset(clampedStart);
    syncTimelineDom(choreography.currentTime, true);
    isPlaying = true;
    syncPlayButton();
    resetDrsWindow(0.6);
    applySceneFrame(0.016, clampedStart, false, true);

    try {
      await audio.unlockAndInit();
      if (isPlaying) {
        audio.startPlayback(choreography.currentTime);
      }
    } catch {
      // Audio unlock/decode failure must never block visual playback
    }
  };

  const togglePlayPause = async () => {
    if (!hasLaunched) {
      await startDemoFrom(0);
      return;
    }
    isPlaying = !isPlaying;
    syncPlayButton();
    if (isPlaying) {
      if (choreography.currentTime >= TOTAL_DURATION - 0.1) {
        choreography.reset(0);
        syncTimelineDom(0, true);
      }
      finaleOverlay.classList.add('hidden');
      finaleShown = false;
      resetDrsWindow(0.5);
      try {
        await audio.unlockAndInit();
        if (isPlaying) {
          audio.startPlayback(choreography.currentTime);
        }
      } catch {
        // Audio unlock/decode failure must never block visual playback
      }
    } else {
      audio.stopMusicAndEngine();
    }
  };

  // Preload all 14 fal.ai audio assets in the background immediately while pre-compiling shaders
  let audioLoadedCount = 0;
  let audioTotalCount = 14;
  let shadersCompiled = false;

  const updateLaunchStatus = () => {
    if (!shadersCompiled) {
      launchStatus.textContent =
        audioLoadedCount < audioTotalCount
          ? `Compiling WebGL2 shaders & loading audio stems (${audioLoadedCount}/${audioTotalCount})...`
          : `Compiling WebGL2 shaders · all ${audioTotalCount} audio stems armed...`;
    } else if (audioLoadedCount < audioTotalCount) {
      launchStatus.textContent = `WebGL2 shaders compiled · loading audio stems (${audioLoadedCount}/${audioTotalCount})...`;
    } else {
      launchStatus.textContent = `All ${audioTotalCount} audio stems armed · WebGL2 HDR pipeline ready.`;
    }
  };

  audio.preloadAll((loaded, total) => {
    audioLoadedCount = loaded;
    audioTotalCount = total;
    updateLaunchStatus();
  });

  // Button listeners
  btnLaunch.addEventListener('click', () => void startDemoFrom(0));
  btnReplay.addEventListener('click', () => void startDemoFrom(0));
  btnFreecam.addEventListener('click', () => {
    finaleOverlay.classList.add('hidden');
    setCameraMode('orbit');
    document.body.classList.add('no-letterbox');
  });
  btnPlay.addEventListener('click', () => void togglePlayPause());
  btnRestart.addEventListener('click', () => void startDemoFrom(0));
  btnMute.addEventListener('click', toggleMute);
  btnHud.addEventListener('click', toggleHud);
  btnDrs.addEventListener('click', toggleDrsMode);

  camButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn.dataset.cam || 'auto') as CameraMode;
      setCameraMode(mode);
    });
  });

  const commitScrub = (targetT: number, resumeAudio: boolean) => {
    const clampedT = THREE.MathUtils.clamp(Number.isFinite(targetT) ? targetT : 0, 0, TOTAL_DURATION);
    if (clampedT < TOTAL_DURATION - 0.1) {
      finaleShown = false;
      finaleOverlay.classList.add('hidden');
    }
    choreography.reset(clampedT);
    syncTimelineDom(choreography.currentTime, true);
    resetDrsWindow(0.4);
    applySceneFrame(0.016, clampedT, false, true);
    if (resumeAudio && isPlaying) {
      void audio
        .unlockAndInit()
        .then(() => {
          if (isPlaying && !isScrubbing) {
            audio.startPlayback(choreography.currentTime);
          }
        })
        .catch(() => {
          // Ignore audio resume failure during scrub
        });
    }
  };

  let scrubCommitPending = false;
  const finishScrub = () => {
    if (!scrubCommitPending && !isScrubbing) return;
    isScrubbing = false;
    scrubCommitPending = false;
    commitScrub(parseFloat(scrubber.value), true);
  };

  scrubber.addEventListener('input', () => {
    isScrubbing = true;
    scrubCommitPending = true;
    commitScrub(parseFloat(scrubber.value), false);
  });

  scrubber.addEventListener('change', () => {
    // Prevent duplicate audio restarts when mouse release already committed via pointerup
    if (scrubCommitPending || isScrubbing) {
      finishScrub();
    } else if (Math.abs(parseFloat(scrubber.value) - choreography.currentTime) > 0.05) {
      commitScrub(parseFloat(scrubber.value), true);
    }
  });

  scrubber.addEventListener('pointerup', finishScrub);
  scrubber.addEventListener('pointercancel', finishScrub);

  tripSlider.addEventListener('input', () => {
    const val = THREE.MathUtils.clamp(parseFloat(tripSlider.value) || 0, 0, 1.5);
    userTripOverride = val;
    lastTripIntensity = val;
    tripValueEl.textContent = `${Math.round(val * 100)}%`;
    if (hasLaunched && !isPlaying) {
      applySceneFrame(0.016, performance.now() / 1000, false, false);
    }
  });

  tripSlider.addEventListener('dblclick', () => {
    userTripOverride = null;
    lastTripIntensity = choreography.autoTripIntensity;
    tripValueEl.textContent = 'AUTO';
    if (hasLaunched && !isPlaying) {
      applySceneFrame(0.016, performance.now() / 1000, false, false);
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const keyLower = e.key.toLowerCase();
    if (e.code === 'Space') {
      e.preventDefault();
      void togglePlayPause();
    } else if (e.key === '1') setCameraMode('auto');
    else if (e.key === '2') setCameraMode('cockpit');
    else if (e.key === '3') setCameraMode('chase');
    else if (e.key === '4') setCameraMode('orbit');
    else if (e.key === '5') setCameraMode('cinematic');
    else if (keyLower === 'h') toggleHud();
    else if (keyLower === 'm') toggleMute();
    else if (keyLower === 'q') toggleDrsMode();
    else if (keyLower === 'r') void startDemoFrom(0);
    else if (keyLower === 'l') {
      if (userTripOverride === null || userTripOverride < 1.2) {
        userTripOverride = 1.45;
        lastTripIntensity = 1.45;
        tripSlider.value = '1.45';
        tripValueEl.textContent = '145%';
      } else {
        userTripOverride = null;
        lastTripIntensity = choreography.autoTripIntensity;
        tripSlider.value = '1.0';
        tripValueEl.textContent = 'AUTO';
      }
      if (hasLaunched && !isPlaying) {
        applySceneFrame(0.016, performance.now() / 1000, false, false);
      }
    }
  });

  // Auto-dim dock when pointer is idle during playback (desktop + tablet touch support)
  let dockIdleTimer: number | null = null;
  const bumpDockActivity = () => {
    controlDock.classList.remove('dimmed');
    if (dockIdleTimer) window.clearTimeout(dockIdleTimer);
    dockIdleTimer = window.setTimeout(() => {
      if (isPlaying) controlDock.classList.add('dimmed');
    }, 3200);
  };
  window.addEventListener('mousemove', bumpDockActivity, { passive: true });
  window.addEventListener('pointerdown', bumpDockActivity, { passive: true });
  window.addEventListener('touchstart', bumpDockActivity, { passive: true });

  // Resize handling (updates DPR too when moving between Retina and external displays)
  window.addEventListener('resize', () => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const nativeDpr = getNativeDpr();
    const minDpr = getMinAutoDpr(nativeDpr);
    const nextDpr = drsMode === 'native' ? nativeDpr : quantiseDpr(appliedDpr, minDpr, nativeDpr);
    applyViewportResolution(w, h, nextDpr);
    resetDrsWindow(0.6);
  });

  // ------------------------------------------------------------------
  // 4. DETERMINISTIC DEBUG & VERIFICATION HOOK
  // ------------------------------------------------------------------
  const applySceneFrame = (dt: number, realTime: number, advanceSim: boolean, forceCamSnap = false) => {
    const { tripIntensity } = choreography.update(
      dt,
      realTime,
      camera,
      camMode,
      userTripOverride,
      advanceSim,
    );
    lastTripIntensity = tripIntensity;

    if (forceCamSnap && camMode !== 'orbit') {
      choreography.updateCamera(dt, realTime, camera, camMode, true);
    }

    if (camMode === 'orbit') {
      if (forceCamSnap) {
        const heroPos = choreography.hero.group.position;
        orbitControls.target.copy(heroPos);
        camera.position.copy(heroPos).add(orbitOffset);
        camera.position.y = Math.max(12, camera.position.y);
        prevOrbitHeroPos.copy(heroPos);
      } else {
        heroDelta.subVectors(choreography.hero.group.position, prevOrbitHeroPos);
        if (heroDelta.lengthSq() > 1e-8) {
          orbitControls.target.add(heroDelta);
          camera.position.add(heroDelta);
          prevOrbitHeroPos.copy(choreography.hero.group.position);
        }
      }
      orbitControls.update();
    }

    const simDt = advanceSim ? dt * choreography.timeScale : 0;

    // Pass Viper-1 world position & pre-allocated forward vector for sea-spray wake
    const heroPos = choreography.hero.group.position;
    heroForward.set(0, 0, -1).applyQuaternion(choreography.hero.group.quaternion);
    env.setHeroPosition(heroPos, heroForward);

    // Subtle real-time Web Audio FFT sync driving LSD prism, monolith conduits, and bloom
    const audioBass = isPlaying ? audio.bassEnergy : 0;
    const audioMid = isPlaying ? audio.midEnergy : 0;
    const audioBeat = isPlaying ? audio.beatPulse : 0;
    const reactiveTrip = THREE.MathUtils.clamp(
      tripIntensity + audioBass * 0.06 + audioBeat * 0.11,
      0,
      1.5,
    );

    env.update(
      realTime,
      dt,
      camera.position,
      choreography.stormIntensity,
      reactiveTrip,
      vfx.explosionFlash,
      heroPos,
      heroForward,
    );

    // Pulse monolith energy conduits (only once revealed) & rim illumination cleanly with bass/beat transients
    const monolithPulse = audioBass * 0.24 + audioBeat * 0.48;
    if (monolithPulse > 0.001) {
      for (let i = 0; i < monolithConduitMats.length; i++) {
        const uniforms = monolithConduitMats[i].uniforms;
        if (uniforms.uReveal.value > 0.005) {
          uniforms.uLightning.value += monolithPulse;
        }
      }
      env.rimLight.intensity += audioBass * 0.35 + audioBeat * 0.55;
    }

    vfx.update(simDt, realTime, camera, reactiveTrip, choreography.speedIntensity);

    // Fog smoothly tracks storm & chromatic overdrive
    const fog = scene.fog as THREE.FogExp2;
    fog.color.setHSL(
      reactiveTrip > 0.25 ? (0.82 + Math.sin(realTime * 0.2) * 0.1) % 1 : 0.07,
      0.38 + reactiveTrip * 0.45,
      THREE.MathUtils.lerp(0.24, 0.12, choreography.stormIntensity),
    );
    fog.density = 0.00014 + choreography.stormIntensity * 0.00012;

    post.update(
      realTime,
      reactiveTrip,
      vfx.shockImpact + choreography.cameraShake * 0.35,
      choreography.speedIntensity,
    );
    if (audioBass > 0.001 || audioBeat > 0.001 || audioMid > 0.001) {
      post.bloomPass.strength += audioBass * 0.10 + audioBeat * 0.16;
      post.anamorphicPass.intensity += audioBeat * 0.10 + audioMid * 0.05;
    }
    renderPostFrame();
    renderHudNow(realTime, tripIntensity);
  };

  let pixelReadBuf: Uint8Array | null = null;
  const sampleCanvasStats = (): DogfightCanvasStats => {
    renderPostFrame();
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const needed = w * h * 4;
    if (!pixelReadBuf || pixelReadBuf.length !== needed) {
      pixelReadBuf = new Uint8Array(needed);
    }
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixelReadBuf);

    // Sample central 3D viewport (excluding letterbox bands and dock)
    const x0 = Math.floor(w * 0.08);
    const x1 = Math.floor(w * 0.92);
    const y0 = Math.floor(h * 0.24);
    const y1 = Math.floor(h * 0.88);
    const step = 4;

    let count = 0;
    let sumLum = 0;
    let sumLumSq = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumRSq = 0;
    let sumGSq = 0;
    let sumBSq = 0;
    let nonBlack = 0;

    for (let y = y0; y < y1; y += step) {
      const rowStart = y * w * 4;
      for (let x = x0; x < x1; x += step) {
        const idx = rowStart + x * 4;
        const r = pixelReadBuf[idx];
        const g = pixelReadBuf[idx + 1];
        const b = pixelReadBuf[idx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        sumLum += lum;
        sumLumSq += lum * lum;
        sumR += r;
        sumG += g;
        sumB += b;
        sumRSq += r * r;
        sumGSq += g * g;
        sumBSq += b * b;
        if (lum > 4) nonBlack++;
        count++;
      }
    }

    const safeCount = Math.max(count, 1);
    const meanLuminance = sumLum / safeCount;
    const lumVariance = Math.max(0, sumLumSq / safeCount - meanLuminance * meanLuminance);
    const varR = Math.max(0, sumRSq / safeCount - (sumR / safeCount) ** 2);
    const varG = Math.max(0, sumGSq / safeCount - (sumG / safeCount) ** 2);
    const varB = Math.max(0, sumBSq / safeCount - (sumB / safeCount) ** 2);

    return {
      meanLuminance,
      lumVariance,
      colourVariance: varR + varG + varB,
      nonBlackRatio: nonBlack / safeCount,
      sampleCount: count,
    };
  };

  const readState = (): DogfightDebugState => ({
    currentTime: choreography.currentTime,
    camMode,
    cameraTag: choreography.activeCameraTag,
    cameraPosition: [camera.position.x, camera.position.y, camera.position.z],
    cameraUp: [camera.up.x, camera.up.y, camera.up.z],
    hudEnabled: hud.enabled,
    tripIntensity: userTripOverride !== null ? userTripOverride : lastTripIntensity,
    isPlaying,
    fps: currentFps,
    audioBass: audio.bassEnergy,
    audioMid: audio.midEnergy,
    audioBeat: audio.beatPulse,
  });

  const getPerfStats = (): DogfightPerfStats => {
    const n = frameRingCount;
    let frameMsP50 = 0;
    let frameMsP95 = 0;
    let frameMsP99 = 0;
    let fps = currentFps;

    if (n > 0) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = frameDeltaRing[i];
        frameSortScratch[i] = v;
        sum += v;
      }
      // In-place insertion sort on pre-allocated scratch buffer (n <= 120)
      for (let i = 1; i < n; i++) {
        const key = frameSortScratch[i];
        let j = i - 1;
        while (j >= 0 && frameSortScratch[j] > key) {
          frameSortScratch[j + 1] = frameSortScratch[j];
          j--;
        }
        frameSortScratch[j + 1] = key;
      }
      frameMsP50 = frameSortScratch[Math.min(n - 1, Math.max(0, Math.ceil(0.5 * n) - 1))];
      frameMsP95 = frameSortScratch[Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1))];
      frameMsP99 = frameSortScratch[Math.min(n - 1, Math.max(0, Math.ceil(0.99 * n) - 1))];
      const meanMs = sum / n;
      fps = meanMs > 0 ? 1000 / meanMs : currentFps;
    }

    const info = renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs ? info.programs.length : 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      pixelRatio: renderer.getPixelRatio(),
      drsMode,
      frameMsP50,
      frameMsP95,
      frameMsP99,
      fps,
    };
  };

  const debugApi: DogfightDebugApi = Object.freeze({
    get currentTime() {
      return choreography.currentTime;
    },
    get camMode() {
      return camMode;
    },
    get cameraTag() {
      return choreography.activeCameraTag;
    },
    get cameraPosition(): readonly [number, number, number] {
      return [camera.position.x, camera.position.y, camera.position.z];
    },
    get cameraUp(): readonly [number, number, number] {
      return [camera.up.x, camera.up.y, camera.up.z];
    },
    get hudEnabled() {
      return hud.enabled;
    },
    get tripIntensity() {
      return userTripOverride !== null ? userTripOverride : lastTripIntensity;
    },
    get isPlaying() {
      return isPlaying;
    },
    get fps() {
      return currentFps;
    },
    get audioBass() {
      return audio.bassEnergy;
    },
    get audioMid() {
      return audio.midEnergy;
    },
    get audioBeat() {
      return audio.beatPulse;
    },
    getState: readState,
    getPerfStats,
    seek(t: number) {
      const targetT = THREE.MathUtils.clamp(Number(t) || 0, 0, TOTAL_DURATION);
      choreography.reset(targetT);
      resetDrsWindow(0.4);
      applySceneFrame(0.016, targetT, false, true);
      syncTimelineDom(choreography.currentTime, true);
    },
    setCamera(mode: CameraMode) {
      setCameraMode(mode);
    },
    sampleCanvasStats,
  });

  // ------------------------------------------------------------------
  // 5. ASYNC SHADER PRE-WARM & MAIN ANIMATION LOOP
  // ------------------------------------------------------------------
  // Pre-compile all scene materials once against the HalfFloat EffectComposer target
  // via KHR_parallel_shader_compile with constant PointLight count so Act I–V
  // transitions suffer zero shader-compile stutter.
  updateLaunchStatus();
  syncConstantPointLightCount();
  const prevCompileTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(post.composer.renderTarget1);
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    // Graceful fallback if driver lacks parallel compile support
  } finally {
    renderer.setRenderTarget(prevCompileTarget);
  }
  shadersCompiled = true;
  updateLaunchStatus();

  // Warm up offscreen cloud pass and fused post-processing passes once before frame timing starts,
  // unless playback was already engaged while async shader compilation was in flight.
  if (!hasLaunched) {
    choreography.currentTime = 4.2;
    const warmupState = choreography.update(0.016, 0, camera, 'cinematic', 0.12, false);
    lastTripIntensity = warmupState.tripIntensity;
    heroForward.set(0, 0, -1).applyQuaternion(choreography.hero.group.quaternion);
    env.setHeroPosition(choreography.hero.group.position, heroForward);
    env.update(
      0,
      0.016,
      camera.position,
      0.08,
      warmupState.tripIntensity,
      0,
      choreography.hero.group.position,
      heroForward,
    );
    vfx.update(0.016, 0, camera, warmupState.tripIntensity, 0.3);
    post.update(0, warmupState.tripIntensity, 0, 0.2);
    renderPostFrame();
  }

  Object.defineProperty(window, '__DOGFIGHT_DEBUG__', {
    value: debugApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  let lastNow = -1;
  let fpsAccum = 0;
  let fpsFrames = 0;

  const animate = (now: number) => {
    requestAnimationFrame(animate);

    let rawDt = 0.016;
    let frameMs = 0;
    if (lastNow >= 0) {
      frameMs = now - lastNow;
      if (frameMs > 0 && frameMs < 5000) {
        frameDeltaRing[frameRingHead] = frameMs;
        frameRingHead = (frameRingHead + 1) % FRAME_RING_CAPACITY;
        if (frameRingCount < FRAME_RING_CAPACITY) {
          frameRingCount++;
        }
      }
      rawDt = Math.min(Math.max(frameMs, 0) / 1000, 0.08);
    }
    lastNow = now;
    const realTime = now / 1000;

    // Adaptive Dynamic Resolution Scaler (hysteresis-guarded, zero allocations)
    updateDrs(frameMs, realTime);

    // FPS counter
    fpsAccum += rawDt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      currentFps = Math.round(fpsFrames / fpsAccum);
      updatePerfReadout();
      fpsAccum = 0;
      fpsFrames = 0;
    }

    if (!hasLaunched) {
      // Lush live idling hero fly-past behind the title card
      choreography.currentTime = 4.2;
      const { tripIntensity } = choreography.update(rawDt, realTime, camera, 'cinematic', 0.12, false);
      lastTripIntensity = tripIntensity;
      heroForward.set(0, 0, -1).applyQuaternion(choreography.hero.group.quaternion);
      env.setHeroPosition(choreography.hero.group.position, heroForward);
      env.update(
        realTime,
        rawDt,
        camera.position,
        0.08,
        tripIntensity,
        0,
        choreography.hero.group.position,
        heroForward,
      );
      vfx.update(rawDt, realTime, camera, tripIntensity, 0.3);
      post.update(realTime, tripIntensity, 0, 0.2);
      renderPostFrame();
      return;
    }

    // Update real-time FFT audio analysis (zero heap allocations) before rendering frame
    audio.updateAnalysis(rawDt, isPlaying && !isScrubbing);

    applySceneFrame(rawDt, realTime, isPlaying && !isScrubbing, false);

    // Update Web Audio continuous engine bed
    audio.updateContinuous(choreography.hero.throttle, choreography.timeScale, isPlaying);

    // Throttled scrubber & timeline clock DOM sync (avoids per-frame DOM thrashing at 120 fps)
    if (!isScrubbing) {
      syncTimelineDom(choreography.currentTime);
    }

    // Show finale card at end of 88-second sequence
    if (isPlaying && choreography.currentTime >= TOTAL_DURATION && !finaleShown) {
      finaleShown = true;
      isPlaying = false;
      syncPlayButton();
      audio.stopMusicAndEngine();
      finaleOverlay.classList.remove('hidden');
    }
  };

  requestAnimationFrame(animate);
}

void bootstrap();
