import * as THREE from 'three';
import { FighterJet } from '../aircraft/FighterJet';
import { BayhemVFX, GuidedMissile } from '../vfx/BayhemVFX';
import { WorldEnvironment } from '../environment/WorldEnvironment';
import { CameraDirector, CameraDirectorContext, CameraMode } from './CameraDirector';

export type { CameraMode } from './CameraDirector';

export interface RadioCue {
  id: string;
  time: number;
  callsign: string;
  text: string;
  audioKey: string;
  duration: number;
}

export interface ActInfo {
  eyebrow: string;
  title: string;
  start: number;
  end: number;
}

export interface ChoreographyCallbacks {
  onRadio: (cue: RadioCue) => void;
  onSfx: (key: string, volume?: number, pan?: number) => void;
  onActChange: (act: ActInfo) => void;
  onLockState: (locked: boolean, target: FighterJet | null) => void;
}

export const TOTAL_DURATION = 88.0;

export const ACTS: ActInfo[] = [
  { eyebrow: 'ACT I · 0:00', title: 'GOLDEN HOUR BREAK', start: 0, end: 14 },
  { eyebrow: 'ACT II · 0:14', title: 'GUNS, GUNS, GUNS', start: 14, end: 32 },
  { eyebrow: 'ACT III · 0:32', title: 'CHROMATIC SUPERCELL', start: 32, end: 52 },
  { eyebrow: 'ACT IV · 0:52', title: 'PUGACHEV SUPERNOVA', start: 52, end: 76 },
  { eyebrow: 'ACT V · 1:16', title: 'VERTICAL SUNRISE', start: 76, end: 88 },
];

export const RADIO_CUES: RadioCue[] = [
  {
    id: 'r1',
    time: 3.5,
    callsign: 'OVERLORD AWACS · UHF 243.0',
    text: "Viper-One, weapons free! Bandits twelve o'clock high, angels twenty — punch it!",
    audioKey: 'radio_01',
    duration: 4.6,
  },
  {
    id: 'r2',
    time: 16.5,
    callsign: 'VIPER-1 · GUARD',
    text: 'Tally five! Switching to guns — too close for missiles!',
    audioKey: 'radio_02',
    duration: 4.0,
  },
  {
    id: 'r3',
    time: 26.2,
    callsign: 'VIPER-1 · GUARD',
    text: "Splash one! Going down in flames — watch the debris!",
    audioKey: 'radio_03',
    duration: 3.8,
  },
  {
    id: 'r4',
    time: 38.5,
    callsign: 'VIPER-1 · GUARD',
    text: "Whoa — what is happening to the sky?! Instruments are melting — staying on his six!",
    audioKey: 'radio_04',
    duration: 5.2,
  },
  {
    id: 'r5',
    time: 58.0,
    callsign: 'VIPER-1 · GUARD',
    text: "Fox-Two! Fox-Two! Everything I've got — light 'em up!",
    audioKey: 'radio_05',
    duration: 4.2,
  },
  {
    id: 'r6',
    time: 75.8,
    callsign: 'VIPER-1 · GUARD',
    text: 'Splash Bandit Ace! Skies are clear... Viper-One, heading home.',
    audioKey: 'radio_06',
    duration: 4.6,
  },
];

interface DebrisTrailSlot {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  duration: number;
  emitAccum: number;
  splashed: boolean;
  prism: boolean;
}

const KILL_TIME_W2 = 24.5;
const KILL_TIME_W1 = 37.1;
const KILL_TIME_W3 = 47.6;
const KILL_TIME_W4 = 49.4;
const KILL_TIME_ACE = 69.4;

const SCHEDULED_EVENTS: readonly (readonly [string, number])[] = [
  ['flyby1', 6.5],
  ['guns1', 20.8],
  ['kill_w2', KILL_TIME_W2],
  ['flares1', 27.4],
  ['missile_w1', 33.8],
  ['kill_w1_fallback', KILL_TIME_W1],
  ['flares2', 41.5],
  ['missile_w3', 44.5],
  ['flares3', 44.8],
  ['missile_w4', 46.2],
  ['kill_w3_fallback', KILL_TIME_W3],
  ['kill_w4_fallback', KILL_TIME_W4],
  ['cobra_boom', 56.8],
  ['macross_salvo', 64.0],
  ['kill_ace_fallback', KILL_TIME_ACE],
  ['finale_boom', 81.2],
];

export class DogfightChoreography {
  public readonly hero: FighterJet;
  public readonly bandits: FighterJet[];
  public readonly allJets: FighterJet[];
  public readonly ace: FighterJet;

  public currentTime = 0;
  public timeScale = 1.0;
  public autoTripIntensity = 0;
  public stormIntensity = 0;
  public speedIntensity = 0;
  public cameraShake = 0;
  public activeCameraTag = 'DIRECTOR';
  public lockedTarget: FighterJet | null = null;
  public isMissileLocked = false;

  private readonly director = new CameraDirector();
  private readonly heroCurve: THREE.CatmullRomCurve3;
  private readonly idleHeroCurve: THREE.CatmullRomCurve3;
  private readonly banditCurves: THREE.CatmullRomCurve3[];
  private readonly triggeredEvents = new Set<string>();
  private readonly vfx: BayhemVFX;
  private readonly env: WorldEnvironment;
  private readonly callbacks: ChoreographyCallbacks;

  private readonly debrisTrails: DebrisTrailSlot[] = [];

  private hasLaunchedOrReset = false;
  private currentActIdx = -1;
  private featuredMissile: GuidedMissile | null = null;
  private gunTimer = 0;
  private sprayTimer = 0;
  private lastIsPlaying = false;

  // Pre-allocated scratch vectors & reusable structures (zero per-frame heap allocations)
  private readonly _pos = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3();
  private readonly _tangent = new THREE.Vector3();
  private readonly _nextTangent = new THREE.Vector3();
  private readonly _aim = new THREE.Vector3();
  private readonly _origin = new THREE.Vector3();
  private readonly _initVel = new THREE.Vector3();
  private readonly _offset = new THREE.Vector3();
  private readonly _launchDir = new THREE.Vector3();
  private readonly _secPos = new THREE.Vector3();
  private readonly _w2KillPos = new THREE.Vector3(10, 165, -1480);
  private readonly _supernovaFocus = new THREE.Vector3(35, 528, -1545);
  private readonly _updateResult = { tripIntensity: 0 };
  private readonly _camCtx: CameraDirectorContext;

  constructor(
    scene: THREE.Scene,
    vfx: BayhemVFX,
    env: WorldEnvironment,
    callbacks: ChoreographyCallbacks,
  ) {
    this.vfx = vfx;
    this.env = env;
    this.callbacks = callbacks;

    this.hero = new FighterJet('viper1', 'VIPER-1', 'hero');
    const w1 = new FighterJet('wraith1', 'WRAITH-1', 'bandit');
    const w2 = new FighterJet('wraith2', 'WRAITH-2', 'bandit');
    const w3 = new FighterJet('wraith3', 'WRAITH-3', 'bandit');
    const w4 = new FighterJet('wraith4', 'WRAITH-4', 'bandit');
    this.ace = new FighterJet('crimson1', 'CRIMSON-1', 'ace');

    this.bandits = [w1, w2, w3, w4, this.ace];
    this.allJets = [this.hero, ...this.bandits];

    for (const j of this.allJets) {
      scene.add(j.group);
    }
    this.vfx.registerContrails(this.allJets);

    // Pre-allocate 5 flaming debris trail slots (one per enemy kill)
    for (let i = 0; i < 5; i++) {
      this.debrisTrails.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        age: 0,
        duration: 3.4,
        emitAccum: 0,
        splashed: false,
        prism: false,
      });
    }

    // ------------------------------------------------------------------
    // HERO 88-SECOND FLIGHT SPLINE (GOLDEN CANYON -> SUPERCELL -> COBRA -> SUNRISE)
    // ------------------------------------------------------------------
    this.heroCurve = new THREE.CatmullRomCurve3(
      [
        // Act I (0–14s): Low ocean-skimming break & near-miss past basalt sea-stacks
        new THREE.Vector3(0, 26, 220),
        new THREE.Vector3(-48, 24, -80),
        new THREE.Vector3(-92, 34, -340), // Sea-stack near-miss inside [-210, -320]
        new THREE.Vector3(96, 56, -610),  // Sweeps past [230, -480] during Act I barrel roll
        // Act II (14–32s): Aggressive canyon merge & cockpit Vulcan pass on WRAITH-2
        new THREE.Vector3(-95, 92, -960),
        new THREE.Vector3(78, 142, -1310),
        new THREE.Vector3(-88, 188, -1660),
        new THREE.Vector3(65, 255, -2040),
        // Act III (32–52s): High-G climb into Chromatic Supercell & Monolith Cathedral
        new THREE.Vector3(-135, 365, -2220),
        new THREE.Vector3(-275, 475, -1820),
        new THREE.Vector3(-155, 525, -1360),
        new THREE.Vector3(175, 555, -1210),
        // Act IV (52–76s): Head-on duel vs CRIMSON-1, inverted Cobra & 8-missile Macross salvo
        new THREE.Vector3(260, 540, -1580),
        new THREE.Vector3(60, 522, -1720),
        new THREE.Vector3(-25, 520, -1410), // Inverted Pugachev's Cobra bullet-time apex!
        new THREE.Vector3(15, 515, -1220),  // 8-missile Macross prism salvo release!
        new THREE.Vector3(165, 505, -1440), // Sweeping high bank around central monolith cathedral
        new THREE.Vector3(155, 465, -1740), // Banking clear of CRIMSON-1 thermobaric supernova
        // Act V (76–88s): Shockwave dive -> glassy ocean victory roll -> vertical sunrise climb!
        new THREE.Vector3(65, 195, -2080),
        new THREE.Vector3(-35, 72, -2420),
        new THREE.Vector3(-90, 250, -2640),
        new THREE.Vector3(-145, 760, -2800),
      ],
      false,
      'catmullrom',
      0.5,
    );

    // Closed golden-hour ocean canyon loop for the live pre-launch title screen fly-past
    this.idleHeroCurve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(-18, 28, 160),
        new THREE.Vector3(-74, 25, -220),
        new THREE.Vector3(62, 36, -620),
        new THREE.Vector3(-42, 46, -980),
        new THREE.Vector3(115, 42, -560),
        new THREE.Vector3(88, 30, -80),
      ],
      true,
      'catmullrom',
      0.5,
    );

    // ------------------------------------------------------------------
    // 5 BANDIT SPLINES CHOREOGRAPHED FOR TIGHT COMBAT ALIGNMENT
    // ------------------------------------------------------------------
    // WRAITH-1 (Act III Sidewinder kill at ~36.8s)
    const cW1 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-180, 320, -1100),
      new THREE.Vector3(-40, 125, -820),
      new THREE.Vector3(135, 165, -1420),
      new THREE.Vector3(-190, 275, -1860),
      new THREE.Vector3(-280, 415, -2060),
      new THREE.Vector3(-220, 485, -1680), // Ahead-port of Viper-1 at t=34–37s
      new THREE.Vector3(120, 540, -1320),
      new THREE.Vector3(240, 515, -1560),
    ]);

    // WRAITH-2 (Act II Vulcan gun kill at t=24.5s — anchored directly ahead of Viper-1's gunsight!)
    const w2Points: THREE.Vector3[] = [
      new THREE.Vector3(175, 305, -1040),
      new THREE.Vector3(85, 110, -760),
    ];
    const leadTimes = [11.0, 14.5, 17.5, 20.5, 22.5, 24.5, 27.0, 30.0];
    const lateralWeave = [32, -26, 22, -11, 7, 0, -24, -48];
    const vertOffset = [22, 12, 8, 3, 2, 1, -18, -55];
    for (let i = 0; i < leadTimes.length; i++) {
      const leadU = THREE.MathUtils.clamp((leadTimes[i] + 1.35) / TOTAL_DURATION, 0.01, 0.98);
      const pt = this.heroCurve.getPointAt(leadU);
      pt.x += lateralWeave[i];
      pt.y += vertOffset[i];
      w2Points.push(pt);
    }
    const cW2 = new THREE.CatmullRomCurve3(w2Points);

    // WRAITH-3 (Act III featured Sidewinder missile-nose cam kill at ~47.3s)
    const cW3 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 370, -1180),
      new THREE.Vector3(-120, 185, -960),
      new THREE.Vector3(25, 235, -1560),
      new THREE.Vector3(-190, 390, -2020),
      new THREE.Vector3(-165, 515, -1540),
      new THREE.Vector3(75, 550, -1240),   // Crossing ahead of monolith cathedral during flares
      new THREE.Vector3(295, 555, -1390),  // Target intercept zone at t=45–48s
      new THREE.Vector3(210, 520, -1720),
    ]);

    // WRAITH-4 (wingman to WRAITH-3, cascading twin detonation at ~49.1s)
    const cW4 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(85, 390, -1240),
      new THREE.Vector3(145, 210, -980),
      new THREE.Vector3(-65, 260, -1600),
      new THREE.Vector3(-240, 415, -1980),
      new THREE.Vector3(-120, 540, -1490),
      new THREE.Vector3(125, 578, -1285),
      new THREE.Vector3(345, 575, -1440),
      new THREE.Vector3(255, 540, -1765),
    ]);

    // CRIMSON-1 ACE (Act IV boss duel + 8-missile Macross supernova inside central monolith ring at t=69.3s)
    const cAce = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 460, -1280),
      new THREE.Vector3(0, 265, -1020),
      new THREE.Vector3(190, 295, -1620),
      new THREE.Vector3(-60, 450, -2120),
      new THREE.Vector3(-290, 565, -1660),
      new THREE.Vector3(170, 595, -1240),
      new THREE.Vector3(310, 555, -1520),  // Act IV head-on merge (~52–56s)
      new THREE.Vector3(95, 535, -1680),   // Overshoots past Viper-1 during inverted Cobra (~58–62s)
      new THREE.Vector3(-145, 545, -1840), // Pulls wide arc ahead (~64–67s) for 8-missile Macross sweep
      new THREE.Vector3(35, 528, -1545),   // Dead-centre inside central obsidian monolith ring at t=69.3s!
      new THREE.Vector3(185, 505, -1760),
      new THREE.Vector3(135, 455, -2040),
    ]);

    this.banditCurves = [cW1, cW2, cW3, cW4, cAce];

    // Pre-compute exact nominal kill anchors for paused scrubbing / supernova framing
    this.sampleBanditAt(1, KILL_TIME_W2, this._w2KillPos, this._fwd);
    this.sampleBanditAt(4, KILL_TIME_ACE, this._supernovaFocus, this._fwd);

    // Pre-allocate mutable camera director context (zero per-frame allocations)
    this._camCtx = {
      time: 0,
      realTime: 0,
      dt: 0.016,
      mode: 'auto',
      forceSnap: false,
      isPlaying: false,
      isPreLaunchIdle: true,
      hero: this.hero,
      bandits: this.bandits,
      ace: this.ace,
      featuredMissile: null,
      supernovaFocus: this._supernovaFocus,
      w2KillPos: this._w2KillPos,
      cameraShake: 0,
      speedIntensity: 0,
      shockImpact: 0,
    };
  }

  public reset(toTime = 0): void {
    this.hasLaunchedOrReset = true;
    this.currentTime = THREE.MathUtils.clamp(toTime, 0, TOTAL_DURATION);
    this.triggeredEvents.clear();
    this.vfx.clearDynamic();
    this.featuredMissile = null;
    this.currentActIdx = -1;
    this.cameraShake = 0;
    this.gunTimer = 0;
    this.sprayTimer = 0;
    this.director.reset();

    for (let i = 0; i < this.debrisTrails.length; i++) {
      this.debrisTrails[i].active = false;
    }

    for (const j of this.allJets) {
      j.alive = true;
      j.health = 1.0;
    }

    // Deterministic alive/dead states for scrubbing forward or backward
    if (toTime > KILL_TIME_W2 + 0.05) this.bandits[1].alive = false;
    if (toTime > KILL_TIME_W1 + 0.05) this.bandits[0].alive = false;
    if (toTime > KILL_TIME_W3 + 0.05) this.bandits[2].alive = false;
    if (toTime > KILL_TIME_W4 + 0.05) this.bandits[3].alive = false;
    if (toTime > KILL_TIME_ACE + 0.05) this.ace.alive = false;

    for (const cue of RADIO_CUES) {
      if (cue.time < toTime - 0.35) this.triggeredEvents.add(`radio_${cue.id}`);
    }
    for (let i = 0; i < SCHEDULED_EVENTS.length; i++) {
      const ev = SCHEDULED_EVENTS[i];
      if (ev[1] < toTime) this.triggeredEvents.add(ev[0]);
    }

    // Snap all jet world transforms immediately so scrubbed camera/VFX states are exact
    this.updateAtmosphereAndTrip(this.currentTime);
    this.updateJetPoses(this.currentTime, 0.016, this.currentTime, this.autoTripIntensity);
    this.sampleBanditAt(1, KILL_TIME_W2, this._w2KillPos, this._fwd);
    this.sampleBanditAt(4, KILL_TIME_ACE, this._supernovaFocus, this._fwd);

    // Seed signature paused-preview pyrotechnics when scrubbing directly into climax beats
    if (toTime >= KILL_TIME_W2 - 0.05 && toTime <= 26.2) {
      this.triggeredEvents.add('kill_w2');
      this.bandits[1].alive = false;
      this.bandits[1].updateVisuals(this.currentTime, this.autoTripIntensity);
      this.vfx.spawnExplosion(this._w2KillPos, 58, false, this.autoTripIntensity);
      this.env.triggerOceanShockwave(this._w2KillPos, 0.95);
    } else if (toTime >= 44.5 && toTime <= 47.2 && this.bandits[2].alive) {
      this.triggeredEvents.add('missile_w3');
      this.triggeredEvents.add('flares2');
      this.triggeredEvents.add('flares3');
      this.vfx.popDecoyFlares(this.bandits[2], 12);
      if (this.bandits[3].alive) this.vfx.popDecoyFlares(this.bandits[3], 10);
      const frac = THREE.MathUtils.clamp((toTime - 44.5) / 2.9, 0.12, 0.72);
      this._origin.copy(this.hero.group.position).lerp(this.bandits[2].group.position, frac);
      this._initVel
        .subVectors(this.bandits[2].group.position, this._origin)
        .normalize()
        .multiplyScalar(425);
      this.featuredMissile = this.vfx.launchMissile(
        'm_w3',
        this._origin,
        this._initVel,
        this.bandits[2],
        true,
        425,
        (hitPos) => this.killWraith3(hitPos, this.autoTripIntensity),
      );
    } else if (toTime >= KILL_TIME_ACE - 0.1 && toTime <= 72.4) {
      this.triggeredEvents.add('macross_salvo');
      this.triggeredEvents.add('kill_ace_fallback');
      this.ace.alive = false;
      this.ace.updateVisuals(this.currentTime, this.autoTripIntensity);
      this.vfx.spawnExplosion(this._supernovaFocus, 118, true, Math.max(this.autoTripIntensity, 1.0));
      this.env.triggerOceanShockwave(this._supernovaFocus, 1.95);
    }
  }

  private fireOnce(key: string, fn: () => void): void {
    if (this.triggeredEvents.has(key)) return;
    this.triggeredEvents.add(key);
    fn();
  }

  private sampleFlight(
    curve: THREE.CatmullRomCurve3,
    u: number,
    outPos: THREE.Vector3,
    outFwd: THREE.Vector3,
    closed = false,
  ): number {
    const cu = closed ? ((u % 1) + 1) % 1 : THREE.MathUtils.clamp(u, 0.001, 0.997);
    curve.getPointAt(cu, outPos);
    curve.getTangentAt(cu, this._tangent);
    outFwd.copy(this._tangent).normalize();

    const nextU = closed ? (cu + 0.014) % 1 : Math.min(0.999, cu + 0.014);
    curve.getTangentAt(nextU, this._nextTangent);
    const crossY = this._tangent.x * this._nextTangent.z - this._tangent.z * this._nextTangent.x;
    return THREE.MathUtils.clamp(crossY * 14.5, -1.25, 1.25);
  }

  private sampleBanditAt(
    idx: number,
    t: number,
    outPos: THREE.Vector3,
    outFwd: THREE.Vector3,
  ): number {
    const bSpan = idx === 1 ? 30.5 : idx === 0 ? 45.5 : idx < 4 ? 58.0 : 81.5;
    const bu = THREE.MathUtils.clamp((t + 1.5) / bSpan, 0, 0.995);
    return this.sampleFlight(this.banditCurves[idx], bu, outPos, outFwd, false);
  }

  private updateAtmosphereAndTrip(t: number): void {
    if (t < 24) {
      this.stormIntensity = THREE.MathUtils.smoothstep(t, 12, 24) * 0.22;
      this.autoTripIntensity = THREE.MathUtils.smoothstep(t, 16, 24) * 0.14;
    } else if (t < 46) {
      this.stormIntensity = THREE.MathUtils.lerp(0.22, 0.92, THREE.MathUtils.smoothstep(t, 24, 42));
      this.autoTripIntensity = THREE.MathUtils.lerp(0.14, 0.85, THREE.MathUtils.smoothstep(t, 26, 44));
    } else if (t < 73) {
      this.stormIntensity = 0.95;
      this.autoTripIntensity = THREE.MathUtils.lerp(0.85, 1.15, THREE.MathUtils.smoothstep(t, 48, 66));
    } else {
      this.stormIntensity = THREE.MathUtils.lerp(0.95, 0.12, THREE.MathUtils.smoothstep(t, 73, 84));
      this.autoTripIntensity = THREE.MathUtils.lerp(1.15, 0.18, THREE.MathUtils.smoothstep(t, 73, 84));
    }
  }

  private updateJetPoses(t: number, motionDt: number, realTime: number, tripIntensity: number): void {
    const uHero = THREE.MathUtils.clamp(t / TOTAL_DURATION, 0, 1);
    const pos = this._pos;
    const fwd = this._fwd;
    let heroBank = this.sampleFlight(this.heroCurve, uHero, pos, fwd, false);

    // Signature hero stunts: Act I barrel roll, Act IV inverted Cobra, Act V victory roll
    let extraPitch = 0;
    if (t > 9.4 && t < 12.6) {
      const p = (t - 9.4) / 3.2;
      heroBank += Math.sin(p * Math.PI) * Math.PI * 2;
    } else if (t > 56.2 && t < 63.0) {
      // Inverted Pugachev's Cobra!
      const p = (t - 56.2) / 6.8;
      const bell = Math.sin(p * Math.PI);
      heroBank += Math.PI * bell;
      extraPitch = bell * 0.92;
    } else if (t > 76.8 && t < 80.3) {
      const p = (t - 76.8) / 3.5;
      heroBank += p * Math.PI * 2;
    }

    this.hero.throttle =
      t < 5.0 ? 0.92 + t * 0.08 : t > 79.5 ? 1.48 : 1.18 + Math.sin(t * 1.45) * 0.15;

    // Supersonic Prandtl-Glauert vapour cone flashes on Mach break, storm climb, Cobra, vertical punch
    const vaporPulse =
      Math.exp(-Math.pow((t - 6.8) / 1.35, 2)) +
      Math.exp(-Math.pow((t - 32.5) / 1.7, 2)) * 0.92 +
      Math.exp(-Math.pow((t - 57.4) / 1.6, 2)) * 1.0 +
      Math.exp(-Math.pow((t - 82.0) / 2.2, 2)) * 1.0;
    this.hero.vaporIntensity = THREE.MathUtils.clamp(vaporPulse, 0, 1);
    this.speedIntensity = THREE.MathUtils.clamp(
      (this.hero.throttle - 0.72) * 0.85 + vaporPulse * 0.55,
      0,
      1.2,
    );

    this.hero.setPoseFromMotion(pos, fwd, heroBank, Math.max(motionDt, 0.016), extraPitch);
    this.hero.updateVisuals(realTime, tripIntensity);

    // Update all 5 bandits along their choreographed intercept splines
    for (let i = 0; i < this.bandits.length; i++) {
      const b = this.bandits[i];
      if (!b.alive) {
        b.updateVisuals(realTime, tripIntensity);
        continue;
      }
      const bBank = this.sampleBanditAt(i, t, pos, fwd);
      b.throttle = i === 4 ? 1.35 : 1.08;
      b.vaporIntensity = i === 4 && t > 52 && t < 68 ? 0.48 : 0;
      b.setPoseFromMotion(pos, fwd, bBank, Math.max(motionDt, 0.016));
      b.updateVisuals(realTime, tripIntensity);
    }
  }

  private updatePreLaunchIdle(rawDt: number, realTime: number, tripIntensity: number): void {
    const safeDt = Math.max(rawDt, 0.016);
    const uLoop = (realTime * 0.022) % 1;
    const bank = this.sampleFlight(this.idleHeroCurve, uLoop, this._pos, this._fwd, true);

    this.hero.alive = true;
    this.hero.throttle = 1.18 + Math.sin(realTime * 1.2) * 0.12;
    this.hero.vaporIntensity = 0.25 * Math.max(0, Math.sin(realTime * 0.75));
    this.speedIntensity = 0.42;
    this.hero.setPoseFromMotion(this._pos, this._fwd, bank, safeDt, 0);
    this.hero.updateVisuals(realTime, tripIntensity);

    // Distant bandits cruising high above the golden ocean canyon during idle preview
    for (let i = 0; i < this.bandits.length; i++) {
      const b = this.bandits[i];
      const angle = realTime * 0.12 + i * 1.25;
      const rad = 340 + i * 55;
      this._pos.set(Math.cos(angle) * rad, 220 + i * 32, -720 + Math.sin(angle) * rad);
      this._fwd.set(-Math.sin(angle), 0, Math.cos(angle)).normalize();
      b.alive = true;
      b.throttle = 1.0;
      b.vaporIntensity = 0;
      b.setPoseFromMotion(this._pos, this._fwd, 0.35, safeDt);
      b.updateVisuals(realTime, tripIntensity);
    }

    this.emitSeaSprayWake(safeDt);
  }

  private emitSeaSprayWake(dt: number): void {
    const heroPos = this.hero.group.position;
    if (heroPos.y >= 46 || dt <= 0) return;

    this.sprayTimer += dt;
    if (this.sprayTimer < 0.032) return;
    this.sprayTimer = 0;

    const altFactor = THREE.MathUtils.clamp(1 - (heroPos.y - 18) / 28, 0.18, 1.0);
    const hv = this.hero.velocity;
    for (let s = -1; s <= 1; s += 2) {
      this.vfx.particles.emitPuff(
        heroPos.x + s * (5.5 + Math.random() * 4.5),
        2.6 + Math.random() * 2.5,
        heroPos.z + (Math.random() - 0.5) * 8.0,
        hv.x * 0.12 + s * (16 + Math.random() * 14),
        10 + Math.random() * 12 * altFactor,
        hv.z * 0.12 + (Math.random() - 0.5) * 10,
        2.8,
        13.5 * altFactor,
        0.95 + Math.random() * 0.45,
        0.0,
        0.0,
        0.98,
        0.88,
        0.74,
        0.34 * altFactor,
        1.7,
        4.0,
        (Math.random() - 0.5) * 1.6,
        0,
      );
    }
  }

  private spawnDebrisTrail(
    slotIndex: number,
    origin: THREE.Vector3,
    velocity: THREE.Vector3,
    prism: boolean,
  ): void {
    const slot = this.debrisTrails[slotIndex % this.debrisTrails.length];
    slot.active = true;
    slot.pos.copy(origin);
    slot.vel.copy(velocity);
    if (slot.vel.lengthSq() < 1600) {
      slot.vel.set(0, -18, -110);
    }
    slot.vel.multiplyScalar(0.62);
    slot.vel.y -= 16;
    slot.age = 0;
    slot.duration = 3.6;
    slot.emitAccum = 0;
    slot.splashed = false;
    slot.prism = prism;
  }

  private updateDebrisTrails(simDt: number): void {
    if (simDt <= 0) return;

    for (let i = 0; i < this.debrisTrails.length; i++) {
      const d = this.debrisTrails[i];
      if (!d.active) continue;

      d.age += simDt;
      if (d.age >= d.duration) {
        d.active = false;
        continue;
      }

      // Ballistic tumbling wreckage descent under gravity
      d.vel.y -= 48 * simDt;
      d.vel.multiplyScalar(Math.max(0, 1 - 0.22 * simDt));
      d.pos.addScaledVector(d.vel, simDt);

      if (!d.splashed && d.pos.y <= 10) {
        d.splashed = true;
        d.pos.y = 10;
        this.env.triggerOceanShockwave(d.pos, 0.72);
        d.active = false;
        continue;
      }

      d.emitAccum += simDt;
      if (d.emitAccum >= 0.036) {
        d.emitAccum = 0;
        const fade = 1 - d.age / d.duration;

        // Thick soot-and-ember smoke ribbon behind falling wreckage
        this.vfx.particles.emitPuff(
          d.pos.x + (Math.random() - 0.5) * 4,
          d.pos.y + (Math.random() - 0.5) * 4,
          d.pos.z + (Math.random() - 0.5) * 4,
          -d.vel.x * 0.08 + (Math.random() - 0.5) * 10,
          8 + Math.random() * 10,
          -d.vel.z * 0.08 + (Math.random() - 0.5) * 10,
          3.4,
          16.5,
          1.45 + Math.random() * 0.65,
          0.95 * fade,
          0.0,
          0.12,
          0.10,
          0.11,
          0.74 * fade,
          1.35,
          7.0,
          (Math.random() - 0.5) * 2.2,
          d.prism ? 1 : 0,
        );

        // Trailing molten wreckage sparks
        for (let k = 0; k < 3; k++) {
          this.vfx.particles.emitSpark(
            d.pos.x,
            d.pos.y,
            d.pos.z,
            -d.vel.x * 0.25 + (Math.random() - 0.5) * 42,
            -d.vel.y * 0.15 + (Math.random() - 0.5) * 32,
            -d.vel.z * 0.25 + (Math.random() - 0.5) * 42,
            0.95,
            0.55 + Math.random() * 0.35,
            1.0,
            d.prism ? 0.45 : 0.65,
            d.prism ? 0.95 : 0.18,
            1.5,
            0.7,
            26.0,
          );
        }
      }
    }
  }

  private killWraith2(tripIntensity: number): void {
    const w2 = this.bandits[1];
    if (!w2.alive) return;
    this._w2KillPos.copy(w2.group.position);
    w2.alive = false;
    this.vfx.spawnExplosion(this._w2KillPos, 58, false, tripIntensity);
    this.spawnDebrisTrail(1, this._w2KillPos, w2.velocity, false);
    this.env.triggerOceanShockwave(this._w2KillPos, 0.95);
    this.callbacks.onSfx('sfx_explosion', 1.0, -0.1);
    this.cameraShake = Math.max(this.cameraShake, 1.3);
  }

  private killWraith1(hitPos: THREE.Vector3, tripIntensity: number): void {
    const w1 = this.bandits[0];
    if (!w1.alive) return;
    w1.alive = false;
    this.vfx.spawnExplosion(hitPos, 60, false, tripIntensity);
    this.spawnDebrisTrail(0, hitPos, w1.velocity, tripIntensity > 0.3);
    this.env.triggerOceanShockwave(hitPos, 0.85);
    this.callbacks.onSfx('sfx_explosion', 0.96, -0.25);
    this.cameraShake = Math.max(this.cameraShake, 1.2);
  }

  private killWraith3(hitPos: THREE.Vector3, tripIntensity: number): void {
    const w3 = this.bandits[2];
    if (!w3.alive) return;
    w3.alive = false;
    this.featuredMissile = null;
    this.vfx.spawnExplosion(hitPos, 66, false, tripIntensity);
    this.spawnDebrisTrail(2, hitPos, w3.velocity, true);
    this.env.triggerOceanShockwave(hitPos, 0.9);
    this.callbacks.onSfx('sfx_explosion', 1.0, 0.15);
    this.cameraShake = Math.max(this.cameraShake, 1.35);
  }

  private killWraith4(hitPos: THREE.Vector3, tripIntensity: number): void {
    const w4 = this.bandits[3];
    if (!w4.alive) return;
    w4.alive = false;
    this.vfx.spawnExplosion(hitPos, 72, false, tripIntensity);
    this.spawnDebrisTrail(3, hitPos, w4.velocity, true);
    this.env.triggerOceanShockwave(hitPos, 1.0);
    this.callbacks.onSfx('sfx_explosion', 0.98, -0.15);
    this.cameraShake = Math.max(this.cameraShake, 1.35);
  }

  private killAce(hitPos: THREE.Vector3, tripIntensity: number): void {
    if (!this.ace.alive) return;
    this.ace.alive = false;
    this.featuredMissile = null;
    this._supernovaFocus.copy(hitPos);

    // Colossal thermobaric supernova sky detonation + twin cascading shock blasts
    this.vfx.spawnExplosion(hitPos, 165, true, Math.max(tripIntensity, 1.0));
    this._secPos.set(hitPos.x + 28, hitPos.y + 18, hitPos.z - 18);
    this.vfx.spawnExplosion(this._secPos, 92, false, 1.0);
    this._secPos.set(hitPos.x - 32, hitPos.y - 14, hitPos.z + 22);
    this.vfx.spawnExplosion(this._secPos, 86, false, 1.0);

    this.spawnDebrisTrail(4, hitPos, this.ace.velocity, true);
    this.env.triggerOceanShockwave(hitPos, 1.95);
    this.callbacks.onSfx('sfx_supernova', 1.0, 0);
    this.cameraShake = 2.2;
  }

  public update(
    rawDt: number,
    realTime: number,
    camera: THREE.PerspectiveCamera,
    camMode: CameraMode,
    userTripOverride: number | null,
    isPlaying: boolean,
  ): { tripIntensity: number } {
    if (isPlaying) {
      this.hasLaunchedOrReset = true;
    }
    this.lastIsPlaying = isPlaying;

    const isPreLaunchIdle = !this.hasLaunchedOrReset && !isPlaying && camMode === 'cinematic';
    if (isPreLaunchIdle) {
      const tripIntensity = userTripOverride !== null ? userTripOverride : 0.12;
      this.stormIntensity = 0.08;
      this.autoTripIntensity = 0.12;
      this.timeScale = 1.0;
      this.updatePreLaunchIdle(rawDt, realTime, tripIntensity);
      this.updateCameraInternal(rawDt, realTime, camera, camMode, false, false, true);
      this._updateResult.tripIntensity = tripIntensity;
      return this._updateResult;
    }

    // Slow-motion bullet-time curve at signature Michael Bay hero beats
    const t = this.currentTime;
    let targetTimeScale = 1.0;
    if (t > 24.3 && t < 26.5) {
      targetTimeScale = 0.34; // WRAITH-2 slow-mo wing-shear fireball pass
    } else if (t > 56.4 && t < 62.6) {
      targetTimeScale = 0.28; // Inverted Pugachev's Cobra 360° bullet-time orbit
    } else if (t > 69.2 && t < 72.6) {
      targetTimeScale = 0.30; // CRIMSON-1 Ace thermobaric supernova blast
    }
    this.timeScale = THREE.MathUtils.lerp(this.timeScale, targetTimeScale, Math.min(1, rawDt * 6));

    const simDt = isPlaying ? Math.min(rawDt, 0.05) * this.timeScale : 0;
    if (isPlaying) {
      this.currentTime = Math.min(TOTAL_DURATION, this.currentTime + rawDt);
    }

    // Act banner transitions
    for (let i = 0; i < ACTS.length; i++) {
      if (t >= ACTS[i].start && t < ACTS[i].end && i !== this.currentActIdx) {
        this.currentActIdx = i;
        this.callbacks.onActChange(ACTS[i]);
      }
    }

    // Atmosphere & LSD escalation curve
    this.updateAtmosphereAndTrip(t);
    const tripIntensity = userTripOverride !== null ? userTripOverride : this.autoTripIntensity;

    // ------------------------------------------------------------------
    // 1. UPDATE HERO & BANDIT POSES + LOW-ALTITUDE SEA-SPRAY WAKE
    // ------------------------------------------------------------------
    this.updateJetPoses(t, simDt, realTime, tripIntensity);
    if (isPlaying) {
      this.emitSeaSprayWake(simDt);
      this.updateDebrisTrails(simDt);
    }

    // ------------------------------------------------------------------
    // 2. TRIGGER CHOREOGRAPHED RADIO, COMBAT, MISSILE & EXPLOSION BEATS
    // ------------------------------------------------------------------
    if (isPlaying) {
      for (let i = 0; i < RADIO_CUES.length; i++) {
        const cue = RADIO_CUES[i];
        if (t >= cue.time) {
          this.fireOnce(`radio_${cue.id}`, () => this.callbacks.onRadio(cue));
        }
      }

      // Act I: Supersonic Mach 1 break & sea-stack near-miss ocean shockwave
      if (t >= 6.5) {
        this.fireOnce('flyby1', () => {
          this.callbacks.onSfx('sfx_flyby', 0.95, 0.15);
          this.cameraShake = Math.max(this.cameraShake, 0.72);
          this.env.triggerOceanShockwave(this.hero.group.position, 0.75);
        });
      }

      // Act II: 20mm Vulcan rotary cannon burst ripping into WRAITH-2 (t=20.8–24.45s)
      if (t >= 20.8 && t <= 24.45 && this.bandits[1].alive) {
        this.fireOnce('guns1', () => this.callbacks.onSfx('sfx_vulcan', 0.94, 0));
        this.gunTimer += rawDt;
        if (this.gunTimer > 0.062) {
          this.gunTimer = 0;
          this._aim.subVectors(this.bandits[1].group.position, this.hero.group.position);
          this.vfx.fireVulcanBurst(this.hero, this._aim, 3);
          this.cameraShake = Math.max(this.cameraShake, 0.36);
        }
      }

      // Kill #1: WRAITH-2 wing-shear fireball in slow-mo!
      if (t >= KILL_TIME_W2) {
        this.fireOnce('kill_w2', () => this.killWraith2(tripIntensity));
      }

      // VIPER-1 pops golden decoy flare blossom banking clear of fireball
      if (t >= 27.4) {
        this.fireOnce('flares1', () => {
          this.vfx.popDecoyFlares(this.hero, 14);
          this.callbacks.onSfx('sfx_flares', 0.88, 0.1);
        });
      }

      // Act III: Sidewinder launch & guaranteed Kill #2 on WRAITH-1
      if (t >= 33.8) {
        this.fireOnce('missile_w1', () => {
          this._offset.set(-4.5, -1.0, 0).applyQuaternion(this.hero.group.quaternion);
          this._origin.copy(this.hero.group.position).add(this._offset);
          this._initVel.copy(this.hero.velocity);
          if (this._initVel.lengthSq() < 1) {
            this._initVel.set(0, 0, -1).applyQuaternion(this.hero.group.quaternion);
          } else {
            this._initVel.normalize();
          }
          this._initVel.multiplyScalar(320);
          this.callbacks.onSfx('sfx_missile', 0.92, -0.2);
          this.vfx.launchMissile('m_w1', this._origin, this._initVel, this.bandits[0], true, 475, (hitPos) => {
            this.killWraith1(hitPos, tripIntensity);
          });
        });
      }
      if (t >= KILL_TIME_W1 && this.bandits[0].alive) {
        this.fireOnce('kill_w1_fallback', () => {
          this.killWraith1(this.bandits[0].group.position, tripIntensity);
        });
      }

      // Supercell decoy flare curtains popped by WRAITH-3 & WRAITH-4
      if (t >= 41.5) {
        this.fireOnce('flares2', () => {
          if (this.bandits[2].alive) this.vfx.popDecoyFlares(this.bandits[2], 12);
          if (this.bandits[3].alive) this.vfx.popDecoyFlares(this.bandits[3], 12);
          this.callbacks.onSfx('sfx_flares', 0.84, 0.25);
        });
      }

      // Act III: Featured Sidewinder Missile-Nose Cam slalom through flares -> Kill #3 (WRAITH-3)
      if (t >= 44.5) {
        this.fireOnce('missile_w3', () => {
          this._offset.set(5.0, -1.0, 0).applyQuaternion(this.hero.group.quaternion);
          this._origin.copy(this.hero.group.position).add(this._offset);
          this._initVel.copy(this.hero.velocity);
          if (this._initVel.lengthSq() < 1) {
            this._initVel.set(0, 0, -1).applyQuaternion(this.hero.group.quaternion);
          } else {
            this._initVel.normalize();
          }
          this._initVel.multiplyScalar(285);
          this.callbacks.onSfx('sfx_missile', 0.95, 0.2);
          this.featuredMissile = this.vfx.launchMissile(
            'm_w3',
            this._origin,
            this._initVel,
            this.bandits[2],
            true,
            425,
            (hitPos) => this.killWraith3(hitPos, tripIntensity),
          );
        });
      }

      // Second mid-slalom flare burst right in front of the Sidewinder nose cam
      if (t >= 44.8) {
        this.fireOnce('flares3', () => {
          if (this.bandits[2].alive) this.vfx.popDecoyFlares(this.bandits[2], 10);
          this.callbacks.onSfx('sfx_flares', 0.78, 0.15);
        });
      }

      // Second curving prism Sidewinder -> Kill #4 (WRAITH-4 cascading twin detonation!)
      if (t >= 46.2) {
        this.fireOnce('missile_w4', () => {
          this._offset.set(-5.0, -1.0, 0).applyQuaternion(this.hero.group.quaternion);
          this._origin.copy(this.hero.group.position).add(this._offset);
          this._initVel.copy(this.hero.velocity);
          if (this._initVel.lengthSq() < 1) {
            this._initVel.set(0, 0, -1).applyQuaternion(this.hero.group.quaternion);
          } else {
            this._initVel.normalize();
          }
          this._initVel.multiplyScalar(295);
          this.callbacks.onSfx('sfx_missile', 0.88, -0.2);
          this.vfx.launchMissile('m_w4', this._origin, this._initVel, this.bandits[3], true, 445, (hitPos) => {
            this.killWraith4(hitPos, tripIntensity);
          });
        });
      }

      if (t >= KILL_TIME_W3 && this.bandits[2].alive) {
        this.fireOnce('kill_w3_fallback', () => {
          this.killWraith3(this.bandits[2].group.position, tripIntensity);
        });
      }
      if (t >= KILL_TIME_W4 && this.bandits[3].alive) {
        this.fireOnce('kill_w4_fallback', () => {
          this.killWraith4(this.bandits[3].group.position, tripIntensity);
        });
      }

      // Act IV: CRIMSON-1 Ace head-on Vulcan tracer stream
      if (t >= 52.2 && t <= 56.0 && this.ace.alive) {
        this.gunTimer += rawDt;
        if (this.gunTimer > 0.105) {
          this.gunTimer = 0;
          this._aim.subVectors(this.hero.group.position, this.ace.group.position);
          this._aim.x += 13;
          this._aim.y += 5;
          this.vfx.fireVulcanBurst(this.ace, this._aim, 2);
        }
      }

      // Inverted Pugachev's Cobra sonic boom + golden decoy flare blossom
      if (t >= 56.8) {
        this.fireOnce('cobra_boom', () => {
          this.vfx.popDecoyFlares(this.hero, 18);
          this.callbacks.onSfx('sfx_flyby', 0.92, 0);
          this.callbacks.onSfx('sfx_flares', 0.9, 0);
          this.cameraShake = Math.max(this.cameraShake, 0.88);
        });
      }

      // 8-MISSILE MACROSS PRISM-TRAIL SALVO AT CRIMSON-1 ACE!
      if (t >= 64.0) {
        this.fireOnce('macross_salvo', () => {
          this.callbacks.onSfx('sfx_missile', 1.0, 0);
          const heroQ = this.hero.group.quaternion;
          const heroPos = this.hero.group.position;
          for (let k = 0; k < 8; k++) {
            const norm = (k - 3.5) / 3.5;
            const fanAngle = norm * 1.15;
            this._offset.set(norm * 7.8, -1.1 + (k % 2 === 0 ? 0.45 : -0.35), 0).applyQuaternion(heroQ);
            this._origin.copy(heroPos).add(this._offset);

            this._launchDir
              .set(Math.sin(fanAngle) * 0.72, Math.cos(k * 1.35) * 0.34 + 0.12, -1.0)
              .applyQuaternion(heroQ)
              .normalize()
              .multiplyScalar(310);

            const m = this.vfx.launchMissile(
              `macross_${k}`,
              this._origin,
              this._launchDir,
              this.ace,
              true,
              325 + k * 14,
              (hitPos) => this.killAce(hitPos, tripIntensity),
            );
            if (k === 3) this.featuredMissile = m;
          }
        });
      }

      // Guaranteed Kill #5: CRIMSON-1 Ace thermobaric supernova fallback
      if (t >= KILL_TIME_ACE && this.ace.alive) {
        this.fireOnce('kill_ace_fallback', () => {
          this.killAce(this.ace.group.position, tripIntensity);
        });
      }

      // Act V: Vertical Sunrise twin-afterburner Mach punch
      if (t >= 81.2) {
        this.fireOnce('finale_boom', () => {
          this.callbacks.onSfx('sfx_flyby', 0.92, 0);
          this.env.triggerOceanShockwave(this.hero.group.position, 0.75);
          this.cameraShake = Math.max(this.cameraShake, 0.72);
        });
      }
    }

    // ------------------------------------------------------------------
    // 3. TARGET LOCK STATE FOR HUD & AIM-9 SIDEWINDER GROWL
    // ------------------------------------------------------------------
    let lockCandidate: FighterJet | null = null;
    if (t >= 16.5 && t < KILL_TIME_W2 && this.bandits[1].alive) lockCandidate = this.bandits[1];
    else if (t >= 31.5 && t < KILL_TIME_W1 && this.bandits[0].alive) lockCandidate = this.bandits[0];
    else if (t >= 41.0 && t < KILL_TIME_W3 && this.bandits[2].alive) lockCandidate = this.bandits[2];
    else if (t >= 47.2 && t < KILL_TIME_W4 && this.bandits[3].alive) lockCandidate = this.bandits[3];
    else if (t >= 52.0 && t < KILL_TIME_ACE && this.ace.alive) lockCandidate = this.ace;

    const lockedNow =
      lockCandidate !== null &&
      ((t >= 32.5 && t <= 35.5) || (t >= 43.0 && t <= 46.8) || (t >= 61.0 && t <= 66.2));
    if (lockedNow !== this.isMissileLocked || lockCandidate !== this.lockedTarget) {
      this.isMissileLocked = lockedNow;
      this.lockedTarget = lockCandidate;
      this.callbacks.onLockState(lockedNow, lockCandidate);
    }

    // ------------------------------------------------------------------
    // 4. 14-SHOT VIRTUAL MICHAEL BAY / RIDLEY SCOTT CAMERA DIRECTOR
    // ------------------------------------------------------------------
    this.cameraShake = Math.max(0, this.cameraShake - rawDt * 1.45);
    this.updateCameraInternal(rawDt, realTime, camera, camMode, false, isPlaying, false);

    this._updateResult.tripIntensity = tripIntensity;
    return this._updateResult;
  }

  public updateCamera(
    dt: number,
    realTime: number,
    camera: THREE.PerspectiveCamera,
    mode: CameraMode,
    forceSnap = false,
  ): void {
    const isPreLaunchIdle = !this.hasLaunchedOrReset && !this.lastIsPlaying && mode === 'cinematic';
    this.updateCameraInternal(dt, realTime, camera, mode, forceSnap, this.lastIsPlaying, isPreLaunchIdle);
  }

  private updateCameraInternal(
    dt: number,
    realTime: number,
    camera: THREE.PerspectiveCamera,
    mode: CameraMode,
    forceSnap: boolean,
    isPlaying: boolean,
    isPreLaunchIdle: boolean,
  ): void {
    const ctx = this._camCtx;
    ctx.time = this.currentTime;
    ctx.realTime = realTime;
    ctx.dt = dt;
    ctx.mode = mode;
    ctx.forceSnap = forceSnap;
    ctx.isPlaying = isPlaying;
    ctx.isPreLaunchIdle = isPreLaunchIdle;
    ctx.featuredMissile = this.featuredMissile;
    ctx.cameraShake = this.cameraShake;
    ctx.speedIntensity = this.speedIntensity;
    ctx.shockImpact = this.vfx.shockImpact;

    this.director.update(ctx, camera);
    this.activeCameraTag = this.director.activeCameraTag;
  }
}
