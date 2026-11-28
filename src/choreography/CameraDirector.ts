import * as THREE from 'three';
import { FighterJet } from '../aircraft/FighterJet';
import { GuidedMissile } from '../vfx/BayhemVFX';

export type CameraMode = 'auto' | 'cockpit' | 'chase' | 'orbit' | 'cinematic';

export interface DirectorShotSpec {
  readonly id: string;
  readonly tag: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 14 tightly framed Michael Bay / Ridley Scott director shots spanning the
 * complete 88-second five-act arc with zero dead air.
 */
export const DIRECTOR_SHOTS: readonly DirectorShotSpec[] = [
  { id: 'cut_low_skim', tag: 'LOW SEA SKIM', start: 0.0, end: 5.2 },
  { id: 'cut_canyon_nearmiss', tag: 'SEA-STACK NEAR-MISS', start: 5.2, end: 9.2 },
  { id: 'cut_wingtip_roll', tag: 'WINGTIP BARREL-ROLL', start: 9.2, end: 14.0 },
  { id: 'cut_canyon_merge', tag: 'RIDLEY CANYON MERGE', start: 14.0, end: 20.4 },
  { id: 'cut_cockpit_guns', tag: 'COCKPIT GUNSIGHT', start: 20.4, end: 24.4 },
  { id: 'cut_wingshear_fireball', tag: 'WING-SHEAR FIREBALL', start: 24.4, end: 31.8 },
  { id: 'cut_supercell_ascent', tag: 'SUPERCELL ASCENT', start: 31.8, end: 38.2 },
  { id: 'cut_monolith_reveal', tag: 'MONOLITH CATHEDRAL', start: 38.2, end: 44.5 },
  { id: 'cut_missile_slalom', tag: 'SIDEWINDER NOSE CAM', start: 44.5, end: 51.8 },
  { id: 'cut_ace_duel', tag: 'ACE HEAD-ON', start: 51.8, end: 56.2 },
  { id: 'cut_cobra_360', tag: '360° COBRA BULLET-TIME', start: 56.2, end: 63.4 },
  { id: 'cut_macross_salvo', tag: 'MACROSS PRISM SALVO', start: 63.4, end: 69.2 },
  { id: 'cut_supernova_wide', tag: 'THERMOBARIC SUPERNOVA', start: 69.2, end: 76.2 },
  { id: 'cut_vertical_sunrise', tag: 'VERTICAL SUNRISE', start: 76.2, end: 88.0 },
] as const;

export const DIRECTOR_SHOT_COUNT = DIRECTOR_SHOTS.length;

export interface CameraDirectorContext {
  time: number;
  realTime: number;
  dt: number;
  mode: CameraMode;
  forceSnap: boolean;
  isPlaying: boolean;
  isPreLaunchIdle: boolean;
  hero: FighterJet;
  bandits: readonly FighterJet[];
  ace: FighterJet;
  featuredMissile: GuidedMissile | null;
  supernovaFocus: THREE.Vector3;
  w2KillPos: THREE.Vector3;
  cameraShake: number;
  speedIntensity: number;
  shockImpact: number;
}

// Sea-stack canyon placements matching WorldEnvironment.ts [x, z, sx, sy]
const SEA_STACKS: readonly (readonly [number, number, number, number])[] = [
  [-210, -320, 1.35, 1.2],
  [230, -480, 1.5, 1.4],
  [-340, -820, 1.9, 1.65],
  [290, -1080, 1.6, 1.35],
  [-260, -1480, 2.2, 1.85],
  [390, -1720, 1.8, 1.55],
  [-520, -2100, 2.5, 2.1],
  [480, -2450, 2.3, 1.9],
  [-760, -500, 2.7, 2.2],
  [780, -780, 2.6, 2.0],
  [-860, -1420, 3.1, 2.4],
  [840, -1620, 2.9, 2.3],
  [-450, 280, 2.1, 1.7],
  [510, 340, 2.3, 1.8],
  [-1150, -1100, 3.6, 2.7],
  [1180, -1250, 3.4, 2.5],
  [-620, -2850, 2.8, 2.4],
  [640, -3050, 3.1, 2.6],
];

// Obsidian monolith ring descriptors matching Monoliths.ts [x, y, z, outerRadius]
const MONOLITH_RINGS: readonly (readonly [number, number, number, number])[] = [
  [0, 520, -1550, 245],
  [-425, 615, -1880, 170],
  [465, 575, -1350, 188],
  [0, 745, -2450, 315],
];

/**
 * Dedicated zero-allocation cinematography director managing all 14 bespoke
 * auto-director shots plus all 5 interactive camera modes (`auto`, `cockpit`,
 * `chase`, `orbit`, `cinematic`) during both live playback and pause.
 */
export class CameraDirector {
  public activeCameraTag = 'DIRECTOR';

  private lastShotCutId = '';
  private readonly smoothPos = new THREE.Vector3(0, 48, 120);
  private readonly smoothLook = new THREE.Vector3(0, 42, -100);
  private readonly smoothUp = new THREE.Vector3(0, 1, 0);

  // Pre-allocated scratch vectors (zero per-frame heap allocations)
  private readonly _desiredPos = new THREE.Vector3();
  private readonly _desiredLook = new THREE.Vector3();
  private readonly _desiredUp = new THREE.Vector3(0, 1, 0);
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);
  private readonly _jetUp = new THREE.Vector3();
  private readonly _shakeVec = new THREE.Vector3();
  private readonly _auxA = new THREE.Vector3();
  private readonly _auxB = new THREE.Vector3();
  private readonly _mDir = new THREE.Vector3();
  private readonly _mSide = new THREE.Vector3();

  public reset(): void {
    this.lastShotCutId = '';
    this.smoothUp.set(0, 1, 0);
  }

  public update(ctx: CameraDirectorContext, camera: THREE.PerspectiveCamera): void {
    const mode = ctx.mode;

    // 4 ORBIT: yield immediately so OrbitControls retains unobstructed free mouse control
    if (mode === 'orbit') {
      this.activeCameraTag = 'FREE ORBIT';
      this.lastShotCutId = 'orbit';
      this.smoothUp.set(0, 1, 0);
      camera.up.set(0, 1, 0);
      return;
    }

    const hero = ctx.hero;
    const heroPos = hero.group.position;
    const heroQ = hero.group.quaternion;
    const safeDt = Math.max(ctx.dt, 0.008);
    const t = ctx.time;
    const realTime = ctx.realTime;

    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;
    const desiredUp = this._desiredUp;
    desiredUp.set(0, 1, 0);

    let targetFov = 64;
    let followRate = 8.0;
    let hardCutId: string = mode;
    let isCockpitShot = false;
    let shakeScale = 1.0;

    if (mode === 'cockpit') {
      // 2 COCKPIT: unobstructed forward canopy view with jet-aligned roll horizon
      this.computeCockpitView(hero, desiredPos, desiredLook, desiredUp);
      targetFov = 74;
      hardCutId = 'cockpit';
      this.activeCameraTag = 'COCKPIT HUD';
      isCockpitShot = true;
      shakeScale = 0.22;
    } else if (mode === 'chase') {
      // 3 CHASE: tight kinetic tail chase with dynamic speed pull-back
      const speedPull = ctx.speedIntensity * 2.4;
      desiredPos.set(0, 4.75, 21.8 + speedPull).applyQuaternion(heroQ).add(heroPos);
      desiredLook.set(0, 1.35, -72).applyQuaternion(heroQ).add(heroPos);
      targetFov = 68;
      followRate = 10.5;
      hardCutId = 'chase';
      this.activeCameraTag = 'TAIL CHASE';
    } else if (mode === 'cinematic') {
      // 5 BAYHEM: dramatic hero fly-past on pre-launch idle, sweeping Michael Bay orbit in-game
      hardCutId = ctx.isPreLaunchIdle ? 'prelaunch_flypast' : 'cinematic';
      this.activeCameraTag = 'BAYHEM ORBIT';
      if (ctx.isPreLaunchIdle) {
        // Low-angle golden-hour fly-past sweeping heroically across VIPER-1 over the ocean canyon
        const sweep = realTime * 0.42;
        const sideSign = Math.sin(sweep * 0.5) >= 0 ? 1 : -1;
        const localX = Math.cos(sweep) * 24 + sideSign * 6;
        const localY = 4.2 + Math.sin(sweep * 1.4) * 3.8;
        const localZ = -18 + Math.sin(sweep) * 20;
        desiredPos.set(localX, localY, localZ).applyQuaternion(heroQ).add(heroPos);
        desiredPos.y = Math.max(12.5, desiredPos.y);
        desiredLook.set(0, 0.6, -12).applyQuaternion(heroQ).add(heroPos);
        targetFov = 56;
        followRate = 5.5;
        shakeScale = 0.0;
      } else {
        // Sweeping crane orbit kept cleanly distinct from LOW SEA SKIM, CHASE, COCKPIT & ORBIT
        const a = realTime * 0.55;
        desiredPos.set(
          heroPos.x + Math.cos(a) * 36,
          heroPos.y + 11.5 + Math.sin(a * 1.3) * 3.5,
          heroPos.z + Math.sin(a) * 36,
        );
        this._auxA.set(0, 0.8, -8).applyQuaternion(heroQ);
        desiredLook.copy(heroPos).add(this._auxA);
        targetFov = 54;
        followRate = 7.5;
      }
    } else {
      // 1 AUTO: 14 tightly framed choreographed director shots across 0:00–1:28
      const w1 = ctx.bandits[0];
      const w2 = ctx.bandits[1];
      const w3 = ctx.bandits[2];
      const w4 = ctx.bandits[3];
      const ace = ctx.ace;

      if (t < 5.2) {
        // SHOT 1: Low ocean sea-spray skim off VIPER-1's starboard bow
        hardCutId = DIRECTOR_SHOTS[0].id;
        this.activeCameraTag = DIRECTOR_SHOTS[0].tag;
        const p = t / 5.2;
        desiredPos
          .set(16.5 - p * 3.5, -1.6 + p * 1.4, -24.5 + p * 4.0)
          .applyQuaternion(heroQ)
          .add(heroPos);
        desiredPos.y = Math.max(12.0, desiredPos.y);
        desiredLook.set(-1.5, 1.2, 6.0).applyQuaternion(heroQ).add(heroPos);
        targetFov = 58;
        followRate = 8.5;
      } else if (t < 9.2) {
        // SHOT 2: Sea-stack canyon near-miss + Mach 1 boom sweep
        hardCutId = DIRECTOR_SHOTS[1].id;
        this.activeCameraTag = DIRECTOR_SHOTS[1].tag;
        const p = (t - 5.2) / 4.0;
        desiredPos
          .set(22.0 - p * 10.0, 2.2 + p * 5.2, 16.5 - p * 26.0)
          .applyQuaternion(heroQ)
          .add(heroPos);
        desiredPos.y = Math.max(14.0, desiredPos.y);
        desiredLook.set(-4.0, 1.5, -28.0).applyQuaternion(heroQ).add(heroPos);
        targetFov = 66;
        followRate = 9.0;
      } else if (t < 14.0) {
        // SHOT 3: Tight wingtip barrel-roll cam bolted off port-aft wing
        hardCutId = DIRECTOR_SHOTS[2].id;
        this.activeCameraTag = DIRECTOR_SHOTS[2].tag;
        const p = (t - 9.2) / 4.8;
        desiredPos
          .set(-13.8, 2.8 + Math.sin(p * Math.PI) * 1.6, 11.8)
          .applyQuaternion(heroQ)
          .add(heroPos);
        desiredLook.set(2.4, 0.4, -46.0).applyQuaternion(heroQ).add(heroPos);
        // Subtle 42% horizon roll lean to sell the barrel roll without disorienting
        this._jetUp.set(0, 1, 0).applyQuaternion(heroQ).normalize();
        desiredUp.copy(this._worldUp).lerp(this._jetUp, 0.42).normalize();
        targetFov = 74;
        followRate = 14.0;
      } else if (t < 20.4) {
        // SHOT 4: Ridley Scott monumental scale canyon merge wide
        hardCutId = DIRECTOR_SHOTS[3].id;
        this.activeCameraTag = DIRECTOR_SHOTS[3].tag;
        const p = (t - 14.0) / 6.4;
        desiredPos
          .set(26.0 - p * 8.0, 10.5 - p * 2.5, 31.0 - p * 6.0)
          .applyQuaternion(heroQ)
          .add(heroPos);
        if (w2 && w2.alive) {
          desiredLook.copy(w2.group.position).lerp(heroPos, 0.48);
        } else {
          desiredLook.set(0, 2.0, -36.0).applyQuaternion(heroQ).add(heroPos);
        }
        targetFov = 60;
        followRate = 7.5;
      } else if (t < 24.4) {
        // SHOT 5: Unobstructed cockpit HUD gunsight pass on WRAITH-2
        hardCutId = DIRECTOR_SHOTS[4].id;
        this.activeCameraTag = DIRECTOR_SHOTS[4].tag;
        this.computeCockpitView(hero, desiredPos, desiredLook, desiredUp);
        targetFov = 68;
        isCockpitShot = true;
        shakeScale = 0.25;
      } else if (t < 31.8) {
        // SHOT 6: Slow-mo wing-shear fireball pass + golden decoy flare blossom
        hardCutId = DIRECTOR_SHOTS[5].id;
        this.activeCameraTag = DIRECTOR_SHOTS[5].tag;
        const p = (t - 24.4) / 7.4;
        if (p < 0.55) {
          // Low port-forward sweeping past VIPER-1 and WRAITH-2's blazing fireball
          const q = p / 0.55;
          desiredPos
            .set(-21.5 + q * 7.0, 6.5 + q * 4.5, 16.0 - q * 10.0)
            .applyQuaternion(heroQ)
            .add(heroPos);
          // Frame both hero jet and WRAITH-2 detonation plume
          desiredLook.copy(ctx.w2KillPos).lerp(heroPos, 0.52 + q * 0.30);
          targetFov = 62;
        } else {
          // Pull behind twin afterburners as VIPER-1 climbs toward the gathering storm
          const q = (p - 0.55) / 0.45;
          desiredPos
            .set(-14.5 + q * 28.0, -3.2 + q * 6.0, 22.0 + q * 5.0)
            .applyQuaternion(heroQ)
            .add(heroPos);
          desiredLook.set(0, 4.0, -42.0).applyQuaternion(heroQ).add(heroPos);
          targetFov = 68;
        }
        followRate = 8.5;
      } else if (t < 38.2) {
        // SHOT 7: High-G afterburner climb into Chromatic Supercell & WRAITH-1 kill
        hardCutId = DIRECTOR_SHOTS[6].id;
        this.activeCameraTag = DIRECTOR_SHOTS[6].tag;
        const p = (t - 31.8) / 6.4;
        desiredPos
          .set(17.5 - p * 6.0, -4.2 + p * 8.0, 23.5)
          .applyQuaternion(heroQ)
          .add(heroPos);
        if (w1 && w1.alive) {
          desiredLook.copy(w1.group.position).lerp(heroPos, 0.58);
        } else {
          desiredLook.set(0, 5.5, -48.0).applyQuaternion(heroQ).add(heroPos);
        }
        targetFov = 70;
        followRate = 8.0;
      } else if (t < 44.5) {
        // SHOT 8: Supercell monolith cathedral monumental reveal
        hardCutId = DIRECTOR_SHOTS[7].id;
        this.activeCameraTag = DIRECTOR_SHOTS[7].tag;
        const sweep = (t - 38.2) * 0.48 + 0.35;
        desiredPos.set(
          heroPos.x + Math.cos(sweep) * 32,
          heroPos.y + 9.5 + Math.sin(sweep * 1.2) * 4.0,
          heroPos.z + Math.sin(sweep) * 32,
        );
        // Aim past VIPER-1 toward the floating obsidian monolith cathedral centre
        this._auxA.set(0, 520, -1550);
        desiredLook.copy(heroPos).lerp(this._auxA, 0.24);
        targetFov = 66;
        followRate = 6.5;
      } else if (t < 51.8) {
        // SHOT 9: Curving Sidewinder missile-nose slalom through flares -> twin kills
        hardCutId = DIRECTOR_SHOTS[8].id;
        this.activeCameraTag = DIRECTOR_SHOTS[8].tag;
        const fm = ctx.featuredMissile;
        if (fm && fm.alive) {
          this._mDir.copy(fm.vel);
          if (this._mDir.lengthSq() < 1e-4) this._mDir.set(0, 0, -1);
          else this._mDir.normalize();
          this._mSide.crossVectors(this._mDir, this._worldUp);
          if (this._mSide.lengthSq() < 1e-4) this._mSide.set(1, 0, 0);
          else this._mSide.normalize();

          desiredPos
            .copy(fm.pos)
            .addScaledVector(this._mDir, -13.5)
            .addScaledVector(this._mSide, 2.4);
          desiredPos.y += 2.8;
          if (w3 && w3.alive) {
            desiredLook.copy(w3.group.position).lerp(fm.pos, 0.32);
          } else {
            desiredLook.copy(fm.pos).addScaledVector(this._mDir, 55);
          }
          targetFov = 78;
          followRate = 18.0;
        } else {
          // Kill-confirmation sweep catching WRAITH-4 twin detonation & Ace entry
          desiredPos.set(-19.0, 6.5, 24.0).applyQuaternion(heroQ).add(heroPos);
          const focusJet = w4 && w4.alive ? w4 : ace && ace.alive ? ace : null;
          if (focusJet) {
            desiredLook.copy(focusJet.group.position).lerp(heroPos, 0.45);
          } else {
            desiredLook.set(0, 2.0, -45.0).applyQuaternion(heroQ).add(heroPos);
          }
          targetFov = 66;
          followRate = 8.0;
        }
      } else if (t < 56.2) {
        // SHOT 10: High-tension Ace head-on joust inside obsidian monolith rings
        hardCutId = DIRECTOR_SHOTS[9].id;
        this.activeCameraTag = DIRECTOR_SHOTS[9].tag;
        const p = (t - 51.8) / 4.4;
        desiredPos
          .set(15.5 - p * 4.5, 5.2, 24.5 - p * 3.5)
          .applyQuaternion(heroQ)
          .add(heroPos);
        if (ace && ace.alive) {
          desiredLook.copy(ace.group.position).lerp(heroPos, 0.46);
        } else {
          desiredLook.set(0, 1.5, -50.0).applyQuaternion(heroQ).add(heroPos);
        }
        targetFov = 63;
        followRate = 9.0;
      } else if (t < 63.4) {
        // SHOT 11: Iconic 360° inverted Pugachev's Cobra bullet-time orbit
        hardCutId = DIRECTOR_SHOTS[10].id;
        this.activeCameraTag = DIRECTOR_SHOTS[10].tag;
        const p = (t - 56.2) / 7.2;
        const angle = p * Math.PI * 2.25 + 0.55;
        const radius = 23.0 - Math.sin(p * Math.PI) * 3.0;
        desiredPos.set(
          heroPos.x + Math.cos(angle) * radius,
          heroPos.y + 3.8 + Math.sin(angle * 2.0) * 4.5,
          heroPos.z + Math.sin(angle) * radius,
        );
        desiredLook.copy(heroPos);
        desiredLook.y += 0.6;
        targetFov = 55;
        followRate = 12.0;
      } else if (t < 69.2) {
        // SHOT 12: 8-missile Macross prism salvo launch -> leader prism missile track
        hardCutId = DIRECTOR_SHOTS[11].id;
        this.activeCameraTag = DIRECTOR_SHOTS[11].tag;
        const fm = ctx.featuredMissile;
        if (fm && fm.alive && t >= 65.5) {
          this._mDir.copy(fm.vel);
          if (this._mDir.lengthSq() < 1e-4) this._mDir.set(0, 0, -1);
          else this._mDir.normalize();
          this._mSide.crossVectors(this._mDir, this._worldUp);
          if (this._mSide.lengthSq() < 1e-4) this._mSide.set(1, 0, 0);
          else this._mSide.normalize();

          desiredPos
            .copy(fm.pos)
            .addScaledVector(this._mDir, -23.0)
            .addScaledVector(this._mSide, -7.5);
          desiredPos.y += 5.5;
          if (ace && ace.alive) {
            desiredLook.copy(ace.group.position).lerp(fm.pos, 0.28);
          } else {
            desiredLook.copy(fm.pos).addScaledVector(this._mDir, 50);
          }
          targetFov = 74;
          followRate = 13.0;
        } else {
          // Wide low-port hero angle capturing all 8 fanning Macross prism ribbons
          const p = Math.min(1, (t - 63.4) / 2.2);
          desiredPos
            .set(-19.5 + p * 3.5, 6.2 - p * 1.5, 24.0 + p * 4.0)
            .applyQuaternion(heroQ)
            .add(heroPos);
          if (ace && ace.alive) {
            desiredLook.copy(ace.group.position).lerp(heroPos, 0.36);
          } else {
            desiredLook.set(0, 2.0, -55.0).applyQuaternion(heroQ).add(heroPos);
          }
          targetFov = 68;
          followRate = 9.0;
        }
      } else if (t < 76.2) {
        // SHOT 13: Wide thermobaric supernova blast framed through obsidian monolith ring
        hardCutId = DIRECTOR_SHOTS[12].id;
        this.activeCameraTag = DIRECTOR_SHOTS[12].tag;
        const p = (t - 69.2) / 7.0;
        desiredPos
          .set(36.0 - p * 6.0, 14.0 + p * 4.0, 44.0 + p * 6.0)
          .applyQuaternion(heroQ)
          .add(heroPos);
        // Bias framing between banking VIPER-1 and the colossal supernova epicentre
        desiredLook.copy(heroPos).lerp(ctx.supernovaFocus, 0.50 - p * 0.22);
        targetFov = 72;
        followRate = 7.0;
      } else {
        // SHOT 14: Victory roll over glassy sea sweeping into vertical twin-afterburner sunrise climb
        hardCutId = DIRECTOR_SHOTS[13].id;
        this.activeCameraTag = DIRECTOR_SHOTS[13].tag;
        const p = THREE.MathUtils.clamp((t - 76.2) / 11.8, 0, 1);
        if (p < 0.40) {
          // Forward-starboard hero victory barrel roll over golden ocean
          const q = p / 0.40;
          desiredPos
            .set(16.5 + q * 6.0, 3.8 - q * 1.5, -21.5 + q * 32.0)
            .applyQuaternion(heroQ)
            .add(heroPos);
          desiredLook.copy(heroPos);
          desiredLook.y += 1.2;
          targetFov = 60;
          followRate = 8.5;
        } else {
          // Monumental low-angle vertical twin-afterburner sunrise climb
          const q = (p - 0.40) / 0.60;
          desiredPos.set(
            heroPos.x + 28.0 + q * 14.0,
            heroPos.y - 20.0 - q * 14.0,
            heroPos.z + 32.0 + q * 14.0,
          );
          desiredLook.set(heroPos.x - 8.0, heroPos.y + 18.0 + q * 12.0, heroPos.z - 14.0);
          targetFov = 64 + q * 4.0;
          followRate = 6.5;
        }
      }
    }

    // Keep all non-cockpit cameras clear of ocean crests, sea-stacks, monoliths, and hero hull
    if (!isCockpitShot) {
      this.enforceGeometryClearance(desiredPos, heroPos);
    }

    const isCut = ctx.forceSnap || hardCutId !== this.lastShotCutId;
    if (isCut) {
      this.lastShotCutId = hardCutId;
      this.smoothPos.copy(desiredPos);
      this.smoothLook.copy(desiredLook);
      this.smoothUp.copy(desiredUp);
    } else if (isCockpitShot) {
      // Rigid cockpit lock prevents canopy near-plane clipping during extreme high-G rolls
      this.smoothPos.copy(desiredPos);
      this.smoothLook.copy(desiredLook);
      this.smoothUp.copy(desiredUp);
    } else {
      const alpha = 1 - Math.exp(-followRate * safeDt);
      this.smoothPos.lerp(desiredPos, alpha);
      this.smoothLook.lerp(desiredLook, alpha);
      this.smoothUp.lerp(desiredUp, Math.min(1, safeDt * 12)).normalize();
      this.enforceGeometryClearance(this.smoothPos, heroPos);
    }

    // Exact upright reset whenever target up is world-up so non-cockpit modes never drift
    if (desiredUp.y > 0.9999 && Math.abs(desiredUp.x) < 1e-4 && Math.abs(desiredUp.z) < 1e-4) {
      if (isCut || this.smoothUp.y > 0.995) {
        this.smoothUp.set(0, 1, 0);
      }
    }
    camera.up.copy(this.smoothUp);

    // Apply kinetic Michael Bay camera shake only during active playback (rock-steady when paused)
    if (ctx.isPlaying && shakeScale > 0) {
      const shakeMag = (ctx.cameraShake * 2.25 + ctx.speedIntensity * 0.13) * shakeScale;
      this._shakeVec.set(
        (Math.sin(realTime * 47.3) + Math.cos(realTime * 81.7)) * 0.5 * shakeMag,
        (Math.cos(realTime * 53.1) + Math.sin(realTime * 67.9)) * 0.5 * shakeMag,
        Math.sin(realTime * 39.7) * 0.5 * shakeMag,
      );
      camera.position.copy(this.smoothPos).add(this._shakeVec);
    } else {
      camera.position.copy(this.smoothPos);
    }

    camera.lookAt(this.smoothLook);

    // Dynamic FOV punch scaled by supersonic speed and explosion shockwaves
    const dynamicFov = THREE.MathUtils.clamp(
      targetFov + (ctx.isPreLaunchIdle ? 0 : ctx.speedIntensity * 5.2 + ctx.shockImpact * 6.8),
      46,
      92,
    );
    camera.fov = isCut
      ? dynamicFov
      : THREE.MathUtils.lerp(camera.fov, dynamicFov, Math.min(1, safeDt * 6.5));
    camera.updateProjectionMatrix();
  }

  private computeCockpitView(
    hero: FighterJet,
    outPos: THREE.Vector3,
    outLook: THREE.Vector3,
    outUp: THREE.Vector3,
  ): void {
    hero.group.updateMatrixWorld(true);
    hero.cockpitAnchor.getWorldPosition(outPos);
    // Subtle canopy sill clearance in jet-local space (guarantees > near=0.8 clearance in all maneuvers)
    this._auxA.set(0, 0.12, -0.18).applyQuaternion(hero.group.quaternion);
    outPos.add(this._auxA);

    outLook.set(0, -0.02, -180).applyQuaternion(hero.group.quaternion).add(outPos);
    outUp.set(0, 1, 0).applyQuaternion(hero.group.quaternion).normalize();
  }

  private enforceGeometryClearance(camPos: THREE.Vector3, heroPos: THREE.Vector3): void {
    // 1. Keep strictly above Gerstner ocean wave crests
    if (camPos.y < 11.5) {
      camPos.y = 11.5;
    }

    // 2. Push outside any basalt sea-stack cone in the canyon corridor
    for (let i = 0; i < SEA_STACKS.length; i++) {
      const stack = SEA_STACKS[i];
      const sx = stack[2];
      const sy = stack[3];
      const topY = sy * 295 - 40;
      if (camPos.y > topY + 18) continue;

      const baseY = sy * -45 - 40;
      const height = sy * 340;
      const frac = THREE.MathUtils.clamp((camPos.y - baseY) / height, 0, 1);
      // Cone radius tapers toward apex; multiply by 1.28 max crag factor + 16 unit buffer
      const minRadius = 42 * sx * (1 - frac) * 1.28 + 16;

      const dx = camPos.x - stack[0];
      const dz = camPos.z - stack[1];
      const distSq = dx * dx + dz * dz;
      if (distSq < minRadius * minRadius) {
        const dist = Math.sqrt(distSq);
        if (dist > 1e-3) {
          const push = minRadius / dist;
          camPos.x = stack[0] + dx * push;
          camPos.z = stack[1] + dz * push;
        } else {
          camPos.x = stack[0] + minRadius;
        }
      }
    }

    // 3. Push clear of the solid rim cross-section of obsidian monolith rings
    for (let i = 0; i < MONOLITH_RINGS.length; i++) {
      const ring = MONOLITH_RINGS[i];
      const dx = camPos.x - ring[0];
      const dy = camPos.y - ring[1];
      const dz = camPos.z - ring[2];
      if (Math.abs(dz) > 36) continue;

      const radial = Math.hypot(dx, dy);
      const ringR = ring[3];
      const rimDelta = radial - ringR;
      if (Math.abs(rimDelta) < 24) {
        const safeSign = rimDelta >= 0 ? 1 : -1;
        const targetR = ringR + safeSign * 24;
        if (radial > 1e-3) {
          const scale = targetR / radial;
          camPos.x = ring[0] + dx * scale;
          camPos.y = Math.max(11.5, ring[1] + dy * scale);
        }
      }
    }

    // 4. Maintain safe bounding clearance outside VIPER-1 fuselage & wingspan
    this._auxB.subVectors(camPos, heroPos);
    const heroDistSq = this._auxB.lengthSq();
    const minHeroDist = 10.5;
    if (heroDistSq < minHeroDist * minHeroDist) {
      if (heroDistSq > 1e-4) {
        this._auxB.multiplyScalar(minHeroDist / Math.sqrt(heroDistSq));
        camPos.copy(heroPos).add(this._auxB);
      } else {
        camPos.set(heroPos.x, heroPos.y + minHeroDist, heroPos.z + minHeroDist);
      }
      if (camPos.y < 11.5) camPos.y = 11.5;
    }
  }
}
