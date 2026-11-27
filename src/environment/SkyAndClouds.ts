import * as THREE from 'three';

const SKY_CLOUD_VERT = /* glsl */ `
  varying vec3 vWorldDir;
  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldDir = safeNormalize(position);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKY_CLOUD_FRAG = /* glsl */ `
  varying vec3 vWorldDir;

  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  uniform float uTime;
  uniform float uStorm;
  uniform float uTrip;
  uniform float uLightning;
  uniform vec3 uLightningPos;
  uniform float uExplosionFlash;

  const float PI = 3.14159265;
  const int CLOUD_STEPS = 24;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  // Interleaved Gradient Noise (blue-noise screen-space dithering, zero temporal crawl)
  float ignBlueNoise(vec2 fragCoord) {
    return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
  }

  // Trig-free 3D hash (fast on Apple Silicon, numerically stable at large world coordinates)
  float hash31(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
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
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
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

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash31(i);
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));

    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);

    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  // Henyey-Greenstein Mie scattering phase function (strictly guarded pow & division)
  float hgPhase(float cosTheta, float g) {
    float g2 = g * g;
    float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
    return (1.0 - g2) / max(4.0 * PI * pow(max(denom, 1e-4), 1.5), 1e-4);
  }

  // Ray-sphere intersection against a curved planetary cloud shell centred at (0, -R, 0)
  vec2 intersectShell(float roY, float rdY, float radius) {
    float b = roY * rdY;
    float c = roY * roY - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(-1.0);
    float s = sqrt(max(disc, 0.0));
    return vec2(-b - s, -b + s);
  }

  // Coarse sculpted cumulonimbus cathedral density (used for empty-space skip & light marching)
  float sampleCloudCoarse(vec3 worldPos, float hNorm) {
    // Classic cumulonimbus vertical profile: flat dark base, towering columns, flaring anvil cap
    float bottomGrad = smoothstep(0.0, 0.11, hNorm);
    float topGrad = smoothstep(1.0, 0.56, hNorm);
    float anvilCap = smoothstep(0.62, 0.84, hNorm) * smoothstep(1.0, 0.87, hNorm) * 0.48;
    float heightMask = bottomGrad * topGrad + anvilCap;
    if (heightMask < 0.005) return 0.0;

    // Frame Acts I-II with towering canyon walls and Acts III-IV with a circular supercell colosseum
    vec2 eyeDelta = worldPos.xz - vec2(0.0, -1550.0);
    float eyeDist = length(eyeDelta);
    float supercellWall = smoothstep(480.0, 1450.0, eyeDist);
    float canyonWall = smoothstep(220.0, 1080.0, abs(worldPos.x));
    float corridorKeep = mix(canyonWall, supercellWall, smoothstep(0.18, 0.72, uStorm));
    float spatialMask = mix(0.24 + 0.76 * corridorKeep, 1.0, smoothstep(0.48, 0.84, hNorm));

    // Wind-advected 3D cumulonimbus cauliflower structure (Nyquist-clean for 24 jittered steps)
    vec3 wind = vec3(uTime * 12.0, -uTime * 2.5, uTime * 8.0);
    vec3 p = (worldPos + wind) * vec3(0.00062, 0.00084, 0.00062);

    float n1 = noise3(p);
    // Billowy inverted-ridge cauliflower towers for crisp sculptural cloud lobes
    float n2Raw = noise3(p * 1.95 + vec3(4.3, 1.7, 9.1));
    float billow2 = 1.0 - abs(n2Raw * 2.0 - 1.0);
    float base = n1 * 0.56 + billow2 * 0.44;

    float coverage = mix(0.49, 0.36, uStorm);
    float density = smoothstep(coverage, coverage + 0.24, base * spatialMask) * heightMask;
    return density;
  }

  // Crisp cauliflower edge erosion evaluated only inside non-empty cloud voxels
  float sampleCloudDetail(vec3 worldPos, float coarseD) {
    vec3 p = (worldPos + vec3(uTime * 18.0, -uTime * 3.5, uTime * 10.0)) * 0.00155;
    float nFine = noise3(p);
    float cauliflower = 1.0 - abs(nFine * 2.0 - 1.0);
    float eroded = coarseD - (1.0 - cauliflower) * 0.28 * (1.0 - coarseD * 0.35);
    return clamp(eroded * 1.22, 0.0, 1.0);
  }

  void main() {
    vec3 dir = safeNormalize(vWorldDir);
    vec3 sunDir = safeNormalize(uSunDir);
    vec3 twinDir = safeNormalize(sunDir + vec3(0.11, 0.06, -0.05));
    float y = max(dir.y, -0.15);

    // ------------------------------------------------------------------
    // 1. TWIN-ECLIPSE ATMOSPHERIC SCATTERING SKY DOME
    // ------------------------------------------------------------------
    vec3 goldZenith = vec3(0.025, 0.085, 0.22);
    vec3 goldMid = vec3(0.12, 0.22, 0.37);
    vec3 goldHorizon = vec3(0.95, 0.38, 0.12);

    vec3 stormZenith = vec3(0.014, 0.022, 0.08);
    vec3 stormMid = vec3(0.045, 0.10, 0.18);
    vec3 stormHorizon = vec3(0.24, 0.09, 0.24);

    vec3 zenith = mix(goldZenith, stormZenith, uStorm);
    vec3 midCol = mix(goldMid, stormMid, uStorm);
    vec3 horizon = mix(goldHorizon, stormHorizon, uStorm * 0.72);

    float invY = 1.0 - clamp(y, 0.0, 1.0);
    float midFactor = pow(max(invY, 1e-4), 1.5);
    float hFactor = pow(max(invY, 1e-4), 4.1);
    vec3 skyCol = mix(zenith, midCol, midFactor);
    skyCol = mix(skyCol, horizon, hFactor);

    // Rayleigh/Mie directional horizon glow aligned with the sun azimuth
    float sunDot = max(dot(dir, sunDir), 0.0);
    float twinDot = max(dot(dir, twinDir), 0.0);
    float horizonSunGlow = pow(max(sunDot, 1e-4), 5.0) * pow(max(invY, 1e-4), 2.8);
    skyCol += mix(vec3(0.55, 0.24, 0.08), vec3(0.38, 0.10, 0.45), uTrip * 0.6) * horizonSunGlow * 0.62;

    // High-altitude stratospheric cirrus wisps
    vec2 skyUv = dir.xz / max(abs(dir.y) + 0.22, 1e-4);
    float cirrusN = fbm2(skyUv * 0.9 + vec2(uTime * 0.016, -uTime * 0.011));
    float cirrusMask = smoothstep(0.48, 0.86, cirrusN) * smoothstep(0.04, 0.36, dir.y);
    vec3 cirrusCol = mix(vec3(0.88, 0.46, 0.20), vec3(0.28, 0.14, 0.44), uStorm);
    skyCol = mix(skyCol, cirrusCol * (0.45 + 0.55 * cirrusN), cirrusMask * 0.28);

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
    vec3 sunTint = mix(vec3(1.25, 0.66, 0.26), vec3(1.15, 0.34, 0.85), uTrip * 0.55);
    skyCol += sunTint * mieGlow;

    float sunDisc = smoothstep(0.9968, 0.9988, sunDot);
    float eclipseAmt = smoothstep(0.18, 0.85, uTrip);
    float eclipseCore = smoothstep(0.9981, 0.9992, sunDot) * eclipseAmt;
    float coronaRim = smoothstep(0.9960, 0.9984, sunDot) * (1.0 - smoothstep(0.9984, 0.9994, sunDot));
    skyCol += vec3(2.8, 1.9, 1.1) * sunDisc * (1.0 - eclipseCore * 0.92);
    skyCol += mix(vec3(1.4, 0.60, 0.26), vec3(1.45, 0.32, 1.35), uTrip) * coronaRim * (0.65 + eclipseAmt * 1.85);

    // Secondary Twin Sun (molten amber companion -> cyan plasma eclipse twin)
    float twinDisc = smoothstep(0.9988, 0.9995, twinDot);
    vec3 twinTint = mix(vec3(1.05, 0.48, 0.18), vec3(0.32, 0.88, 1.45), uTrip);
    skyCol += twinTint * (pow(max(twinDot, 1e-4), 84.0) * 0.42 + twinDisc * 1.35);

    // ------------------------------------------------------------------
    // 2. VOLUMETRIC RAYMARCHED CUMULONIMBUS CLOUD CATHEDRAL (26 STEPS <= 28)
    // ------------------------------------------------------------------
    vec3 col = skyCol;
    float cloudTransmittance = 1.0;

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
        float jitter = ignBlueNoise(gl_FragCoord.xy);

        // Dual-lobe Henyey-Greenstein Mie scattering (razor-sharp silver lining + subtle back-scatter)
        float cosTheta = dot(dir, sunDir);
        float cosTwin = dot(dir, twinDir);
        float phasePrimary = mix(hgPhase(cosTheta, 0.80), hgPhase(cosTheta, -0.28), 0.22);
        float phaseTwin = hgPhase(cosTwin, 0.74) * 0.38;
        float phaseTotal = clamp(phasePrimary * 2.3 + phaseTwin * 1.1, 0.14, 3.6);

        // Deep dramatic Ridley Scott colour grading: dark brooding undersides + sunlit amber/prism rims
        vec3 sunLightCol = mix(vec3(1.38, 0.68, 0.28), vec3(0.75, 0.42, 0.82), uStorm * 0.62);
        sunLightCol = mix(sunLightCol, vec3(1.10, 0.36, 0.98), uTrip * 0.45);

        vec3 ambientTop = mix(vec3(0.24, 0.36, 0.58), vec3(0.08, 0.14, 0.28), uStorm);
        vec3 ambientBot = mix(vec3(0.22, 0.11, 0.09), vec3(0.05, 0.03, 0.11), uStorm);
        if (uTrip > 0.02) {
          ambientTop = mix(ambientTop, vec3(0.14, 0.44, 0.66), uTrip * 0.55);
          ambientBot = mix(ambientBot, vec3(0.32, 0.06, 0.36), uTrip * 0.62);
        }

        vec3 accumLight = vec3(0.0);
        float transmittance = 1.0;
        float t = tStart + baseStep * 0.55 * jitter;
        float horizonSmooth = smoothstep(-0.03, 0.075, dir.y);

        for (int i = 0; i < CLOUD_STEPS; i++) {
          if (transmittance < 0.03 || t > tEnd) break;

          // Non-linear step growth: finer steps up close for sharp clouds, wider far out
          float progress = float(i) / float(CLOUD_STEPS);
          float stepLen = baseStep * (0.68 + 0.64 * progress);

          vec3 samplePos = uCameraPos + dir * t;
          float horizSq = dot(dir.xz * t, dir.xz * t);
          float curvedY = samplePos.y - horizSq / (2.0 * R_EARTH);
          float hNorm = clamp((curvedY - CLOUD_MIN_Y) / max(CLOUD_THICK, 1.0), 0.0, 1.0);

          float coarseD = sampleCloudCoarse(samplePos, hNorm) * horizonSmooth;
          if (coarseD > 0.005) {
            float d = sampleCloudDetail(samplePos, coarseD);
            if (d > 0.004) {
              // 2-tap directional sun shadow march for sculpted anvil shadows & blazing rims
              float dSun1 = sampleCloudCoarse(samplePos + sunDir * 135.0, clamp(hNorm + 0.07, 0.0, 1.0));
              float dSun2 = sampleCloudCoarse(samplePos + sunDir * 390.0, clamp(hNorm + 0.18, 0.0, 1.0));
              float optDepth = (dSun1 * 1.25 + dSun2 * 1.95) * 2.35;

              // Beer-Lambert self-shadow + Powder dark-crease contrast + crisp Mie silver lining
              float beer = exp(-optDepth);
              float powder = 1.0 - exp(-optDepth * 2.6);
              float sunEnergy = beer * (0.34 + 1.05 * powder);
              float silverEdge = exp(-d * 5.2) * pow(max(sunDot, 1e-4), 8.0) * 1.15;

              vec3 directScatter = sunLightCol * (sunEnergy * phaseTotal + silverEdge);
              vec3 ambientScatter = mix(ambientBot, ambientTop, smoothstep(0.08, 0.86, hNorm)) * (0.55 + 0.45 * beer);

              // Bioluminescent psychedelic rim veining inside storm cathedrals (Acts III-IV)
              vec3 bioGlow = vec3(0.0);
              if (uTrip > 0.05) {
                float veinPhase = fract(samplePos.x * 0.00062 + samplePos.z * 0.00054 + hNorm * 0.9 - uTime * 0.11);
                vec3 veinHue = hsv2rgb(vec3(veinPhase, 0.94, 0.92));
                // Concentrate bioluminescence on dramatic cloud edges, keeping interiors deep obsidian
                float edgeVein = smoothstep(0.08, 0.28, d) * smoothstep(0.68, 0.22, d);
                bioGlow = veinHue * edgeVein * uTrip * (0.32 + 0.42 * uStorm);
              }

              // Cloud-internal 3D supercell lightning discharge illumination
              vec3 lightningGlow = vec3(0.0);
              if (uLightning > 0.01) {
                float strikeDist = length(samplePos - uLightningPos);
                float strikeAtten = exp(-strikeDist * 0.00082);
                vec3 boltCol = mix(vec3(0.85, 0.62, 1.65), vec3(0.45, 1.15, 1.75), uTrip * 0.6);
                lightningGlow = boltCol * uLightning * (0.20 + 2.1 * strikeAtten) * (0.4 + 0.6 * beer);
              }

              // Aerial detonation warm under-bounce
              vec3 boomBounce = vec3(1.35, 0.58, 0.22) * uExplosionFlash * (1.0 - hNorm * 0.78) * 0.52;

              vec3 stepScattering = directScatter + ambientScatter + bioGlow + lightningGlow + boomBounce;

              // Atmospheric distance haze blend into horizon
              float haze = 1.0 - exp(-t * 0.00016);
              vec3 hazeCol = mix(horizon * 0.78, stormHorizon * 0.92, uStorm * 0.75);
              stepScattering = mix(stepScattering, hazeCol, haze * 0.68);

              float sigma = d * mix(0.0052, 0.0074, uStorm) * stepLen;
              float stepTrans = exp(-sigma);
              accumLight += transmittance * stepScattering * (1.0 - stepTrans);
              transmittance *= stepTrans;
            }
          }

          t += stepLen;
        }

        cloudTransmittance = transmittance;
        col = accumLight + skyCol * transmittance;
      }
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
      // Sharper dark shadows between crepuscular shafts for crisp volumetric sunbeams
      float shafts = pow(max(shaft1 * 0.55 + shaft2 * 0.45, 1e-4), 3.4) * (0.35 + 0.65 * gapNoise);

      float edgePeek = 0.26 + 0.74 * (1.0 - abs(cloudTransmittance * 2.0 - 1.0));
      float elevFade = smoothstep(-0.04, 0.14, dir.y);

      vec3 amberShaft = vec3(1.25, 0.66, 0.26);
      vec3 auroraShaft = hsv2rgb(vec3(fract(radialAngle * 0.16 + 0.78 - uTime * 0.10), 0.90, 0.92)) * 1.15;
      vec3 shaftCol = mix(amberShaft, auroraShaft, clamp(uTrip * 0.92, 0.0, 1.0));

      float shaftPower = (sunRayMask * 0.38 + twinRayMask * 0.26) * shafts * edgePeek * elevFade * (1.0 - uStorm * 0.25);
      col += shaftCol * shaftPower;
    }

    // Transient sky flash on lightning & detonations
    col += mix(vec3(0.55, 0.38, 1.12), vec3(0.38, 0.85, 1.32), uTrip * 0.5) * uLightning * (0.14 + 0.28 * cirrusN);
    col += vec3(1.05, 0.56, 0.24) * uExplosionFlash * 0.32;

    // Below-horizon deep ocean-mirror blend
    float below = smoothstep(0.015, -0.075, dir.y);
    col = mix(col, mix(vec3(0.022, 0.050, 0.095), vec3(0.065, 0.018, 0.125), uTrip), below);

    gl_FragColor = vec4(clamp(col, 0.0, 18.0), 1.0);
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

    // Smooth top-and-bottom volumetric attenuation
    float verticalFade = smoothstep(0.0, 0.30, vUv.y) * smoothstep(1.0, 0.16, vUv.y);
    verticalFade *= pow(max(vUv.y, 1e-4), 0.5);

    // Soft proximity fade so flying directly through a sunbeam never pops or washes out
    float camDist = length(cameraPosition - vWorldPos);
    float nearFade = smoothstep(140.0, 440.0, camDist);

    // Sculpted drifting light striations along the beam
    float curtain = 0.65 + 0.35 * sin(vUv.x * 18.84955 + uTime * 0.55 + uPhase);
    float mist = 0.78 + 0.22 * sin(vUv.y * 12.0 - uTime * 0.42 + uPhase * 1.7);

    float colourBlend = clamp(0.5 + 0.5 * sin(vUv.x * 6.28318 + vUv.y * 3.0 - uTime * 0.45 + uPhase), 0.0, 1.0);
    vec3 beamCol = mix(uColorPrimary, uColorSecondary, colourBlend * uTrip);

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
    float tipFade = smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.90, vUv.y);

    vec3 col = mix(uHaloColor * 1.25, uCoreColor * 2.6, core);
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
  private readonly skyMesh: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly godRayMats: THREE.ShaderMaterial[] = [];
  private readonly lightningClusters: LightningCluster[] = [];

  private lightningTimer = 0.2;
  private nextClusterIdx = 0;
  private prngState = 918273;

  // Pre-allocated scratch objects (zero per-frame heap allocations)
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

  constructor(sunDirection: THREE.Vector3) {
    this.sunDirection.copy(sunDirection).normalize();

    for (let i = 0; i <= TRUNK_SEGMENTS; i++) {
      this._trunkNodes.push(new THREE.Vector3());
    }
    for (let i = 0; i <= FORK_SEGMENTS; i++) {
      this._forkNodes.push(new THREE.Vector3());
    }

    // ------------------------------------------------------------------
    // 1. TWIN-ECLIPSE SKY DOME + VOLUMETRIC RAYMARCHED CLOUD CATHEDRAL
    // ------------------------------------------------------------------
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_CLOUD_VERT,
      fragmentShader: SKY_CLOUD_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: this.sunDirection.clone() },
        uCameraPos: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
        uLightningPos: { value: this.lightningWorldPos.clone() },
        uExplosionFlash: { value: 0 },
      },
    });

    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(9500, 48, 32), this.skyMat);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -10;
    this.group.add(this.skyMesh);

    // ------------------------------------------------------------------
    // 2. 3D VOLUMETRIC GOD-RAY SUN SHAFTS (FRESNEL-FADED CONES)
    // ------------------------------------------------------------------
    this.buildVolumetricGodRays();

    // ------------------------------------------------------------------
    // 3. BRANCHING 3D SUPERCELL LIGHTNING POOL (ZERO RUNTIME ALLOCATION)
    // ------------------------------------------------------------------
    this.buildLightningPool();
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

      for (let q = 0; q < totalQuads; q++) {
        const vOff = q * 4;
        const iOff = q * 6;

        ribbonUv[vOff * 2 + 0] = 0;
        ribbonUv[vOff * 2 + 1] = 0;
        ribbonUv[(vOff + 1) * 2 + 0] = 1;
        ribbonUv[(vOff + 1) * 2 + 1] = 0;
        ribbonUv[(vOff + 2) * 2 + 0] = 0;
        ribbonUv[(vOff + 2) * 2 + 1] = 1;
        ribbonUv[(vOff + 3) * 2 + 0] = 1;
        ribbonUv[(vOff + 3) * 2 + 1] = 1;

        indices[iOff + 0] = vOff;
        indices[iOff + 1] = vOff + 1;
        indices[iOff + 2] = vOff + 2;
        indices[iOff + 3] = vOff + 1;
        indices[iOff + 4] = vOff + 3;
        indices[iOff + 5] = vOff + 2;
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
    // Keep sky dome centred on camera while raymarching in true world space
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

    // Update volumetric sky & cloud uniforms
    this.skyMat.uniforms.uCameraPos.value.copy(cameraPos);
    this.skyMat.uniforms.uTime.value = time;
    this.skyMat.uniforms.uStorm.value = stormIntensity;
    this.skyMat.uniforms.uTrip.value = tripIntensity;
    this.skyMat.uniforms.uLightning.value = this.lightningFlash;
    this.skyMat.uniforms.uLightningPos.value.copy(this.lightningWorldPos);
    this.skyMat.uniforms.uExplosionFlash.value = explosionFlash;

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
