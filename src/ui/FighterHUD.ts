import * as THREE from 'three';
import { FighterJet } from '../aircraft/FighterJet';

export class FighterHUD {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  public enabled = true;

  private readonly euler = new THREE.Euler();
  private readonly projVec = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  public resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
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
  ): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled) return;

    // Colour shifts subtly from military phosphor green -> chromatic neon cyan/magenta during LSD peak
    const hue = tripIntensity > 0.35 ? (152 + Math.sin(time * 2.4) * 95 * tripIntensity + 360) % 360 : 152;
    const primary = `hsla(${hue}, 96%, 64%, 0.84)`;
    const faint = `hsla(${hue}, 96%, 64%, 0.34)`;
    const alert = isMissileLocked ? 'rgba(255, 58, 92, 0.95)' : 'rgba(255, 196, 70, 0.88)';

    // Subtle psychedelic instrument jitter when trip > 0.5 ("Instruments are melting!")
    const glitchX = tripIntensity > 0.55 ? Math.sin(time * 41) * (tripIntensity - 0.55) * 4.5 : 0;
    const glitchY = tripIntensity > 0.55 ? Math.cos(time * 37) * (tripIntensity - 0.55) * 3.0 : 0;

    ctx.save();
    ctx.translate(glitchX, glitchY);
    ctx.strokeStyle = primary;
    ctx.fillStyle = primary;
    ctx.lineWidth = 1.4;
    ctx.font = '600 11px "SF Mono", "Fira Code", ui-monospace, monospace';

    const cx = w * 0.5;
    const cy = h * 0.5;

    // 1. Central Pitch Ladder & Flight Path Vector (tilts with Viper-1 roll)
    this.euler.setFromQuaternion(hero.group.quaternion, 'YXZ');
    const headingDeg = (((-this.euler.y * 180) / Math.PI) % 360 + 360) % 360;
    const pitchDeg = (this.euler.x * 180) / Math.PI;
    const rollRad = this.euler.z;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-rollRad * 0.65);

    // Pitch rungs
    ctx.strokeStyle = faint;
    for (let deg = -20; deg <= 20; deg += 10) {
      if (deg === 0) continue;
      const yOff = (pitchDeg - deg) * 4.5;
      if (Math.abs(yOff) > h * 0.24) continue;
      ctx.beginPath();
      ctx.moveTo(-64, yOff);
      ctx.lineTo(-26, yOff);
      ctx.moveTo(26, yOff);
      ctx.lineTo(64, yOff);
      ctx.stroke();
    }

    // Horizon line
    ctx.strokeStyle = primary;
    const horY = pitchDeg * 4.5;
    if (Math.abs(horY) < h * 0.26) {
      ctx.beginPath();
      ctx.moveTo(-110, horY);
      ctx.lineTo(-28, horY);
      ctx.moveTo(28, horY);
      ctx.lineTo(110, horY);
      ctx.stroke();
    }
    ctx.restore();

    // Central gun reticle / water-line pipper
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

    // 2. Top Heading Compass Tape
    const tapeW = Math.min(340, w * 0.42);
    const tapeY = Math.max(58, h * 0.085);
    ctx.strokeStyle = faint;
    ctx.beginPath();
    ctx.moveTo(cx - tapeW / 2, tapeY);
    ctx.lineTo(cx + tapeW / 2, tapeY);
    ctx.stroke();

    ctx.textAlign = 'center';
    for (let offset = -30; offset <= 30; offset += 10) {
      const degVal = Math.round((headingDeg + offset + 360) % 360);
      const tx = cx + (offset / 35) * (tapeW * 0.5);
      ctx.beginPath();
      ctx.moveTo(tx, tapeY - 5);
      ctx.lineTo(tx, tapeY + 4);
      ctx.stroke();
      ctx.fillText(String(degVal).padStart(3, '0'), tx, tapeY - 9);
    }

    // Current heading readout box
    ctx.strokeStyle = primary;
    ctx.strokeRect(cx - 22, tapeY + 7, 44, 18);
    ctx.fillText(String(Math.round(headingDeg)).padStart(3, '0'), cx, tapeY + 20);

    // 3. Left Airspeed / Mach / G-Force Telemetry Column
    const leftX = Math.max(28, w * 0.045);
    const mach = (hero.speed / 128).toFixed(2);
    const knots = Math.round(hero.speed * 3.4);
    const altFt = Math.max(0, Math.round(hero.group.position.y * 28));

    ctx.textAlign = 'left';
    ctx.fillStyle = primary;
    ctx.fillText(`IAS  ${knots} KT`, leftX, cy - 42);
    ctx.fillText(`MACH ${mach}`, leftX, cy - 24);
    ctx.fillText(`G    +${hero.gForce.toFixed(1)}`, leftX, cy - 6);
    ctx.fillText(`THR  ${Math.round(hero.throttle * 100)}% AB`, leftX, cy + 12);
    if (timeScale < 0.7) {
      ctx.fillStyle = '#ff66dd';
      ctx.fillText(`TIME ${(timeScale * 100).toFixed(0)}% BULLET`, leftX, cy + 32);
    }

    // 4. Right Altitude / Weapons / Camera Tag Column
    const rightX = w - Math.max(28, w * 0.045);
    ctx.textAlign = 'right';
    ctx.fillStyle = primary;
    ctx.fillText(`ALT  ${altFt.toLocaleString()} FT`, rightX, cy - 42);
    ctx.fillText(`WPN  ${isMissileLocked ? 'AIM-9X PRISM' : 'M61A1 VULCAN'}`, rightX, cy - 24);
    ctx.fillStyle = alert;
    ctx.fillText(`CAM: ${cameraTag}`, rightX, cy - 6);
    if (isMissileLocked) {
      ctx.fillStyle = 'rgba(255, 58, 92, 0.95)';
      ctx.fillText('LOCK: SHOOT', rightX, cy + 30);
    }
    if (tripIntensity > 0.2) {
      ctx.fillStyle = '#ff7ae5';
      ctx.fillText(`FLUX ${Math.round(tripIntensity * 100)}%`, rightX, cy + 12);
    }

    // 5. 3D-Projected Bandit Target Diamonds
    camera.updateMatrixWorld();
    for (const b of bandits) {
      if (!b.alive) continue;
      this.projVec.copy(b.group.position).project(camera);
      if (this.projVec.z > 1) continue; // Behind camera

      const sx = (this.projVec.x * 0.5 + 0.5) * w;
      const sy = (-this.projVec.y * 0.5 + 0.5) * h;
      if (sx < 24 || sx > w - 24 || sy < 24 || sy > h - 24) continue;

      const isLocked = b === lockedTarget;
      const distKm = (b.group.position.distanceTo(hero.group.position) / 140).toFixed(1);
      const boxCol = isLocked && isMissileLocked ? 'rgba(255, 48, 86, 0.96)' : b.role === 'ace' ? 'rgba(255, 90, 210, 0.92)' : 'rgba(255, 190, 68, 0.86)';

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
        // Rotating inner lock bracket
        ctx.beginPath();
        ctx.arc(sx, sy, r + 6, time * 5, time * 5 + Math.PI * 1.4);
        ctx.stroke();
      }

      ctx.textAlign = 'center';
      ctx.fillText(`${b.callsign} · ${distKm}KM`, sx, sy - r - 7);
    }

    ctx.restore();
  }
}
