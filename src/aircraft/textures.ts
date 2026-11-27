import * as THREE from 'three';

export interface HullTextureSet {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function createSeededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Generates weathered aerospace PBR textures (albedo, bump, roughness)
 * with panel seams, flush rivets, carbon-fibre wear, and squadron markings.
 */
export function createHullTextureSet(variant: 'hero' | 'bandit' | 'ace'): HullTextureSet {
  const size = 1024;
  const rand = createSeededRandom(variant === 'hero' ? 1986 : variant === 'ace' ? 6661 : 4047);

  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = size;
  albedoCanvas.height = size;
  const aCtx = albedoCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = size;
  roughCanvas.height = size;
  const rCtx = roughCanvas.getContext('2d')!;

  // Base metallic skin fill
  const baseGrad = aCtx.createLinearGradient(0, 0, size, size);
  if (variant === 'hero') {
    baseGrad.addColorStop(0, '#96a5b6');
    baseGrad.addColorStop(0.5, '#7e8e9f');
    baseGrad.addColorStop(1, '#687788');
  } else if (variant === 'ace') {
    baseGrad.addColorStop(0, '#1e2028');
    baseGrad.addColorStop(0.5, '#121319');
    baseGrad.addColorStop(1, '#22151c');
  } else {
    baseGrad.addColorStop(0, '#2a2e38');
    baseGrad.addColorStop(0.5, '#1d2029');
    baseGrad.addColorStop(1, '#26242c');
  }
  aCtx.fillStyle = baseGrad;
  aCtx.fillRect(0, 0, size, size);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  rCtx.fillStyle = variant === 'hero' ? '#585858' : variant === 'ace' ? '#464646' : '#646464';
  rCtx.fillRect(0, 0, size, size);

  // Subtle tonal panel variation
  const cols = 8;
  const rows = 12;
  const pw = size / cols;
  const ph = size / rows;

  for (let gx = 0; gx < cols; gx++) {
    for (let gy = 0; gy < rows; gy++) {
      const x = gx * pw;
      const y = gy * ph;
      const toneDelta = (rand() - 0.5) * 18;
      const alpha = 0.14 + rand() * 0.1;
      aCtx.fillStyle = toneDelta > 0
        ? `rgba(255, 255, 255, ${alpha * 0.45})`
        : `rgba(0, 0, 0, ${alpha * 0.55})`;
      aCtx.fillRect(x + 2, y + 2, pw - 4, ph - 4);

      // Roughness patch variation per composite tile
      const rVal = Math.floor((variant === 'hero' ? 75 : 68) + (rand() - 0.5) * 42);
      rCtx.fillStyle = `rgb(${rVal},${rVal},${rVal})`;
      rCtx.fillRect(x + 2, y + 2, pw - 4, ph - 4);

      // Slightly raised panel bump
      const bVal = Math.floor(128 + (rand() - 0.5) * 18);
      bCtx.fillStyle = `rgb(${bVal},${bVal},${bVal})`;
      bCtx.fillRect(x + 2, y + 2, pw - 4, ph - 4);
    }
  }

  // Airflow weathering streaks along fuselage axis
  for (let i = 0; i < 420; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 24 + rand() * 140;
    const w = 1 + rand() * 3;
    aCtx.fillStyle = rand() > 0.5
      ? `rgba(12, 16, 22, ${0.04 + rand() * 0.08})`
      : `rgba(220, 235, 255, ${0.03 + rand() * 0.05})`;
    aCtx.fillRect(x, y, w, len);
  }

  // Squadron accent livery stripes & hazard stencils
  if (variant === 'hero') {
    aCtx.fillStyle = 'rgba(255, 168, 38, 0.85)';
    aCtx.fillRect(0, size * 0.18, size, 16);
    aCtx.fillStyle = 'rgba(20, 28, 40, 0.88)';
    aCtx.fillRect(0, size * 0.18 + 18, size, 9);
    aCtx.fillStyle = 'rgba(0, 220, 255, 0.45)';
    aCtx.fillRect(0, size * 0.82, size, 8);
  } else if (variant === 'ace') {
    aCtx.fillStyle = 'rgba(235, 24, 58, 0.92)';
    aCtx.fillRect(0, size * 0.22, size, 22);
    aCtx.fillStyle = 'rgba(255, 195, 65, 0.78)';
    aCtx.fillRect(0, size * 0.22 + 26, size, 6);
  } else {
    aCtx.fillStyle = 'rgba(195, 28, 45, 0.82)';
    aCtx.fillRect(0, size * 0.26, size, 12);
  }

  // Deep recessed panel seam lines & flush rivets
  aCtx.strokeStyle = 'rgba(6, 10, 16, 0.72)';
  aCtx.lineWidth = 2;
  bCtx.strokeStyle = '#202020';
  bCtx.lineWidth = 2.5;
  rCtx.strokeStyle = '#c8c8c8';
  rCtx.lineWidth = 2;

  for (let gx = 0; gx <= cols; gx++) {
    const x = gx * pw;
    for (const ctx of [aCtx, bCtx, rCtx]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
  }
  for (let gy = 0; gy <= rows; gy++) {
    const y = gy * ph;
    for (const ctx of [aCtx, bCtx, rCtx]) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
  }

  // Rivet rows along seams
  for (let gy = 0; gy < rows; gy++) {
    const y = gy * ph + 6;
    for (let rx = 8; rx < size; rx += 16) {
      bCtx.fillStyle = '#484848';
      bCtx.fillRect(rx, y, 2, 2);
      aCtx.fillStyle = 'rgba(0,0,0,0.28)';
      aCtx.fillRect(rx, y, 2, 2);
    }
  }

  // Service hatches & warning triangles
  for (let i = 0; i < 14; i++) {
    const hx = Math.floor(rand() * cols) * pw + 18;
    const hy = Math.floor(rand() * rows) * ph + 14;
    aCtx.strokeStyle = 'rgba(255, 190, 60, 0.55)';
    aCtx.lineWidth = 1.5;
    aCtx.strokeRect(hx, hy, 26, 16);
    bCtx.strokeStyle = '#323232';
    bCtx.strokeRect(hx, hy, 26, 16);
  }

  const configureTex = (canvas: HTMLCanvasElement, isColor: boolean): THREE.CanvasTexture => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
    tex.anisotropy = 8;
    if (isColor) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.needsUpdate = true;
    return tex;
  };

  return {
    map: configureTex(albedoCanvas, true),
    bumpMap: configureTex(bumpCanvas, false),
    roughnessMap: configureTex(roughCanvas, false),
  };
}

/**
 * Generates a soft volumetric cloud puff radial sprite texture.
 */
export function createCloudTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = createSeededRandom(7731);

  ctx.clearRect(0, 0, size, size);

  // Layered soft organic puffs
  for (let i = 0; i < 18; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = rand() * size * 0.22;
    const cx = size * 0.5 + Math.cos(angle) * dist;
    const cy = size * 0.5 + Math.sin(angle) * dist * 0.85;
    const r = size * (0.22 + rand() * 0.22);

    const grad = ctx.createRadialGradient(cx, cy, r * 0.08, cx, cy, r);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
    grad.addColorStop(0.55, 'rgba(235, 240, 250, 0.14)');
    grad.addColorStop(1, 'rgba(210, 220, 235, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a glowing radial flare / spark sprite texture.
 */
export function createGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.18, 'rgba(255, 245, 215, 0.92)');
  grad.addColorStop(0.45, 'rgba(255, 165, 65, 0.35)');
  grad.addColorStop(1, 'rgba(255, 80, 10, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
