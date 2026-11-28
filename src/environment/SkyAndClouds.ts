import * as THREE from 'three';

const CLOUD_TEX_SIZE = 64;

// 12 canonical Perlin 3D unit-ish gradient directions (Ken Perlin improved noise)
const PERLIN_GRAD3: readonly [number, number, number][] = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
];

function createSeededPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Generates a tileable 3D cellular (inverted Worley F1) scalar field on a 64^3 grid
 * with power-of-two period `period` (4, 8, or 16).
 */
function buildTileableWorley3D(size: number, period: number, seed: number): Float32Array {
  const rand = createSeededPrng(seed);
  const cellCount = period * period * period;
  const points = new Float32Array(cellCount * 3);
  for (let i = 0; i < cellCount; i++) {
    const o = i * 3;
    points[o + 0] = rand();
    points[o + 1] = rand();
    points[o + 2] = rand();
  }

  const out = new Float32Array(size * size * size);
  const mask = period - 1;
  const invSize = period / size;
  const periodSq = period * period;

  let idx = 0;
  for (let z = 0; z < size; z++) {
    const gz = z * invSize;
    const iz = Math.floor(gz);
    const fz = gz - iz;

    for (let y = 0; y < size; y++) {
      const gy = y * invSize;
      const iy = Math.floor(gy);
      const fy = gy - iy;

      for (let x = 0; x < size; x++) {
        const gx = x * invSize;
        const ix = Math.floor(gx);
        const fx = gx - ix;

        let minDistSq = 10.0;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = (iz + dz) & mask;
          const nzOff = nz * periodSq;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = (iy + dy) & mask;
            const nyOff = nzOff + ny * period;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = (ix + dx) & mask;
              const pOff = (nyOff + nx) * 3;
              const px = dx + points[pOff + 0] - fx;
              const py = dy + points[pOff + 1] - fy;
              const pz = dz + points[pOff + 2] - fz;
              const dSq = px * px + py * py + pz * pz;
              if (dSq < minDistSq) minDistSq = dSq;
            }
          }
        }

        // Inverted Worley dome (1.0 at cell puff centres, 0.0 at Voronoi crevices)
        const billow = 1.0 - Math.sqrt(minDistSq) * 1.08;
        out[idx++] = billow < 0 ? 0 : billow > 1 ? 1 : billow;
      }
    }
  }

  return out;
}

/**
 * Generates a tileable 3D gradient (Perlin) scalar field on a 64^3 grid
 * with power-of-two period `period`, mapped cleanly to [0, 1].
 */
function buildTileablePerlin3D(size: number, period: number, seed: number): Float32Array {
  const rand = createSeededPrng(seed);
  const cellCount = period * period * period;
  const gradIdx = new Uint8Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    gradIdx[i] = Math.floor(rand() * 12) % 12;
  }

  const out = new Float32Array(size * size * size);
  const mask = period - 1;
  const invSize = period / size;
  const periodSq = period * period;

  const dotGrad = (cx: number, cy: number, cz: number, fx: number, fy: number, fz: number): number => {
    const g = PERLIN_GRAD3[gradIdx[cz * periodSq + cy * period + cx]];
    return g[0] * fx + g[1] * fy + g[2] * fz;
  };

  let idx = 0;
  for (let z = 0; z < size; z++) {
    const gz = z * invSize;
    const iz0 = Math.floor(gz) & mask;
    const iz1 = (iz0 + 1) & mask;
    const fz = gz - Math.floor(gz);
    const wz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

    for (let y = 0; y < size; y++) {
      const gy = y * invSize;
      const iy0 = Math.floor(gy) & mask;
      const iy1 = (iy0 + 1) & mask;
      const fy = gy - Math.floor(gy);
      const wy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);

      for (let x = 0; x < size; x++) {
        const gx = x * invSize;
        const ix0 = Math.floor(gx) & mask;
        const ix1 = (ix0 + 1) & mask;
        const fx = gx - Math.floor(gx);
        const wx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);

        const n000 = dotGrad(ix0, iy0, iz0, fx, fy, fz);
        const n100 = dotGrad(ix1, iy0, iz0, fx - 1, fy, fz);
        const n010 = dotGrad(ix0, iy1, iz0, fx, fy - 1, fz);
        const n110 = dotGrad(ix1, iy1, iz0, fx - 1, fy - 1, fz);
        const n001 = dotGrad(ix0, iy0, iz1, fx, fy, fz - 1);
        const n101 = dotGrad(ix1, iy0, iz1, fx - 1, fy, fz - 1);
        const n011 = dotGrad(ix0, iy1, iz1, fx, fy - 1, fz - 1);
        const n111 = dotGrad(ix1, iy1, iz1, fx - 1, fy - 1, fz - 1);

        const nx00 = n000 + (n100 - n000) * wx;
        const nx10 = n010 + (n110 - n010) * wx;
        const nx01 = n001 + (n101 - n001) * wx;
        const nx11 = n011 + (n111 - n011) * wx;

        const nxy0 = nx00 + (nx10 - nx00) * wy;
        const nxy1 = nx01 + (nx11 - nx01) * wy;
        const val = nxy0 + (nxy1 - nxy0) * wz;

        const norm = val * 0.52 + 0.5;
        out[idx++] = norm < 0 ? 0 : norm > 1 ? 1 : norm;
      }
    }
  }

  return out;
}

/**
 * Pre-bakes a seamless tileable 64x64x64 RGBA Data3DTexture once at startup:
 * - R: Low-frequency Perlin-Worley base shape (sculpted cumulus anvil macro-silhouette)
 * - G: Mid-frequency Worley billow erosion octave
 * - B: High-frequency Worley cauliflower puff erosion octave
 * - A: Divergence-free 3D curl turbulence detail (centred at 0.5)
 */
function generateCloudNoise3DTexture(): THREE.Data3DTexture {
  const S = CLOUD_TEX_SIZE;
  const mask = S - 1;
  const sSq = S * S;

  const perlin4 = buildTileablePerlin3D(S, 4, 133701);
  const perlin8 = buildTileablePerlin3D(S, 8, 294817);
  const worley4 = buildTileableWorley3D(S, 4, 419203);
  const worley8 = buildTileableWorley3D(S, 8, 638119);
  const worley16 = buildTileableWorley3D(S, 16, 871429);

  const data = new Uint8Array(S * S * S * 4);

  const sampleP8 = (x: number, y: number, z: number): number =>
    perlin8[((z & mask) * sSq) + ((y & mask) * S) + (x & mask)];

  let vIdx = 0;
  let oIdx = 0;
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        // Low-frequency Perlin-Worley base shape (Schneider/Nubis dilation remap)
        const pFbm = perlin4[vIdx] * 0.65 + perlin8[vIdx] * 0.35;
        const wFbm = worley4[vIdx] * 0.625 + worley8[vIdx] * 0.25 + worley16[vIdx] * 0.125;
        const lo = (1.0 - wFbm) * 0.55;
        const dilated = Math.max(0, Math.min(1, (pFbm - lo) / Math.max(1.0 - lo, 1e-4)));
        const chR = Math.max(0, Math.min(1, dilated * 0.72 + wFbm * 0.28));

        // Mid-frequency and high-frequency Worley erosion octaves
        const chG = Math.max(0, Math.min(1, worley8[vIdx] * 0.72 + worley16[vIdx] * 0.28));
        const chB = worley16[vIdx];

        // Discrete divergence-free 3D curl from three decorrelated periodic shifts of perlin8
        const dPzDy = sampleP8(x + 43, y + 12, z + 29) - sampleP8(x + 43, y + 10, z + 29);
        const dPyDz = sampleP8(x + 21, y + 37, z + 14) - sampleP8(x + 21, y + 37, z + 12);
        const dPxDz = sampleP8(x, y, z + 1) - sampleP8(x, y, z - 1);
        const dPzDx = sampleP8(x + 44, y + 11, z + 29) - sampleP8(x + 42, y + 11, z + 29);
        const dPyDx = sampleP8(x + 22, y + 37, z + 13) - sampleP8(x + 20, y + 37, z + 13);
        const dPxDy = sampleP8(x, y + 1, z) - sampleP8(x, y - 1, z);

        const curlX = dPzDy - dPyDz;
        const curlY = dPxDz - dPzDx;
        const curlZ = dPyDx - dPxDy;
        const curlSignal = 0.5 + (curlX * 0.65 + curlY * 0.55 - curlZ * 0.50) * 1.45;
        const chA = curlSignal < 0 ? 0 : curlSignal > 1 ? 1 : curlSignal;

        data[oIdx + 0] = Math.round(chR * 255);
        data[oIdx + 1] = Math.round(chG * 255);
        data[oIdx + 2] = Math.round(chB * 255);
        data[oIdx + 3] = Math.round(chA * 255);

        vIdx++;
        oIdx += 4;
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// 1. HALF-RESOLUTION (0.5x) TEMPORAL VOLUMETRIC CLOUD RAYMARCHER (GLSL3)
// ---------------------------------------------------------------------------
const CLOUD_PASS_VERT = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const CLOUD_PASS_FRAG = /* glsl */ `
  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler3D uCloudNoise3D;
  uniform sampler2D uPrevCloudTex;

  uniform mat4 uInvProj;
  uniform mat4 uCamWorldMatrix;
  uniform mat4 uPrevViewProj;
  uniform vec3 uCameraPos;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uStorm;
  uniform float uTrip;
  uniform float uLightning;
  uniform vec3 uLightningPos;
  uniform float uExplosionFlash;
  uniform float uFrameIndex;
  uniform float uHistoryReset;
  uniform float uFlashDelta;

  const float PI = 3.14159265;
  const int CLOUD_STEPS = 20;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  // Interleaved Gradient Noise (blue-noise screen-space dithering with 4-frame temporal phase)
  float ignBlueNoise(vec2 fragCoord) {
    return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), clamp(c.y, 0.0, 1.0));
  }

  // Henyey-Greenstein Mie scattering phase function (strictly guarded pow & division)
  float hgPhase(float cosTheta, float g) {
    float g2 = g * g;
    float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
    return (1.0 - g2) / max(4.0 * PI * pow(max(denom, 1e-4), 1.5), 1e-4);
  }

  // Ray-sphere intersection against curved planetary cloud shell centred at (0, -R, 0)
  vec2 intersectShell(float roY, float rdY, float radius) {
    float b = roY * rdY;
    float c = roY * roY - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(-1.0);
    float s = sqrt(max(disc, 0.0));
    return vec2(-b - s, -b + s);
  }

  // Coarse sculpted cumulonimbus cathedral density sampled from 64^3 3D Worley-Perlin Data3DTexture
  float sampleCloudCoarse(vec3 worldPos, float hNorm, float storm01, out vec4 baseSample) {
    baseSample = vec4(0.0);

    // Cumulonimbus vertical profile: flat dark base, towering columns, flaring anvil cap
    float bottomGrad = smoothstep(0.0, 0.11, hNorm);
    float topGrad = 1.0 - smoothstep(0.56, 1.0, hNorm);
    float anvilCap = smoothstep(0.62, 0.84, hNorm) * (1.0 - smoothstep(0.87, 1.0, hNorm)) * 0.48;
    float heightMask = bottomGrad * topGrad + anvilCap;
    if (heightMask < 0.005) return 0.0;

    // Frame Acts I-II with towering canyon walls and Acts III-IV with a circular supercell colosseum
    vec2 eyeDelta = worldPos.xz - vec2(0.0, -1550.0);
    float eyeDist = length(eyeDelta);
    float supercellWall = smoothstep(480.0, 1450.0, eyeDist);
    float canyonWall = smoothstep(220.0, 1080.0, abs(worldPos.x));
    float corridorKeep = mix(canyonWall, supercellWall, smoothstep(0.18, 0.72, storm01));
    float spatialMask = mix(0.24 + 0.76 * corridorKeep, 1.0, smoothstep(0.48, 0.84, hNorm));

    // Wind-advected 3D hardware-trilinear sample (period-4 macro structure -> ~1610 world units/lobe)
    vec3 wind = vec3(uTime * 12.0, -uTime * 2.5, uTime * 8.0);
    vec3 uvw = (worldPos + wind) * vec3(0.000155, 0.000210, 0.000155);
    baseSample = texture(uCloudNoise3D, uvw);

    // R: Perlin-Worley base shape, G: mid-freq Worley billow lobes
    float base = baseSample.r * 0.62 + baseSample.g * 0.38;
    float coverage = mix(0.47, 0.34, storm01);
    float density = smoothstep(coverage, coverage + 0.25, base * spatialMask) * heightMask;
    return density;
  }

  // Crisp curl-warped Worley cauliflower edge erosion evaluated only inside non-empty cloud voxels
  float sampleCloudDetail(vec3 worldPos, float coarseD, float hNorm, vec4 baseSample) {
    vec3 windFine = vec3(uTime * 19.0, -uTime * 3.8, uTime * 11.0);
    vec3 curlOffset = vec3(baseSample.a - 0.5, (baseSample.g - 0.5) * 0.45, 0.5 - baseSample.a) * 0.042;
    vec3 detailUvw = (worldPos + windFine) * 0.00039 + curlOffset;
    vec4 detailSample = texture(uCloudNoise3D, detailUvw);

    // Blend mid & high-frequency Worley puffs; stronger crispness near sunlit upper anvil lobes
    float worleyErode = detailSample.g * 0.55 + detailSample.b * 0.45;
    float erodeWeight = mix(0.25, 0.34, smoothstep(0.15, 0.85, hNorm));
    float eroded = coarseD - (1.0 - worleyErode) * erodeWeight * (1.0 - coarseD * 0.38);
    return clamp(eroded * 1.24, 0.0, 1.0);
  }

  void main() {
    // Reconstruct exact world-space camera view ray from NDC using inverse projection + camera basis
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 viewPos = uInvProj * vec4(ndc, 0.0, 1.0);
    vec3 viewDir = viewPos.xyz / max(abs(viewPos.w), 1e-4);
    vec3 dir = safeNormalize(mat3(uCamWorldMatrix) * viewDir);

    vec3 sunDir = safeNormalize(uSunDir);
    vec3 twinDir = safeNormalize(sunDir + vec3(0.11, 0.06, -0.05));

    float storm01 = clamp(uStorm, 0.0, 1.0);
    float trip01 = clamp(uTrip, 0.0, 1.0);
    float sunDot = max(dot(dir, sunDir), 0.0);

    vec3 goldHorizon = vec3(0.95, 0.38, 0.12);
    vec3 stormHorizon = vec3(0.24, 0.09, 0.24);
    vec3 horizon = mix(goldHorizon, stormHorizon, clamp(storm01 * 0.72, 0.0, 1.0));

    vec3 accumLight = vec3(0.0);
    float transmittance = 1.0;
    float weightedDist = 0.0;
    float weightSum = 0.0;

    if (dir.y > -0.04) {
      const float R_EARTH = 60000.0;
      const float CLOUD_MIN_Y = 250.0;
      const float CLOUD_MAX_Y = 1780.0;
      const float CLOUD_THICK = CLOUD_MAX_Y - CLOUD_MIN_Y;

      float camH = clamp(uCameraPos.y, 12.0, CLOUD_MAX_Y - 30.0);
      float roY = R_EARTH + camH;

      vec2 hitInner = intersectShell(roY, dir.y, R_EARTH + CLOUD_MIN_Y);
      vec2 hitOuter = intersectShell(roY, dir.y, R_EARTH + CLOUD_MAX_Y);

      float tStart = 0.0;
      float tEnd = 0.0;
      if (camH < CLOUD_MIN_Y) {
        tStart = max(hitInner.y, 260.0);
        tEnd = min(hitOuter.y, 8200.0);
      } else {
        // Inside the supercell cathedral arena (Acts III-IV): keep immediate dogfight clear
        tStart = 320.0;
        tEnd = min(hitOuter.y, 7600.0);
      }

      if (tEnd > tStart + 50.0) {
        float marchDist = tEnd - tStart;
        float baseStep = marchDist / float(CLOUD_STEPS);

        // 4-frame golden-ratio temporal IGN blue-noise jitter
        vec2 temporalShift = vec2(uFrameIndex * 5.588238, uFrameIndex * 3.719461);
        float jitter = ignBlueNoise(gl_FragCoord.xy + temporalShift);

        // Dual-lobe Henyey-Greenstein Mie scattering (razor-sharp silver lining + subtle back-scatter)
        float cosTheta = dot(dir, sunDir);
        float cosTwin = dot(dir, twinDir);
        float phasePrimary = mix(hgPhase(cosTheta, 0.80), hgPhase(cosTheta, -0.28), 0.22);
        float phaseTwin = hgPhase(cosTwin, 0.74) * 0.38;
        float phaseTotal = clamp(phasePrimary * 2.35 + phaseTwin * 1.12, 0.14, 3.8);

        // Deep dramatic Ridley Scott colour grading: brooding undersides + molten sunlit/prism rims
        vec3 sunLightCol = mix(vec3(1.42, 0.70, 0.29), vec3(0.75, 0.42, 0.82), clamp(storm01 * 0.62, 0.0, 1.0));
        sunLightCol = mix(sunLightCol, vec3(1.12, 0.36, 0.98), clamp(uTrip * 0.45, 0.0, 1.0));

        vec3 ambientTop = mix(vec3(0.24, 0.36, 0.58), vec3(0.08, 0.14, 0.28), storm01);
        vec3 ambientBot = mix(vec3(0.22, 0.11, 0.09), vec3(0.05, 0.03, 0.11), storm01);
        if (uTrip > 0.02) {
          ambientTop = mix(ambientTop, vec3(0.14, 0.46, 0.68), clamp(uTrip * 0.55, 0.0, 1.0));
          ambientBot = mix(ambientBot, vec3(0.34, 0.06, 0.38), clamp(uTrip * 0.62, 0.0, 1.0));
        }

        float t = tStart + baseStep * 0.62 * jitter;
        float horizonSmooth = smoothstep(-0.03, 0.075, dir.y);

        for (int i = 0; i < CLOUD_STEPS; i++) {
          if (transmittance < 0.03 || t > tEnd) break;

          // Non-linear step growth: finer steps up close for crisp cauliflower edges, wider far out
          float progress = float(i) / float(CLOUD_STEPS);
          float stepLen = baseStep * (0.65 + 0.70 * progress);

          vec3 samplePos = uCameraPos + dir * t;
          float horizSq = dot(dir.xz * t, dir.xz * t);
          float curvedY = samplePos.y - horizSq / (2.0 * R_EARTH);
          float hNorm = clamp((curvedY - CLOUD_MIN_Y) / max(CLOUD_THICK, 1.0), 0.0, 1.0);

          vec4 baseSample;
          float coarseD = sampleCloudCoarse(samplePos, hNorm, storm01, baseSample) * horizonSmooth;
          if (coarseD > 0.005) {
            float d = sampleCloudDetail(samplePos, coarseD, hNorm, baseSample);
            if (d > 0.004) {
              // 2-tap directional sun shadow march using the pre-baked 3D texture
              vec4 dummy1;
              vec4 dummy2;
              float dSun1 = sampleCloudCoarse(samplePos + sunDir * 135.0, clamp(hNorm + 0.07, 0.0, 1.0), storm01, dummy1);
              float dSun2 = sampleCloudCoarse(samplePos + sunDir * 390.0, clamp(hNorm + 0.18, 0.0, 1.0), storm01, dummy2);
              float optDepth = (dSun1 * 1.25 + dSun2 * 1.95) * 2.35;

              // Beer-Lambert self-shadow + Powder dark-crease contrast + crisp Mie silver lining
              float beer = exp(-optDepth);
              float powder = 1.0 - exp(-optDepth * 2.6);
              float sunEnergy = beer * (0.34 + 1.08 * powder);
              float silverEdge = exp(-d * 4.8) * pow(max(sunDot, 1e-4), 7.5) * 1.28;

              vec3 directScatter = sunLightCol * (sunEnergy * phaseTotal + silverEdge);
              vec3 ambientScatter = mix(ambientBot, ambientTop, smoothstep(0.08, 0.86, hNorm)) * (0.55 + 0.45 * beer);

              // Bioluminescent psychedelic rim veining inside storm cathedrals (Acts III-IV)
              vec3 bioGlow = vec3(0.0);
              if (uTrip > 0.05) {
                float veinPhase = fract(samplePos.x * 0.00062 + samplePos.z * 0.00054 + hNorm * 0.9 + baseSample.a * 0.35 - uTime * 0.11);
                vec3 veinHue = hsv2rgb(vec3(veinPhase, 0.94, 0.94));
                float edgeVein = smoothstep(0.08, 0.28, d) * (1.0 - smoothstep(0.22, 0.68, d));
                bioGlow = veinHue * edgeVein * uTrip * (0.34 + 0.44 * storm01);
              }

              // Cloud-internal 3D supercell lightning discharge illumination
              vec3 lightningGlow = vec3(0.0);
              if (uLightning > 0.01) {
                float strikeDist = length(samplePos - uLightningPos);
                float strikeAtten = exp(-strikeDist * 0.00082);
                vec3 boltCol = mix(vec3(0.85, 0.62, 1.65), vec3(0.45, 1.15, 1.75), clamp(uTrip * 0.6, 0.0, 1.0));
                lightningGlow = boltCol * uLightning * (0.20 + 2.15 * strikeAtten) * (0.4 + 0.6 * beer);
              }

              // Aerial detonation warm under-bounce
              vec3 boomBounce = vec3(1.35, 0.58, 0.22) * uExplosionFlash * (1.0 - hNorm * 0.78) * 0.52;

              vec3 stepScattering = directScatter + ambientScatter + bioGlow + lightningGlow + boomBounce;

              // Atmospheric distance haze blend into horizon
              float haze = 1.0 - exp(-t * 0.00016);
              vec3 hazeCol = mix(horizon * 0.78, stormHorizon * 0.92, clamp(storm01 * 0.75, 0.0, 1.0));
              stepScattering = mix(stepScattering, hazeCol, clamp(haze * 0.68, 0.0, 1.0));

              float sigma = d * mix(0.0052, 0.0074, storm01) * stepLen;
              float stepTrans = exp(-sigma);
              float contrib = transmittance * (1.0 - stepTrans);
              accumLight += contrib * stepScattering;
              weightedDist += t * contrib;
              weightSum += contrib;
              transmittance *= stepTrans;
            }
          }

          t += stepLen;
        }
      }
    }

    vec4 currCloud = vec4(clamp(accumLight, 0.0, 18.0), clamp(transmittance, 0.0, 1.0));

    // 4-frame temporal reprojection with camera-cut history reset & flash responsiveness
    vec4 finalCloud = currCloud;
    if (uHistoryReset < 0.5) {
      float reprojDist = weightSum > 1e-3 ? (weightedDist / max(weightSum, 1e-4)) : 3200.0;
      vec3 reprojWorldPos = uCameraPos + dir * reprojDist;
      vec4 prevClip = uPrevViewProj * vec4(reprojWorldPos, 1.0);

      if (prevClip.w > 1e-4) {
        vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
        if (prevUv.x >= 0.002 && prevUv.x <= 0.998 && prevUv.y >= 0.002 && prevUv.y <= 0.998) {
          vec4 histSample = texture(uPrevCloudTex, prevUv);
          bool histFinite =
            !isnan(histSample.r) && !isnan(histSample.g) && !isnan(histSample.b) && !isnan(histSample.a) &&
            !isinf(histSample.r) && !isinf(histSample.g) && !isinf(histSample.b) && !isinf(histSample.a);

          if (histFinite) {
            float motion = length(prevUv - vUv);
            float motionAtten = 1.0 - smoothstep(0.015, 0.14, motion) * 0.45;
            float flashAtten = clamp(1.0 - uFlashDelta * 1.8, 0.0, 1.0);
            float transDiff = abs(histSample.a - currCloud.a);
            float disocclusionAtten = 1.0 - smoothstep(0.22, 0.65, transDiff) * 0.55;
            float histWeight = clamp(0.75 * motionAtten * flashAtten * disocclusionAtten, 0.0, 0.75);
            finalCloud = mix(currCloud, histSample, histWeight);
          }
        }
      }
    }

    fragColor = vec4(clamp(finalCloud.rgb, 0.0, 18.0), clamp(finalCloud.a, 0.0, 1.0));
  }
`;

// ---------------------------------------------------------------------------
// 2. EARLY-Z FULL-RESOLUTION SKY DOME & SMOOTH CLOUD COMPOSITE (GLSL3)
// ---------------------------------------------------------------------------
const SKY_COMPOSITE_VERT = /* glsl */ `
  out vec3 vWorldDir;
  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }
  void main() {
    vWorldDir = safeNormalize(position);
    // Rotation-only view transform keeps sky dome centred on camera with exact far-plane depth (ndc.z = 1.0)
    mat4 rotView = mat4(mat3(viewMatrix));
    vec4 clipPos = projectionMatrix * rotView * vec4(position, 1.0);
    gl_Position = clipPos.xyww;
  }
`;

const SKY_COMPOSITE_FRAG = /* glsl */ `
  in vec3 vWorldDir;
  out vec4 fragColor;

  uniform sampler2D uCloudTex;
  uniform vec2 uViewportSize;
  uniform vec2 uCloudTexelSize;

  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uStorm;
  uniform float uTrip;
  uniform float uLightning;
  uniform float uExplosionFlash;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, clamp(f.x, 0.0, 1.0)), mix(c, d, clamp(f.x, 0.0, 1.0)), clamp(f.y, 0.0, 1.0));
  }

  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p = rot * p * 2.03;
      a *= 0.5;
    }
    return v;
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), clamp(c.y, 0.0, 1.0));
  }

  // Smooth 5-tap tent upsample from 0.5x cloud render target (zero bilinear diamond artefacts)
  vec4 sampleCloudsSmooth(vec2 uv) {
    vec2 halfTexel = uCloudTexelSize * 0.5;
    vec2 minUv = halfTexel;
    vec2 maxUv = vec2(1.0) - halfTexel;
    vec2 safeUv = clamp(uv, minUv, maxUv);
    vec2 d = uCloudTexelSize * 0.45;

    vec4 c0 = texture(uCloudTex, safeUv);
    vec4 c1 = texture(uCloudTex, clamp(safeUv + vec2( d.x,  d.y), minUv, maxUv));
    vec4 c2 = texture(uCloudTex, clamp(safeUv + vec2(-d.x,  d.y), minUv, maxUv));
    vec4 c3 = texture(uCloudTex, clamp(safeUv + vec2( d.x, -d.y), minUv, maxUv));
    vec4 c4 = texture(uCloudTex, clamp(safeUv + vec2(-d.x, -d.y), minUv, maxUv));
    return c0 * 0.52 + (c1 + c2 + c3 + c4) * 0.12;
  }

  void main() {
    vec3 dir = safeNormalize(vWorldDir);
    vec3 sunDir = safeNormalize(uSunDir);
    vec3 twinDir = safeNormalize(sunDir + vec3(0.11, 0.06, -0.05));
    float y = max(dir.y, -0.15);

    float storm01 = clamp(uStorm, 0.0, 1.0);
    float trip01 = clamp(uTrip, 0.0, 1.0);

    // ------------------------------------------------------------------
    // 1. FULL-RESOLUTION TWIN-ECLIPSE ATMOSPHERIC SCATTERING SKY DOME
    // ------------------------------------------------------------------
    vec3 goldZenith = vec3(0.025, 0.085, 0.22);
    vec3 goldMid = vec3(0.12, 0.22, 0.37);
    vec3 goldHorizon = vec3(0.95, 0.38, 0.12);

    vec3 stormZenith = vec3(0.014, 0.022, 0.08);
    vec3 stormMid = vec3(0.045, 0.10, 0.18);
    vec3 stormHorizon = vec3(0.24, 0.09, 0.24);

    vec3 zenith = mix(goldZenith, stormZenith, storm01);
    vec3 midCol = mix(goldMid, stormMid, storm01);
    vec3 horizon = mix(goldHorizon, stormHorizon, clamp(storm01 * 0.72, 0.0, 1.0));

    float invY = 1.0 - clamp(y, 0.0, 1.0);
    float midFactor = clamp(pow(max(invY, 1e-4), 1.5), 0.0, 1.0);
    float hFactor = clamp(pow(max(invY, 1e-4), 4.1), 0.0, 1.0);
    vec3 skyCol = mix(zenith, midCol, midFactor);
    skyCol = mix(skyCol, horizon, hFactor);

    // Rayleigh/Mie directional horizon glow aligned with the sun azimuth
    float sunDot = max(dot(dir, sunDir), 0.0);
    float twinDot = max(dot(dir, twinDir), 0.0);
    float horizonSunGlow = pow(max(sunDot, 1e-4), 5.0) * pow(max(invY, 1e-4), 2.8);
    skyCol += mix(vec3(0.55, 0.24, 0.08), vec3(0.38, 0.10, 0.45), clamp(uTrip * 0.6, 0.0, 1.0)) * horizonSunGlow * 0.62;

    // High-altitude stratospheric cirrus wisps
    vec2 skyUv = dir.xz / max(abs(dir.y) + 0.22, 1e-4);
    float cirrusN = fbm2(skyUv * 0.9 + vec2(uTime * 0.016, -uTime * 0.011));
    float cirrusMask = smoothstep(0.48, 0.86, cirrusN) * smoothstep(0.04, 0.36, dir.y);
    vec3 cirrusCol = mix(vec3(0.88, 0.46, 0.20), vec3(0.28, 0.14, 0.44), storm01);
    skyCol = mix(skyCol, cirrusCol * (0.45 + 0.55 * cirrusN), clamp(cirrusMask * 0.28, 0.0, 1.0));

    // LSD Chromatic Supercell Aurora & Prismatic Eclipse Halos (Acts III-IV)
    if (uTrip > 0.01) {
      float safeX = (abs(dir.x) < 1e-5 && abs(dir.z) < 1e-5) ? 1e-5 : dir.x;
      float angle = atan(dir.z, safeX);
      float warp = fbm2(skyUv * 1.45 + vec2(sin(uTime * 0.24), cos(uTime * 0.21)) * 1.4);
      float ribbon = pow(max(sin(angle * 4.0 + warp * 8.5 - uTime * 0.85) * 0.5 + 0.5, 1e-4), 3.6);
      vec3 acidCol = hsv2rgb(vec3(fract(warp * 1.3 + angle * 0.16 - uTime * 0.12), 0.92, 0.85));
      float upperMask = smoothstep(0.0, 0.44, dir.y);
      skyCol += acidCol * ribbon * upperMask * uTrip * 0.58;

      // Double prismatic ice-crystal halo around the eclipsed sun
      float sunAngle = acos(clamp(dot(dir, sunDir), -0.9999, 0.9999));
      float d1 = (sunAngle - 0.30) * 16.0;
      float d2 = (sunAngle - 0.50) * 20.0;
      float haloRing = exp(-(d1 * d1)) + exp(-(d2 * d2)) * 0.55;
      vec3 haloPrism = hsv2rgb(vec3(fract(sunAngle * 5.2 - uTime * 0.35), 0.95, 0.92));
      skyCol += haloPrism * haloRing * uTrip * 0.72;
    }

    // Twin Eclipse Sun: Controlled HDR solar corona + dark eclipse core + diamond prominence
    float mieGlow = pow(max(sunDot, 1e-4), 16.0) * 0.58 + pow(max(sunDot, 1e-4), 110.0) * 1.25;
    vec3 sunTint = mix(vec3(1.25, 0.66, 0.26), vec3(1.15, 0.34, 0.85), clamp(uTrip * 0.55, 0.0, 1.0));
    skyCol += sunTint * mieGlow;

    float sunDisc = smoothstep(0.9968, 0.9988, sunDot);
    float eclipseAmt = smoothstep(0.18, 0.85, uTrip);
    float eclipseCore = smoothstep(0.9981, 0.9992, sunDot) * eclipseAmt;
    float coronaRim = smoothstep(0.9960, 0.9984, sunDot) * (1.0 - smoothstep(0.9984, 0.9994, sunDot));
    skyCol += vec3(2.8, 1.9, 1.1) * sunDisc * (1.0 - eclipseCore * 0.92);
    skyCol += mix(vec3(1.4, 0.60, 0.26), vec3(1.45, 0.32, 1.35), trip01) * coronaRim * (0.65 + eclipseAmt * 1.85);

    // Secondary Twin Sun (molten amber companion -> cyan plasma eclipse twin)
    float twinDisc = smoothstep(0.9988, 0.9995, twinDot);
    vec3 twinTint = mix(vec3(1.05, 0.48, 0.18), vec3(0.32, 0.88, 1.45), trip01);
    skyCol += twinTint * (pow(max(twinDot, 1e-4), 84.0) * 0.42 + twinDisc * 1.35);

    // ------------------------------------------------------------------
    // 2. SMOOTH HALF-RES TEMPORAL VOLUMETRIC CLOUD COMPOSITE (ZERO HORIZON HALO)
    // ------------------------------------------------------------------
    vec3 col = skyCol;
    float cloudTransmittance = 1.0;

    if (dir.y > -0.04) {
      vec2 screenUv = gl_FragCoord.xy / max(uViewportSize, vec2(1.0));
      vec4 cloudData = sampleCloudsSmooth(screenUv);
      float horizonMask = smoothstep(-0.03, 0.04, dir.y);
      vec3 cloudLight = max(cloudData.rgb, vec3(0.0)) * horizonMask;
      cloudTransmittance = mix(1.0, clamp(cloudData.a, 0.0, 1.0), horizonMask);
      col = cloudLight + skyCol * cloudTransmittance;
    }

    // ------------------------------------------------------------------
    // 3. RADIAL VOLUMETRIC CREPUSCULAR GOD-RAY SHAFTS FROM TWIN ECLIPSE SUN
    // ------------------------------------------------------------------
    float sunRayMask = pow(max(sunDot, 1e-4), 6.0);
    float twinRayMask = pow(max(twinDot, 1e-4), 9.0) * 0.45;
    if (sunRayMask + twinRayMask > 0.015 && dir.y > -0.05) {
      vec3 rayAxis = safeNormalize(cross(sunDir, vec3(0.0, 1.0, 0.0)));
      vec3 rayUp = safeNormalize(cross(rayAxis, sunDir));
      vec2 sunPlane = vec2(dot(dir, rayAxis), dot(dir, rayUp));
      float safePX = (abs(sunPlane.x) < 1e-5 && abs(sunPlane.y) < 1e-5) ? 1e-5 : sunPlane.x;
      float radialAngle = atan(sunPlane.y, safePX);
      float radialDist = length(sunPlane);

      float shaft1 = sin(radialAngle * 13.0 + uTime * 0.22) * 0.5 + 0.5;
      float shaft2 = sin(radialAngle * 21.0 - uTime * 0.30 + 1.4) * 0.5 + 0.5;
      float gapNoise = noise2(vec2(radialAngle * 4.2, radialDist * 2.6 - uTime * 0.08));
      float shafts = pow(max(shaft1 * 0.55 + shaft2 * 0.45, 1e-4), 3.4) * (0.35 + 0.65 * gapNoise);

      float edgePeek = 0.26 + 0.74 * (1.0 - abs(cloudTransmittance * 2.0 - 1.0));
      float elevFade = smoothstep(-0.04, 0.14, dir.y);

      vec3 amberShaft = vec3(1.25, 0.66, 0.26);
      vec3 auroraShaft = hsv2rgb(vec3(fract(radialAngle * 0.16 + 0.78 - uTime * 0.10), 0.90, 0.92)) * 1.15;
      vec3 shaftCol = mix(amberShaft, auroraShaft, clamp(uTrip * 0.92, 0.0, 1.0));

      float shaftPower = (sunRayMask * 0.38 + twinRayMask * 0.26) * shafts * edgePeek * elevFade * (1.0 - storm01 * 0.25);
      col += shaftCol * shaftPower;
    }

    // Transient sky flash on lightning & detonations
    col += mix(vec3(0.55, 0.38, 1.12), vec3(0.38, 0.85, 1.32), clamp(uTrip * 0.5, 0.0, 1.0)) * uLightning * (0.14 + 0.28 * cirrusN);
    col += vec3(1.05, 0.56, 0.24) * uExplosionFlash * 0.32;

    // Below-horizon deep ocean-mirror blend (non-inverted smoothstep)
    float below = 1.0 - smoothstep(-0.075, 0.015, dir.y);
    col = mix(col, mix(vec3(0.022, 0.050, 0.095), vec3(0.065, 0.018, 0.125), trip01), clamp(below, 0.0, 1.0));

    fragColor = vec4(clamp(col, 0.0, 18.0), 1.0);
  }
`;

const GODRAY_SHAFT_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = safeNormalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const GODRAY_SHAFT_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  uniform float uTime;
  uniform float uOpacity;
  uniform float uTrip;
  uniform float uPhase;
  uniform vec3 uColorPrimary;
  uniform vec3 uColorSecondary;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    vec3 V = safeNormalize(cameraPosition - vWorldPos);
    float ndotv = abs(dot(safeNormalize(vWorldNormal), V));

    // Silky volumetric cylindrical edge fade — never reveals hard polygon edges
    float edgeFade = pow(max(ndotv, 1e-4), 2.5);

    // Smooth top-and-bottom volumetric attenuation (non-inverted smoothstep)
    float verticalFade = smoothstep(0.0, 0.30, vUv.y) * (1.0 - smoothstep(0.16, 1.0, vUv.y));
    verticalFade *= pow(max(vUv.y, 1e-4), 0.5);

    // Soft proximity fade so flying directly through a sunbeam never pops or washes out
    float camDist = length(cameraPosition - vWorldPos);
    float nearFade = smoothstep(140.0, 440.0, camDist);

    // Sculpted drifting light striations along the beam
    float curtain = 0.65 + 0.35 * sin(vUv.x * 18.84955 + uTime * 0.55 + uPhase);
    float mist = 0.78 + 0.22 * sin(vUv.y * 12.0 - uTime * 0.42 + uPhase * 1.7);

    float colourBlend = clamp(0.5 + 0.5 * sin(vUv.x * 6.28318 + vUv.y * 3.0 - uTime * 0.45 + uPhase), 0.0, 1.0);
    vec3 beamCol = max(mix(uColorPrimary, uColorSecondary, clamp(colourBlend * uTrip, 0.0, 1.0)), vec3(0.0));

    float alpha = edgeFade * verticalFade * nearFade * curtain * mist * uOpacity;
    gl_FragColor = vec4(beamCol, clamp(alpha, 0.0, 0.42));
  }
`;

const LIGHTNING_RIBBON_VERT = /* glsl */ `
  attribute float aBranchWeight;
  varying vec2 vUv;
  varying float vWeight;

  void main() {
    vUv = uv;
    vWeight = aBranchWeight;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LIGHTNING_RIBBON_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vWeight;

  uniform float uOpacity;
  uniform vec3 uCoreColor;
  uniform vec3 uHaloColor;

  void main() {
    // Distance from ribbon centreline (vUv.x in [0, 1])
    float d = abs(vUv.x * 2.0 - 1.0);
    float core = exp(-(d * d) * 22.0);
    float halo = pow(max(1.0 - d, 1e-4), 3.0);
    float tipFade = smoothstep(0.0, 0.06, vUv.y) * (1.0 - smoothstep(0.90, 1.0, vUv.y));

    vec3 col = mix(uHaloColor * 1.25, uCoreColor * 2.6, clamp(core, 0.0, 1.0));
    float alpha = (halo * 0.72 + core * 0.95) * tipFade * vWeight * uOpacity;
    gl_FragColor = vec4(clamp(col, 0.0, 10.0), clamp(alpha, 0.0, 1.0));
  }
`;

const TRUNK_SEGMENTS = 18;
const FORK_COUNT = 3;
const FORK_SEGMENTS = 8;
const TOTAL_RIBBON_SEGMENTS = TRUNK_SEGMENTS + FORK_COUNT * FORK_SEGMENTS; // 42
const RIBBON_QUADS_PER_SEG = 2; // Crossed X & Z ribbons for true 3D thickness from all angles
const TENDRIL_SEGMENTS = 56;
const CAMERA_CUT_RESET_DISTANCE = 15.0;

interface LightningCluster {
  ribbonMesh: THREE.Mesh;
  ribbonMat: THREE.ShaderMaterial;
  ribbonPos: Float32Array;
  ribbonWeight: Float32Array;
  tendrilLines: THREE.LineSegments;
  tendrilMat: THREE.LineBasicMaterial;
  tendrilPos: Float32Array;
  age: number;
  duration: number;
  active: boolean;
}

export class SkyAndClouds {
  public readonly group = new THREE.Group();
  public lightningFlash = 0;
  public readonly lightningWorldPos = new THREE.Vector3(0, 620, -1550);

  private readonly sunDirection = new THREE.Vector3();
  private readonly cloudNoise3D: THREE.Data3DTexture;
  private readonly cloudRTs: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly cloudScene: THREE.Scene;
  private readonly cloudCamera: THREE.OrthographicCamera;
  private readonly cloudQuadMat: THREE.ShaderMaterial;
  private readonly cloudQuadMesh: THREE.Mesh;

  private readonly skyMesh: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly godRayMats: THREE.ShaderMaterial[] = [];
  private readonly lightningClusters: LightningCluster[] = [];

  private writeIdx = 0;
  private frameIndex = 0;
  private halfWidth = 0;
  private halfHeight = 0;
  private isRenderingClouds = false;
  private hasPrevFrame = false;
  private currTime = 0;
  private prevCloudTime = 0;
  private prevLightning = 0;
  private currExplosionFlash = 0;
  private prevExplosionFlash = 0;

  private lightningTimer = 0.2;
  private nextClusterIdx = 0;
  private prngState = 918273;

  // Pre-allocated scratch objects (zero per-frame heap allocations)
  private readonly _fbSize = new THREE.Vector2();
  private readonly _currCameraPos = new THREE.Vector3();
  private readonly _prevCameraPos = new THREE.Vector3();
  private readonly _prevCameraFwd = new THREE.Vector3(0, 0, -1);
  private readonly _currCameraFwd = new THREE.Vector3(0, 0, -1);
  private readonly _prevViewProj = new THREE.Matrix4();
  private readonly _currInvProj = new THREE.Matrix4();
  private readonly _rayColPrimary = new THREE.Color();
  private readonly _rayColSecondary = new THREE.Color();
  private readonly _boltHaloCol = new THREE.Color();
  private readonly _boltCoreCol = new THREE.Color(0xf6f2ff);
  private readonly _segA = new THREE.Vector3();
  private readonly _segB = new THREE.Vector3();
  private readonly _segDir = new THREE.Vector3();
  private readonly _perp1 = new THREE.Vector3();
  private readonly _perp2 = new THREE.Vector3();
  private readonly _refUp = new THREE.Vector3(0, 1, 0);
  private readonly _refSide = new THREE.Vector3(1, 0, 0);
  private readonly _trunkNodes: THREE.Vector3[] = [];
  private readonly _forkNodes: THREE.Vector3[] = [];

  constructor(sunDirection: THREE.Vector3, targetScene?: THREE.Scene) {
    this.sunDirection.copy(sunDirection).normalize();

    for (let i = 0; i <= TRUNK_SEGMENTS; i++) {
      this._trunkNodes.push(new THREE.Vector3());
    }
    for (let i = 0; i <= FORK_SEGMENTS; i++) {
      this._forkNodes.push(new THREE.Vector3());
    }

    // ------------------------------------------------------------------
    // 1. PRE-BAKED SEAMLESS 64^3 3D WORLEY-PERLIN DATA3DTEXTURE
    // ------------------------------------------------------------------
    this.cloudNoise3D = generateCloudNoise3DTexture();

    // ------------------------------------------------------------------
    // 2. HALF-RESOLUTION (0.5x) PING-PONG TEMPORAL CLOUD PASS
    // ------------------------------------------------------------------
    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.halfWidth = Math.max(1, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 1280) * 0.5));
    this.halfHeight = Math.max(1, Math.floor((typeof window !== 'undefined' ? window.innerHeight : 720) * 0.5));
    this.cloudRTs = [
      new THREE.WebGLRenderTarget(this.halfWidth, this.halfHeight, rtOpts),
      new THREE.WebGLRenderTarget(this.halfWidth, this.halfHeight, rtOpts),
    ];

    this.cloudScene = new THREE.Scene();
    this.cloudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.cloudQuadMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: CLOUD_PASS_VERT,
      fragmentShader: CLOUD_PASS_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCloudNoise3D: { value: this.cloudNoise3D },
        uPrevCloudTex: { value: this.cloudRTs[1].texture },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorldMatrix: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: this.sunDirection.clone() },
        uTime: { value: 0 },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
        uLightningPos: { value: this.lightningWorldPos.clone() },
        uExplosionFlash: { value: 0 },
        uFrameIndex: { value: 0 },
        uHistoryReset: { value: 1 },
        uFlashDelta: { value: 0 },
      },
    });

    this.cloudQuadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.cloudQuadMat);
    this.cloudQuadMesh.frustumCulled = false;
    this.cloudScene.add(this.cloudQuadMesh);

    // ------------------------------------------------------------------
    // 3. EARLY-Z FULL-RESOLUTION SKY DOME + SMOOTH CLOUD COMPOSITE
    // ------------------------------------------------------------------
    this.skyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SKY_COMPOSITE_VERT,
      fragmentShader: SKY_COMPOSITE_FRAG,
      side: THREE.BackSide,
      transparent: false,
      depthTest: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      uniforms: {
        uCloudTex: { value: this.cloudRTs[0].texture },
        uViewportSize: { value: new THREE.Vector2(this.halfWidth * 2, this.halfHeight * 2) },
        uCloudTexelSize: { value: new THREE.Vector2(1 / this.halfWidth, 1 / this.halfHeight) },
        uSunDir: { value: this.sunDirection.clone() },
        uTime: { value: 0 },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
        uExplosionFlash: { value: 0 },
      },
    });

    // Render sky dome AFTER all opaque geometry (ocean, sea-stacks, fighters, monoliths)
    // and BEFORE transparent VFX so hardware early-Z rejects every occluded fragment.
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 20), this.skyMat);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = 100;
    this.group.add(this.skyMesh);

    // Run the 0.5x temporal cloud pass before the main MSAA scene pass begins (zero mid-pass tile flush)
    if (targetScene) {
      const prevOnBeforeRender = targetScene.onBeforeRender;
      targetScene.onBeforeRender = (renderer, renderScene, camera, geometry, material, group) => {
        prevOnBeforeRender.call(targetScene, renderer, renderScene, camera, geometry, material, group);
        this.renderCloudPass(renderer, camera);
      };
    } else {
      this.skyMesh.onBeforeRender = (renderer, _renderScene, camera) => {
        this.renderCloudPass(renderer, camera);
      };
    }

    // ------------------------------------------------------------------
    // 4. 3D VOLUMETRIC GOD-RAY SUN SHAFTS (FRESNEL-FADED CONES)
    // ------------------------------------------------------------------
    this.buildVolumetricGodRays();

    // ------------------------------------------------------------------
    // 5. BRANCHING 3D SUPERCELL LIGHTNING POOL (ZERO RUNTIME ALLOCATION)
    // ------------------------------------------------------------------
    this.buildLightningPool();
  }

  private renderCloudPass(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (this.isRenderingClouds) return;
    this.isRenderingClouds = true;

    const prevTarget = renderer.getRenderTarget();
    const prevCubeFace = renderer.getActiveCubeFace();
    const prevMipmapLevel = renderer.getActiveMipmapLevel();
    const prevAutoClear = renderer.autoClear;
    const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const prevXrEnabled = renderer.xr.enabled;

    let fbWidth: number;
    let fbHeight: number;
    if (prevTarget) {
      fbWidth = prevTarget.width;
      fbHeight = prevTarget.height;
    } else {
      renderer.getDrawingBufferSize(this._fbSize);
      fbWidth = this._fbSize.x;
      fbHeight = this._fbSize.y;
    }

    const safeFbW = Math.max(1, fbWidth);
    const safeFbH = Math.max(1, fbHeight);
    const targetHalfW = Math.max(1, Math.floor(safeFbW * 0.5));
    const targetHalfH = Math.max(1, Math.floor(safeFbH * 0.5));

    let resized = false;
    if (targetHalfW !== this.halfWidth || targetHalfH !== this.halfHeight) {
      this.halfWidth = targetHalfW;
      this.halfHeight = targetHalfH;
      this.cloudRTs[0].setSize(targetHalfW, targetHalfH);
      this.cloudRTs[1].setSize(targetHalfW, targetHalfH);
      resized = true;
    }

    // Detect director camera cuts (> 15 units), instant orientation snaps, timeline seeks, or resize
    this._currCameraPos.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this._currCameraFwd);
    const cameraDelta = this.hasPrevFrame ? this._currCameraPos.distanceTo(this._prevCameraPos) : Infinity;
    const fwdDot = this.hasPrevFrame ? this._currCameraFwd.dot(this._prevCameraFwd) : 0;
    const timeJump =
      !this.hasPrevFrame ||
      this.currTime < this.prevCloudTime - 1e-4 ||
      Math.abs(this.currTime - this.prevCloudTime) > 0.5;
    const shouldReset =
      !this.hasPrevFrame ||
      resized ||
      cameraDelta > CAMERA_CUT_RESET_DISTANCE ||
      fwdDot < 0.72 ||
      timeJump;

    const readRT = this.cloudRTs[1 - this.writeIdx];
    const writeRT = this.cloudRTs[this.writeIdx];

    this._currInvProj.copy(camera.projectionMatrix).invert();

    const cloudUniforms = this.cloudQuadMat.uniforms;
    cloudUniforms.uPrevCloudTex.value = readRT.texture;
    (cloudUniforms.uInvProj.value as THREE.Matrix4).copy(this._currInvProj);
    (cloudUniforms.uCamWorldMatrix.value as THREE.Matrix4).copy(camera.matrixWorld);
    (cloudUniforms.uPrevViewProj.value as THREE.Matrix4).copy(this._prevViewProj);
    (cloudUniforms.uCameraPos.value as THREE.Vector3).copy(this._currCameraPos);
    cloudUniforms.uFrameIndex.value = this.frameIndex;
    cloudUniforms.uHistoryReset.value = shouldReset ? 1.0 : 0.0;
    cloudUniforms.uFlashDelta.value =
      Math.abs(this.lightningFlash - this.prevLightning) +
      Math.abs(this.currExplosionFlash - this.prevExplosionFlash);

    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(writeRT);
    renderer.render(this.cloudScene, this.cloudCamera);

    renderer.setRenderTarget(prevTarget, prevCubeFace, prevMipmapLevel);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    renderer.xr.enabled = prevXrEnabled;

    // Bind freshly updated half-res cloud texture to the early-Z sky dome composite shader
    this.skyMat.uniforms.uCloudTex.value = writeRT.texture;
    (this.skyMat.uniforms.uViewportSize.value as THREE.Vector2).set(safeFbW, safeFbH);
    (this.skyMat.uniforms.uCloudTexelSize.value as THREE.Vector2).set(1 / targetHalfW, 1 / targetHalfH);

    // Advance 4-frame temporal phase and save current camera matrices for next frame's reprojection
    this.writeIdx = 1 - this.writeIdx;
    this.frameIndex = (this.frameIndex + 1) & 3;
    this._prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._prevCameraPos.copy(this._currCameraPos);
    this._prevCameraFwd.copy(this._currCameraFwd);
    this.prevCloudTime = this.currTime;
    this.prevLightning = this.lightningFlash;
    this.prevExplosionFlash = this.currExplosionFlash;
    this.hasPrevFrame = true;
    this.isRenderingClouds = false;
  }

  private nextRand(): number {
    this.prngState = (this.prngState * 1664525 + 1013904223) >>> 0;
    return this.prngState / 0xffffffff;
  }

  private buildVolumetricGodRays(): void {
    const shaftGeo = new THREE.CylinderGeometry(36, 130, 1750, 14, 1, true);

    // Align shaft local +Y axis directly toward the twin eclipse sun
    const alignQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      this.sunDirection,
    );

    const placements: [number, number, number, number][] = [
      // Golden canyon shafts framing the basalt corridor (Acts I-II)
      [-480, 520, -480, 1.0],
      [440, 540, -680, 0.92],
      [-540, 560, -1120, 1.1],
      [530, 580, -1340, 1.05],
      // Supercell amphitheatre cathedral beams (Acts III-IV)
      [-680, 660, -1620, 1.25],
      [660, 680, -1720, 1.20],
      [-310, 740, -2140, 1.30],
      [330, 720, -2280, 1.25],
      // Horizon sunrise shafts flanking the vertical climb (Act V)
      [-520, 640, -2850, 1.35],
      [490, 660, -3050, 1.30],
    ];

    for (let i = 0; i < placements.length; i++) {
      const [px, py, pz, scale] = placements[i];
      const mat = new THREE.ShaderMaterial({
        vertexShader: GODRAY_SHAFT_VERT,
        fragmentShader: GODRAY_SHAFT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0.085 },
          uTrip: { value: 0 },
          uPhase: { value: i * 1.17 },
          uColorPrimary: { value: new THREE.Color(1.0, 0.56, 0.20) },
          uColorSecondary: { value: new THREE.Color(0.28, 0.85, 1.22) },
        },
      });

      const mesh = new THREE.Mesh(shaftGeo, mat);
      mesh.position.set(px, py, pz);
      mesh.quaternion.copy(alignQuat);
      mesh.rotateZ(((i % 5) - 2) * 0.045);
      mesh.scale.set(scale, 1.0 + (i % 3) * 0.14, scale);
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.godRayMats.push(mat);
    }
  }

  private buildLightningPool(): void {
    const totalQuads = TOTAL_RIBBON_SEGMENTS * RIBBON_QUADS_PER_SEG;
    const vertCount = totalQuads * 4;
    const idxCount = totalQuads * 6;

    for (let c = 0; c < 3; c++) {
      // Volumetric crossed-ribbon geometry for main trunk + primary forks
      const ribbonGeo = new THREE.BufferGeometry();
      const ribbonPos = new Float32Array(vertCount * 3);
      const ribbonUv = new Float32Array(vertCount * 2);
      const ribbonWeight = new Float32Array(vertCount);
      const indices = new Uint16Array(idxCount);

      // Assign continuous branch-normalised vUv.y across each trunk/fork so interior joints never pinch
      for (let segIdx = 0; segIdx < TOTAL_RIBBON_SEGMENTS; segIdx++) {
        let v0: number;
        let v1: number;
        if (segIdx < TRUNK_SEGMENTS) {
          v0 = segIdx / TRUNK_SEGMENTS;
          v1 = (segIdx + 1) / TRUNK_SEGMENTS;
        } else {
          const forkSeg = (segIdx - TRUNK_SEGMENTS) % FORK_SEGMENTS;
          v0 = forkSeg / FORK_SEGMENTS;
          v1 = (forkSeg + 1) / FORK_SEGMENTS;
        }

        for (let r = 0; r < RIBBON_QUADS_PER_SEG; r++) {
          const q = segIdx * RIBBON_QUADS_PER_SEG + r;
          const vOff = q * 4;
          const iOff = q * 6;

          ribbonUv[vOff * 2 + 0] = 0;
          ribbonUv[vOff * 2 + 1] = v0;
          ribbonUv[(vOff + 1) * 2 + 0] = 1;
          ribbonUv[(vOff + 1) * 2 + 1] = v0;
          ribbonUv[(vOff + 2) * 2 + 0] = 0;
          ribbonUv[(vOff + 2) * 2 + 1] = v1;
          ribbonUv[(vOff + 3) * 2 + 0] = 1;
          ribbonUv[(vOff + 3) * 2 + 1] = v1;

          indices[iOff + 0] = vOff;
          indices[iOff + 1] = vOff + 1;
          indices[iOff + 2] = vOff + 2;
          indices[iOff + 3] = vOff + 1;
          indices[iOff + 4] = vOff + 3;
          indices[iOff + 5] = vOff + 2;
        }
      }

      ribbonGeo.setAttribute('position', new THREE.BufferAttribute(ribbonPos, 3));
      ribbonGeo.setAttribute('uv', new THREE.BufferAttribute(ribbonUv, 2));
      ribbonGeo.setAttribute('aBranchWeight', new THREE.BufferAttribute(ribbonWeight, 1));
      ribbonGeo.setIndex(new THREE.BufferAttribute(indices, 1));

      const ribbonMat = new THREE.ShaderMaterial({
        vertexShader: LIGHTNING_RIBBON_VERT,
        fragmentShader: LIGHTNING_RIBBON_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uOpacity: { value: 0 },
          uCoreColor: { value: new THREE.Color(0xf8f4ff) },
          uHaloColor: { value: new THREE.Color(0xb874ff) },
        },
      });

      const ribbonMesh = new THREE.Mesh(ribbonGeo, ribbonMat);
      ribbonMesh.frustumCulled = false;
      ribbonMesh.visible = false;
      ribbonMesh.renderOrder = 3;
      this.group.add(ribbonMesh);

      // Fine secondary & tertiary crackling branch tendrils
      const tendrilGeo = new THREE.BufferGeometry();
      const tendrilPos = new Float32Array(TENDRIL_SEGMENTS * 2 * 3);
      tendrilGeo.setAttribute('position', new THREE.BufferAttribute(tendrilPos, 3));

      const tendrilMat = new THREE.LineBasicMaterial({
        color: 0xd098ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      const tendrilLines = new THREE.LineSegments(tendrilGeo, tendrilMat);
      tendrilLines.frustumCulled = false;
      tendrilLines.visible = false;
      tendrilLines.renderOrder = 3;
      this.group.add(tendrilLines);

      this.lightningClusters.push({
        ribbonMesh,
        ribbonMat,
        ribbonPos,
        ribbonWeight,
        tendrilLines,
        tendrilMat,
        tendrilPos,
        age: 10,
        duration: 0.36,
        active: false,
      });
    }
  }

  private writeCrossedRibbonSegment(
    posArr: Float32Array,
    weightArr: Float32Array,
    segIdx: number,
    a: THREE.Vector3,
    b: THREE.Vector3,
    halfWidthA: number,
    halfWidthB: number,
    weight: number,
  ): void {
    this._segDir.subVectors(b, a);
    const len = this._segDir.length();
    if (len < 1e-4) {
      this._segDir.set(0, -1, 0);
    } else {
      this._segDir.multiplyScalar(1 / len);
    }

    // Build two orthonormal perpendicular axes for 3D crossed ribbons
    const ref = Math.abs(this._segDir.y) < 0.92 ? this._refUp : this._refSide;
    this._perp1.crossVectors(this._segDir, ref).normalize();
    this._perp2.crossVectors(this._segDir, this._perp1).normalize();

    const baseQuad = segIdx * RIBBON_QUADS_PER_SEG;
    for (let q = 0; q < 2; q++) {
      const axis = q === 0 ? this._perp1 : this._perp2;
      const vOff = (baseQuad + q) * 4;
      const pOff = vOff * 3;

      posArr[pOff + 0] = a.x - axis.x * halfWidthA;
      posArr[pOff + 1] = a.y - axis.y * halfWidthA;
      posArr[pOff + 2] = a.z - axis.z * halfWidthA;

      posArr[pOff + 3] = a.x + axis.x * halfWidthA;
      posArr[pOff + 4] = a.y + axis.y * halfWidthA;
      posArr[pOff + 5] = a.z + axis.z * halfWidthA;

      posArr[pOff + 6] = b.x - axis.x * halfWidthB;
      posArr[pOff + 7] = b.y - axis.y * halfWidthB;
      posArr[pOff + 8] = b.z - axis.z * halfWidthB;

      posArr[pOff + 9] = b.x + axis.x * halfWidthB;
      posArr[pOff + 10] = b.y + axis.y * halfWidthB;
      posArr[pOff + 11] = b.z + axis.z * halfWidthB;

      weightArr[vOff + 0] = weight;
      weightArr[vOff + 1] = weight;
      weightArr[vOff + 2] = weight;
      weightArr[vOff + 3] = weight;
    }
  }

  private triggerLightningStrike(cameraPos: THREE.Vector3, trip: number): void {
    const cluster = this.lightningClusters[this.nextClusterIdx];
    this.nextClusterIdx = (this.nextClusterIdx + 1) % this.lightningClusters.length;

    // Position the supercell discharge around the cloud cathedral perimeter
    const angle = this.nextRand() * Math.PI * 2;
    const dist = 560 + this.nextRand() * 1050;
    const startX = cameraPos.x + Math.cos(angle) * dist;
    const startZ = cameraPos.z + Math.sin(angle) * dist - 220;
    const topY = 980 + this.nextRand() * 440;
    const botY = 120 + this.nextRand() * 260;

    // Record mid-cloud strike centre for volumetric cloud-internal flash illumination
    this.lightningWorldPos.set(startX, topY * 0.68 + botY * 0.32, startZ);
    this.lightningFlash = 1.0;

    // 1. Generate jagged main 3D trunk nodes
    let driftX = 0;
    let driftZ = 0;
    for (let i = 0; i <= TRUNK_SEGMENTS; i++) {
      const t = i / TRUNK_SEGMENTS;
      const env = Math.sin(t * Math.PI);
      driftX += (this.nextRand() - 0.5) * 82 * env;
      driftZ += (this.nextRand() - 0.5) * 82 * env;
      this._trunkNodes[i].set(
        startX + driftX + (this.nextRand() - 0.5) * 44 * env,
        THREE.MathUtils.lerp(topY, botY, t),
        startZ + driftZ + (this.nextRand() - 0.5) * 44 * env,
      );
    }

    let segCursor = 0;
    for (let i = 0; i < TRUNK_SEGMENTS; i++) {
      const t0 = i / TRUNK_SEGMENTS;
      const t1 = (i + 1) / TRUNK_SEGMENTS;
      const w0 = THREE.MathUtils.lerp(11.0, 4.2, t0);
      const w1 = THREE.MathUtils.lerp(11.0, 4.2, t1);
      this.writeCrossedRibbonSegment(
        cluster.ribbonPos,
        cluster.ribbonWeight,
        segCursor++,
        this._trunkNodes[i],
        this._trunkNodes[i + 1],
        w0,
        w1,
        1.0,
      );
    }

    // 2. Generate primary 3D forks + fine crackling tertiary tendrils
    let tendrilCursor = 0;
    const tPos = cluster.tendrilPos;

    for (let f = 0; f < FORK_COUNT; f++) {
      const attachIdx = 3 + f * 4 + Math.floor(this.nextRand() * 2);
      const anchor = this._trunkNodes[Math.min(attachIdx, TRUNK_SEGMENTS - 2)];
      const forkAngle = angle + (f - 1) * 1.45 + (this.nextRand() - 0.5) * 0.9;
      const forkReach = 240 + this.nextRand() * 260;
      const forkDrop = 280 + this.nextRand() * 240;

      this._forkNodes[0].copy(anchor);
      for (let s = 1; s <= FORK_SEGMENTS; s++) {
        const ft = s / FORK_SEGMENTS;
        const j = 42 * (1.0 - ft * 0.4);
        this._forkNodes[s].set(
          anchor.x + Math.cos(forkAngle) * forkReach * ft + (this.nextRand() - 0.5) * j,
          anchor.y - forkDrop * ft + (this.nextRand() - 0.5) * 28,
          anchor.z + Math.sin(forkAngle) * forkReach * ft + (this.nextRand() - 0.5) * j,
        );
      }

      for (let s = 0; s < FORK_SEGMENTS; s++) {
        const ft0 = s / FORK_SEGMENTS;
        const ft1 = (s + 1) / FORK_SEGMENTS;
        this.writeCrossedRibbonSegment(
          cluster.ribbonPos,
          cluster.ribbonWeight,
          segCursor++,
          this._forkNodes[s],
          this._forkNodes[s + 1],
          THREE.MathUtils.lerp(6.2, 1.8, ft0),
          THREE.MathUtils.lerp(6.2, 1.8, ft1),
          0.76,
        );

        if (tendrilCursor < TENDRIL_SEGMENTS - 3 && s > 0 && s < FORK_SEGMENTS - 1) {
          this._segA.copy(this._forkNodes[s]);
          const subAngle = forkAngle + (this.nextRand() > 0.5 ? 0.85 : -0.85) + (this.nextRand() - 0.5) * 0.5;
          for (let sub = 0; sub < 3 && tendrilCursor < TENDRIL_SEGMENTS; sub++) {
            this._segB.set(
              this._segA.x + Math.cos(subAngle) * (36 + this.nextRand() * 44),
              this._segA.y - (26 + this.nextRand() * 45),
              this._segA.z + Math.sin(subAngle) * (36 + this.nextRand() * 44),
            );
            const idx = tendrilCursor * 6;
            tPos[idx + 0] = this._segA.x;
            tPos[idx + 1] = this._segA.y;
            tPos[idx + 2] = this._segA.z;
            tPos[idx + 3] = this._segB.x;
            tPos[idx + 4] = this._segB.y;
            tPos[idx + 5] = this._segB.z;
            this._segA.copy(this._segB);
            tendrilCursor++;
          }
        }
      }
    }

    // Fill remaining tendril segments with cloud-top anvil spider-lightning arcs
    while (tendrilCursor < TENDRIL_SEGMENTS) {
      const node = this._trunkNodes[1 + (tendrilCursor % (TRUNK_SEGMENTS - 2))];
      const spiderAngle = this.nextRand() * Math.PI * 2;
      this._segA.copy(node);
      for (let sub = 0; sub < 2 && tendrilCursor < TENDRIL_SEGMENTS; sub++) {
        this._segB.set(
          this._segA.x + Math.cos(spiderAngle) * (45 + this.nextRand() * 65),
          this._segA.y - (15 + this.nextRand() * 40),
          this._segA.z + Math.sin(spiderAngle) * (45 + this.nextRand() * 65),
        );
        const idx = tendrilCursor * 6;
        tPos[idx + 0] = this._segA.x;
        tPos[idx + 1] = this._segA.y;
        tPos[idx + 2] = this._segA.z;
        tPos[idx + 3] = this._segB.x;
        tPos[idx + 4] = this._segB.y;
        tPos[idx + 5] = this._segB.z;
        this._segA.copy(this._segB);
        tendrilCursor++;
      }
    }

    (cluster.ribbonMesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (cluster.ribbonMesh.geometry.attributes.aBranchWeight as THREE.BufferAttribute).needsUpdate = true;
    (cluster.tendrilLines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    const hue = trip > 0.25 ? (this.nextClusterIdx % 2 === 0 ? 0.84 : 0.52) : 0.69;
    this._boltHaloCol.setHSL(hue, 0.96, 0.65);
    cluster.ribbonMat.uniforms.uHaloColor.value.copy(this._boltHaloCol);
    cluster.ribbonMat.uniforms.uCoreColor.value.copy(this._boltCoreCol);
    cluster.ribbonMat.uniforms.uOpacity.value = 1.0;
    cluster.tendrilMat.color.copy(this._boltHaloCol);
    cluster.tendrilMat.opacity = 0.92;

    cluster.age = 0;
    cluster.duration = 0.34 + this.nextRand() * 0.16;
    cluster.active = true;
    cluster.ribbonMesh.visible = true;
    cluster.tendrilLines.visible = true;
  }

  public update(
    time: number,
    dt: number,
    cameraPos: THREE.Vector3,
    stormIntensity: number,
    tripIntensity: number,
    explosionFlash: number,
  ): void {
    this.currTime = time;
    this.currExplosionFlash = explosionFlash;

    // Keep sky dome centred on camera (vertex shader also uses rotation-only view matrix)
    this.skyMesh.position.copy(cameraPos);

    // Supercell 3D branching lightning cadence with realistic double-flicker envelope
    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 4.8);

    if (stormIntensity > 0.32) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.triggerLightningStrike(cameraPos, tripIntensity);
        this.lightningTimer = 0.68 + this.nextRand() * 1.65;
      }
    } else {
      this.lightningTimer = Math.min(this.lightningTimer, 0.18);
    }

    for (let i = 0; i < this.lightningClusters.length; i++) {
      const c = this.lightningClusters[i];
      if (!c.active) continue;
      c.age += dt;
      if (c.age >= c.duration) {
        c.active = false;
        c.ribbonMesh.visible = false;
        c.tendrilLines.visible = false;
        c.ribbonMat.uniforms.uOpacity.value = 0;
        c.tendrilMat.opacity = 0;
        continue;
      }
      const norm = c.age / c.duration;
      const restrike = Math.exp(-Math.pow((norm - 0.34) * 11.0, 2.0)) * 0.72;
      const env = Math.max(0, Math.pow(1.0 - norm, 1.8) + restrike);
      const clampedEnv = Math.min(1.0, env);
      c.ribbonMat.uniforms.uOpacity.value = clampedEnv;
      c.tendrilMat.opacity = clampedEnv * 0.92;
      if (restrike > 0.35) {
        this.lightningFlash = Math.max(this.lightningFlash, restrike * 0.85);
      }
    }

    // Update half-res volumetric cloud pass uniforms
    const cloudUniforms = this.cloudQuadMat.uniforms;
    cloudUniforms.uTime.value = time;
    cloudUniforms.uStorm.value = stormIntensity;
    cloudUniforms.uTrip.value = tripIntensity;
    cloudUniforms.uLightning.value = this.lightningFlash;
    (cloudUniforms.uLightningPos.value as THREE.Vector3).copy(this.lightningWorldPos);
    cloudUniforms.uExplosionFlash.value = explosionFlash;

    // Update early-Z full-res sky dome composite uniforms
    const skyUniforms = this.skyMat.uniforms;
    skyUniforms.uTime.value = time;
    skyUniforms.uStorm.value = stormIntensity;
    skyUniforms.uTrip.value = tripIntensity;
    skyUniforms.uLightning.value = this.lightningFlash;
    skyUniforms.uExplosionFlash.value = explosionFlash;

    // Update 3D volumetric god-ray shafts (molten amber -> chromatic aurora)
    const primaryHue = (0.075 + tripIntensity * 0.72 * (0.5 + 0.5 * Math.sin(time * 0.32))) % 1.0;
    const secondaryHue = (0.52 + tripIntensity * 0.38 * Math.cos(time * 0.27) + 1.0) % 1.0;
    this._rayColPrimary.setHSL(primaryHue, 0.92, 0.56);
    this._rayColSecondary.setHSL(secondaryHue, 0.94, 0.54);

    const baseOpacity = (0.075 + tripIntensity * 0.045) * (1.0 - stormIntensity * 0.32);
    for (let i = 0; i < this.godRayMats.length; i++) {
      const m = this.godRayMats[i];
      m.uniforms.uTime.value = time + i * 0.45;
      m.uniforms.uTrip.value = tripIntensity;
      m.uniforms.uOpacity.value = baseOpacity;
      m.uniforms.uColorPrimary.value.copy(this._rayColPrimary);
      m.uniforms.uColorSecondary.value.copy(this._rayColSecondary);
    }
  }
}
