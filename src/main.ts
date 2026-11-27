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
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // MSAA handled inside HalfFloat EffectComposer render target
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.NoToneMapping; // ACES applied in our custom final shader pass
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x281c28, 0.00018);

  const camera = new THREE.PerspectiveCamera(64, window.innerWidth / window.innerHeight, 0.8, 16000);
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
  const audio = new AudioEngine();
  const hud = new FighterHUD(hudCanvas);

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
  let finaleShown = false;

  const setCameraMode = (mode: CameraMode) => {
    camMode = mode;
    orbitControls.enabled = mode === 'orbit';
    if (mode === 'orbit') {
      orbitControls.target.copy(choreography.hero.group.position);
      camera.position.copy(choreography.hero.group.position).add(new THREE.Vector3(28, 12, 34));
      orbitControls.update();
    }
    camButtons.forEach((b) => b.classList.toggle('active', b.dataset.cam === mode));
  };

  const syncPlayButton = () => {
    btnPlay.textContent = isPlaying ? '❚❚' : '▶';
  };

  const startDemoFrom = async (startTime = 0) => {
    hasLaunched = true;
    finaleShown = false;
    launchOverlay.classList.add('hidden');
    finaleOverlay.classList.add('hidden');
    controlDock.classList.remove('hidden');

    await audio.unlockAndInit();
    choreography.reset(startTime);
    isPlaying = true;
    syncPlayButton();
    audio.startPlayback(startTime);
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
      }
      finaleOverlay.classList.add('hidden');
      finaleShown = false;
      await audio.unlockAndInit();
      audio.startPlayback(choreography.currentTime);
    } else {
      audio.stopMusicAndEngine();
    }
  };

  // Preload all 14 fal.ai audio assets in the background immediately
  audio.preloadAll((loaded, total) => {
    if (loaded < total) {
      launchStatus.textContent = `Loading bespoke fal.ai audio stems (${loaded}/${total})...`;
    } else {
      launchStatus.textContent = `All ${total} audio stems armed · WebGL HDR pipeline ready.`;
    }
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

  btnMute.addEventListener('click', () => {
    audio.setMuted(!audio.isMuted);
    btnMute.textContent = audio.isMuted ? '🔇' : '🔊';
  });

  btnHud.addEventListener('click', () => {
    hud.enabled = !hud.enabled;
    btnHud.classList.toggle('active', hud.enabled);
  });

  camButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn.dataset.cam || 'auto') as CameraMode;
      setCameraMode(mode);
    });
  });

  scrubber.addEventListener('input', () => {
    isScrubbing = true;
    const targetT = parseFloat(scrubber.value);
    choreography.reset(targetT);
    timeCurrentEl.textContent = formatTime(targetT);
  });

  scrubber.addEventListener('change', () => {
    isScrubbing = false;
    const targetT = parseFloat(scrubber.value);
    choreography.reset(targetT);
    if (isPlaying) {
      audio.startPlayback(targetT);
    }
  });

  tripSlider.addEventListener('input', () => {
    const val = parseFloat(tripSlider.value);
    userTripOverride = val;
    tripValueEl.textContent = `${Math.round(val * 100)}%`;
  });

  tripSlider.addEventListener('dblclick', () => {
    userTripOverride = null;
    tripValueEl.textContent = 'AUTO';
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') {
      e.preventDefault();
      void togglePlayPause();
    } else if (e.key === '1') setCameraMode('auto');
    else if (e.key === '2') setCameraMode('cockpit');
    else if (e.key === '3') setCameraMode('chase');
    else if (e.key === '4') setCameraMode('orbit');
    else if (e.key === '5') setCameraMode('cinematic');
    else if (e.key.toLowerCase() === 'h') {
      hud.enabled = !hud.enabled;
      btnHud.classList.toggle('active', hud.enabled);
    } else if (e.key.toLowerCase() === 'm') {
      audio.setMuted(!audio.isMuted);
      btnMute.textContent = audio.isMuted ? '🔇' : '🔊';
    } else if (e.key.toLowerCase() === 'r') {
      void startDemoFrom(0);
    } else if (e.key.toLowerCase() === 'l') {
      if (userTripOverride === null || userTripOverride < 1.2) {
        userTripOverride = 1.45;
        tripSlider.value = '1.45';
        tripValueEl.textContent = '145%';
      } else {
        userTripOverride = null;
        tripSlider.value = '1.0';
        tripValueEl.textContent = 'AUTO';
      }
    }
  });

  // Auto-dim dock when mouse is idle during playback
  let dockIdleTimer: number | null = null;
  const bumpDockActivity = () => {
    controlDock.classList.remove('dimmed');
    if (dockIdleTimer) window.clearTimeout(dockIdleTimer);
    dockIdleTimer = window.setTimeout(() => {
      if (isPlaying) controlDock.classList.add('dimmed');
    }, 3200);
  };
  window.addEventListener('mousemove', bumpDockActivity);

  // Resize handling
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    post.setSize(w, h);
    hud.resize();
  });

  // ------------------------------------------------------------------
  // 4. MAIN ANIMATION LOOP
  // ------------------------------------------------------------------
  let lastNow = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;

  const animate = (now: number) => {
    requestAnimationFrame(animate);

    const rawDt = Math.min((now - lastNow) / 1000, 0.08);
    lastNow = now;
    const realTime = now / 1000;

    // FPS counter
    fpsAccum += rawDt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      perfReadout.textContent = `${Math.round(fpsFrames / fpsAccum)} FPS`;
      fpsAccum = 0;
      fpsFrames = 0;
    }

    if (!hasLaunched) {
      // Lush live idling hero fly-past behind the title card
      choreography.currentTime = 4.2;
      const { tripIntensity } = choreography.update(rawDt, realTime, camera, 'cinematic', 0.12, false);
      env.update(realTime, rawDt, camera.position, 0.08, tripIntensity, 0);
      vfx.update(rawDt, realTime, camera, tripIntensity, 0.3);
      post.update(realTime, tripIntensity, 0, 0.2);
      post.render();
      return;
    }

    const { tripIntensity } = choreography.update(
      rawDt,
      realTime,
      camera,
      camMode,
      userTripOverride,
      isPlaying && !isScrubbing,
    );

    if (camMode === 'orbit') {
      orbitControls.target.lerp(choreography.hero.group.position, 0.08);
      orbitControls.update();
    }

    const simDt = isPlaying && !isScrubbing ? rawDt * choreography.timeScale : 0;
    env.update(
      realTime,
      rawDt,
      camera.position,
      choreography.stormIntensity,
      tripIntensity,
      vfx.explosionFlash,
    );
    vfx.update(simDt, realTime, camera, tripIntensity, choreography.speedIntensity);

    // Fog smoothly tracks storm & acid vibe
    const fog = scene.fog as THREE.FogExp2;
    fog.color.setHSL(
      tripIntensity > 0.25 ? (0.82 + Math.sin(realTime * 0.2) * 0.1) % 1 : 0.07,
      0.38 + tripIntensity * 0.45,
      THREE.MathUtils.lerp(0.24, 0.12, choreography.stormIntensity),
    );
    fog.density = 0.00014 + choreography.stormIntensity * 0.00012;

    post.update(
      realTime,
      tripIntensity,
      vfx.shockImpact + choreography.cameraShake * 0.35,
      choreography.speedIntensity,
    );
    post.render();

    // Update 2D Fighter HUD overlay
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
    );

    // Update Web Audio continuous engine bed
    audio.updateContinuous(choreography.hero.throttle, choreography.timeScale, isPlaying);

    // Sync scrubber & timeline clock
    if (!isScrubbing) {
      scrubber.value = choreography.currentTime.toFixed(2);
      timeCurrentEl.textContent = formatTime(choreography.currentTime);
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
