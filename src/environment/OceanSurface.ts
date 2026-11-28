import * as THREE from 'three';

const INNER_HALF = 1600;
const INNER_CELL = 20;
const OUTER_HALF = 8000;
const OUTER_CELL = 100;
const MAX_SHOCKWAVES = 3;
const SPRAY_PARTICLE_COUNT = 240;

const OCEAN_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uStorm;
  uniform vec3 uShockOrigin[3];
  uniform vec3 uShockParams[3]; // x: radius, y: strength, z: bandScale
  uniform vec3 uJetPos;
  uniform vec2 uJetFwdXZ;
  uniform float uJetWakeStrength;

  varying vec3 vWorldPos;
  varying vec3 vWaveNormal;
  varying float vWaveHeight;
  varying float vCrestFold;
  varying float vShockGlow;
  varying float vWakeFoam;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  // Evaluates one Gerstner wave and accumulates 3D displacement + analytical tangent/bitangent
  void addGerstnerWave(
    vec2 xz,
    vec2 dir,
    float wavelength,
    float amplitude,
    float steepness,
    float speedMul,
    float phaseOffset,
    inout vec3 disp,
    inout vec3 tangent,
    inout vec3 bitangent
  ) {
    float k = 6.2831853 / max(wavelength, 1.0);
    float omega = sqrt(9.81 * k) * speedMul;
    float wa = k * amplitude;
    float theta = k * dot(dir, xz) - omega * uTime + phaseOffset;
    float s = sin(theta);
    float c = cos(theta);

    // 3D Gerstner orbital displacement
    float qA = steepness * amplitude;
    disp.x += qA * dir.x * c;
    disp.y += amplitude * s;
    disp.z += qA * dir.y * c;

    // Exact partial derivatives dP/dx (tangent) and dP/dz (bitangent)
    float qWaS = steepness * wa * s;
    float waC = wa * c;

    tangent.x -= dir.x * dir.x * qWaS;
    tangent.y += dir.x * waC;
    tangent.z -= dir.x * dir.y * qWaS;

    bitangent.x -= dir.x * dir.y * qWaS;
    bitangent.y += dir.y * waC;
    bitangent.z -= dir.y * dir.y * qWaS;
  }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec2 xz = wp.xz;

    // Gentle distance fade on shortest Gerstner octaves so far horizon stays silk-smooth
    float camDist = length(cameraPosition.xz - xz);
    float nearWeight = 1.0 - smoothstep(1400.0, 4800.0, camDist);
    float midWeight = 1.0 - smoothstep(2600.0, 6800.0, camDist);
    float stormBoost = 1.0 + uStorm * 0.34;
    float steepBoost = 1.0 + uStorm * 0.22;

    vec3 disp = vec3(0.0);
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 bitangent = vec3(0.0, 0.0, 1.0);

    // 8 non-harmonic Gerstner wave octaves (Pacific primary swells -> cross-seas -> steep chop)
    // Total sum(Q * k * A) stays safely <= 0.42 even at peak storm, preventing inverted loops.
    addGerstnerWave(xz, vec2( 0.841,  0.541), 620.0, 4.40 * stormBoost,            0.66 * steepBoost, 1.45, 0.31, disp, tangent, bitangent);
    addGerstnerWave(xz, vec2(-0.418,  0.908), 418.0, 3.05 * stormBoost,            0.64 * steepBoost, 1.52, 1.74, disp, tangent, bitangent);
    addGerstnerWave(xz, vec2( 0.951, -0.309), 292.0, 2.05 * stormBoost,            0.62 * steepBoost, 1.58, 3.19, disp, tangent, bitangent);
    addGerstnerWave(xz, vec2( 0.553,  0.833), 196.0, 1.38 * stormBoost * midWeight, 0.58 * steepBoost, 1.66, 0.88, disp, tangent, bitangent);
    addGerstnerWave(xz, vec2(-0.761,  0.649), 138.0, 0.92 * stormBoost * midWeight, 0.56 * steepBoost, 1.74, 4.52, disp, tangent, bitangent);
    addGerstnerWave(xz, vec2( 0.281, -0.960),  94.0, 0.58 * stormBoost * nearWeight, 0.52 * steepBoost, 1.84, 2.41, disp, tangent, bitangent);
    addGerstnerWave(xz, vec2(-0.921, -0.390),  68.0, 0.36 * stormBoost * nearWeight, 0.48 * steepBoost, 1.92, 5.13, disp, tangent, bitangent);
    addGerstnerWave(xz, vec2( 0.682, -0.731),  49.0, 0.22 * stormBoost * nearWeight, 0.44 * steepBoost, 2.02, 1.27, disp, tangent, bitangent);

    // Expanding aerial detonation shockwave rings: concentric physical crests + slope normals
    float shockGlow = 0.0;
    for (int i = 0; i < 3; i++) {
      float strength = uShockParams[i].y;
      if (strength > 0.004) {
        float radius = uShockParams[i].x;
        float bandScale = uShockParams[i].z;
        vec2 toPt = xz - uShockOrigin[i].xz;
        float distShock = length(toPt);
        vec2 radDir = distShock > 1e-4 ? toPt / distShock : vec2(1.0, 0.0);

        float delta = distShock - radius;
        float envArg = delta * bandScale;
        float envelope = exp(-(envArg * envArg)) * strength;

        // Concentric harmonic wave train behind the leading pressure front
        float waveFreq = 0.095;
        float wavePhase = delta * waveFreq;
        float amp = 16.5;
        float waveH = envelope * amp * sin(wavePhase);

        // Analytical radial derivative d(waveH)/dr for crisp shockwave normal lighting
        float dH_dr = envelope * amp * (waveFreq * cos(wavePhase) - 2.0 * envArg * bandScale * sin(wavePhase));
        dH_dr = clamp(dH_dr, -1.6, 1.6);

        disp.y += waveH;
        tangent.y += dH_dr * radDir.x;
        bitangent.y += dH_dr * radDir.y;

        // Sharp leading luminous wavefront + trailing aerated foam ring
        float leadRing = exp(-((delta * bandScale * 1.65) * (delta * bandScale * 1.65))) * strength;
        float trailRing = exp(-(((delta + 55.0) * bandScale * 0.95) * ((delta + 55.0) * bandScale * 0.95))) * strength * 0.48;
        shockGlow = max(shockGlow, leadRing + trailRing);
      }
    }

    // Low-altitude jet downwash trough & twin V-wake ridges beneath hero jet (hero.position.y < 95)
    float wakeFoam = 0.0;
    if (uJetWakeStrength > 0.004) {
      vec2 jetFwd = length(uJetFwdXZ) > 1e-4 ? normalize(uJetFwdXZ) : vec2(0.0, -1.0);
      vec2 jetRight = vec2(-jetFwd.y, jetFwd.x);
      vec2 rel = xz - uJetPos.xz;

      // along > 0 is behind the jet along its flight path
      float along = dot(rel, -jetFwd);
      float across = dot(rel, jetRight);
      float absAcross = abs(across);

      float alongEnv = smoothstep(-24.0, 10.0, along) * (1.0 - smoothstep(140.0, 440.0, along));
      if (alongEnv > 0.002) {
        float halfWidth = 6.5 + max(along, 0.0) * 0.105;
        float normAcross = absAcross / max(halfWidth, 1.0);

        // Centre downwash depression flanked by twin raised Kelvin wake ridges
        float centreTrough = -exp(-(normAcross * normAcross) * 2.6) * 2.4;
        float ridgeArg = normAcross - 1.0;
        float twinRidge = exp(-(ridgeArg * ridgeArg) * 7.5) * 1.85;
        float wakeH = (centreTrough + twinRidge) * alongEnv * uJetWakeStrength;

        // Lateral derivative for wake ridge glints
        float dCentre = 2.0 * 2.6 * normAcross * exp(-(normAcross * normAcross) * 2.6) * 2.4;
        float dRidge = -2.0 * 7.5 * ridgeArg * exp(-(ridgeArg * ridgeArg) * 7.5) * 1.85;
        float dH_dAcross = ((dCentre + dRidge) / max(halfWidth, 1.0)) * alongEnv * uJetWakeStrength * (across >= 0.0 ? 1.0 : -1.0);
        dH_dAcross = clamp(dH_dAcross, -0.75, 0.75);

        disp.y += wakeH;
        tangent.y += dH_dAcross * jetRight.x;
        bitangent.y += dH_dAcross * jetRight.y;

        // Aerated jet-wash centre scar + twin foam arms
        float centreFoam = exp(-(normAcross * normAcross) * 1.8);
        float armFoam = exp(-(ridgeArg * ridgeArg) * 9.0) * 0.92;
        wakeFoam = clamp((centreFoam + armFoam) * alongEnv * uJetWakeStrength, 0.0, 1.35);
      }
    }

    wp.xyz += disp;

    // Right-handed outward (+Y) analytical wave normal: B x T = (0, 0, 1) x (1, 0, 0) = (0, +1, 0)
    vec3 N = safeNormalize(cross(bitangent, tangent));
    if (N.y < 0.12) {
      N = safeNormalize(vec3(N.x, 0.12, N.z));
    }

    // Jacobian determinant of horizontal Gerstner mapping for breaking-crest foam
    float jacobian = tangent.x * bitangent.z - tangent.z * bitangent.x;
    float crestFold = clamp((1.0 - jacobian) * 1.65, 0.0, 1.0);

    vWorldPos = wp.xyz;
    vWaveNormal = N;
    vWaveHeight = disp.y;
    vCrestFold = crestFold;
    vShockGlow = shockGlow;
    vWakeFoam = wakeFoam;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const OCEAN_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform float uStorm;
  uniform float uTrip;
  uniform float uLightning;
  uniform float uExplosionFlash;
  uniform vec3 uJetPos;
  uniform vec2 uJetFwdXZ;
  uniform float uJetWakeStrength;

  varying vec3 vWorldPos;
  varying vec3 vWaveNormal;
  varying float vWaveHeight;
  varying float vCrestFold;
  varying float vShockGlow;
  varying float vWakeFoam;

  const float PI = 3.14159265;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  // Trig-free hash for crisp, artefact-free world-space coordinates on Apple Silicon
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Value noise returning value + analytical gradient (df/dx, df/dy) for capillary detail normals
  vec3 noise2DGrad(vec2 p) {
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

  float fbmFoam(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 3; i++) {
      v += a * noise2DGrad(p).x;
      p = rot * p * 2.07;
      a *= 0.5;
    }
    return v;
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  // Procedural sky reflection matching SkyAndClouds horizon, zenith, and twin-eclipse sun
  vec3 sampleSkyReflection(vec3 R, vec3 L, float storm, float trip) {
    float ry = clamp(R.y, 0.0, 1.0);
    float horizonCurve = pow(max(1.0 - ry, 1e-4), 2.4);

    vec3 horizonCalm = vec3(0.96, 0.46, 0.21);
    vec3 zenithCalm  = vec3(0.08, 0.19, 0.38);
    vec3 horizonStorm = vec3(0.24, 0.16, 0.34);
    vec3 zenithStorm  = vec3(0.04, 0.05, 0.12);

    vec3 horizonCol = mix(horizonCalm, horizonStorm, storm);
    vec3 zenithCol = mix(zenithCalm, zenithStorm, storm);
    vec3 sky = mix(zenithCol, horizonCol, horizonCurve);

    // Reflected solar glow & twin-sun companion sheen
    float sunDot = max(dot(R, L), 0.0);
    float mieGlow = pow(max(sunDot, 1e-4), 10.0) * 0.65 + pow(max(sunDot, 1e-4), 64.0) * 1.1;
    vec3 sunTint = mix(vec3(1.25, 0.65, 0.28), vec3(1.15, 0.34, 0.92), clamp(trip * 0.55, 0.0, 1.0));
    sky += sunTint * mieGlow * (1.0 - storm * 0.35);

    // Subtle reflected cloud-deck silhouette bands
    vec2 cloudUv = R.xz / max(ry + 0.24, 0.24);
    float cloudBand = fbmFoam(cloudUv * 0.65 + vec2(uTime * 0.014, -uTime * 0.01));
    vec3 cloudTint = mix(vec3(0.92, 0.48, 0.24), vec3(0.14, 0.10, 0.24), storm);
    sky = mix(sky, cloudTint, smoothstep(0.45, 0.82, cloudBand) * (0.24 + 0.32 * storm));

    return sky;
  }

  void main() {
    vec3 V = safeNormalize(cameraPosition - vWorldPos);
    vec3 L = safeNormalize(uSunDir);
    float dist = length(cameraPosition - vWorldPos);

    // Base analytical Gerstner wave normal
    vec3 geoN = safeNormalize(vWaveNormal);

    // Construct singularity-free tangent-space basis aligned with world XZ (geoN.y >= 0.12)
    vec3 T = safeNormalize(cross(geoN, vec3(0.0, 0.0, 1.0)));
    vec3 B = safeNormalize(cross(T, geoN));

    // Dual-octave capillary detail normals (wind-advected, distance-attenuated for zero horizon aliasing)
    float detailFade = 1.0 - smoothstep(220.0, 3200.0, dist);
    float microFade = 1.0 - smoothstep(90.0, 1250.0, dist);

    vec2 capUv1 = vWorldPos.xz * 0.085 + vec2(uTime * 0.52, -uTime * 0.38);
    vec2 capUv2 = vWorldPos.xz * 0.235 + vec2(-uTime * 0.74, uTime * 0.61);
    vec3 cap1 = noise2DGrad(capUv1);
    vec3 cap2 = noise2DGrad(capUv2);

    float stormChop = 1.0 + uStorm * 0.45;
    vec2 capGrad =
      cap1.yz * (0.19 * detailFade * stormChop) +
      cap2.yz * (0.11 * microFade * stormChop);

    // Extra fine surface chop disturbance inside the jet wake
    float fineWakeFoam = 0.0;
    if (uJetWakeStrength > 0.004) {
      vec2 jetFwd = length(uJetFwdXZ) > 1e-4 ? normalize(uJetFwdXZ) : vec2(0.0, -1.0);
      vec2 jetRight = vec2(-jetFwd.y, jetFwd.x);
      vec2 rel = vWorldPos.xz - uJetPos.xz;
      float along = dot(rel, -jetFwd);
      float across = abs(dot(rel, jetRight));
      float alongEnv = smoothstep(-20.0, 8.0, along) * (1.0 - smoothstep(120.0, 420.0, along));
      if (alongEnv > 0.002) {
        float halfW = 5.5 + max(along, 0.0) * 0.105;
        float normAcross = across / max(halfW, 1.0);
        float turb = fbmFoam(vec2(along * 0.08 - uTime * 2.8, across * 0.14));
        float centreStreak = exp(-(normAcross * normAcross) * 2.2) * (0.55 + 0.75 * turb);
        float armArg = normAcross - 1.0;
        float twinArms = exp(-(armArg * armArg) * 10.5) * (0.65 + 0.65 * turb);
        fineWakeFoam = clamp((centreStreak + twinArms) * alongEnv * uJetWakeStrength, 0.0, 1.25);

        // High-frequency turbulent jet-wash normal perturbation
        vec3 wakeCap = noise2DGrad(vec2(along * 0.24 - uTime * 4.5, across * 0.34));
        capGrad += wakeCap.yz * (0.36 * fineWakeFoam * detailFade);
      }
    }

    vec3 N = safeNormalize(geoN - T * capGrad.x - B * capGrad.y);
    if (N.y < 0.08) {
      N = safeNormalize(vec3(N.x, 0.08, N.z));
    }

    float ndotv = max(dot(N, V), 1e-4);
    float ndotl = max(dot(N, L), 1e-4);

    // ------------------------------------------------------------------
    // 1. BEER-LAMBERT DEEP-TEAL ABSORPTION & SUBSURFACE WAVE SCATTER
    // ------------------------------------------------------------------
    float crestNorm = clamp((vWaveHeight + 6.0) / 15.0, 0.0, 1.0);
    float opticalDepth = mix(15.0, 2.4, crestNorm) / max(ndotv, 0.20);
    // Absorption coefficients (red attenuates rapidly, green/blue penetrate deep teal)
    vec3 beerTrans = exp(-opticalDepth * vec3(0.42, 0.13, 0.08));

    vec3 abyssalCol = mix(vec3(0.007, 0.028, 0.056), vec3(0.007, 0.014, 0.036), uStorm);
    vec3 scatterTeal = mix(vec3(0.025, 0.28, 0.34), vec3(0.018, 0.13, 0.21), uStorm);
    if (uTrip > 0.02) {
      abyssalCol = mix(abyssalCol, vec3(0.032, 0.008, 0.078), clamp(uTrip * 0.62, 0.0, 0.72));
      scatterTeal = mix(scatterTeal, vec3(0.06, 0.32, 0.46), clamp(uTrip * 0.5, 0.0, 0.65));
    }

    vec3 waterBody = mix(abyssalCol, scatterTeal, clamp(beerTrans.g * 0.62, 0.0, 0.72));

    // Backlit translucent jade-turquoise glow through peaked Gerstner crests
    vec3 sssDir = safeNormalize(-L + N * 0.48);
    float sssForward = pow(max(dot(V, sssDir), 1e-4), 3.0);
    float crestThin = smoothstep(0.6, 6.2, vWaveHeight) * (0.45 + 0.55 * vCrestFold);
    vec3 sssCol = mix(vec3(0.06, 0.48, 0.46), vec3(0.12, 0.56, 0.74), clamp(uTrip * 0.5, 0.0, 0.6));
    waterBody += sssCol * (0.22 + sssForward * 1.45) * crestThin * (1.0 - uStorm * 0.42);

    // ------------------------------------------------------------------
    // 2. SCHLICK FRESNEL SKY & LIQUID-CHROME REFLECTIONS
    // ------------------------------------------------------------------
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.015);
    R = safeNormalize(R);

    float fresnel = 0.02 + 0.98 * pow(max(1.0 - ndotv, 1e-4), 5.0);
    vec3 skyReflect = sampleSkyReflection(R, L, uStorm, uTrip);

    // Psychedelic liquid-chrome oil-slick iridescence during LSD acts (Acts III-IV)
    if (uTrip > 0.02) {
      float oilPhase =
        vWorldPos.x * 0.0032 +
        vWorldPos.z * 0.0032 +
        cap1.x * 1.65 +
        (1.0 - ndotv) * 1.35 -
        uTime * 0.28;
      vec3 liquidChrome = hsv2rgb(vec3(fract(oilPhase), 0.86, 1.0));
      float chromeMix = clamp(uTrip * 0.78, 0.0, 0.88);
      skyReflect = mix(skyReflect, liquidChrome * 1.28, chromeMix);
    }

    vec3 col = mix(waterBody, skyReflect, clamp(fresnel * 0.94 + 0.04, 0.0, 0.98));

    // ------------------------------------------------------------------
    // 3. WIND-BLOWN FOAM CRESTS & JET WAKE DISTURBANCE
    // ------------------------------------------------------------------
    vec2 foamUv = vWorldPos.xz * 0.045 + vec2(uTime * 0.22, -uTime * 0.16);
    float foamPattern = fbmFoam(foamUv);
    float foamLace = smoothstep(0.38, 0.78, foamPattern + vCrestFold * 0.42 + uStorm * 0.14);

    float crestFoam =
      smoothstep(0.24, 0.78, vCrestFold + smoothstep(2.4, 7.6, vWaveHeight) * 0.55 + uStorm * 0.18) *
      (0.32 + 0.68 * foamLace);
    float totalWakeFoam = clamp(max(vWakeFoam * 0.75, fineWakeFoam), 0.0, 1.0);
    float foamMask = clamp(crestFoam * (0.48 + uStorm * 0.42) + totalWakeFoam * 0.92, 0.0, 1.0);

    // ------------------------------------------------------------------
    // 4. CRISP GGX SOLAR SPECULAR GLITTER (TROWBRIDGE-REITZ + SMITH)
    // ------------------------------------------------------------------
    vec3 H = safeNormalize(L + V);
    float ndoth = max(dot(N, H), 1e-4);
    float vdoth = max(dot(V, H), 1e-4);

    // Broad ocean glitter highway + micro-facet sparkle lobe
    float distRough = smoothstep(300.0, 5200.0, dist) * 0.12;
    float alphaBroad = clamp(mix(0.055, 0.15, uStorm) + foamMask * 0.34 + distRough, 0.03, 0.55);
    float a2Broad = alphaBroad * alphaBroad;
    float denomB = ndoth * ndoth * (a2Broad - 1.0) + 1.0;
    float dBroad = a2Broad / max(PI * denomB * denomB, 1e-4);

    float kB = (alphaBroad + 1.0) * (alphaBroad + 1.0) * 0.125;
    float g1v = ndotv / max(ndotv * (1.0 - kB) + kB, 1e-4);
    float g1l = ndotl / max(ndotl * (1.0 - kB) + kB, 1e-4);
    float fSpec = 0.02 + 0.98 * pow(max(1.0 - vdoth, 1e-4), 5.0);
    float ggxBroad = (dBroad * g1v * g1l * fSpec) / max(4.0 * ndotv * ndotl, 1e-4);

    // Pinpoint grazing solar sparkle facets (attenuated by foam & storm)
    float alphaSharp = clamp(0.019 + distRough * 0.35 + foamMask * 0.18, 0.016, 0.25);
    float a2Sharp = alphaSharp * alphaSharp;
    float denomS = ndoth * ndoth * (a2Sharp - 1.0) + 1.0;
    float dSharp = a2Sharp / max(PI * denomS * denomS, 1e-4);
    float ggxSharp = dSharp * fSpec * 0.042 * (1.0 - uStorm * 0.45);

    vec3 sunSpecCol = mix(vec3(1.55, 0.88, 0.40), vec3(1.45, 0.55, 1.48), clamp(uTrip * 0.58, 0.0, 0.78));
    vec3 specular = sunSpecCol * clamp(ggxBroad * 1.45 + ggxSharp, 0.0, 6.8) * (1.0 - foamMask * 0.65);
    col += specular;

    // Blend sunlit sea-foam albedo over water
    vec3 foamLit = mix(vec3(0.86, 0.76, 0.68), vec3(0.46, 0.52, 0.64), uStorm);
    foamLit += vec3(0.32, 0.18, 0.08) * ndotl * (1.0 - uStorm * 0.5);
    if (uTrip > 0.05) {
      foamLit = mix(foamLit, vec3(0.75, 0.88, 1.05), clamp(uTrip * 0.35, 0.0, 0.45));
    }
    col = mix(col, foamLit, foamMask * 0.82);

    // ------------------------------------------------------------------
    // 5. LUMINOUS EXPLOSION SHOCKWAVE RINGS & LIGHTNING REFLECTIONS
    // ------------------------------------------------------------------
    if (vShockGlow > 0.002) {
      vec3 shockCol = mix(vec3(1.75, 0.92, 0.38), vec3(0.38, 1.65, 1.92), clamp(uTrip, 0.0, 1.0));
      float shockLace = 0.72 + 0.28 * foamPattern;
      col += shockCol * vShockGlow * 1.55 * shockLace;
    }

    // Supercell lightning & aerial fireball flash reflections on ocean facets
    col += mix(vec3(0.58, 0.44, 1.25), vec3(0.35, 0.95, 1.45), clamp(uTrip * 0.6, 0.0, 1.0)) * uLightning * (0.25 + fresnel * 0.95);
    col += vec3(1.25, 0.62, 0.22) * uExplosionFlash * (0.12 + fresnel * 0.45);

    // ------------------------------------------------------------------
    // 6. SEAMLESS ATMOSPHERIC HORIZON HAZE BLEND
    // ------------------------------------------------------------------
    float fogAmt = smoothstep(1100.0, 7200.0, dist);
    vec3 fogCol = mix(vec3(0.82, 0.42, 0.21), vec3(0.18, 0.13, 0.26), uStorm);
    if (uTrip > 0.05) {
      fogCol = mix(fogCol, vec3(0.32, 0.09, 0.44), clamp(uTrip * 0.55, 0.0, 0.65));
    }
    col = mix(col, fogCol, fogAmt);

    gl_FragColor = vec4(clamp(col, 0.0, 10.0), 1.0);
  }
`;

const SPRAY_VERT = /* glsl */ `
  attribute float aPhase;
  attribute float aSide;
  attribute float aSpread;
  attribute float aScale;

  uniform float uTime;
  uniform vec3 uJetPos;
  uniform vec2 uJetFwdXZ;
  uniform float uJetWakeStrength;

  varying vec2 vUv;
  varying float vAlpha;
  varying float vSeed;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vSeed = aPhase * 17.3 + aSpread * 9.1;

    if (uJetWakeStrength < 0.004) {
      vAlpha = 0.0;
      vWorldPos = vec3(0.0);
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec2 jetFwd = length(uJetFwdXZ) > 1e-4 ? normalize(uJetFwdXZ) : vec2(0.0, -1.0);
    vec2 jetRight = vec2(-jetFwd.y, jetFwd.x);

    // Continuous streaming age loop [0, 1) — works live AND immediately on paused seek()
    float age = fract(aPhase + uTime * (1.28 + aSpread * 0.32));
    float along = -4.0 + age * (185.0 + aSpread * 55.0);

    // Twin rooster-tail spray sheets erupting outward & arcing upward from the ocean surface
    float lateralBase = 3.2 + age * (24.0 + aSpread * 16.0);
    float across = aSide * lateralBase + sin(aPhase * 41.0 + age * 5.0) * (2.2 + age * 4.5);

    float arc = sin(pow(max(age, 1e-4), 0.56) * 3.14159265);
    float peakHeight = (13.0 + 18.0 * uJetWakeStrength) * (0.58 + 0.65 * aSpread);
    float worldY = 2.5 + arc * peakHeight;

    vec3 centreWorld = vec3(
      uJetPos.x - jetFwd.x * along + jetRight.x * across,
      worldY,
      uJetPos.z - jetFwd.y * along + jetRight.y * across
    );

    // Soft camera proximity fade so spray never blocks or whites out low sea-skim lenses
    float camDist = length(cameraPosition - centreWorld);
    float nearCamFade = smoothstep(8.0, 24.0, camDist);

    float size = aScale * (4.2 + age * 19.5) * (0.55 + 0.65 * uJetWakeStrength);
    float fadeIn = smoothstep(0.0, 0.14, age);
    float fadeOut = 1.0 - smoothstep(0.42, 1.0, age);
    vAlpha = fadeIn * fadeOut * uJetWakeStrength * nearCamFade * 0.56;

    // Camera-facing spherical billboard expansion in view space
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    // Gentle per-puff roll rotation
    float ang = aPhase * 6.2831853 + age * aSide * 1.4;
    float cs = cos(ang);
    float sn = sin(ang);
    vec2 rotPos = vec2(
      position.x * cs - position.y * sn,
      position.x * sn + position.y * cs
    );

    vec3 worldPos = centreWorld + (camRight * rotPos.x + camUp * rotPos.y) * size;
    vWorldPos = worldPos;
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const SPRAY_FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform float uStorm;
  uniform float uTrip;
  uniform float uLightning;

  varying vec2 vUv;
  varying float vAlpha;
  varying float vSeed;
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

    vec2 centered = vUv * 2.0 - 1.0;
    float r2 = dot(centered, centered);
    if (r2 > 1.0) discard;

    // Wispy frothy droplet texture inside each billboard puff
    float n1 = noise2(vUv * 4.5 + vec2(vSeed, vSeed * 0.7));
    float n2 = noise2(vUv * 9.5 - vec2(vSeed * 1.3, vSeed * 0.4));
    float wisp = 0.55 * n1 + 0.45 * n2;

    float radialSoft = pow(max(1.0 - r2, 1e-4), 1.85);
    float alpha = radialSoft * smoothstep(0.18, 0.88, wisp + radialSoft * 0.45) * vAlpha;
    if (alpha < 0.005) discard;

    // Mie forward-scattered golden sunlight through translucent sea-spray mist
    vec3 V = safeNormalize(vWorldPos - cameraPosition);
    vec3 L = safeNormalize(uSunDir);
    float sunAlign = max(dot(V, L), 0.0);
    float mie = pow(max(sunAlign, 1e-4), 4.0) * 0.85;

    vec3 baseMist = mix(vec3(0.76, 0.84, 0.88), vec3(0.36, 0.44, 0.56), uStorm);
    vec3 sunLit = mix(vec3(1.35, 0.78, 0.42), vec3(0.95, 0.52, 1.25), clamp(uTrip * 0.6, 0.0, 0.7));
    vec3 col = baseMist * (0.68 + 0.32 * vUv.y) + sunLit * (0.28 + mie) * (1.0 - uStorm * 0.4);
    col += vec3(0.55, 0.48, 1.15) * uLightning * 0.6;

    gl_FragColor = vec4(clamp(col, 0.0, 5.0), clamp(alpha, 0.0, 0.65));
  }
`;

interface ShockwaveSlot {
  origin: THREE.Vector3;
  params: THREE.Vector3; // x = radius, y = strength, z = bandScale
}

/**
 * Builds a watertight two-tier ocean clipmap:
 * - Inner hi-res patch [-1600, +1600] at 20-unit spacing, with its perimeter ring
 *   snapped cleanly to exact 100-unit outer stations so there are zero T-junction cracks.
 * - Outer horizon ring [-8000, +8000] at 100-unit spacing, omitting inner-patch quads.
 */
function buildClipmapOceanGeometry(): THREE.BufferGeometry {
  const innerSegs = (INNER_HALF * 2) / INNER_CELL; // 160
  const outerSegs = (OUTER_HALF * 2) / OUTER_CELL; // 160
  const innerCols = innerSegs + 1;
  const outerCols = outerSegs + 1;

  const positions: number[] = [];
  const indices: number[] = [];

  // 1. Inner high-resolution mesh (snaps perimeter ring to exact OUTER_CELL multiples)
  for (let iz = 0; iz <= innerSegs; iz++) {
    const rawZ = -INNER_HALF + iz * INNER_CELL;
    const onZEdge = iz === 0 || iz === innerSegs;
    for (let ix = 0; ix <= innerSegs; ix++) {
      const rawX = -INNER_HALF + ix * INNER_CELL;
      const onXEdge = ix === 0 || ix === innerSegs;

      const x = onZEdge ? Math.round(rawX / OUTER_CELL) * OUTER_CELL : rawX;
      const z = onXEdge ? Math.round(rawZ / OUTER_CELL) * OUTER_CELL : rawZ;
      positions.push(x, 0, z);
    }
  }

  for (let iz = 0; iz < innerSegs; iz++) {
    for (let ix = 0; ix < innerSegs; ix++) {
      const a = iz * innerCols + ix;
      const b = a + 1;
      const c = a + innerCols;
      const d = c + 1;
      // Counter-clockwise when viewed from +Y -> outward upward (+Y) front faces
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  // 2. Outer horizon mesh with central [-INNER_HALF, +INNER_HALF] cutout
  const outerBaseVertex = positions.length / 3;
  for (let oz = 0; oz <= outerSegs; oz++) {
    const z = -OUTER_HALF + oz * OUTER_CELL;
    for (let ox = 0; ox <= outerSegs; ox++) {
      const x = -OUTER_HALF + ox * OUTER_CELL;
      positions.push(x, 0, z);
    }
  }

  for (let oz = 0; oz < outerSegs; oz++) {
    const z0 = -OUTER_HALF + oz * OUTER_CELL;
    const z1 = z0 + OUTER_CELL;
    for (let ox = 0; ox < outerSegs; ox++) {
      const x0 = -OUTER_HALF + ox * OUTER_CELL;
      const x1 = x0 + OUTER_CELL;
      // Skip quads covered by the high-resolution inner patch
      if (x0 >= -INNER_HALF && x1 <= INNER_HALF && z0 >= -INNER_HALF && z1 <= INNER_HALF) {
        continue;
      }
      const a = outerBaseVertex + oz * outerCols + ox;
      const b = a + 1;
      const c = a + outerCols;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  // Generous bounding sphere so frustum culling never clips displaced ocean horizons
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), OUTER_HALF * 1.5);
  return geo;
}

/**
 * Builds deterministic GPU-instanced billboard geometry for the low-altitude
 * rooster-tail sea-spray plume behind VIPER-1.
 */
function buildRoosterTailSprayGeometry(): THREE.InstancedBufferGeometry {
  const baseQuad = new THREE.PlaneGeometry(1, 1);
  const instGeo = new THREE.InstancedBufferGeometry();
  instGeo.index = baseQuad.index;
  instGeo.attributes.position = baseQuad.attributes.position;
  instGeo.attributes.uv = baseQuad.attributes.uv;
  instGeo.instanceCount = SPRAY_PARTICLE_COUNT;

  const phases = new Float32Array(SPRAY_PARTICLE_COUNT);
  const sides = new Float32Array(SPRAY_PARTICLE_COUNT);
  const spreads = new Float32Array(SPRAY_PARTICLE_COUNT);
  const scales = new Float32Array(SPRAY_PARTICLE_COUNT);

  // Deterministic pseudo-random sequence (repeatable across verification runs)
  let seed = 48271;
  const nextRand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let i = 0; i < SPRAY_PARTICLE_COUNT; i++) {
    phases[i] = i / SPRAY_PARTICLE_COUNT + nextRand() * (1 / SPRAY_PARTICLE_COUNT);
    sides[i] = i % 2 === 0 ? 1.0 : -1.0;
    spreads[i] = nextRand();
    scales[i] = 0.68 + nextRand() * 0.78;
  }

  instGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  instGeo.setAttribute('aSide', new THREE.InstancedBufferAttribute(sides, 1));
  instGeo.setAttribute('aSpread', new THREE.InstancedBufferAttribute(spreads, 1));
  instGeo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
  return instGeo;
}

export class OceanSurface {
  public readonly group = new THREE.Group();

  private readonly oceanMesh: THREE.Mesh;
  private readonly oceanMat: THREE.ShaderMaterial;
  private readonly sprayMesh: THREE.Mesh;
  private readonly sprayMat: THREE.ShaderMaterial;

  private readonly shockSlots: ShockwaveSlot[];
  private nextShockSlot = 0;

  // Pre-allocated uniform vectors (zero per-frame heap allocations)
  private readonly uJetPos = new THREE.Vector3(0, 9999, 0);
  private readonly uJetFwdXZ = new THREE.Vector2(0, -1);

  constructor(sunDirection: THREE.Vector3) {
    this.shockSlots = [];
    const shockOrigins: THREE.Vector3[] = [];
    const shockParams: THREE.Vector3[] = [];
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const origin = new THREE.Vector3(0, 0, 0);
      const params = new THREE.Vector3(9999, 0, 0.012);
      this.shockSlots.push({ origin, params });
      shockOrigins.push(origin);
      shockParams.push(params);
    }

    this.oceanMat = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDirection.clone() },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
        uExplosionFlash: { value: 0 },
        uShockOrigin: { value: shockOrigins },
        uShockParams: { value: shockParams },
        uJetPos: { value: this.uJetPos },
        uJetFwdXZ: { value: this.uJetFwdXZ },
        uJetWakeStrength: { value: 0 },
      },
    });

    const oceanGeo = buildClipmapOceanGeometry();
    this.oceanMesh = new THREE.Mesh(oceanGeo, this.oceanMat);
    this.oceanMesh.frustumCulled = false;
    this.oceanMesh.position.y = 0;
    this.group.add(this.oceanMesh);

    // Low-altitude jet rooster-tail sea-spray plume
    this.sprayMat = new THREE.ShaderMaterial({
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDirection.clone() },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
        uJetPos: { value: this.uJetPos },
        uJetFwdXZ: { value: this.uJetFwdXZ },
        uJetWakeStrength: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    const sprayGeo = buildRoosterTailSprayGeometry();
    this.sprayMesh = new THREE.Mesh(sprayGeo, this.sprayMat);
    this.sprayMesh.frustumCulled = false;
    this.sprayMesh.renderOrder = 3;
    this.group.add(this.sprayMesh);
  }

  public triggerShockwave(origin: THREE.Vector3, strength = 1.0): void {
    const slot = this.shockSlots[this.nextShockSlot];
    this.nextShockSlot = (this.nextShockSlot + 1) % MAX_SHOCKWAVES;
    slot.origin.copy(origin);
    slot.params.set(16.0, THREE.MathUtils.clamp(strength, 0.2, 2.2), 0.013);
  }

  public update(
    time: number,
    dt: number,
    cameraPos: THREE.Vector3,
    stormIntensity: number,
    tripIntensity: number,
    lightningFlash: number,
    explosionFlash: number,
    heroPos: THREE.Vector3,
    heroForward: THREE.Vector3,
  ): void {
    // Snap two-tier ocean clipmap to exact OUTER_CELL lattice around camera (zero vertex swimming)
    this.oceanMesh.position.x = Math.round(cameraPos.x / OUTER_CELL) * OUTER_CELL;
    this.oceanMesh.position.z = Math.round(cameraPos.z / OUTER_CELL) * OUTER_CELL;

    // Advance expanding concentric shockwave rings
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const p = this.shockSlots[i].params;
      if (p.y > 0.004) {
        p.x += dt * 435.0; // Expanding pressure ring radius
        p.y = Math.max(0.0, p.y - dt * 0.36); // Smooth dissipation
        p.z = Math.max(0.0055, 0.014 / (1.0 + p.x * 0.00045)); // Ring widens naturally as it propagates
      }
    }

    // Low-altitude sea-spray wake strength: active whenever hero.position.y < 95
    this.uJetPos.copy(heroPos);
    const fwdLenSq = heroForward.x * heroForward.x + heroForward.z * heroForward.z;
    if (fwdLenSq > 1e-6) {
      const invLen = 1.0 / Math.sqrt(fwdLenSq);
      this.uJetFwdXZ.set(heroForward.x * invLen, heroForward.z * invLen);
    }

    let wakeStrength = 0.0;
    if (heroPos.y < 95.0) {
      const t = THREE.MathUtils.clamp((95.0 - heroPos.y) / 72.0, 0.0, 1.0);
      wakeStrength = t * t * (3.0 - 2.0 * t); // Smoothstep onset below 95 altitude
    }

    this.oceanMat.uniforms.uTime.value = time;
    this.oceanMat.uniforms.uStorm.value = stormIntensity;
    this.oceanMat.uniforms.uTrip.value = tripIntensity;
    this.oceanMat.uniforms.uLightning.value = lightningFlash;
    this.oceanMat.uniforms.uExplosionFlash.value = explosionFlash;
    this.oceanMat.uniforms.uJetWakeStrength.value = wakeStrength;

    this.sprayMesh.visible = wakeStrength > 0.004;
    this.sprayMat.uniforms.uTime.value = time;
    this.sprayMat.uniforms.uStorm.value = stormIntensity;
    this.sprayMat.uniforms.uTrip.value = tripIntensity;
    this.sprayMat.uniforms.uLightning.value = lightningFlash;
    this.sprayMat.uniforms.uJetWakeStrength.value = wakeStrength;
  }
}
