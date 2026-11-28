import * as THREE from 'three';
import { FighterJet } from '../aircraft/FighterJet';

const GUN_MUZZLE_SPEED = 920; // World units/s for M61A1 20mm Vulcan lead calculation
const RWR_MAX_RANGE = 1450;   // World units mapped to the outer RWR threat ring
const LEAD_TETHER_DASH = [4, 4];

const HUD_FONT_COMPACT = '600 10px "SF Mono", "Fira Code", ui-monospace, monospace';
const HUD_FONT_NORMAL = '600 11px "SF Mono", "Fira Code", ui-monospace, monospace';
const RWR_FONT = '600 9.5px "SF Mono", "Fira Code", ui-monospace, monospace';
const WPN_MISSILE_LABEL = 'WPN  AIM-9X PRISM';
const WPN_GUN_LABEL = 'WPN  M61A1 VULCAN';

// Pre-computed 000–359 compass tape labels (zero per-frame string allocations)
const DEGREE_LABELS: readonly string[] = Array.from({ length: 360 }, (_, deg) =>
  String(deg).padStart(3, '0'),
);

interface BanditHudLabelCache {
  callsign: string;
  shortTag: string;
  distTenths: number;
  onScreenLabel: string;
  offScreenLabel: string;
}

export class FighterHUD {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  public enabled = true;

  private viewW = 1280;
  private viewH = 720;
  private smoothedGLoad = 0;

  // Cached formatted HUD strings so unchanged telemetry avoids per-frame allocations
  private lastGKey = -1;
  private cachedGMidStop = 'rgba(6, 3, 14, 0.000)';
  private cachedGOutStop = 'rgba(2, 1, 8, 0.000)';
  private lastHueKey = -1;
  private lastAlphaKey = -1;
  private cachedPrimary = 'hsla(152, 96%, 64%, 0.84)';
  private cachedFaint = 'hsla(152, 96%, 64%, 0.34)';
  private lastKnots = -1;
  private cachedKnotsStr = 'IAS  0 KT';
  private lastMachHundredths = -1;
  private cachedMachStr = 'MACH 0.00';
  private lastGTenths = Number.NaN;
  private cachedGStr = 'G    +1.0';
  private lastThrPct = -1;
  private cachedThrStr = 'THR  100% AB';
  private lastTimePct = -1;
  private cachedTimeStr = 'TIME 100% BULLET';
  private lastAltFt = -1;
  private cachedAltStr = 'ALT  0 FT';
  private lastCameraTag = '';
  private cachedCamTagStr = 'CAM: ';
  private lastFluxPct = -1;
  private cachedFluxStr = 'FLUX 0%';
  private lastRwrThreatCount = -1;
  private cachedRwrStr = 'RWR · 0 TRK';
  private readonly banditLabelCache: BanditHudLabelCache[] = [];

  // Pre-allocated scratch math objects (zero per-frame heap allocations)
  private readonly euler = new THREE.Euler();
  private readonly projVec = new THREE.Vector3();
  private readonly leadProjVec = new THREE.Vector3();
  private readonly camSpacePos = new THREE.Vector3();
  private readonly leadWorldPos = new THREE.Vector3();
  private readonly relPos = new THREE.Vector3();
  private readonly relVel = new THREE.Vector3();
  private readonly heroForward = new THREE.Vector3();
  private readonly heroRight = new THREE.Vector3();
  private readonly rwrOffset = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  public resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewW = Math.max(1, window.innerWidth);
    this.viewH = Math.max(1, window.innerHeight);
    this.canvas.width = Math.floor(this.viewW * dpr);
    this.canvas.height = Math.floor(this.viewH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  public render(
    time: number,
    hero: FighterJet,
    bandits: FighterJet[],
    lockedTarget: FighterJet | null,
    isMissileLocked: boolean,
    camera: THREE.PerspectiveCamera,
    cameraTag: string,
    tripIntensity: number,
    timeScale: number,
    beatPulse = 0,
  ): void {
    const w = this.viewW;
    const h = this.viewH;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled) return;

    const cx = w * 0.5;
    const cy = h * 0.5;
    const isCompact = w < 780;

    // ------------------------------------------------------------------
    // 0. HIGH-G (9G+) PERIPHERAL TUNNEL-VISION DARKENING (UNDER SYMBOLOGY)
    // ------------------------------------------------------------------
    const targetGLoad = THREE.MathUtils.clamp((hero.gForce - 8.6) / 3.4, 0, 1);
    this.smoothedGLoad += (targetGLoad - this.smoothedGLoad) * (targetGLoad > this.smoothedGLoad ? 0.22 : 0.14);
    if (this.smoothedGLoad < 0.004) this.smoothedGLoad = 0;

    if (this.smoothedGLoad > 0.004) {
      const g = this.smoothedGLoad;
      const gKey = Math.round(g * 200);
      if (gKey !== this.lastGKey) {
        this.lastGKey = gKey;
        this.cachedGMidStop = `rgba(6, 3, 14, ${(0.22 * g).toFixed(3)})`;
        this.cachedGOutStop = `rgba(2, 1, 8, ${(0.58 * g).toFixed(3)})`;
      }
      const innerR = Math.min(w, h) * (0.44 - g * 0.11);
      const outerR = Math.hypot(cx, cy) * 1.04;
      const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
      grad.addColorStop(0, 'rgba(4, 2, 10, 0)');
      grad.addColorStop(0.62, this.cachedGMidStop);
      grad.addColorStop(1, this.cachedGOutStop);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // Colour shifts subtly from military phosphor green -> chromatic neon cyan/magenta during LSD peak
    const hue = tripIntensity > 0.35 ? (152 + Math.sin(time * 2.4) * 95 * tripIntensity + 360) % 360 : 152;
    const hueKey = Math.round(hue * 2);
    const alphaKey = Math.round(Math.min(0.98, 0.84 + beatPulse * 0.12) * 100);
    if (hueKey !== this.lastHueKey || alphaKey !== this.lastAlphaKey) {
      this.lastHueKey = hueKey;
      this.lastAlphaKey = alphaKey;
      const hueVal = hueKey * 0.5;
      this.cachedPrimary = `hsla(${hueVal}, 96%, 64%, ${(alphaKey * 0.01).toFixed(2)})`;
      this.cachedFaint = `hsla(${hueVal}, 96%, 64%, 0.34)`;
    }
    const primary = this.cachedPrimary;
    const faint = this.cachedFaint;
    const alert = isMissileLocked ? 'rgba(255, 58, 92, 0.95)' : 'rgba(255, 196, 70, 0.88)';

    // Subtle psychedelic instrument jitter when trip > 0.55 ("Instruments are melting!")
    const glitchX = tripIntensity > 0.55 ? Math.sin(time * 41) * (tripIntensity - 0.55) * 4.5 : 0;
    const glitchY = tripIntensity > 0.55 ? Math.cos(time * 37) * (tripIntensity - 0.55) * 3.0 : 0;

    ctx.save();
    ctx.translate(glitchX, glitchY);
    ctx.strokeStyle = primary;
    ctx.fillStyle = primary;
    ctx.lineWidth = 1.4;
    ctx.font = isCompact ? HUD_FONT_COMPACT : HUD_FONT_NORMAL;

    // ------------------------------------------------------------------
    // 1. CENTRAL PITCH LADDER & FLIGHT PATH VECTOR (TILTS WITH VIPER-1 ROLL)
    // ------------------------------------------------------------------
    this.euler.setFromQuaternion(hero.group.quaternion, 'YXZ');
    const headingDeg = (((-this.euler.y * 180) / Math.PI) % 360 + 360) % 360;
    const pitchDeg = (this.euler.x * 180) / Math.PI;
    const rollRad = this.euler.z;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-rollRad * 0.65);

    ctx.strokeStyle = faint;
    const rungOuter = isCompact ? 50 : 64;
    const rungInner = isCompact ? 20 : 26;
    for (let deg = -20; deg <= 20; deg += 10) {
      if (deg === 0) continue;
      const yOff = (pitchDeg - deg) * 4.5;
      if (Math.abs(yOff) > h * 0.24) continue;
      ctx.beginPath();
      ctx.moveTo(-rungOuter, yOff);
      ctx.lineTo(-rungInner, yOff);
      ctx.moveTo(rungInner, yOff);
      ctx.lineTo(rungOuter, yOff);
      ctx.stroke();
    }

    // Artificial horizon line
    ctx.strokeStyle = primary;
    const horY = pitchDeg * 4.5;
    const horOuter = isCompact ? 82 : 110;
    if (Math.abs(horY) < h * 0.26) {
      ctx.beginPath();
      ctx.moveTo(-horOuter, horY);
      ctx.lineTo(-28, horY);
      ctx.moveTo(28, horY);
      ctx.lineTo(horOuter, horY);
      ctx.stroke();
    }
    ctx.restore();

    // Central gun boresight reticle / water-line pipper
    ctx.strokeStyle = primary;
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.moveTo(cx - 24, cy);
    ctx.lineTo(cx - 12, cy);
    ctx.moveTo(cx + 12, cy);
    ctx.lineTo(cx + 24, cy);
    ctx.moveTo(cx, cy - 20);
    ctx.lineTo(cx, cy - 12);
    ctx.stroke();

    // ------------------------------------------------------------------
    // 2. TOP HEADING COMPASS TAPE
    // ------------------------------------------------------------------
    const tapeW = Math.min(340, w * (isCompact ? 0.44 : 0.38));
    const tapeY = Math.max(54, h * 0.085);
    ctx.strokeStyle = faint;
    ctx.beginPath();
    ctx.moveTo(cx - tapeW / 2, tapeY);
    ctx.lineTo(cx + tapeW / 2, tapeY);
    ctx.stroke();

    ctx.textAlign = 'center';
    for (let offset = -30; offset <= 30; offset += 10) {
      const degVal = ((Math.round(headingDeg + offset) % 360) + 360) % 360;
      const tx = cx + (offset / 35) * (tapeW * 0.5);
      ctx.beginPath();
      ctx.moveTo(tx, tapeY - 5);
      ctx.lineTo(tx, tapeY + 4);
      ctx.stroke();
      ctx.fillText(DEGREE_LABELS[degVal], tx, tapeY - 9);
    }

    ctx.strokeStyle = primary;
    ctx.strokeRect(cx - 22, tapeY + 7, 44, 18);
    const headIdx = ((Math.round(headingDeg) % 360) + 360) % 360;
    ctx.fillText(DEGREE_LABELS[headIdx], cx, tapeY + 20);

    // ------------------------------------------------------------------
    // 3. LEFT AIRSPEED / MACH / G-FORCE TELEMETRY COLUMN
    // ------------------------------------------------------------------
    const leftX = Math.max(20, w * 0.042);
    const machHundredths = Math.round((hero.speed / 128) * 100);
    if (machHundredths !== this.lastMachHundredths) {
      this.lastMachHundredths = machHundredths;
      this.cachedMachStr = `MACH ${(machHundredths * 0.01).toFixed(2)}`;
    }
    const knots = Math.round(hero.speed * 3.4);
    if (knots !== this.lastKnots) {
      this.lastKnots = knots;
      this.cachedKnotsStr = `IAS  ${knots} KT`;
    }
    const gTenths = Math.round(hero.gForce * 10);
    if (gTenths !== this.lastGTenths) {
      this.lastGTenths = gTenths;
      const gText = (gTenths * 0.1).toFixed(1);
      this.cachedGStr = gTenths >= 90 ? `G    +${gText} OVER-G` : `G    +${gText}`;
    }
    const thrPct = Math.round(hero.throttle * 100);
    if (thrPct !== this.lastThrPct) {
      this.lastThrPct = thrPct;
      this.cachedThrStr = `THR  ${thrPct}% AB`;
    }
    const altFt = Math.max(0, Math.round(hero.group.position.y * 28));
    if (altFt !== this.lastAltFt) {
      this.lastAltFt = altFt;
      this.cachedAltStr = `ALT  ${altFt.toLocaleString()} FT`;
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = primary;
    ctx.fillText(this.cachedKnotsStr, leftX, cy - 42);
    ctx.fillText(this.cachedMachStr, leftX, cy - 24);
    ctx.fillStyle = hero.gForce >= 9.0 ? 'rgba(255, 76, 98, 0.96)' : primary;
    ctx.fillText(this.cachedGStr, leftX, cy - 6);
    ctx.fillStyle = primary;
    ctx.fillText(this.cachedThrStr, leftX, cy + 12);
    if (timeScale < 0.7) {
      const timePct = Math.round(timeScale * 100);
      if (timePct !== this.lastTimePct) {
        this.lastTimePct = timePct;
        this.cachedTimeStr = `TIME ${timePct}% BULLET`;
      }
      ctx.fillStyle = '#ff66dd';
      ctx.fillText(this.cachedTimeStr, leftX, cy + 32);
    }

    // ------------------------------------------------------------------
    // 4. RIGHT ALTITUDE / WEAPONS / CAMERA TAG COLUMN
    // ------------------------------------------------------------------
    const rightX = w - Math.max(20, w * 0.042);
    if (cameraTag !== this.lastCameraTag) {
      this.lastCameraTag = cameraTag;
      this.cachedCamTagStr = `CAM: ${cameraTag}`;
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = primary;
    ctx.fillText(this.cachedAltStr, rightX, cy - 42);
    ctx.fillText(isMissileLocked ? WPN_MISSILE_LABEL : WPN_GUN_LABEL, rightX, cy - 24);
    ctx.fillStyle = alert;
    ctx.fillText(this.cachedCamTagStr, rightX, cy - 6);
    if (isMissileLocked) {
      ctx.fillStyle = 'rgba(255, 58, 92, 0.95)';
      ctx.fillText('LOCK: SHOOT', rightX, cy + 30);
    }
    if (tripIntensity > 0.2) {
      const fluxPct = Math.round(tripIntensity * 100);
      if (fluxPct !== this.lastFluxPct) {
        this.lastFluxPct = fluxPct;
        this.cachedFluxStr = `FLUX ${fluxPct}%`;
      }
      ctx.fillStyle = '#ff7ae5';
      ctx.fillText(this.cachedFluxStr, rightX, cy + 12);
    }

    // ------------------------------------------------------------------
    // 5. 3D-PROJECTED BANDIT DIAMONDS, OFF-BORESIGHT CHEVRONS & GUN PIPPER
    // ------------------------------------------------------------------
    camera.updateMatrixWorld();

    // Determine active bandit for lead-computing gun pipper (prefer locked target, else nearest alive)
    let activeBandit: FighterJet | null = lockedTarget && lockedTarget.alive ? lockedTarget : null;
    let nearestDistSq = Infinity;
    if (!activeBandit) {
      for (let i = 0; i < bandits.length; i++) {
        const b = bandits[i];
        if (!b.alive) continue;
        const dSq = b.group.position.distanceToSquared(hero.group.position);
        if (dSq < nearestDistSq && dSq < 1350 * 1350) {
          nearestDistSq = dSq;
          activeBandit = b;
        }
      }
    }

    const edgeMarginX = Math.max(38, w * 0.046);
    const edgeMarginY = Math.max(58, h * 0.115);
    const halfBoundW = Math.max(40, cx - edgeMarginX);
    const halfBoundH = Math.max(40, cy - edgeMarginY);

    let activeScreenX = 0;
    let activeScreenY = 0;
    let activeOnScreen = false;

    for (let i = 0; i < bandits.length; i++) {
      const b = bandits[i];
      if (!b.alive) continue;

      const isLocked = b === lockedTarget;
      const dist = b.group.position.distanceTo(hero.group.position);
      const distTenths = Math.round((dist / 140) * 10);
      let labelCache = this.banditLabelCache[i];
      if (!labelCache) {
        const shortTag = b.role === 'ace' ? 'ACE' : b.callsign.replace('WRAITH-', 'W');
        const distKm = (distTenths * 0.1).toFixed(1);
        labelCache = {
          callsign: b.callsign,
          shortTag,
          distTenths,
          onScreenLabel: `${b.callsign} · ${distKm}KM`,
          offScreenLabel: `${shortTag} ${distKm}K`,
        };
        this.banditLabelCache[i] = labelCache;
      } else if (labelCache.callsign !== b.callsign || labelCache.distTenths !== distTenths) {
        if (labelCache.callsign !== b.callsign) {
          labelCache.callsign = b.callsign;
          labelCache.shortTag = b.role === 'ace' ? 'ACE' : b.callsign.replace('WRAITH-', 'W');
        }
        labelCache.distTenths = distTenths;
        const distKm = (distTenths * 0.1).toFixed(1);
        labelCache.onScreenLabel = `${b.callsign} · ${distKm}KM`;
        labelCache.offScreenLabel = `${labelCache.shortTag} ${distKm}K`;
      }

      const boxCol =
        isLocked && isMissileLocked
          ? 'rgba(255, 48, 86, 0.96)'
          : b.role === 'ace'
            ? 'rgba(255, 90, 210, 0.92)'
            : 'rgba(255, 190, 68, 0.88)';

      this.projVec.copy(b.group.position).project(camera);
      const inFront = this.projVec.z <= 1.0;
      const sx = (this.projVec.x * 0.5 + 0.5) * w;
      const sy = (-this.projVec.y * 0.5 + 0.5) * h;
      const inViewport = inFront && sx >= 28 && sx <= w - 28 && sy >= 36 && sy <= h - 42;

      if (inViewport) {
        if (b === activeBandit) {
          activeScreenX = sx;
          activeScreenY = sy;
          activeOnScreen = true;
        }

        ctx.strokeStyle = boxCol;
        ctx.fillStyle = boxCol;
        ctx.lineWidth = isLocked ? 2.0 : 1.3;

        const r = isLocked ? 18 + Math.sin(time * 18) * 2.5 : 12;
        ctx.beginPath();
        ctx.moveTo(sx, sy - r);
        ctx.lineTo(sx + r, sy);
        ctx.lineTo(sx, sy + r);
        ctx.lineTo(sx - r, sy);
        ctx.closePath();
        ctx.stroke();

        if (isLocked && isMissileLocked) {
          ctx.beginPath();
          ctx.arc(sx, sy, r + 6, time * 5, time * 5 + Math.PI * 1.4);
          ctx.stroke();
        }

        ctx.textAlign = 'center';
        ctx.fillText(labelCache.onScreenLabel, sx, sy - r - 7);
      } else {
        // Off-boresight edge-of-screen directional chevron arrow via camera-space vector
        this.camSpacePos.copy(b.group.position).applyMatrix4(camera.matrixWorldInverse);
        let dirX = this.camSpacePos.x;
        let dirY = -this.camSpacePos.y;
        const dirLen = Math.hypot(dirX, dirY);
        if (dirLen < 1e-4) {
          dirX = 0;
          dirY = -1;
        } else {
          dirX /= dirLen;
          dirY /= dirLen;
        }

        const scaleX = Math.abs(dirX) > 1e-4 ? halfBoundW / Math.abs(dirX) : Infinity;
        const scaleY = Math.abs(dirY) > 1e-4 ? halfBoundH / Math.abs(dirY) : Infinity;
        const edgeScale = Math.min(scaleX, scaleY);
        const ax = cx + dirX * edgeScale;
        const ay = cy + dirY * edgeScale;
        const angle = Math.atan2(dirY, dirX);

        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(angle);
        ctx.strokeStyle = boxCol;
        ctx.fillStyle = boxCol;
        ctx.lineWidth = isLocked || b.role === 'ace' ? 2.0 : 1.5;

        // Primary outer chevron
        ctx.beginPath();
        ctx.moveTo(9, 0);
        ctx.lineTo(-5, -6.5);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-5, 6.5);
        ctx.closePath();
        ctx.fill();

        // Trailing wing chevron for locked or Ace threat emphasis
        if (isLocked || b.role === 'ace') {
          ctx.beginPath();
          ctx.moveTo(-4, -8);
          ctx.lineTo(-11, -8);
          ctx.lineTo(-6.5, 0);
          ctx.lineTo(-11, 8);
          ctx.lineTo(-4, 8);
          ctx.stroke();
        }
        ctx.restore();

        // Inset compact distance/callsign tag toward screen centre so it stays inside bounds
        const labelX = ax - dirX * 26;
        const labelY = ay - dirY * 18 + 3;
        ctx.fillStyle = boxCol;
        ctx.textAlign = 'center';
        ctx.fillText(labelCache.offScreenLabel, labelX, labelY);
      }
    }

    // Lead-Computing Optical Sight (LCOS) gun pipper on the active bandit
    if (activeBandit && activeBandit.alive) {
      this.relPos.subVectors(activeBandit.group.position, hero.group.position);
      const targetDist = this.relPos.length();
      if (targetDist > 12 && targetDist < 1350) {
        this.relVel.subVectors(activeBandit.velocity, hero.velocity);
        let tof = THREE.MathUtils.clamp(targetDist / GUN_MUZZLE_SPEED, 0.04, 1.4);
        this.leadWorldPos.copy(activeBandit.group.position).addScaledVector(this.relVel, tof);
        const refinedDist = this.leadWorldPos.distanceTo(hero.group.position);
        tof = THREE.MathUtils.clamp(refinedDist / GUN_MUZZLE_SPEED, 0.04, 1.4);
        this.leadWorldPos.copy(activeBandit.group.position).addScaledVector(this.relVel, tof);

        this.leadProjVec.copy(this.leadWorldPos).project(camera);
        if (this.leadProjVec.z <= 1.0) {
          const lx = (this.leadProjVec.x * 0.5 + 0.5) * w;
          const ly = (-this.leadProjVec.y * 0.5 + 0.5) * h;

          if (lx >= 28 && lx <= w - 28 && ly >= 36 && ly <= h - 42) {
            const inGunEnvelope = targetDist < 560;
            const reticleDelta = Math.hypot(lx - cx, ly - cy);
            const onSolution = inGunEnvelope && reticleDelta < 46;
            const pipperCol = onSolution
              ? 'rgba(255, 72, 96, 0.96)'
              : inGunEnvelope
                ? 'rgba(255, 214, 72, 0.92)'
                : primary;

            // Faint dashed lead-angle tether connecting target diamond to LCOS gun pipper
            if (activeOnScreen && Math.hypot(lx - activeScreenX, ly - activeScreenY) > 16) {
              ctx.save();
              ctx.strokeStyle = faint;
              ctx.lineWidth = 1.0;
              ctx.setLineDash(LEAD_TETHER_DASH);
              ctx.beginPath();
              ctx.moveTo(activeScreenX, activeScreenY);
              ctx.lineTo(lx, ly);
              ctx.stroke();
              ctx.restore();
            }

            // LCOS pipper ring + range-closing arc + cardinal ticks + centre dot
            const pipperR = 14;
            const rangeFrac = THREE.MathUtils.clamp(1.0 - targetDist / 950, 0.12, 1.0);
            ctx.strokeStyle = faint;
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.arc(lx, ly, pipperR, 0, Math.PI * 2);
            ctx.stroke();

            ctx.strokeStyle = pipperCol;
            ctx.fillStyle = pipperCol;
            ctx.lineWidth = onSolution ? 2.1 : 1.6;
            ctx.beginPath();
            ctx.arc(lx, ly, pipperR, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * rangeFrac);
            ctx.stroke();

            // 4 micro cross ticks
            ctx.beginPath();
            ctx.moveTo(lx - pipperR - 4, ly);
            ctx.lineTo(lx - pipperR + 2, ly);
            ctx.moveTo(lx + pipperR - 2, ly);
            ctx.lineTo(lx + pipperR + 4, ly);
            ctx.moveTo(lx, ly - pipperR - 4);
            ctx.lineTo(lx, ly - pipperR + 2);
            ctx.moveTo(lx, ly + pipperR - 2);
            ctx.lineTo(lx, ly + pipperR + 4);
            ctx.stroke();

            // Crisp firing dot
            ctx.beginPath();
            ctx.arc(lx, ly, onSolution ? 2.6 : 2.0, 0, Math.PI * 2);
            ctx.fill();

            ctx.textAlign = 'center';
            ctx.fillText(onSolution ? 'SHOOT' : 'LEAD', lx, ly + pipperR + 13);
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // 6. CORNER RWR (RADAR WARNING RECEIVER) THREAT SCOPE
    // ------------------------------------------------------------------
    this.renderRwrScope(ctx, w, h, time, hero, bandits, lockedTarget, isMissileLocked, primary, faint, beatPulse);

    ctx.restore();
  }

  private renderRwrScope(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    time: number,
    hero: FighterJet,
    bandits: FighterJet[],
    lockedTarget: FighterJet | null,
    isMissileLocked: boolean,
    primary: string,
    faint: string,
    beatPulse: number,
  ): void {
    const r = Math.max(36, Math.min(54, Math.min(w, h) * 0.082));
    const marginX = Math.max(20, w * 0.032);
    const topOffset = Math.max(46, h * 0.082);
    const rx = w - marginX - r;
    const ry = topOffset + r;

    ctx.save();

    // Translucent dark phosphor backing disc
    ctx.fillStyle = 'rgba(4, 12, 18, 0.44)';
    ctx.beginPath();
    ctx.arc(rx, ry, r, 0, Math.PI * 2);
    ctx.fill();

    // Rotating phosphor sweep wedge
    const sweepAngle = (time * 2.1) % (Math.PI * 2);
    ctx.fillStyle = 'rgba(72, 255, 180, 0.08)';
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.arc(rx, ry, r - 1, sweepAngle - 0.55, sweepAngle);
    ctx.closePath();
    ctx.fill();

    // Outer & inner range rings (outer rim subtly breathes with beatPulse)
    ctx.strokeStyle = primary;
    ctx.lineWidth = 1.2 + beatPulse * 0.8;
    ctx.beginPath();
    ctx.arc(rx, ry, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = faint;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(rx, ry, r * 0.52, 0, Math.PI * 2);
    ctx.moveTo(rx - r, ry);
    ctx.lineTo(rx - r + 6, ry);
    ctx.moveTo(rx + r - 6, ry);
    ctx.lineTo(rx + r, ry);
    ctx.moveTo(rx, ry - r);
    ctx.lineTo(rx, ry - r + 6);
    ctx.moveTo(rx, ry + r - 6);
    ctx.lineTo(rx, ry + r);
    ctx.stroke();

    // Ownship miniature nose-up delta at scope centre
    ctx.strokeStyle = primary;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(rx, ry - 5);
    ctx.lineTo(rx + 4, ry + 4);
    ctx.lineTo(rx, ry + 2);
    ctx.lineTo(rx - 4, ry + 4);
    ctx.closePath();
    ctx.stroke();

    // Project alive bandits into ownship horizontal/forward radar plane (zero allocations)
    this.heroForward.set(0, 0, -1).applyQuaternion(hero.group.quaternion);
    this.heroRight.set(1, 0, 0).applyQuaternion(hero.group.quaternion);

    let threatCount = 0;
    const maxPlotR = r * 0.84;
    for (let i = 0; i < bandits.length; i++) {
      const b = bandits[i];
      if (!b.alive) continue;
      threatCount++;

      this.rwrOffset.subVectors(b.group.position, hero.group.position);
      const fwd = this.rwrOffset.dot(this.heroForward);
      const right = this.rwrOffset.dot(this.heroRight);
      const planarDist = Math.hypot(right, fwd);
      const normDist = Math.min(1, planarDist / RWR_MAX_RANGE);
      const dirR = planarDist > 1e-4 ? right / planarDist : 0;
      const dirF = planarDist > 1e-4 ? fwd / planarDist : 1;

      const bx = rx + dirR * normDist * maxPlotR;
      const by = ry - dirF * normDist * maxPlotR;
      const isLocked = b === lockedTarget;
      const isAce = b.role === 'ace';
      const threatCol =
        isLocked && isMissileLocked
          ? 'rgba(255, 52, 88, 0.98)'
          : isAce
            ? 'rgba(255, 96, 214, 0.95)'
            : 'rgba(255, 196, 70, 0.90)';

      // Lock vector line to locked threat
      if (isLocked) {
        ctx.strokeStyle = isMissileLocked ? 'rgba(255, 52, 88, 0.48)' : 'rgba(255, 196, 70, 0.34)';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }

      ctx.strokeStyle = threatCol;
      ctx.fillStyle = threatCol;
      ctx.lineWidth = isLocked || isAce ? 1.5 : 1.1;

      if (isAce) {
        const d = 4.2 + (isLocked ? Math.sin(time * 16) * 1.1 : 0);
        ctx.beginPath();
        ctx.moveTo(bx, by - d);
        ctx.lineTo(bx + d, by);
        ctx.lineTo(bx, by + d);
        ctx.lineTo(bx - d, by);
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(bx, by, isLocked ? 3.2 : 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Compact RWR status caption beneath scope
    if (threatCount !== this.lastRwrThreatCount) {
      this.lastRwrThreatCount = threatCount;
      this.cachedRwrStr = `RWR · ${threatCount} TRK`;
    }
    ctx.fillStyle = threatCount > 0 && isMissileLocked ? 'rgba(255, 58, 92, 0.95)' : primary;
    ctx.textAlign = 'center';
    ctx.font = RWR_FONT;
    ctx.fillText(this.cachedRwrStr, rx, ry + r + 13);

    ctx.restore();
  }
}
