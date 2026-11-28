import * as THREE from 'three';

const BASALT_VERT = /* glsl */ `
  attribute float aColumnAO;
  attribute vec2 aColumnMod; // x: per-column hash [0, 1], y: rigid upper-column height span
  #ifdef USE_INSTANCING
    attribute float aStackSeed;
  #endif

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying float vColumnAO;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    vec3 localPos = position;
    mat4 worldMat = modelMatrix;
    #ifdef USE_INSTANCING
      // Rigid vertical column-height modulation varies every sea-stack skyline in 1 instanced draw
      localPos.y += aColumnMod.y * sin(aColumnMod.x * 6.2831853 + aStackSeed * 4.712389);
      worldMat = modelMatrix * instanceMatrix;
    #endif

    vec4 wp = worldMat * vec4(localPos, 1.0);
    vWorldPos = wp.xyz;

    // Exact 3x3 cofactor transform preserves outward normals under non-uniform instance scale
    mat3 nm = mat3(worldMat);
    vec3 c0 = cross(nm[1], nm[2]);
    vec3 c1 = cross(nm[2], nm[0]);
    vec3 c2 = cross(nm[0], nm[1]);
    vWorldNormal = safeNormalize(mat3(c0, c1, c2) * normal);
    vColumnAO = aColumnAO;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const BASALT_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform float uStorm;
  uniform float uTrip;
  uniform float uLightning;
  uniform float uExplosionFlash;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying float vColumnAO;

  const float PI = 3.14159265;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  // Trig-free 2D hash for crisp, artefact-free tri-planar sampling at large world coordinates
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec3 noise2Grad(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 du = 6.0 * f * (1.0 - f);

    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));

    float k0 = a;
    float k1 = b - a;
    float k2 = c - a;
    float k3 = a - b - c + d;

    float val = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
    vec2 grad = du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);
    return vec3(val, grad);
  }

  // Distance-LOD mineral fBM: smoothly tapers octaves 3 -> 2 -> 1 -> neutral mean
  float fbm2Lod(vec2 p, float coarseLod, float fineLod) {
    if (coarseLod <= 0.002) {
      return 0.4375;
    }
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    float v = noise2Grad(p).x;
    float wSum = 1.0;

    float w2 = smoothstep(0.15, 0.75, coarseLod);
    if (w2 > 0.002) {
      p = rot * p * 2.04;
      float a2 = 0.5 * w2;
      v += a2 * noise2Grad(p).x;
      wSum += a2;

      if (fineLod > 0.002) {
        p = rot * p * 2.04;
        float a3 = 0.25 * fineLod;
        v += a3 * noise2Grad(p).x;
        wSum += a3;
      }
    }
    float sampled = (v / max(wSum, 1e-4)) * 0.875;
    return mix(0.4375, sampled, coarseLod);
  }

  // Distance-faded tri-planar rock detail & strata sampler: returns (heightVal, strataVal, mineralVal)
  vec3 sampleTriplanarRock(vec3 wp, vec3 triW, float coarseLod, float fineLod, out vec3 bumpGrad) {
    float coarse = 0.5;
    float fine = 0.5;
    vec3 coarseGrad = vec3(0.0);
    vec3 fineGrad = vec3(0.0);

    // Low-frequency volcanic fracture octave across significant tri-planar axes only
    if (coarseLod > 0.002) {
      float coarseSum = 0.5;
      if (triW.z > 0.015) {
        vec3 nXY = noise2Grad(wp.xy * 0.042);
        coarseSum += (nXY.x - 0.5) * triW.z;
        coarseGrad += vec3(nXY.y, nXY.z, 0.0) * triW.z;
      }
      if (triW.x > 0.015) {
        vec3 nZY = noise2Grad(wp.zy * 0.042);
        coarseSum += (nZY.x - 0.5) * triW.x;
        coarseGrad += vec3(0.0, nZY.z, nZY.y) * triW.x;
      }
      if (triW.y > 0.015) {
        vec3 nXZ = noise2Grad(wp.xz * 0.042);
        coarseSum += (nXZ.x - 0.5) * triW.y;
        coarseGrad += vec3(nXZ.y, 0.0, nXZ.z) * triW.y;
      }
      coarse = mix(0.5, coarseSum, coarseLod);
      coarseGrad *= coarseLod;

      // High-frequency rock grain octave (smoothly faded & culled beyond mid-distance)
      if (fineLod > 0.002) {
        float fineSum = 0.5;
        if (triW.z > 0.015) {
          vec3 mXY = noise2Grad(wp.xy * 0.165 + vec2(11.3, 4.7));
          fineSum += (mXY.x - 0.5) * triW.z;
          fineGrad += vec3(mXY.y, mXY.z, 0.0) * triW.z;
        }
        if (triW.x > 0.015) {
          vec3 mZY = noise2Grad(wp.zy * 0.165 + vec2(7.1, 19.2));
          fineSum += (mZY.x - 0.5) * triW.x;
          fineGrad += vec3(0.0, mZY.z, mZY.y) * triW.x;
        }
        if (triW.y > 0.015) {
          vec3 mXZ = noise2Grad(wp.xz * 0.165 + vec2(3.4, 8.9));
          fineSum += (mXZ.x - 0.5) * triW.y;
          fineGrad += vec3(mXZ.y, 0.0, mXZ.z) * triW.y;
        }
        fine = mix(0.5, fineSum, fineLod);
        fineGrad *= 0.55 * fineLod;
      }
    }

    float rockVal = coarse * 0.65 + fine * 0.35;

    // Horizontal columnar basalt cooling joints & volcanic strata bands
    float strataWarp = coarse * 3.8 + fine * 1.1;
    float strataBand = sin(wp.y * 0.16 + strataWarp) * 0.5 + 0.5;
    float jointGroove = smoothstep(0.08, 0.24, abs(fract(wp.y * 0.048 + coarse * 0.18) - 0.5));
    float strata = strataBand * 0.62 + jointGroove * 0.38;

    // Mineral / iron-oxide variation
    float mineral = fbm2Lod(wp.xz * 0.018 + vec2(wp.y * 0.014, -wp.y * 0.009), coarseLod, fineLod);

    // World-space tri-planar bump gradient + cooling-joint step slope
    bumpGrad = coarseGrad + fineGrad;
    bumpGrad.y += cos(wp.y * 0.16 + strataWarp) * 0.26 * (1.0 - triW.y) * coarseLod;

    return vec3(rockVal, strata, mineral);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    float dist = length(cameraPosition - vWorldPos);

    // Seamless atmospheric perspective — early-out past full horizon fog
    float fogAmt = smoothstep(950.0, 6800.0, dist);
    vec3 fogCol = mix(vec3(0.82, 0.42, 0.21), vec3(0.18, 0.13, 0.26), uStorm);
    if (uTrip > 0.05) {
      fogCol = mix(fogCol, vec3(0.32, 0.09, 0.44), clamp(uTrip * 0.55, 0.0, 0.65));
    }
    if (fogAmt >= 0.999) {
      gl_FragColor = vec4(clamp(fogCol, 0.0, 8.0), 1.0);
      return;
    }

    vec3 V = safeNormalize(cameraPosition - vWorldPos);
    vec3 L = safeNormalize(uSunDir);

    vec3 geoN = safeNormalize(vWorldNormal);
    vec3 triW = pow(max(abs(geoN), 1e-4), vec3(4.0));
    triW /= max(triW.x + triW.y + triW.z, 1e-4);

    // Smooth non-inverted distance LOD weights for tri-planar rock octaves
    float fineLod = 1.0 - smoothstep(650.0, 1850.0, dist);
    float coarseLod = 1.0 - smoothstep(1800.0, 4400.0, dist);
    float bumpFade = 1.0 - smoothstep(450.0, 2600.0, dist);

    vec3 bumpGrad;
    vec3 rockSample = sampleTriplanarRock(vWorldPos, triW, coarseLod, fineLod, bumpGrad);
    float rockVal = rockSample.x;
    float strata = rockSample.y;
    float mineral = rockSample.z;

    // Project bump gradient onto surface tangent plane so outward normal remains robust
    vec3 N = geoN;
    if (bumpFade > 0.002) {
      vec3 tangentBump = bumpGrad - geoN * dot(bumpGrad, geoN);
      N = safeNormalize(geoN - tangentBump * (0.42 * bumpFade));
    }

    // ------------------------------------------------------------------
    // 1. PROCEDURAL BASALT ALBEDO, STRATA, MINERAL & HIGHLAND MOSS
    // ------------------------------------------------------------------
    vec3 basaltDark = vec3(0.055, 0.062, 0.078);
    vec3 basaltMid  = vec3(0.115, 0.122, 0.140);
    vec3 ironOxide  = vec3(0.215, 0.125, 0.088);
    vec3 paleQuartz = vec3(0.235, 0.228, 0.215);

    vec3 albedo = mix(basaltDark, basaltMid, clamp(rockVal * 0.72 + strata * 0.38, 0.0, 1.0));
    // Rust-ochre volcanic mineral strata veins
    float rustMask = smoothstep(0.46, 0.82, mineral) * smoothstep(0.32, 0.78, strata);
    albedo = mix(albedo, ironOxide, rustMask * 0.42);
    // Subtle weathered mineral ridges
    float quartzMask = smoothstep(0.68, 0.92, rockVal) * smoothstep(0.55, 0.88, 1.0 - mineral);
    albedo = mix(albedo, paleQuartz, quartzMask * 0.25);

    // Highland coastal moss & golden-olive lichen on upward-facing fractured terraces above splash zone
    float upMask = smoothstep(0.46, 0.84, N.y);
    float altMossMask = smoothstep(32.0, 82.0, vWorldPos.y) * (1.0 - smoothstep(280.0, 560.0, vWorldPos.y));
    float mossPatch = smoothstep(0.34, 0.76, mineral + rockVal * 0.35);
    float mossWeight = upMask * altMossMask * mossPatch * 0.86;
    vec3 mossCol = mix(vec3(0.085, 0.155, 0.068), vec3(0.165, 0.175, 0.062), rockVal);
    albedo = mix(albedo, mossCol, mossWeight);

    // ------------------------------------------------------------------
    // 2. DARKENED WET SPLASH ZONE & WATERLINE FOAM CRUST NEAR SEA LEVEL
    // ------------------------------------------------------------------
    float splashWave = sin(vWorldPos.x * 0.035 + uTime * 1.1) * 3.5 + cos(vWorldPos.z * 0.042 - uTime * 0.9) * 3.0;
    float splashHeight = 28.0 + rockVal * 14.0 + uStorm * 12.0 + splashWave;
    float wetness = 1.0 - smoothstep(2.0, max(splashHeight, 8.0), vWorldPos.y);

    // Physically darkened wet porous basalt + low roughness sheen
    albedo = mix(albedo, albedo * 0.32, wetness * 0.88);
    float roughness = mix(mix(0.86, 0.72, mossWeight), 0.15, wetness);

    // Aerated salt-foam surge collar right at the waterline
    float waterlineFoam =
      (1.0 - smoothstep(-1.0, 9.5 + rockVal * 6.5 + uStorm * 4.5, vWorldPos.y - splashWave * 0.45)) *
      smoothstep(0.28, 0.76, rockVal + 0.18 * sin(vWorldPos.x * 0.12 + uTime * 2.2));
    vec3 foamCol = mix(vec3(0.76, 0.74, 0.72), vec3(0.42, 0.48, 0.58), uStorm);
    albedo = mix(albedo, foamCol, waterlineFoam * 0.62);

    // Deep columnar crevice ambient occlusion
    float ao = clamp(vColumnAO * (0.68 + 0.32 * strata), 0.25, 1.0);

    // ------------------------------------------------------------------
    // 3. DIRECT SUN, GGX WET SPECULAR, SKY/OCEAN BOUNCE & LIGHTNING
    // ------------------------------------------------------------------
    float ndotl = max(dot(N, L), 0.0);
    float ndotv = max(dot(N, V), 1e-4);
    vec3 H = safeNormalize(L + V);
    float ndoth = max(dot(N, H), 1e-4);
    float vdoth = max(dot(V, H), 1e-4);

    // GGX specular (subtle matte rock sheen, gleaming molten highlights on wet splash basalt)
    float alpha = clamp(roughness * roughness, 0.025, 0.92);
    float a2 = alpha * alpha;
    float denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
    float D = a2 / max(PI * denom * denom, 1e-4);
    float F0 = mix(0.035, 0.065, wetness);
    float F = F0 + (1.0 - F0) * pow(max(1.0 - vdoth, 1e-4), 5.0);
    float kG = (roughness + 1.0) * (roughness + 1.0) * 0.125;
    float g1v = ndotv / max(ndotv * (1.0 - kG) + kG, 1e-4);
    float g1l = max(ndotl, 1e-4) / max(max(ndotl, 1e-4) * (1.0 - kG) + kG, 1e-4);
    float ggx = (D * g1v * g1l * F) / max(4.0 * ndotv * max(ndotl, 1e-4), 1e-4);

    vec3 sunCol = mix(vec3(2.35, 1.32, 0.68), vec3(0.85, 0.62, 0.95), uStorm * 0.65);
    if (uTrip > 0.05) {
      sunCol = mix(sunCol, vec3(1.85, 0.82, 1.95), clamp(uTrip * 0.45, 0.0, 0.55));
    }

    // Sky/ocean hemisphere ambient + grazing sunset rim wrap
    vec3 skyAmb = mix(vec3(0.34, 0.36, 0.48), vec3(0.14, 0.13, 0.25), uStorm);
    vec3 oceanBounce = mix(vec3(0.06, 0.16, 0.21), vec3(0.04, 0.07, 0.13), uStorm);
    vec3 ambient = mix(oceanBounce, skyAmb, N.y * 0.5 + 0.5) * albedo * ao * 1.15;

    vec3 directDiff = albedo * sunCol * ndotl * (0.85 + 0.15 * ao);
    vec3 directSpec = sunCol * clamp(ggx, 0.0, 5.5) * ndotl * mix(0.42, 1.85, wetness);

    // Wet Fresnel sky mirror on splash-drenched lower basalt faces
    float fresnel = pow(max(1.0 - ndotv, 1e-4), 4.0);
    vec3 wetSkyReflect = mix(vec3(0.85, 0.44, 0.22), vec3(0.24, 0.18, 0.38), uStorm);
    vec3 col = ambient + directDiff + directSpec + wetSkyReflect * fresnel * wetness * 0.48 * ao;

    // Warm golden rim graze on column edges catching low sun
    float backRim = pow(max(1.0 - ndotv, 1e-4), 3.2) * pow(max(dot(V, -L), 1e-4), 2.0);
    col += mix(vec3(1.15, 0.54, 0.22), vec3(0.52, 0.26, 0.88), uStorm) * backRim * 0.38 * ao;

    // Psychedelic iridescent mineral prism sheen during LSD acts
    if (uTrip > 0.04) {
      float prismHue = fract(vWorldPos.y * 0.0045 + mineral * 1.4 - uTime * 0.12 + fresnel * 0.4);
      vec3 prism = hsv2rgb(vec3(prismHue, 0.85, 0.9));
      col += prism * fresnel * clamp(uTrip * 0.38, 0.0, 0.45) * (0.4 + 0.6 * wetness);
    }

    // Supercell lightning & aerial fireball illumination on cliff spires
    float upLight = max(N.y * 0.55 + 0.45, 0.0);
    col += mix(vec3(0.48, 0.36, 1.05), vec3(0.32, 0.85, 1.25), clamp(uTrip * 0.5, 0.0, 1.0)) *
      albedo * uLightning * (1.8 + wetness * 2.4) * upLight;
    col += vec3(1.25, 0.62, 0.25) * albedo * uExplosionFlash * 1.2;

    // Seamless atmospheric perspective matching OceanSurface & SkyAndClouds
    col = mix(col, fogCol, fogAmt);

    gl_FragColor = vec4(clamp(col, 0.0, 8.0), 1.0);
  }
`;

const MIST_VERT = /* glsl */ `
  attribute vec3 aAnchor;
  attribute vec4 aMistParams; // x: orbitRadius, y: phase, z: size, w: height

  uniform float uTime;

  varying vec2 vUv;
  varying float vSeed;
  varying float vAlpha;
  varying float vMistDetail;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vSeed = aMistParams.y;

    float orbitR = aMistParams.x;
    float angle = aMistParams.y + uTime * (0.045 + 0.015 * sin(aMistParams.y * 3.1));
    float bobY = sin(uTime * 0.38 + aMistParams.y * 5.0) * 4.0;

    vec3 centreWorld = vec3(
      aAnchor.x + cos(angle) * orbitR,
      aMistParams.w + bobY,
      aAnchor.z + sin(angle) * orbitR
    );

    float camDist = length(cameraPosition - centreWorld);
    float nearFade = smoothstep(32.0, 120.0, camDist);
    float farFade = 1.0 - smoothstep(2200.0, 5600.0, camDist);
    vAlpha = nearFade * farFade * 0.34;
    vMistDetail = 1.0 - smoothstep(900.0, 2400.0, camDist);

    // Vertex-cull invisible/distant mist billboards to avoid wasted fragment overdraw
    if (vAlpha < 0.004) {
      vWorldPos = vec3(0.0);
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // Horizontally wide drifting mist billboard oriented toward camera
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float sz = aMistParams.z;
    vec3 worldPos = centreWorld + camRight * (position.x * sz * 1.85) + camUp * (position.y * sz * 0.72);
    vWorldPos = worldPos;

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const MIST_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform float uStorm;
  uniform float uTrip;
  uniform float uLightning;

  varying vec2 vUv;
  varying float vSeed;
  varying float vAlpha;
  varying float vMistDetail;
  varying vec3 vWorldPos;

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
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    if (vAlpha < 0.004) discard;

    vec2 c = vUv * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;

    // Slowly drifting wispy coastal sea-mist curl pattern (2nd octave distance-culled)
    vec2 driftUv = vUv * vec2(3.4, 2.2) + vec2(uTime * 0.055 + vSeed, -uTime * 0.02 + vSeed * 0.7);
    float n1 = noise2(driftUv);
    float cloud = n1;
    if (vMistDetail > 0.002) {
      float n2 = noise2(driftUv * 2.3 - vec2(uTime * 0.04, uTime * 0.03));
      cloud = mix(n1, n1 * 0.62 + n2 * 0.38, vMistDetail);
    }

    float radial = pow(max(1.0 - r2, 1e-4), 1.9);
    float baseSoft = smoothstep(0.0, 0.35, vUv.y) * (1.0 - smoothstep(0.65, 1.0, vUv.y));
    float alpha = radial * baseSoft * smoothstep(0.24, 0.86, cloud + radial * 0.32) * vAlpha;
    if (alpha < 0.004) discard;

    // Golden-hour forward Mie scattering + cool sea-spray bounce
    vec3 V = safeNormalize(vWorldPos - cameraPosition);
    vec3 L = safeNormalize(uSunDir);
    float mie = pow(max(dot(V, L), 1e-4), 3.5) * 0.72;

    vec3 mistCalm = vec3(0.84, 0.62, 0.48);
    vec3 mistStorm = vec3(0.26, 0.24, 0.38);
    vec3 col = mix(mistCalm, mistStorm, uStorm);
    col += mix(vec3(1.15, 0.58, 0.26), vec3(0.75, 0.38, 1.15), clamp(uTrip * 0.6, 0.0, 0.7)) * mie * (1.0 - uStorm * 0.4);
    col += vec3(0.55, 0.46, 1.15) * uLightning * 0.55;

    gl_FragColor = vec4(clamp(col, 0.0, 4.0), clamp(alpha, 0.0, 0.42));
  }
`;

interface StackPlacement {
  x: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotY: number;
  seed: number;
}

/**
 * Emits a triangle with verified outward winding and outward unit face normal.
 * If (pB - pA) x (pC - pA) disagrees with expectedOutward, swaps pB and pC so
 * front-face culling and lighting normals are always strictly outward-pointing.
 */
function pushOutwardTriangle(
  positions: number[],
  normals: number[],
  aos: number[],
  colMods: number[],
  pA: [number, number, number],
  pB: [number, number, number],
  pC: [number, number, number],
  aoA: number,
  aoB: number,
  aoC: number,
  colHash: number,
  modA: number,
  modB: number,
  modC: number,
  expectedOutward: [number, number, number],
): void {
  const e1x = pB[0] - pA[0];
  const e1y = pB[1] - pA[1];
  const e1z = pB[2] - pA[2];
  const e2x = pC[0] - pA[0];
  const e2y = pC[1] - pA[1];
  const e2z = pC[2] - pA[2];

  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;

  const dot = nx * expectedOutward[0] + ny * expectedOutward[1] + nz * expectedOutward[2];
  let b = pB;
  let c = pC;
  let bAo = aoB;
  let cAo = aoC;
  let bMod = modB;
  let cMod = modC;
  if (dot < 0) {
    b = pC;
    c = pB;
    bAo = aoC;
    cAo = aoB;
    bMod = modC;
    cMod = modB;
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-6) return;
  const invLen = 1 / len;
  nx *= invLen;
  ny *= invLen;
  nz *= invLen;

  positions.push(pA[0], pA[1], pA[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  aos.push(aoA, bAo, cAo);
  colMods.push(colHash, modA, colHash, bMod, colHash, cMod);
}

/**
 * Generates a clustered hexagonal columnar basalt cliff spire geometry.
 * Columns are packed on a true axial hexagonal grid with stepped fracture tiers,
 * bevelled fractured polygonal crowns, outward-verified normals, crevice AO, and
 * per-column rigid height-modulation attributes for single-draw instanced variety.
 */
function buildBasaltClusterGeometry(seed: number): THREE.BufferGeometry {
  let rngState = seed;
  const rand = (): number => {
    rngState = (rngState * 16807) % 2147483647;
    return (rngState - 1) / 2147483646;
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const aos: number[] = [];
  const colMods: number[] = [];

  const hexCellRadius = 8.4;
  const sqrt3 = Math.sqrt(3);
  const maxRing = 3;

  // Build stepped hexagonal basalt columns on axial hex lattice (q, r)
  for (let q = -maxRing; q <= maxRing; q++) {
    for (let r = -maxRing; r <= maxRing; r++) {
      const s = -q - r;
      const hexDist = Math.max(Math.abs(q), Math.abs(r), Math.abs(s));
      if (hexDist > maxRing) continue;

      // Organically omit some outer ring columns for jagged, asymmetric Ridley Scott silhouettes
      const dropChance = hexDist === 3 ? 0.34 : hexDist === 2 ? 0.10 : 0.0;
      if (rand() < dropChance) continue;

      const cx = hexCellRadius * 1.5 * q;
      const cz = hexCellRadius * sqrt3 * (r + q * 0.5);
      const radialDist = Math.hypot(cx, cz);

      // Height cascade: towering central spire -> stepped mid terraces -> coastal causeway pillars
      let hBase: number;
      if (hexDist === 0) {
        hBase = 295 + rand() * 50;
      } else if (hexDist === 1) {
        hBase = 195 + rand() * 88;
      } else if (hexDist === 2) {
        hBase = 98 + rand() * 92;
      } else {
        hBase = 28 + rand() * 64;
      }

      // Subtle lean away from centre for dramatic geological fracturing
      const leanScale = 0.014 + rand() * 0.022;
      const dirLen = Math.max(radialDist, 1.0);
      const leanX = (cx / dirLen) * leanScale + (rand() - 0.5) * 0.018;
      const leanZ = (cz / dirLen) * leanScale + (rand() - 0.5) * 0.018;

      const baseY = -48.0; // Extends deep below ocean wave troughs
      const topY = hBase;
      const colRadius = hexCellRadius * (0.93 + rand() * 0.06);

      // Slight fractured roof plane tilt (basalt columns cleave along slanted joint planes)
      const capTiltX = (rand() - 0.5) * 0.24;
      const capTiltZ = (rand() - 0.5) * 0.24;

      // Vertical column tiers: base -> waterline flare -> upper fracture joint -> bevelled crown
      const midY = topY * (0.48 + rand() * 0.14);
      const bevelY = Math.max(midY + 4.0, topY - (3.5 + rand() * 3.0));
      const tierY = [baseY, midY, bevelY, topY];
      const tierR = [colRadius * 1.07, colRadius * 1.0, colRadius * 0.96, colRadius * 0.78];

      // Rigid upper-column height modulation span (anchored at baseY, rigid lift on upper tiers)
      const colHash = rand();
      const maxDeltaY = Math.min(28.0, (midY - baseY) * 0.34);
      const tierMod = [0.0, maxDeltaY, maxDeltaY, maxDeltaY];

      // Ambient occlusion: inner hex crevices darker, outer ridges and high crowns brighter
      const radialAO = THREE.MathUtils.clamp(0.45 + (hexDist / maxRing) * 0.42, 0.45, 0.95);
      const tierAO = [radialAO * 0.62, radialAO * 0.84, radialAO * 0.96, 1.0];

      // Precompute 6 corner coordinates for each of the 4 vertical rings
      const rings: [number, number, number][][] = [];
      for (let t = 0; t < 4; t++) {
        const ring: [number, number, number][] = [];
        const yNominal = tierY[t];
        const rRad = tierR[t];
        const ySpan = yNominal - baseY;
        const centerX = cx + leanX * ySpan;
        const centerZ = cz + leanZ * ySpan;

        for (let k = 0; k < 6; k++) {
          const theta = (k * Math.PI) / 3;
          const vx = centerX + Math.cos(theta) * rRad;
          const vz = centerZ + Math.sin(theta) * rRad;
          // Apply cleaved rock tilt on the top crown rings
          const tiltAmt = t >= 2 ? (vx - centerX) * capTiltX + (vz - centerZ) * capTiltZ : 0;
          const vy = yNominal + tiltAmt;
          ring.push([vx, vy, vz]);
        }
        rings.push(ring);
      }

      // Emit crisp vertical hexagonal faces & chamfered crown bevel faces
      for (let t = 0; t < 3; t++) {
        const lower = rings[t];
        const upper = rings[t + 1];
        const aoLo = tierAO[t];
        const aoHi = tierAO[t + 1];
        const modLo = tierMod[t];
        const modHi = tierMod[t + 1];
        const isBevel = t === 2;

        for (let k = 0; k < 6; k++) {
          const kNext = (k + 1) % 6;
          const midTheta = ((k + 0.5) * Math.PI) / 3;
          const outDir: [number, number, number] = isBevel
            ? [Math.cos(midTheta) * 0.78, 0.62, Math.sin(midTheta) * 0.78]
            : [Math.cos(midTheta), 0.0, Math.sin(midTheta)];

          const b0 = lower[k];
          const b1 = lower[kNext];
          const t0 = upper[k];
          const t1 = upper[kNext];

          pushOutwardTriangle(positions, normals, aos, colMods, b0, t0, b1, aoLo, aoHi, aoLo, colHash, modLo, modHi, modLo, outDir);
          pushOutwardTriangle(positions, normals, aos, colMods, b1, t0, t1, aoLo, aoHi, aoHi, colHash, modLo, modHi, modHi, outDir);
        }
      }

      // Emit cleaved hexagonal crown top cap with verified upward (+Y) normal
      const crownRing = rings[3];
      const topSpan = topY - baseY;
      const crownCentre: [number, number, number] = [
        cx + leanX * topSpan,
        topY + 1.4,
        cz + leanZ * topSpan,
      ];
      const upDir: [number, number, number] = [0, 1, 0];
      for (let k = 0; k < 6; k++) {
        const kNext = (k + 1) % 6;
        pushOutwardTriangle(
          positions,
          normals,
          aos,
          colMods,
          crownCentre,
          crownRing[kNext],
          crownRing[k],
          1.0,
          0.98,
          0.98,
          colHash,
          maxDeltaY,
          maxDeltaY,
          maxDeltaY,
          upDir,
        );
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('aColumnAO', new THREE.Float32BufferAttribute(aos, 1));
  geo.setAttribute('aColumnMod', new THREE.Float32BufferAttribute(colMods, 2));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Builds GPU-instanced drifting sea-mist collars orbiting the wet splash bases
 * of all columnar basalt sea-stacks.
 */
function buildSeaMistCollarGeometry(placements: StackPlacement[]): THREE.InstancedBufferGeometry {
  const puffsPerStack = 5;
  const totalPuffs = placements.length * puffsPerStack;

  const baseQuad = new THREE.PlaneGeometry(1, 1);
  const instGeo = new THREE.InstancedBufferGeometry();
  instGeo.index = baseQuad.index;
  instGeo.attributes.position = baseQuad.attributes.position;
  instGeo.attributes.uv = baseQuad.attributes.uv;
  instGeo.instanceCount = totalPuffs;

  const anchors = new Float32Array(totalPuffs * 3);
  const params = new Float32Array(totalPuffs * 4);

  let seed = 91827;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  let idx = 0;
  for (let s = 0; s < placements.length; s++) {
    const p = placements[s];
    const baseRadius = 38.0 * Math.max(p.sx, p.sz);
    for (let k = 0; k < puffsPerStack; k++) {
      anchors[idx * 3] = p.x;
      anchors[idx * 3 + 1] = 0;
      anchors[idx * 3 + 2] = p.z;

      const orbitR = baseRadius * (0.72 + rand() * 0.45);
      const phase = (k / puffsPerStack) * Math.PI * 2 + rand() * 0.85;
      const size = baseRadius * (0.95 + rand() * 0.55);
      const height = 14.0 + rand() * 28.0;

      params[idx * 4] = orbitR;
      params[idx * 4 + 1] = phase;
      params[idx * 4 + 2] = size;
      params[idx * 4 + 3] = height;
      idx++;
    }
  }

  instGeo.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchors, 3));
  instGeo.setAttribute('aMistParams', new THREE.InstancedBufferAttribute(params, 4));
  return instGeo;
}

export class SeaStacks {
  public readonly group = new THREE.Group();

  private readonly rockMat: THREE.ShaderMaterial;
  private readonly mistMat: THREE.ShaderMaterial;

  constructor(sunDirection: THREE.Vector3) {
    // Canyon corridor & monumental vista placements — verified clear of all 88s flight splines
    const rawPlacements: [number, number, number, number][] = [
      // Inner canyon corridor framing Acts I-II without clipping hero/bandit curves
      [-210, -320, 1.15, 1.12],
      [230, -480, 1.25, 1.32],
      [-340, -820, 1.55, 1.55],
      [290, -1080, 1.38, 1.28],
      [-260, -1480, 1.58, 1.32],
      [390, -1720, 1.48, 1.30],
      [-520, -2100, 2.05, 1.98],
      [480, -2450, 1.92, 1.82],
      // Flanking mid-ground cathedral spires
      [-760, -500, 2.25, 2.08],
      [780, -780, 2.15, 1.92],
      [-860, -1420, 2.55, 2.28],
      [840, -1620, 2.42, 2.18],
      [-450, 280, 1.75, 1.62],
      [510, 340, 1.88, 1.72],
      // Distant Ridley Scott horizon megastructures
      [-1150, -1100, 2.95, 2.55],
      [1180, -1250, 2.82, 2.40],
      [-620, -2850, 2.35, 2.28],
      [640, -3050, 2.58, 2.45],
      [-1360, -2120, 3.10, 2.65],
      [1380, -2280, 3.00, 2.55],
    ];

    const placements: StackPlacement[] = rawPlacements.map(([x, z, sx, sy], idx) => ({
      x,
      z,
      sx,
      sy,
      sz: sx * (0.86 + (idx % 3) * 0.13),
      rotY: idx * 1.173,
      seed: idx * 1.6180339,
    }));

    this.rockMat = new THREE.ShaderMaterial({
      vertexShader: BASALT_VERT,
      fragmentShader: BASALT_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDirection.clone() },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
        uExplosionFlash: { value: 0 },
      },
    });

    // Consolidate all 20 hexagonal basalt sea-stacks into 1 single instanced draw call
    // with per-instance deterministic column-height seeds for distinct organic silhouettes.
    const rockGeo = buildBasaltClusterGeometry(1337);
    const stackSeeds = new Float32Array(placements.length);
    const rockInst = new THREE.InstancedMesh(rockGeo, this.rockMat, placements.length);
    rockInst.frustumCulled = false;

    const dummy = new THREE.Object3D();
    placements.forEach((p, idx) => {
      dummy.position.set(p.x, 0, p.z);
      dummy.scale.set(p.sx, p.sy, p.sz);
      dummy.rotation.set(0, p.rotY, (idx % 2 === 0 ? 1 : -1) * 0.025);
      dummy.updateMatrix();
      rockInst.setMatrixAt(idx, dummy.matrix);
      stackSeeds[idx] = p.seed;
    });
    rockGeo.setAttribute('aStackSeed', new THREE.InstancedBufferAttribute(stackSeeds, 1));
    rockInst.instanceMatrix.needsUpdate = true;
    this.group.add(rockInst);

    // Drifting coastal sea-mist collars hugging the basalt splash zone
    this.mistMat = new THREE.ShaderMaterial({
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDirection.clone() },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    const mistGeo = buildSeaMistCollarGeometry(placements);
    const mistMesh = new THREE.Mesh(mistGeo, this.mistMat);
    mistMesh.frustumCulled = false;
    mistMesh.renderOrder = 2;
    this.group.add(mistMesh);
  }

  public update(
    time: number,
    stormIntensity: number,
    tripIntensity: number,
    lightningFlash: number,
    explosionFlash: number,
  ): void {
    this.rockMat.uniforms.uTime.value = time;
    this.rockMat.uniforms.uStorm.value = stormIntensity;
    this.rockMat.uniforms.uTrip.value = tripIntensity;
    this.rockMat.uniforms.uLightning.value = lightningFlash;
    this.rockMat.uniforms.uExplosionFlash.value = explosionFlash;

    this.mistMat.uniforms.uTime.value = time;
    this.mistMat.uniforms.uStorm.value = stormIntensity;
    this.mistMat.uniforms.uTrip.value = tripIntensity;
    this.mistMat.uniforms.uLightning.value = lightningFlash;
  }
}
