import * as THREE from 'three';
import { FighterJet } from '../aircraft/FighterJet';
import { BayhemVFX, GuidedMissile } from '../vfx/BayhemVFX';
import { WorldEnvironment } from '../environment/WorldEnvironment';

export type CameraMode = 'auto' | 'cockpit' | 'chase' | 'orbit' | 'cinematic';

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

  private readonly heroCurve: THREE.CatmullRomCurve3;
  private readonly banditCurves: THREE.CatmullRomCurve3[];
  private readonly triggeredEvents = new Set<string>();
  private readonly vfx: BayhemVFX;
  private readonly env: WorldEnvironment;
  private readonly callbacks: ChoreographyCallbacks;

  private currentActIdx = -1;
  private featuredMissile: GuidedMissile | null = null;
  private gunTimer = 0;
  private smoothCamPos = new THREE.Vector3(0, 48, 120);
  private smoothCamLook = new THREE.Vector3(0, 42, -100);
  private lastShotCutId = '';

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

    // ------------------------------------------------------------------
    // HERO 88-SECOND FLIGHT SPLINE (GOLDEN CANYON -> SUPERCELL -> COBRA -> SUNRISE)
    // ------------------------------------------------------------------
    this.heroCurve = new THREE.CatmullRomCurve3(
      [
        // Act I: Low ocean-skimming break between basalt sea-stacks
        new THREE.Vector3(0, 32, 160),
        new THREE.Vector3(-42, 26, -180),
        new THREE.Vector3(58, 48, -560),
        new THREE.Vector3(-84, 72, -940),
        // Act II: Aggressive canyon weave & guns pass on WRAITH-2
        new THREE.Vector3(110, 125, -1320),
        new THREE.Vector3(-125, 168, -1680),
        new THREE.Vector3(75, 225, -2060),
        new THREE.Vector3(-90, 290, -2360),
        // Act III: High-G climb into the Chromatic Supercell Amphitheatre
        new THREE.Vector3(-340, 415, -1980),
        new THREE.Vector3(-220, 520, -1480),
        new THREE.Vector3(240, 565, -1240),
        new THREE.Vector3(380, 540, -1690),
        // Act IV: Spiralling dogfight vs Crimson-1 inside obsidian monolith rings + Cobra
        new THREE.Vector3(95, 515, -1940),
        new THREE.Vector3(-230, 535, -1610),
        new THREE.Vector3(15, 520, -1420), // Cobra & 6-missile Macross salvo sweet-spot!
        new THREE.Vector3(210, 495, -1720),
        // Act V: Shockwave dive over glassy sea -> dead-vertical climb into the twin sun!
        new THREE.Vector3(80, 145, -1980),
        new THREE.Vector3(-35, 62, -2380),
        new THREE.Vector3(-95, 280, -2680),
        new THREE.Vector3(-190, 780, -2960),
      ],
      false,
      'catmullrom',
      0.5,
    );

    // ------------------------------------------------------------------
    // 5 BANDIT SPLINES CHOREOGRAPHED TO INTERSECT HERO AT KEY COMBAT BEATS
    // ------------------------------------------------------------------
    // WRAITH-1 (dies at t=37.0s by Sidewinder)
    const cW1 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-180, 340, -1100),
      new THREE.Vector3(-40, 130, -820),
      new THREE.Vector3(140, 165, -1420),
      new THREE.Vector3(-210, 280, -1820),
      new THREE.Vector3(-300, 445, -1860),
      new THREE.Vector3(-165, 525, -1420),
      new THREE.Vector3(190, 560, -1210),
      new THREE.Vector3(280, 520, -1550),
    ]);

    // WRAITH-2 (hero's Act II gun kill at t=24.5s — sweeps directly across Viper-1's nose!)
    const cW2 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(190, 320, -1080),
      new THREE.Vector3(80, 95, -780),
      new THREE.Vector3(90, 135, -1240),
      new THREE.Vector3(-115, 172, -1620),
      new THREE.Vector3(62, 226, -2005), // Right in Viper-1's gunsight around t=22-25s
      new THREE.Vector3(-40, 210, -2250),
      new THREE.Vector3(-150, 90, -2500),
    ]);

    // WRAITH-3 (dies at t=47.5s via missile-nose cam!)
    const cW3 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 380, -1180),
      new THREE.Vector3(-120, 180, -960),
      new THREE.Vector3(20, 230, -1560),
      new THREE.Vector3(-180, 390, -2060),
      new THREE.Vector3(-140, 540, -1460),
      new THREE.Vector3(270, 575, -1290),
      new THREE.Vector3(410, 545, -1620),
      new THREE.Vector3(190, 510, -1880),
    ]);

    // WRAITH-4 (wingman to W3, dies at t=49.2s in twin cascading explosion!)
    const cW4 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(90, 400, -1240),
      new THREE.Vector3(150, 210, -980),
      new THREE.Vector3(-70, 260, -1600),
      new THREE.Vector3(-250, 420, -2000),
      new THREE.Vector3(-90, 560, -1410),
      new THREE.Vector3(315, 595, -1330),
      new THREE.Vector3(440, 560, -1650),
      new THREE.Vector3(225, 535, -1910),
    ]);

    // CRIMSON-1 ACE (boss duel in Act IV, annihilated by 6-missile supernova at t=69.5s!)
    const cAce = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 460, -1280),
      new THREE.Vector3(0, 260, -1020),
      new THREE.Vector3(190, 290, -1620),
      new THREE.Vector3(-60, 450, -2140),
      new THREE.Vector3(-310, 575, -1660),
      new THREE.Vector3(210, 610, -1240),
      new THREE.Vector3(345, 555, -1720),
      new THREE.Vector3(45, 525, -1880),
      new THREE.Vector3(-170, 545, -1560),
      new THREE.Vector3(55, 530, -1495), // Center of the obsidian ring for Act IV supernova!
      new THREE.Vector3(220, 510, -1760),
      new THREE.Vector3(140, 460, -2050),
    ]);

    this.banditCurves = [cW1, cW2, cW3, cW4, cAce];
  }

  public reset(toTime = 0): void {
    this.currentTime = THREE.MathUtils.clamp(toTime, 0, TOTAL_DURATION);
    this.triggeredEvents.clear();
    this.vfx.clearDynamic();
    this.featuredMissile = null;
    this.currentActIdx = -1;
    this.cameraShake = 0;
    this.lastShotCutId = '';

    for (const j of this.allJets) {
      j.alive = true;
      j.health = 1.0;
    }

    // Mark past death/radio states when scrubbing forward
    if (toTime > 25.0) this.bandits[1].alive = false;
    if (toTime > 37.5) this.bandits[0].alive = false;
    if (toTime > 48.0) this.bandits[2].alive = false;
    if (toTime > 49.8) this.bandits[3].alive = false;
    if (toTime > 70.0) this.ace.alive = false;

    for (const cue of RADIO_CUES) {
      if (cue.time < toTime - 0.5) this.triggeredEvents.add(`radio_${cue.id}`);
    }
    for (const evTime of [
      ['flyby1', 6.5],
      ['guns1', 21.5],
      ['kill_w2', 24.5],
      ['flares1', 27.5],
      ['missile_w1', 34.0],
      ['flares2', 41.5],
      ['missile_w3', 44.5],
      ['missile_w4', 46.2],
      ['cobra_boom', 56.8],
      ['macross_salvo', 63.5],
      ['supernova_failback', 70.2],
      ['finale_boom', 81.2],
    ] as [string, number][]) {
      if (evTime[1] < toTime) this.triggeredEvents.add(evTime[0]);
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
  ): number {
    const cu = THREE.MathUtils.clamp(u, 0.001, 0.997);
    curve.getPointAt(cu, outPos);
    const tangent = curve.getTangentAt(cu);
    outFwd.copy(tangent).normalize();

    // Compute banking angle from horizontal curve curvature
    const nextT = curve.getTangentAt(Math.min(0.999, cu + 0.014));
    const crossY = tangent.x * nextT.z - tangent.z * nextT.x;
    return THREE.MathUtils.clamp(crossY * 14.5, -1.25, 1.25);
  }

  public update(
    rawDt: number,
    realTime: number,
    camera: THREE.PerspectiveCamera,
    camMode: CameraMode,
    userTripOverride: number | null,
    isPlaying: boolean,
  ): { tripIntensity: number } {
    // Compute slow-motion bullet-time curve at signature Bayhem hero beats!
    let targetTimeScale = 1.0;
    const t = this.currentTime;
    if (t > 24.3 && t < 26.2) {
      targetTimeScale = 0.36; // WRAITH-2 Vulcan shred slow-mo fireball!
    } else if (t > 56.5 && t < 62.0) {
      targetTimeScale = 0.28; // Inverted Pugachev's Cobra bullet-time orbit!
    } else if (t > 69.3 && t < 72.4) {
      targetTimeScale = 0.32; // Crimson-1 Supernova thermobaric detonation!
    }
    this.timeScale = THREE.MathUtils.lerp(this.timeScale, targetTimeScale, Math.min(1, rawDt * 6));

    const simDt = isPlaying ? Math.min(rawDt, 0.05) * this.timeScale : 0;
    if (isPlaying) {
      this.currentTime = Math.min(TOTAL_DURATION, this.currentTime + rawDt);
    }

    // Check Act transitions
    for (let i = 0; i < ACTS.length; i++) {
      if (t >= ACTS[i].start && t < ACTS[i].end && i !== this.currentActIdx) {
        this.currentActIdx = i;
        this.callbacks.onActChange(ACTS[i]);
      }
    }

    // Atmosphere & LSD escalation curve
    // Grounded golden hour (0-24s) -> Storm climb (24-42s) -> Full Acid Supercell (42-73s) -> Golden sunrise aftermath (73-88s)
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

    const tripIntensity = userTripOverride !== null ? userTripOverride : this.autoTripIntensity;

    // ------------------------------------------------------------------
    // 1. UPDATE HERO & BANDIT POSES
    // ------------------------------------------------------------------
    const uHero = THREE.MathUtils.clamp(t / TOTAL_DURATION, 0, 1);
    const pos = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    let heroBank = this.sampleFlight(this.heroCurve, uHero, pos, fwd);

    // Extra dramatic hero stunts: barrel roll in Act I, Cobra pitch-up in Act IV, victory roll in Act V
    let extraPitch = 0;
    if (t > 8.0 && t < 11.2) {
      const p = (t - 8.0) / 3.2;
      heroBank += Math.sin(p * Math.PI) * Math.PI * 2;
    } else if (t > 56.2 && t < 62.5) {
      // Inverted Pugachev's Cobra!
      const p = (t - 56.2) / 6.3;
      const bell = Math.sin(p * Math.PI);
      heroBank += Math.PI * bell;
      extraPitch = bell * 0.88;
    } else if (t > 77.0 && t < 80.5) {
      const p = (t - 77.0) / 3.5;
      heroBank += p * Math.PI * 2;
    }

    this.hero.throttle = t < 5 ? 0.85 + t * 0.1 : t > 79 ? 1.45 : 1.15 + Math.sin(t * 1.4) * 0.15;
    // Supersonic vapor cone flashes at Mach break (t=6-9s), climb (31-35s), Cobra (56-59s), vertical punch (81-86s)
    const vaporPulse =
      Math.exp(-Math.pow((t - 7.0) / 1.4, 2)) +
      Math.exp(-Math.pow((t - 32.5) / 1.8, 2)) * 0.9 +
      Math.exp(-Math.pow((t - 57.2) / 1.6, 2)) * 1.0 +
      Math.exp(-Math.pow((t - 82.0) / 2.2, 2)) * 1.0;
    this.hero.vaporIntensity = THREE.MathUtils.clamp(vaporPulse, 0, 1);
    this.speedIntensity = THREE.MathUtils.clamp(
      (this.hero.throttle - 0.75) * 0.85 + vaporPulse * 0.55,
      0,
      1.2,
    );

    this.hero.setPoseFromMotion(pos, fwd, heroBank, Math.max(simDt, 0.016), extraPitch);
    this.hero.updateVisuals(realTime, tripIntensity);

    // Update Bandits along their splines
    for (let i = 0; i < this.bandits.length; i++) {
      const b = this.bandits[i];
      if (!b.alive) {
        b.updateVisuals(realTime, tripIntensity);
        continue;
      }
      const bSpan = i === 1 ? 30 : i === 0 ? 45 : i < 4 ? 58 : 82;
      const bu = THREE.MathUtils.clamp((t + 1.5) / bSpan, 0, 0.995);
      const bBank = this.sampleFlight(this.banditCurves[i], bu, pos, fwd);
      b.throttle = i === 4 ? 1.3 : 1.05;
      b.vaporIntensity = i === 4 && t > 52 && t < 68 ? 0.45 : 0;
      b.setPoseFromMotion(pos, fwd, bBank, Math.max(simDt, 0.016));
      b.updateVisuals(realTime, tripIntensity);
    }

    // ------------------------------------------------------------------
    // 2. TRIGGER CHOREOGRAPHED RADIO, COMBAT, MISSILE & EXPLOSION BEATS
    // ------------------------------------------------------------------
    if (isPlaying) {
      // Radio callouts
      for (const cue of RADIO_CUES) {
        if (t >= cue.time) {
          this.fireOnce(`radio_${cue.id}`, () => this.callbacks.onRadio(cue));
        }
      }

      // Act I supersonic flyby + Mach boom
      if (t >= 6.5) {
        this.fireOnce('flyby1', () => {
          this.callbacks.onSfx('sfx_flyby', 0.95, 0.15);
          this.cameraShake = Math.max(this.cameraShake, 0.65);
          this.env.triggerOceanShockwave(this.hero.group.position, 0.65);
        });
      }

      // Act II: Vulcan rotary cannon burst tearing into WRAITH-2 (t=21.5–24.5s)
      if (t >= 21.5 && t <= 24.4 && this.bandits[1].alive) {
        this.fireOnce('guns1', () => this.callbacks.onSfx('sfx_vulcan', 0.92, 0));
        this.gunTimer += rawDt;
        if (this.gunTimer > 0.065) {
          this.gunTimer = 0;
          const aim = this.bandits[1].group.position.clone().sub(this.hero.group.position);
          this.vfx.fireVulcanBurst(this.hero, aim, 3);
          this.cameraShake = Math.max(this.cameraShake, 0.35);
        }
      }

      // Kill WRAITH-2 in blazing slow-mo fireball!
      if (t >= 24.5) {
        this.fireOnce('kill_w2', () => {
          const w2 = this.bandits[1];
          const p = w2.group.position.clone();
          w2.alive = false;
          this.vfx.spawnExplosion(p, 52, false, tripIntensity);
          this.env.triggerOceanShockwave(p, 0.85);
          this.callbacks.onSfx('sfx_explosion', 1.0, -0.1);
          this.cameraShake = Math.max(this.cameraShake, 1.25);
        });
      }

      // Hero pops golden decoy flare blossom dodging enemy tracers
      if (t >= 27.5) {
        this.fireOnce('flares1', () => {
          this.vfx.popDecoyFlares(this.hero, 14);
          this.callbacks.onSfx('sfx_flares', 0.88, 0.1);
        });
      }

      // Act III: Sidewinder kill on WRAITH-1
      if (t >= 34.0) {
        this.fireOnce('missile_w1', () => {
          const origin = this.hero.group.position.clone().add(new THREE.Vector3(-4, -1, 0));
          const initVel = this.hero.velocity.clone().normalize().multiplyScalar(320);
          this.callbacks.onSfx('sfx_missile', 0.92, -0.2);
          this.vfx.launchMissile('m_w1', origin, initVel, this.bandits[0], true, 480, (hitPos) => {
            this.bandits[0].alive = false;
            this.vfx.spawnExplosion(hitPos, 56, false, tripIntensity);
            this.env.triggerOceanShockwave(hitPos, 0.8);
            this.callbacks.onSfx('sfx_explosion', 0.95, -0.25);
            this.cameraShake = Math.max(this.cameraShake, 1.15);
          });
        });
      }

      // Supercell decoy flares from WRAITH-3/4
      if (t >= 41.5) {
        this.fireOnce('flares2', () => {
          if (this.bandits[2].alive) this.vfx.popDecoyFlares(this.bandits[2], 12);
          if (this.bandits[3].alive) this.vfx.popDecoyFlares(this.bandits[3], 12);
          this.callbacks.onSfx('sfx_flares', 0.82, 0.3);
        });
      }

      // Missile-Nose Chase Cam! Launch featured Sidewinder at WRAITH-3
      if (t >= 44.5) {
        this.fireOnce('missile_w3', () => {
          const origin = this.hero.group.position.clone().add(new THREE.Vector3(5, -1, 0));
          const initVel = this.hero.velocity.clone().normalize().multiplyScalar(280);
          this.callbacks.onSfx('sfx_missile', 0.95, 0.2);
          this.featuredMissile = this.vfx.launchMissile(
            'm_w3',
            origin,
            initVel,
            this.bandits[2],
            true,
            430,
            (hitPos) => {
              this.bandits[2].alive = false;
              this.featuredMissile = null;
              this.vfx.spawnExplosion(hitPos, 64, false, tripIntensity);
              this.callbacks.onSfx('sfx_explosion', 1.0, 0.15);
              this.cameraShake = Math.max(this.cameraShake, 1.3);
            },
          );
        });
      }

      // Second curving prism missile obliterates WRAITH-4 right behind W3!
      if (t >= 46.2) {
        this.fireOnce('missile_w4', () => {
          const origin = this.hero.group.position.clone().add(new THREE.Vector3(-5, -1, 0));
          const initVel = this.hero.velocity.clone().normalize().multiplyScalar(290);
          this.callbacks.onSfx('sfx_missile', 0.85, -0.2);
          this.vfx.launchMissile('m_w4', origin, initVel, this.bandits[3], true, 460, (hitPos) => {
            this.bandits[3].alive = false;
            this.vfx.spawnExplosion(hitPos, 68, false, tripIntensity);
            this.env.triggerOceanShockwave(hitPos, 0.95);
            this.callbacks.onSfx('sfx_explosion', 0.98, -0.15);
            this.cameraShake = Math.max(this.cameraShake, 1.3);
          });
        });
      }

      // Act IV: Inverted Pugachev's Cobra sonic boom + golden flares
      if (t >= 56.8) {
        this.fireOnce('cobra_boom', () => {
          this.vfx.popDecoyFlares(this.hero, 18);
          this.callbacks.onSfx('sfx_flyby', 0.9, 0);
          this.callbacks.onSfx('sfx_flares', 0.88, 0);
          this.cameraShake = Math.max(this.cameraShake, 0.85);
        });
      }

      // Enemy Ace return-fire tracer stream during Act IV duel
      if (t >= 52.5 && t <= 56.0 && this.ace.alive) {
        this.gunTimer += rawDt;
        if (this.gunTimer > 0.11) {
          this.gunTimer = 0;
          const aim = this.hero.group.position
            .clone()
            .sub(this.ace.group.position)
            .add(new THREE.Vector3(14, 6, 0));
          this.vfx.fireVulcanBurst(this.ace, aim, 2);
        }
      }

      // 6-MISSILE MACROSS PRISM-TRAIL SALVO AT CRIMSON-1 ACE!
      if (t >= 63.5) {
        this.fireOnce('macross_salvo', () => {
          this.callbacks.onSfx('sfx_missile', 1.0, 0);
          for (let k = 0; k < 6; k++) {
            const fanAngle = ((k - 2.5) / 2.5) * 0.95;
            const offset = new THREE.Vector3((k - 2.5) * 2.8, -1.2, 0).applyQuaternion(
              this.hero.group.quaternion,
            );
            const launchDir = new THREE.Vector3(Math.sin(fanAngle) * 0.6, Math.cos(k) * 0.28, -1)
              .applyQuaternion(this.hero.group.quaternion)
              .normalize();
            const origin = this.hero.group.position.clone().add(offset);
            const isLeader = k === 2;
            const m = this.vfx.launchMissile(
              `macross_${k}`,
              origin,
              launchDir.multiplyScalar(320),
              this.ace,
              true,
              405 + k * 14,
              (hitPos) => {
                if (this.ace.alive) {
                  this.ace.alive = false;
                  this.featuredMissile = null;
                  // COLOSSAL THERMOBARIC SUPERNOVA SKY DETONATION!
                  this.vfx.spawnExplosion(hitPos, 155, true, Math.max(tripIntensity, 1.0));
                  this.vfx.spawnExplosion(
                    hitPos.clone().add(new THREE.Vector3(28, 16, -18)),
                    88,
                    false,
                    1.0,
                  );
                  this.vfx.spawnExplosion(
                    hitPos.clone().add(new THREE.Vector3(-32, -14, 22)),
                    82,
                    false,
                    1.0,
                  );
                  this.env.triggerOceanShockwave(hitPos, 1.85);
                  this.callbacks.onSfx('sfx_supernova', 1.0, 0);
                  this.cameraShake = 2.1;
                }
              },
            );
            if (isLeader) this.featuredMissile = m;
          }
        });
      }

      // Safety fallback if Ace somehow evaded all missiles by t=69.6s
      if (t >= 69.6 && this.ace.alive) {
        this.fireOnce('supernova_failback', () => {
          const hitPos = this.ace.group.position.clone();
          this.ace.alive = false;
          this.featuredMissile = null;
          this.vfx.spawnExplosion(hitPos, 155, true, 1.0);
          this.env.triggerOceanShockwave(hitPos, 1.85);
          this.callbacks.onSfx('sfx_supernova', 1.0, 0);
          this.cameraShake = 2.1;
        });
      }

      // Act V Vertical Sunrise Mach punch
      if (t >= 81.2) {
        this.fireOnce('finale_boom', () => {
          this.callbacks.onSfx('sfx_flyby', 0.9, 0);
          this.cameraShake = Math.max(this.cameraShake, 0.7);
        });
      }
    }

    // ------------------------------------------------------------------
    // 3. TARGET LOCK STATE FOR HUD & AIM-9 SIDEWINDER GROWL
    // ------------------------------------------------------------------
    let lockCandidate: FighterJet | null = null;
    if (t >= 17 && t < 24.5 && this.bandits[1].alive) lockCandidate = this.bandits[1];
    else if (t >= 31 && t < 37.5 && this.bandits[0].alive) lockCandidate = this.bandits[0];
    else if (t >= 41 && t < 48.0 && this.bandits[2].alive) lockCandidate = this.bandits[2];
    else if (t >= 53 && t < 69.5 && this.ace.alive) lockCandidate = this.ace;

    const lockedNow = lockCandidate !== null && ((t >= 32.5 && t <= 35.5) || (t >= 43.0 && t <= 46.5) || (t >= 61.0 && t <= 66.0));
    if (lockedNow !== this.isMissileLocked || lockCandidate !== this.lockedTarget) {
      this.isMissileLocked = lockedNow;
      this.lockedTarget = lockCandidate;
      this.callbacks.onLockState(lockedNow, lockCandidate);
    }

    // ------------------------------------------------------------------
    // 4. 12-CAMERA VIRTUAL MICHAEL BAY / RIDLEY SCOTT DIRECTOR
    // ------------------------------------------------------------------
    this.cameraShake = Math.max(0, this.cameraShake - rawDt * 1.45);
    this.updateCamera(rawDt, realTime, camera, camMode);

    return { tripIntensity };
  }

  private updateCamera(
    dt: number,
    realTime: number,
    camera: THREE.PerspectiveCamera,
    mode: CameraMode,
  ): void {
    if (mode === 'orbit') {
      this.activeCameraTag = 'FREE ORBIT';
      return; // Handled by OrbitControls in main.ts
    }

    const t = this.currentTime;
    const desiredPos = new THREE.Vector3();
    const desiredLook = new THREE.Vector3();
    let targetFov = 64;
    let hardCutId: string = mode;

    const heroPos = this.hero.group.position;
    const heroQ = this.hero.group.quaternion;

    if (mode === 'cockpit') {
      this.hero.cockpitAnchor.getWorldPosition(desiredPos);
      desiredLook.set(0, 0.8, -140).applyQuaternion(heroQ).add(heroPos);
      targetFov = 74;
      this.activeCameraTag = 'COCKPIT HUD';
      camera.position.copy(desiredPos);
      camera.lookAt(desiredLook);
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, Math.min(1, dt * 8));
      camera.updateProjectionMatrix();
      return;
    }

    if (mode === 'chase') {
      desiredPos.set(0, 5.2, 22).applyQuaternion(heroQ).add(heroPos);
      desiredLook.set(0, 1.5, -60).applyQuaternion(heroQ).add(heroPos);
      targetFov = 68;
      this.activeCameraTag = 'TAIL CHASE';
    } else if (mode === 'cinematic') {
      const a = realTime * 0.55;
      desiredPos.copy(heroPos).add(new THREE.Vector3(Math.cos(a) * 28, 7 + Math.sin(a * 1.3) * 8, Math.sin(a) * 28));
      desiredLook.copy(heroPos);
      targetFov = 54;
      this.activeCameraTag = 'BAYHEM ORBIT';
    } else {
      // DIRECTOR AUTO: 12 bespoke choreographed camera cuts across 88 seconds!
      if (t < 6.0) {
        hardCutId = 'cut_low_skim';
        this.activeCameraTag = 'LOW SEA SKIM';
        desiredPos.set(16, -2.2, -26).applyQuaternion(heroQ).add(heroPos);
        desiredPos.y = Math.max(11, desiredPos.y);
        desiredLook.copy(heroPos).add(new THREE.Vector3(0, 2, 10));
        targetFov = 58;
      } else if (t < 13.5) {
        hardCutId = 'cut_wingtip_mach';
        this.activeCameraTag = 'WINGTIP MACH CAM';
        desiredPos.set(-13.5, 2.8, 12.5).applyQuaternion(heroQ).add(heroPos);
        desiredLook.set(2, 0.5, -40).applyQuaternion(heroQ).add(heroPos);
        targetFov = 76;
      } else if (t < 20.5) {
        hardCutId = 'cut_canyon_wide';
        this.activeCameraTag = 'RIDLEY SCALE WIDE';
        desiredPos.set(28, 12, 34).applyQuaternion(heroQ).add(heroPos);
        desiredLook.copy(this.bandits[1].alive ? this.bandits[1].group.position : heroPos).lerp(heroPos, 0.55);
        targetFov = 60;
      } else if (t < 24.4) {
        hardCutId = 'cut_cockpit_guns';
        this.activeCameraTag = 'COCKPIT GUNSIGHT';
        this.hero.cockpitAnchor.getWorldPosition(desiredPos);
        desiredLook.set(0, 0.4, -120).applyQuaternion(heroQ).add(heroPos);
        targetFov = 68;
      } else if (t < 29.0) {
        hardCutId = 'cut_w2_pyro';
        this.activeCameraTag = 'SLOW-MO PYRO PASS';
        desiredPos.set(-22, 9, 18).applyQuaternion(heroQ).add(heroPos);
        desiredLook.copy(heroPos).add(new THREE.Vector3(0, 0, -24).applyQuaternion(heroQ));
        targetFov = 62;
      } else if (t < 38.0) {
        hardCutId = 'cut_supercell_climb';
        this.activeCameraTag = 'SUPERCELL ASCENT';
        desiredPos.set(18, -4.5, 24).applyQuaternion(heroQ).add(heroPos);
        desiredLook.copy(heroPos).add(new THREE.Vector3(0, 6, -45).applyQuaternion(heroQ));
        targetFov = 72;
      } else if (t < 44.5) {
        hardCutId = 'cut_monolith_pan';
        this.activeCameraTag = 'MONOLITH CATHEDRAL';
        const sweep = (t - 38.0) * 0.42;
        desiredPos.copy(heroPos).add(new THREE.Vector3(Math.cos(sweep) * 34, 11, Math.sin(sweep) * 34));
        desiredLook.copy(heroPos);
        targetFov = 66;
      } else if (t < 49.8 && this.featuredMissile && this.featuredMissile.alive) {
        hardCutId = 'cut_missile_cam';
        this.activeCameraTag = 'SIDEWINDER NOSE CAM';
        const mDir = this.featuredMissile.vel.clone().normalize();
        desiredPos.copy(this.featuredMissile.pos).addScaledVector(mDir, -14).add(new THREE.Vector3(2.5, 3.2, 0));
        desiredLook.copy(this.featuredMissile.pos).addScaledVector(mDir, 45);
        targetFov = 78;
      } else if (t < 56.2) {
        hardCutId = 'cut_ace_duel';
        this.activeCameraTag = 'ACE HEAD-ON';
        desiredPos.set(15, 6, 26).applyQuaternion(heroQ).add(heroPos);
        desiredLook.copy(this.ace.alive ? this.ace.group.position : heroPos).lerp(heroPos, 0.45);
        targetFov = 64;
      } else if (t < 63.2) {
        // ICONIC 360-DEGREE MICHAEL BAY BULLET-TIME ORBIT AROUND INVERTED COBRA!
        hardCutId = 'cut_cobra_360';
        this.activeCameraTag = '360° COBRA BULLET-TIME';
        const angle = ((t - 56.2) / 7.0) * Math.PI * 2.2 + 0.6;
        desiredPos.copy(heroPos).add(new THREE.Vector3(Math.cos(angle) * 24, 4 + Math.sin(angle * 2) * 5, Math.sin(angle) * 24));
        desiredLook.copy(heroPos);
        targetFov = 56;
      } else if (t < 69.2) {
        hardCutId = 'cut_macross_salvo';
        this.activeCameraTag = 'MACROSS PRISM SALVO';
        if (this.featuredMissile && this.featuredMissile.alive && t > 65.2) {
          const mDir = this.featuredMissile.vel.clone().normalize();
          desiredPos.copy(this.featuredMissile.pos).addScaledVector(mDir, -24).add(new THREE.Vector3(-8, 6, 0));
          desiredLook.copy(this.ace.alive ? this.ace.group.position : this.featuredMissile.pos);
          targetFov = 74;
        } else {
          desiredPos.set(-18, 7, 25).applyQuaternion(heroQ).add(heroPos);
          desiredLook.copy(this.ace.alive ? this.ace.group.position : heroPos);
          targetFov = 68;
        }
      } else if (t < 75.5) {
        hardCutId = 'cut_supernova_wide';
        this.activeCameraTag = 'THERMOBARIC SUPERNOVA';
        desiredPos.set(34, 14, 42).applyQuaternion(heroQ).add(heroPos);
        desiredLook.copy(heroPos).lerp(new THREE.Vector3(55, 530, -1495), 0.55);
        targetFov = 72;
      } else if (t < 81.5) {
        hardCutId = 'cut_victory_roll';
        this.activeCameraTag = 'VICTORY ROLL';
        desiredPos.set(16, 4, -22).applyQuaternion(heroQ).add(heroPos);
        desiredLook.copy(heroPos);
        targetFov = 60;
      } else {
        hardCutId = 'cut_vertical_sun';
        this.activeCameraTag = 'VERTICAL SUNRISE';
        desiredPos.copy(heroPos).add(new THREE.Vector3(38, -28, 42));
        desiredLook.copy(heroPos).add(new THREE.Vector3(-12, 24, -18));
        targetFov = 66;
      }
    }

    // Snap cleanly on director cut transitions, smooth damp inside each shot
    if (hardCutId !== this.lastShotCutId) {
      this.lastShotCutId = hardCutId;
      this.smoothCamPos.copy(desiredPos);
      this.smoothCamLook.copy(desiredLook);
    } else {
      const followRate = hardCutId === 'cut_cockpit_guns' ? 28 : 7.5;
      const alpha = 1 - Math.exp(-followRate * Math.max(dt, 0.016));
      this.smoothCamPos.lerp(desiredPos, alpha);
      this.smoothCamLook.lerp(desiredLook, alpha);
    }

    // Prevent camera from dipping under ocean waves
    this.smoothCamPos.y = Math.max(10, this.smoothCamPos.y);

    // Apply kinetic Michael Bay camera shake
    const shakeMag = this.cameraShake * 2.4 + this.speedIntensity * 0.14;
    const shakeVec = new THREE.Vector3(
      (Math.sin(realTime * 47.3) + Math.cos(realTime * 81.7)) * 0.5 * shakeMag,
      (Math.cos(realTime * 53.1) + Math.sin(realTime * 67.9)) * 0.5 * shakeMag,
      (Math.sin(realTime * 39.7)) * 0.5 * shakeMag,
    );

    camera.position.copy(this.smoothCamPos).add(shakeVec);
    camera.lookAt(this.smoothCamLook);

    // Dynamic FOV punch during high-speed / explosions
    const dynamicFov = targetFov + this.speedIntensity * 6.0 + this.vfx.shockImpact * 7.5;
    camera.fov = THREE.MathUtils.lerp(camera.fov, dynamicFov, Math.min(1, dt * 6));
    camera.updateProjectionMatrix();
  }
}
