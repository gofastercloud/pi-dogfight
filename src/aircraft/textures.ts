import * as THREE from 'three';

export type HullVariant = 'hero' | 'bandit' | 'ace';

export interface HullTextureSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  metalnessMap: THREE.CanvasTexture;
  aoMap: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture;
}

const hullTextureCache: Partial<Record<HullVariant, HullTextureSet>> = {};

function createSeededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function createCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  return [canvas, ctx];
}

/**
 * Computes a true tangent-space normal map from a greyscale height canvas
 * using a seamless toroidal 3×3 Sobel filter.
 */
function buildSobelNormalCanvas(
  heightCtx: CanvasRenderingContext2D,
  size: number,
  strength: number,
): HTMLCanvasElement {
  const [normalCanvas, nCtx] = createCanvas(size);
  const src = heightCtx.getImageData(0, 0, size, size).data;
  const outImg = nCtx.createImageData(size, size);
  const dst = outImg.data;
  const mask = size - 1; // size is 2048 (power of two)
  const inv255 = strength / 255;

  for (let y = 0; y < size; y++) {
    const yUp = ((y - 1) & mask) * size;
    const yMid = y * size;
    const yDn = ((y + 1) & mask) * size;

    for (let x = 0; x < size; x++) {
      const xLt = (x - 1) & mask;
      const xRt = (x + 1) & mask;

      const tl = src[(yUp + xLt) << 2];
      const tc = src[(yUp + x) << 2];
      const tr = src[(yUp + xRt) << 2];
      const ml = src[(yMid + xLt) << 2];
      const mr = src[(yMid + xRt) << 2];
      const bl = src[(yDn + xLt) << 2];
      const bc = src[(yDn + x) << 2];
      const br = src[(yDn + xRt) << 2];

      // 3×3 Sobel gradients (gx right, gy down -> flip gy for OpenGL +Y up)
      const gx = (tr + 2 * mr + br - (tl + 2 * ml + bl)) * inv255;
      const gy = (bl + 2 * bc + br - (tl + 2 * tc + tr)) * inv255;

      const nx = -gx;
      const ny = gy;
      const nz = 1.0;
      const invLen = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);

      const outIdx = (yMid + x) << 2;
      dst[outIdx] = (nx * invLen * 0.5 + 0.5) * 255;
      dst[outIdx + 1] = (ny * invLen * 0.5 + 0.5) * 255;
      dst[outIdx + 2] = (nz * invLen * 0.5 + 0.5) * 255;
      dst[outIdx + 3] = 255;
    }
  }

  nCtx.putImageData(outImg, 0, 0);
  return normalCanvas;
}

/**
 * Draws a stealth serrated (sawtooth) RAM access panel border into a 2D context.
 */
function traceSawtoothRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  toothW: number,
  toothH: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x, y);

  // Top serrated edge
  const topSteps = Math.max(2, Math.floor(w / toothW));
  const stepX = w / topSteps;
  for (let i = 0; i < topSteps; i++) {
    ctx.lineTo(x + (i + 0.5) * stepX, y - toothH);
    ctx.lineTo(x + (i + 1) * stepX, y);
  }

  // Right edge
  ctx.lineTo(x + w, y + h);

  // Bottom serrated edge
  for (let i = topSteps - 1; i >= 0; i--) {
    ctx.lineTo(x + (i + 0.5) * stepX, y + h + toothH);
    ctx.lineTo(x + i * stepX, y + h);
  }

  ctx.closePath();
}

/**
 * Generates and caches crisp 2048×2048 procedural aerospace PBR texture sets
 * (albedo, Sobel tangent-space normal, roughness, metalness, AO, and emissive
 * formation lights / stealth seam accents) per aircraft role.
 */
export function createHullTextureSet(variant: HullVariant): HullTextureSet {
  const cached = hullTextureCache[variant];
  if (cached) {
    return cached;
  }

  const size = 2048;
  const rand = createSeededRandom(variant === 'hero' ? 198601 : variant === 'ace' ? 666109 : 404723);

  const [albedoCanvas, aCtx] = createCanvas(size);
  const [heightCanvas, hCtx] = createCanvas(size);
  const [roughCanvas, rCtx] = createCanvas(size);
  const [metalCanvas, mCtx] = createCanvas(size);
  const [aoCanvas, aoCtx] = createCanvas(size);
  const [emissiveCanvas, eCtx] = createCanvas(size);

  // ------------------------------------------------------------------
  // 1. BASE METALLIC / STEALTH RAM SKIN FILL
  // ------------------------------------------------------------------
  // Note: CanvasTexture has flipY=true, so y=0 maps to v=1 (aft tail/exhaust)
  // and y=size maps to v=0 (forward radome nose).
  const baseGrad = aCtx.createLinearGradient(0, 0, 0, size);
  if (variant === 'hero') {
    baseGrad.addColorStop(0.0, '#626f7d'); // aft titanium nacelle
    baseGrad.addColorStop(0.18, '#7a8a9c');
    baseGrad.addColorStop(0.55, '#8c9cad'); // air-superiority Have Glass grey-silver
    baseGrad.addColorStop(0.86, '#758596');
    baseGrad.addColorStop(1.0, '#444c58'); // composite radar-transparent radome tip
  } else if (variant === 'ace') {
    baseGrad.addColorStop(0.0, '#1f1820');
    baseGrad.addColorStop(0.18, '#171821');
    baseGrad.addColorStop(0.55, '#12131b'); // deep satin obsidian carbon
    baseGrad.addColorStop(0.88, '#1a1a24');
    baseGrad.addColorStop(1.0, '#26141c');
  } else {
    baseGrad.addColorStop(0.0, '#272a34');
    baseGrad.addColorStop(0.22, '#222631');
    baseGrad.addColorStop(0.6, '#1c202a'); // radar-absorbent slate-graphite
    baseGrad.addColorStop(0.9, '#242732');
    baseGrad.addColorStop(1.0, '#191b22');
  }
  aCtx.fillStyle = baseGrad;
  aCtx.fillRect(0, 0, size, size);

  hCtx.fillStyle = '#808080';
  hCtx.fillRect(0, 0, size, size);

  rCtx.fillStyle = variant === 'hero' ? '#666666' : variant === 'ace' ? '#4a4a4a' : '#747474';
  rCtx.fillRect(0, 0, size, size);

  mCtx.fillStyle = variant === 'hero' ? '#c8c8c8' : variant === 'ace' ? '#b0b0b0' : '#969696';
  mCtx.fillRect(0, 0, size, size);

  aoCtx.fillStyle = '#ffffff';
  aoCtx.fillRect(0, 0, size, size);

  eCtx.fillStyle = '#000000';
  eCtx.fillRect(0, 0, size, size);

  // ------------------------------------------------------------------
  // 2. NON-UNIFORM STRUCTURAL AEROSPACE SKIN PANELS
  // ------------------------------------------------------------------
  const xSplits = [0, 140, 320, 512, 720, 910, 1024, 1138, 1328, 1536, 1728, 1908, 2048];
  const ySplits = [
    0, 130, 280, 440, 610, 770, 920, 1080, 1230, 1390, 1540, 1690, 1840, 1960, 2048,
  ];

  for (let gx = 0; gx < xSplits.length - 1; gx++) {
    for (let gy = 0; gy < ySplits.length - 1; gy++) {
      const x = xSplits[gx];
      const y = ySplits[gy];
      const pw = xSplits[gx + 1] - x;
      const ph = ySplits[gy + 1] - y;

      const tone = (rand() - 0.5) * 24;
      const alpha = 0.08 + rand() * 0.14;
      aCtx.fillStyle =
        tone > 0 ? `rgba(240, 248, 255, ${alpha * 0.55})` : `rgba(8, 12, 18, ${alpha * 0.65})`;
      aCtx.fillRect(x + 3, y + 3, pw - 6, ph - 6);

      // Subtle dielectric RAM tape halo around select stealth panels
      if (rand() > 0.52) {
        aCtx.strokeStyle =
          variant === 'hero' ? 'rgba(192, 206, 222, 0.16)' : 'rgba(92, 98, 116, 0.15)';
        aCtx.lineWidth = 10;
        aCtx.strokeRect(x + 7, y + 7, pw - 14, ph - 14);
      }

      // Per-panel calibrated roughness & metalness variation
      const baseR = variant === 'hero' ? 92 : variant === 'ace' ? 68 : 112;
      const rVal = Math.max(36, Math.min(210, Math.floor(baseR + (rand() - 0.5) * 48)));
      rCtx.fillStyle = `rgb(${rVal},${rVal},${rVal})`;
      rCtx.fillRect(x + 3, y + 3, pw - 6, ph - 6);

      const baseM = variant === 'hero' ? 198 : variant === 'ace' ? 172 : 142;
      const mVal = Math.max(70, Math.min(242, Math.floor(baseM + (rand() - 0.5) * 52)));
      mCtx.fillStyle = `rgb(${mVal},${mVal},${mVal})`;
      mCtx.fillRect(x + 3, y + 3, pw - 6, ph - 6);

      // Subtle stamped plate height offset for crisp Sobel specular break-up
      const hVal = Math.floor(128 + (rand() - 0.5) * 20);
      hCtx.fillStyle = `rgb(${hVal},${hVal},${hVal})`;
      hCtx.fillRect(x + 3, y + 3, pw - 6, ph - 6);
    }
  }

  // ------------------------------------------------------------------
  // 3. MICRO BRUSHED TITANIUM / COMPOSITE GRAIN ALONG AIRFLOW AXIS
  // ------------------------------------------------------------------
  for (let i = 0; i < 1600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 32 + rand() * 190;
    const w = 1 + rand() * 2.2;
    const bright = rand() > 0.48;
    aCtx.fillStyle = bright
      ? `rgba(225, 238, 255, ${0.015 + rand() * 0.03})`
      : `rgba(6, 10, 16, ${0.025 + rand() * 0.05})`;
    aCtx.fillRect(x, y, w, len);

    const gh = bright ? 136 : 120;
    hCtx.fillStyle = `rgba(${gh},${gh},${gh},0.22)`;
    hCtx.fillRect(x, y, 1.5, len * 0.65);

    const gr = bright ? 72 : 125;
    rCtx.fillStyle = `rgba(${gr},${gr},${gr},0.18)`;
    rCtx.fillRect(x, y, w, len);
  }

  // ------------------------------------------------------------------
  // 4. HEAT-SCORCHED AFT TITANIUM EXHAUST ZONE (y = 0..310 -> v = 0.85..1.0)
  // ------------------------------------------------------------------
  const scorchH = 310;
  const heatGrad = aCtx.createLinearGradient(0, 0, 0, scorchH);
  if (variant === 'hero') {
    heatGrad.addColorStop(0.0, 'rgba(32, 30, 38, 0.92)'); // dark exhaust soot at lip
    heatGrad.addColorStop(0.24, 'rgba(58, 72, 112, 0.78)'); // thermally blued titanium
    heatGrad.addColorStop(0.48, 'rgba(138, 104, 72, 0.62)'); // straw-gold annealed alloy
    heatGrad.addColorStop(0.72, 'rgba(92, 86, 98, 0.36)'); // warm violet-grey fade
    heatGrad.addColorStop(1.0, 'rgba(92, 98, 108, 0.0)');
  } else {
    heatGrad.addColorStop(0.0, 'rgba(20, 14, 18, 0.94)');
    heatGrad.addColorStop(0.28, 'rgba(72, 34, 62, 0.72)'); // heat-blued crimson-violet titanium
    heatGrad.addColorStop(0.55, 'rgba(128, 78, 48, 0.48)'); // scorched bronze
    heatGrad.addColorStop(1.0, 'rgba(28, 28, 36, 0.0)');
  }
  aCtx.fillStyle = heatGrad;
  aCtx.fillRect(0, 0, size, scorchH);

  // Polished high-metalness / low-roughness bare titanium aft band
  const aftMetalGrad = mCtx.createLinearGradient(0, 0, 0, scorchH);
  aftMetalGrad.addColorStop(0.0, 'rgba(242, 242, 242, 0.95)');
  aftMetalGrad.addColorStop(0.65, 'rgba(232, 232, 232, 0.75)');
  aftMetalGrad.addColorStop(1.0, 'rgba(220, 220, 220, 0.0)');
  mCtx.fillStyle = aftMetalGrad;
  mCtx.fillRect(0, 0, size, scorchH);

  const aftRoughGrad = rCtx.createLinearGradient(0, 0, 0, scorchH);
  aftRoughGrad.addColorStop(0.0, 'rgba(56, 56, 56, 0.88)');
  aftRoughGrad.addColorStop(0.65, 'rgba(68, 68, 68, 0.65)');
  aftRoughGrad.addColorStop(1.0, 'rgba(80, 80, 80, 0.0)');
  rCtx.fillStyle = aftRoughGrad;
  rCtx.fillRect(0, 0, size, scorchH);

  // Aft titanium thermal expansion ribs & soot streaks
  for (let i = 0; i < 64; i++) {
    const sx = (i / 64) * size;
    aCtx.fillStyle = i % 2 === 0 ? 'rgba(10, 8, 12, 0.28)' : 'rgba(195, 165, 118, 0.14)';
    aCtx.fillRect(sx, 0, 4, scorchH * (0.45 + rand() * 0.45));
    hCtx.fillStyle = i % 2 === 0 ? '#686868' : '#9c9c9c';
    hCtx.fillRect(sx, 0, 3, scorchH * 0.72);
  }

  // ------------------------------------------------------------------
  // 5. SQUADRON LIVERY STRIPES, SAWTOOTH RAM HATCHES & STENCILS
  // ------------------------------------------------------------------
  if (variant === 'hero') {
    // VIPER-1 iconic amber-gold + dark gunmetal interceptor bands
    aCtx.fillStyle = 'rgba(248, 164, 34, 0.88)';
    aCtx.fillRect(0, size * 0.23, size, 28);
    aCtx.fillStyle = 'rgba(22, 28, 38, 0.90)';
    aCtx.fillRect(0, size * 0.23 + 32, size, 16);
    aCtx.fillStyle = 'rgba(248, 164, 34, 0.72)';
    aCtx.fillRect(0, size * 0.23 + 52, size, 7);

    // Subtle forward anti-glare charcoal deck strip around cockpit/nose band
    aCtx.fillStyle = 'rgba(24, 30, 40, 0.56)';
    aCtx.fillRect(0, size * 0.71, size, 18);
    rCtx.fillStyle = '#b4b4b4';
    rCtx.fillRect(0, size * 0.71, size, 18);
  } else if (variant === 'ace') {
    // CRIMSON-1 dramatic scarlet + gold Ace interceptor stripes
    aCtx.fillStyle = 'rgba(236, 20, 56, 0.94)';
    aCtx.fillRect(0, size * 0.25, size, 38);
    aCtx.fillStyle = 'rgba(12, 12, 16, 0.92)';
    aCtx.fillRect(0, size * 0.25 + 42, size, 14);
    aCtx.fillStyle = 'rgba(255, 196, 56, 0.88)';
    aCtx.fillRect(0, size * 0.25 + 58, size, 11);

    // Secondary aft crimson chevron trim
    aCtx.fillStyle = 'rgba(218, 22, 54, 0.78)';
    aCtx.fillRect(0, size * 0.64, size, 18);
  } else {
    // WRAITH dark crimson tactical squadron stripe
    aCtx.fillStyle = 'rgba(196, 26, 46, 0.86)';
    aCtx.fillRect(0, size * 0.27, size, 22);
    aCtx.fillStyle = 'rgba(16, 18, 24, 0.88)';
    aCtx.fillRect(0, size * 0.27 + 26, size, 10);
  }

  // Sawtooth stealth maintenance hatches (iconic 5th-gen detail)
  for (let i = 0; i < 22; i++) {
    const hx = 60 + Math.floor(rand() * 14) * 136;
    const hy = 350 + Math.floor(rand() * 10) * 152;
    const hw = 78 + Math.floor(rand() * 54);
    const hh = 56 + Math.floor(rand() * 44);

    // Slightly different metallic tone inside hatch
    aCtx.save();
    traceSawtoothRect(aCtx, hx, hy, hw, hh, 16, 7);
    aCtx.fillStyle =
      variant === 'hero' ? 'rgba(124, 140, 158, 0.26)' : 'rgba(42, 46, 58, 0.34)';
    aCtx.fill();
    aCtx.strokeStyle = 'rgba(8, 12, 18, 0.82)';
    aCtx.lineWidth = 2.5;
    aCtx.stroke();
    aCtx.restore();

    // Recessed sawtooth seam in height, AO, roughness, metalness
    for (const [ctx, stroke, lw] of [
      [hCtx, '#242424', 3.5],
      [aoCtx, '#787878', 6.5],
      [rCtx, '#d4d4d4', 3.0],
      [mCtx, '#303030', 3.0],
    ] as const) {
      traceSawtoothRect(ctx, hx, hy, hw, hh, 16, 7);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }

    // Subtle elevated reinforcement plate inside some hatches
    if (i % 3 === 0) {
      hCtx.fillStyle = '#9c9c9c';
      hCtx.fillRect(hx + 10, hy + 10, hw - 20, hh - 20);
      // Cooling louver slats
      for (let ly = hy + 16; ly < hy + hh - 14; ly += 8) {
        hCtx.fillStyle = '#383838';
        hCtx.fillRect(hx + 16, ly, hw - 32, 3);
        hCtx.fillStyle = '#c4c4c4';
        hCtx.fillRect(hx + 16, ly + 3, hw - 32, 2);
        aCtx.fillStyle = 'rgba(6, 9, 14, 0.58)';
        aCtx.fillRect(hx + 16, ly, hw - 32, 3);
        aoCtx.fillStyle = '#686868';
        aoCtx.fillRect(hx + 16, ly, hw - 32, 4);
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. DEEP PANEL SEAM LINES, CREVICE AO & COUNTERSUNK RIVET ROWS
  // ------------------------------------------------------------------
  // Soft AO halo along all structural seams first
  aoCtx.strokeStyle = 'rgba(95, 95, 95, 0.65)';
  aoCtx.lineWidth = 10;
  for (let i = 0; i < xSplits.length; i++) {
    aoCtx.beginPath();
    aoCtx.moveTo(xSplits[i], 0);
    aoCtx.lineTo(xSplits[i], size);
    aoCtx.stroke();
  }
  for (let i = 0; i < ySplits.length; i++) {
    aoCtx.beginPath();
    aoCtx.moveTo(0, ySplits[i]);
    aoCtx.lineTo(size, ySplits[i]);
    aoCtx.stroke();
  }

  // Crisp recessed panel grooves
  const seamTargets: [CanvasRenderingContext2D, string, number][] = [
    [aCtx, 'rgba(6, 10, 16, 0.80)', 2.8],
    [hCtx, '#181818', 3.6],
    [rCtx, '#dcdcdc', 3.2],
    [mCtx, '#242424', 3.0],
    [aoCtx, '#4c4c4c', 3.5],
  ];

  for (const [ctx, stroke, lw] of seamTargets) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    for (let i = 0; i < xSplits.length; i++) {
      const x = xSplits[i];
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
    for (let i = 0; i < ySplits.length; i++) {
      const y = ySplits[i];
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
  }

  // Subtle bright machined bevel highlight beside primary seams in height & albedo
  hCtx.strokeStyle = 'rgba(164, 164, 164, 0.55)';
  hCtx.lineWidth = 1.6;
  for (let i = 1; i < xSplits.length - 1; i++) {
    hCtx.beginPath();
    hCtx.moveTo(xSplits[i] + 3, 0);
    hCtx.lineTo(xSplits[i] + 3, size);
    hCtx.stroke();
  }
  for (let i = 1; i < ySplits.length - 1; i++) {
    hCtx.beginPath();
    hCtx.moveTo(0, ySplits[i] + 3);
    hCtx.lineTo(size, ySplits[i] + 3);
    hCtx.stroke();
  }

  // Countersunk flush rivets flanking every structural bulkhead & stringer
  const drawRivet = (rx: number, ry: number) => {
    // Dark recessed centre dimple in height + slight countersink lip -> sharp Sobel ring
    hCtx.fillStyle = '#303030';
    hCtx.fillRect(rx - 1.5, ry - 1.5, 3, 3);
    hCtx.fillStyle = '#9a9a9a';
    hCtx.fillRect(rx - 2, ry - 2, 1, 1);

    aCtx.fillStyle = 'rgba(10, 14, 20, 0.42)';
    aCtx.fillRect(rx - 1.5, ry - 1.5, 3, 3);
    aoCtx.fillStyle = '#888888';
    aoCtx.fillRect(rx - 2, ry - 2, 4, 4);
    rCtx.fillStyle = '#c4c4c4';
    rCtx.fillRect(rx - 1.5, ry - 1.5, 3, 3);
  };

  for (let i = 1; i < ySplits.length - 1; i++) {
    const y = ySplits[i];
    for (let rx = 12; rx < size; rx += 22) {
      drawRivet(rx, y - 9);
      drawRivet(rx, y + 9);
    }
  }
  for (let i = 1; i < xSplits.length - 1; i++) {
    const x = xSplits[i];
    for (let ry = 14; ry < size; ry += 26) {
      drawRivet(x - 9, ry);
      drawRivet(x + 9, ry);
    }
  }

  // ------------------------------------------------------------------
  // 7. AERODYNAMIC OIL / HYDRAULIC WEATHERING STREAKS FROM SEAMS
  // ------------------------------------------------------------------
  // Airflow travels nose (high Y) -> tail (low Y), so streaks trail upward in canvas Y!
  for (let i = 0; i < 650; i++) {
    const seamY = ySplits[1 + Math.floor(rand() * (ySplits.length - 2))];
    const sx = rand() * size;
    const len = 28 + rand() * 155;
    const w = 1.2 + rand() * 4.5;
    const grad = aCtx.createLinearGradient(sx, seamY, sx, seamY - len);
    grad.addColorStop(0, `rgba(10, 12, 16, ${0.14 + rand() * 0.16})`);
    grad.addColorStop(0.55, `rgba(14, 18, 24, ${0.06 + rand() * 0.08})`);
    grad.addColorStop(1, 'rgba(14, 18, 24, 0.0)');
    aCtx.fillStyle = grad;
    aCtx.fillRect(sx, seamY - len, w, len);

    const rGrad = rCtx.createLinearGradient(sx, seamY, sx, seamY - len);
    rGrad.addColorStop(0, 'rgba(165, 165, 165, 0.32)');
    rGrad.addColorStop(1, 'rgba(165, 165, 165, 0.0)');
    rCtx.fillStyle = rGrad;
    rCtx.fillRect(sx, seamY - len, w, len);
  }

  // ------------------------------------------------------------------
  // 8. SQUADRON STENCILS, INSIGNIA & HAZARD MARKINGS
  // ------------------------------------------------------------------
  aCtx.save();
  aCtx.textBaseline = 'middle';
  aCtx.textAlign = 'center';

  const stencilPrimary =
    variant === 'hero'
      ? 'rgba(232, 240, 248, 0.72)'
      : variant === 'ace'
        ? 'rgba(255, 72, 96, 0.85)'
        : 'rgba(205, 58, 72, 0.72)';
  const stencilWarn =
    variant === 'hero' ? 'rgba(255, 192, 48, 0.78)' : 'rgba(255, 64, 82, 0.82)';

  const callsignLabel =
    variant === 'hero' ? 'VIPER-1' : variant === 'ace' ? 'CRIMSON-1' : 'WRAITH';
  const tailNum = variant === 'hero' ? '01' : variant === 'ace' ? '00' : '04';

  // Flank squadron callsigns & tail numbers (mirrored cleanly on port & starboard U bands)
  for (const cx of [size * 0.24, size * 0.76]) {
    aCtx.font = '700 44px "SF Mono", Menlo, monospace';
    aCtx.fillStyle = stencilPrimary;
    aCtx.fillText(callsignLabel, cx, size * 0.41);

    aCtx.font = '800 72px "SF Mono", Menlo, monospace';
    aCtx.fillText(tailNum, cx, size * 0.34);

    // Tactical wing / fuselage insignia chevron
    aCtx.strokeStyle = stencilWarn;
    aCtx.lineWidth = 5;
    aCtx.beginPath();
    aCtx.moveTo(cx - 52, size * 0.52);
    aCtx.lineTo(cx, size * 0.49);
    aCtx.lineTo(cx + 52, size * 0.52);
    aCtx.stroke();

    // "NO STEP" & "DANGER INTAKE" aerospace maintenance stencils
    aCtx.font = '700 18px "SF Mono", Menlo, monospace';
    aCtx.fillStyle = stencilWarn;
    aCtx.fillText('NO STEP', cx - 120, size * 0.48);
    aCtx.fillText('DANGER JET INTAKE', cx, size * 0.62);
    aCtx.fillText('RESCUE ►', cx + 96, size * 0.75);

    // Ejection triangle stencil near forward canopy zone
    aCtx.beginPath();
    aCtx.moveTo(cx, size * 0.73 - 18);
    aCtx.lineTo(cx + 18, size * 0.73 + 14);
    aCtx.lineTo(cx - 18, size * 0.73 + 14);
    aCtx.closePath();
    aCtx.strokeStyle = stencilWarn;
    aCtx.lineWidth = 3;
    aCtx.stroke();
  }
  aCtx.restore();

  // ------------------------------------------------------------------
  // 9. EMISSIVE FORMATION SLIME-LIGHTS & STEALTH SEAM ACCENTS
  // ------------------------------------------------------------------
  if (variant === 'hero') {
    // Low-vis electroluminescent lime-cyan formation light strips ("slime lights")
    const slimeCoords: [number, number, number, number][] = [
      [size * 0.22, size * 0.36, 94, 14],
      [size * 0.78 - 94, size * 0.36, 94, 14],
      [size * 0.24, size * 0.68, 76, 12],
      [size * 0.76 - 76, size * 0.68, 76, 12],
      [size * 0.5 - 32, size * 0.29, 64, 10],
    ];
    for (const [sx, sy, sw, sh] of slimeCoords) {
      // Dark metallic bezel in albedo & height
      aCtx.fillStyle = '#182028';
      aCtx.fillRect(sx - 4, sy - 4, sw + 8, sh + 8);
      hCtx.fillStyle = '#505050';
      hCtx.fillRect(sx - 4, sy - 4, sw + 8, sh + 8);

      // Soft outer glow + bright lime-cyan core
      eCtx.fillStyle = 'rgba(84, 248, 212, 0.38)';
      eCtx.fillRect(sx - 3, sy - 3, sw + 6, sh + 6);
      eCtx.fillStyle = '#7effdc';
      eCtx.fillRect(sx, sy, sw, sh);
    }
  } else {
    // WRAITH & CRIMSON-1 glowing crimson stealth seam-trace & formation accents
    const isAce = variant === 'ace';
    const seamCol = isAce ? '#ff1e4a' : '#d81a38';
    const glowCol = isAce ? 'rgba(255, 34, 78, 0.45)' : 'rgba(210, 20, 48, 0.32)';

    // Glowing longitudinal stealth chine seam traces
    for (const sx of [size * 0.25, size * 0.75]) {
      eCtx.fillStyle = glowCol;
      eCtx.fillRect(sx - 6, size * 0.18, 12, size * 0.64);
      eCtx.fillStyle = seamCol;
      eCtx.fillRect(sx - 2, size * 0.18, 4, size * 0.64);
    }

    // Transverse intake/avionics emissive accent ticks
    for (const sy of [size * 0.255, size * 0.642]) {
      eCtx.fillStyle = glowCol;
      eCtx.fillRect(0, sy - 5, size, 10);
      eCtx.fillStyle = seamCol;
      eCtx.fillRect(0, sy - 1.5, size, 3);
    }

    // Extra dorsal cyber-seam line for CRIMSON-1 Ace
    if (isAce) {
      eCtx.fillStyle = 'rgba(255, 88, 128, 0.5)';
      eCtx.fillRect(size * 0.5 - 7, size * 0.22, 14, size * 0.56);
      eCtx.fillStyle = '#ff4872';
      eCtx.fillRect(size * 0.5 - 2.5, size * 0.22, 5, size * 0.56);
    }
  }

  // ------------------------------------------------------------------
  // 10. SOBEL TANGENT-SPACE NORMAL MAP SYNTHESIS
  // ------------------------------------------------------------------
  const normalCanvas = buildSobelNormalCanvas(hCtx, size, 2.35);

  const configureTex = (
    canvas: HTMLCanvasElement,
    isColor: boolean,
    channel = 0,
  ): THREE.CanvasTexture => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1);
    tex.anisotropy = 8;
    tex.channel = channel;
    tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  };

  const result: HullTextureSet = {
    map: configureTex(albedoCanvas, true),
    normalMap: configureTex(normalCanvas, false),
    roughnessMap: configureTex(roughCanvas, false),
    metalnessMap: configureTex(metalCanvas, false),
    aoMap: configureTex(aoCanvas, false, 0),
    emissiveMap: configureTex(emissiveCanvas, true),
  };

  hullTextureCache[variant] = result;
  return result;
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
