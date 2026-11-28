import * as THREE from 'three';

export const PUFF_CAPACITY = 6400;
export const SPARK_CAPACITY = 4200;
export const DEBRIS_CAPACITY = 360;

const DEFAULT_SUN_DIR = new THREE.Vector3(-0.35, 0.18, -0.92).normalize();

const KINEMATIC_HELPERS_GLSL = /* glsl */ `
  // Exact closed-form integral for exponential aerodynamic drag with constant acceleration:
  //   dv/dt = -k * v + a
  //   v(t)  = v0 * exp(-k * t) + a * dragLinear(k, t)
  //   p(t)  = p0 + v0 * dragLinear(k, t) + a * dragQuad(k, t)
  // Smoothly reduces to pos0 + vel0 * t + 0.5 * a * t^2 as drag k -> 0.
  float dragLinear(float k, float t) {
    float u = max(k, 0.0) * t;
    if (u < 1e-3) {
      return t * (1.0 - 0.5 * u + u * u * 0.16666667);
    }
    return (1.0 - exp(-u)) / max(k, 1e-5);
  }

  float dragQuad(float k, float t) {
    float u = max(k, 0.0) * t;
    if (u < 1e-3) {
      return 0.5 * t * t * (1.0 - u * 0.33333333 + u * u * 0.08333333);
    }
    float invK = 1.0 / max(k, 1e-5);
    return (u - (1.0 - exp(-u))) * invK * invK;
  }
`;

const PUFF_VERT = /* glsl */ `
  uniform float uSimTime;

  attribute vec3 aSpawnPos;
  attribute vec3 aSpawnVel;
  attribute float aSpawnTime;
  attribute float aLife;
  attribute float aSeed;
  attribute vec4 aPuffKinematics; // x: drag, y: buoyancy, z: initAngle, w: spin
  attribute vec4 aPuffScaleTemp;  // x: startScale, y: endScale, z: startTemp, w: endTemp
  attribute vec4 aColorAlpha;

  varying vec2 vLocalPos;
  varying vec3 vWorldCenter;
  varying vec4 vMeta;
  varying vec4 vColorAlpha;
  varying vec3 vCamRight;
  varying vec3 vCamUp;
  varying vec3 vCamForward;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 0.0, 1.0);
  }

  ${KINEMATIC_HELPERS_GLSL}

  void main() {
    float age = uSimTime - aSpawnTime;
    float life = max(aLife, 1e-4);
    float lifeT = age / life;

    if (age < 0.0 || lifeT >= 1.0 || aLife <= 1e-4 || aColorAlpha.a <= 1e-4) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vLocalPos = vec2(2.0);
      vWorldCenter = vec3(0.0);
      vMeta = vec4(1.0, 0.0, 0.0, 0.0);
      vColorAlpha = vec4(0.0);
      vCamRight = vec3(1.0, 0.0, 0.0);
      vCamUp = vec3(0.0, 1.0, 0.0);
      vCamForward = vec3(0.0, 0.0, 1.0);
      return;
    }

    float invT = 1.0 - lifeT;
    float expand = 1.0 - invT * invT;
    float scale = mix(aPuffScaleTemp.x, aPuffScaleTemp.y, expand);
    if (scale <= 1e-4) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vLocalPos = vec2(2.0);
      vWorldCenter = vec3(0.0);
      vMeta = vec4(1.0, 0.0, 0.0, 0.0);
      vColorAlpha = vec4(0.0);
      vCamRight = vec3(1.0, 0.0, 0.0);
      vCamUp = vec3(0.0, 1.0, 0.0);
      vCamForward = vec3(0.0, 0.0, 1.0);
      return;
    }

    float drag = aPuffKinematics.x;
    float buoyancy = aPuffKinematics.y;
    float dLin = dragLinear(drag, age);
    float dQuad = dragQuad(drag, age);
    vec3 center = aSpawnPos + aSpawnVel * dLin + vec3(0.0, buoyancy * dQuad, 0.0);

    float cool = 1.0 - invT * invT * invT;
    float temp = mix(aPuffScaleTemp.z, aPuffScaleTemp.w, cool);
    float angle = aPuffKinematics.z + aPuffKinematics.w * age;

    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 camForward = safeNormalize(cameraPosition - center);

    float c = cos(angle);
    float s = sin(angle);
    vec3 rotRight = camRight * c + camUp * s;
    vec3 rotUp = -camRight * s + camUp * c;

    vec3 worldPos = center + (rotRight * position.x + rotUp * position.y) * scale;

    vLocalPos = position.xy * 2.0;
    vWorldCenter = center;
    vMeta = vec4(lifeT, temp, angle, aSeed);
    vColorAlpha = aColorAlpha;
    vCamRight = rotRight;
    vCamUp = rotUp;
    vCamForward = camForward;

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const PUFF_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uTrip;
  uniform vec3 uSunDir;
  uniform vec3 uFlashPos;
  uniform vec3 uFlashColor;
  uniform float uFlashIntensity;

  varying vec2 vLocalPos;
  varying vec3 vWorldCenter;
  varying vec4 vMeta;
  varying vec4 vColorAlpha;
  varying vec3 vCamRight;
  varying vec3 vCamUp;
  varying vec3 vCamForward;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
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
    float a = 0.55;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = rot * p * 2.08;
      a *= 0.48;
    }
    return v;
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  vec3 blackBodyRamp(float temp) {
    vec3 ember = vec3(1.05, 0.14, 0.02);
    vec3 orange = vec3(2.15, 0.72, 0.12);
    vec3 yellow = vec3(3.25, 2.35, 1.15);
    vec3 plasma = vec3(4.45, 3.95, 3.25);

    vec3 col = mix(vec3(0.0), ember, smoothstep(0.12, 0.38, temp));
    col = mix(col, orange, smoothstep(0.36, 0.74, temp));
    col = mix(col, yellow, smoothstep(0.72, 1.16, temp));
    col = mix(col, plasma, smoothstep(1.14, 1.60, temp));
    return col;
  }

  void main() {
    float r2 = dot(vLocalPos, vLocalPos);
    if (r2 >= 1.0) discard;

    float lifeT = clamp(vMeta.x, 0.0, 1.0);
    float baseTemp = max(vMeta.y, 0.0);
    float mode = floor(vMeta.w + 0.001);
    float seed = fract(vMeta.w) * 31.7;

    vec2 billowUv = vLocalPos * 1.95 + vec2(seed, -uTime * 0.55 + seed * 0.37);
    float billow = fbm2(billowUv);
    float billowDx = fbm2(billowUv + vec2(0.16, 0.0)) - billow;
    float billowDy = fbm2(billowUv + vec2(0.0, 0.16)) - billow;

    float radial = 1.0 - r2;
    float shapeMask = smoothstep(0.0, 0.56, radial * (0.58 + 0.68 * billow));
    if (shapeMask < 0.01) discard;

    // Sculptural spherical puff normal perturbed by turbulent billow lobes
    float nz = sqrt(max(1.0 - r2, 1e-4));
    vec3 localN = safeNormalize(vec3(vLocalPos.x + billowDx * 1.35, vLocalPos.y + billowDy * 1.35, nz));
    vec3 worldN = safeNormalize(vCamRight * localN.x + vCamUp * localN.y + vCamForward * localN.z);

    vec3 sunDir = safeNormalize(uSunDir);
    float sunWrap = clamp(dot(worldN, sunDir) * 0.5 + 0.5, 0.0, 1.0);
    float sunRim = pow(max(dot(-vCamForward, sunDir), 1e-4), 3.2) * (1.0 - nz) * 0.9;
    vec3 sunColour = mix(vec3(1.38, 0.84, 0.46), vec3(1.15, 0.62, 1.25), clamp(uTrip * 0.45, 0.0, 0.7));
    vec3 skyAmb = mix(vec3(0.11, 0.09, 0.14), vec3(0.36, 0.44, 0.58), clamp(worldN.y * 0.5 + 0.5, 0.0, 1.0));

    // Dynamic core-flash illumination from the brightest active aerial detonation
    vec3 coreFlashLit = vec3(0.0);
    if (uFlashIntensity > 0.01) {
      vec3 toFlash = uFlashPos - vWorldCenter;
      float flashDist = length(toFlash);
      vec3 flashDir = flashDist > 1e-3 ? toFlash / flashDist : vec3(0.0, 1.0, 0.0);
      float flashAtten = uFlashIntensity / max(1.0 + flashDist * flashDist * 0.00042, 1e-4);
      float flashDiff = clamp(dot(worldN, flashDir) * 0.65 + 0.35, 0.0, 1.0);
      coreFlashLit = uFlashColor * flashAtten * flashDiff * (0.35 + 0.65 * billow);
    }

    vec3 smokeLit = vColorAlpha.rgb * (skyAmb * 0.85 + sunColour * (0.28 + 0.88 * sunWrap) + sunColour * sunRim);
    smokeLit += coreFlashLit * (0.42 + 0.45 * vColorAlpha.rgb);

    // Core-hot, rim-cooling black-body temperature distribution for sculptural volumetric fireballs
    float localTemp = baseTemp * (0.44 + 0.68 * billow) * (0.34 + 0.76 * nz);
    vec3 fireCol = blackBodyRamp(localTemp);
    float fireWeight = smoothstep(0.16, 0.56, localTemp);

    vec3 finalCol = mix(smokeLit, fireCol + smokeLit * 0.14, fireWeight);

    // Condensation vapour mode (supersonic shock collar wisps)
    if (mode > 1.5) {
      vec3 vapourBase = vec3(0.92, 0.96, 1.0) * (0.65 + 0.55 * sunWrap + sunRim * 0.75);
      finalCol = mix(vapourBase, vapourBase * vec3(1.15, 0.88, 1.28), clamp(uTrip * 0.5, 0.0, 0.6));
    }

    // Iridescent prismatic rim for supernova & high-trip beats
    if (mode > 0.5 && mode < 1.5) {
      vec3 prism = hsv2rgb(vec3(fract(billow * 1.4 + seed * 0.07 - uTime * 0.35), 0.92, 1.0)) * 2.2;
      float rim = pow(max(1.0 - nz, 1e-4), 1.65);
      finalCol += prism * rim * (0.65 + uTrip * 0.6) * (1.0 - lifeT * 0.65);
    } else if (uTrip > 0.25 && fireWeight > 0.15) {
      vec3 prism = hsv2rgb(vec3(fract(billow * 1.6 - uTime * 0.3), 0.9, 1.0)) * 1.6;
      float rim = pow(max(1.0 - nz, 1e-4), 1.8);
      finalCol += prism * rim * (uTrip - 0.25) * 0.75 * fireWeight;
    }

    float fadeIn = smoothstep(0.0, 0.07, lifeT);
    float fadeOut = 1.0 - smoothstep(0.54, 1.0, lifeT);
    float alpha = clamp(shapeMask * fadeIn * fadeOut * vColorAlpha.a, 0.0, 0.96);
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(clamp(finalCol, 0.0, 14.0), alpha);
  }
`;

const SPARK_VERT = /* glsl */ `
  uniform float uSimTime;

  attribute vec3 aSpawnPos;
  attribute vec3 aSpawnVel;
  attribute float aSpawnTime;
  attribute float aLife;
  attribute float aSeed;
  attribute vec3 aSparkParams; // x: baseSize, y: drag, z: gravity
  attribute vec4 aColorHeat;

  varying vec2 vUv;
  varying vec4 vColorHeat;
  varying float vLifeT;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  ${KINEMATIC_HELPERS_GLSL}

  void main() {
    float age = uSimTime - aSpawnTime;
    float life = max(aLife, 1e-4);
    float lifeT = age / life;
    float baseSize = aSparkParams.x;

    if (age < 0.0 || lifeT >= 1.0 || aLife <= 1e-4 || baseSize <= 1e-4) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vUv = vec2(0.0);
      vColorHeat = vec4(0.0);
      vLifeT = 1.0;
      return;
    }

    float drag = aSparkParams.y;
    float gravity = aSparkParams.z;
    float dLin = dragLinear(drag, age);
    float dQuad = dragQuad(drag, age);
    float expDrag = exp(-max(drag, 0.0) * age);

    vec3 center = aSpawnPos + aSpawnVel * dLin + vec3(0.0, -gravity * dQuad, 0.0);
    vec3 vel = aSpawnVel * expDrag + vec3(0.0, -gravity * dLin, 0.0);

    float speed = length(vel);
    vec3 dir = speed > 1e-3 ? vel / speed : vec3(0.0, 1.0, 0.0);
    vec3 toCam = safeNormalize(cameraPosition - center);

    vec3 side = cross(dir, toCam);
    if (length(side) < 1e-3) {
      side = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    }
    side = safeNormalize(side);

    float curSize = baseSize * (1.0 - lifeT * 0.45);
    float fade = 1.0 - clamp(lifeT, 0.0, 1.0);
    float shimmer = 0.92 + 0.08 * sin(age * 38.0 + aSeed * 62.8318);
    float width = curSize * (0.42 + 0.58 * fade) * shimmer;
    float streakLen = max(width * 2.4, curSize * (2.0 + speed * 0.044) * (0.35 + 0.65 * fade));

    vec3 worldPos = center
      + side * (position.x * width)
      + dir * (position.y * streakLen);

    vUv = uv;
    vColorHeat = aColorHeat;
    vLifeT = lifeT;

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const SPARK_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vColorHeat;
  varying float vLifeT;

  void main() {
    float across = abs(vUv.x - 0.5) * 2.0;
    float along = vUv.y;

    // Tapered incandescent needle: bright white-hot head tapering into a fiery wake
    float crossProfile = pow(max(1.0 - across, 1e-4), 1.85);
    float headCap = 1.0 - smoothstep(0.72, 1.0, along);
    float tailTaper = pow(max(along, 1e-4), 0.75);
    float mask = crossProfile * headCap * tailTaper;
    if (mask < 0.01) discard;

    float fade = 1.0 - smoothstep(0.55, 1.0, clamp(vLifeT, 0.0, 1.0));
    float headHot = smoothstep(0.42, 0.92, along) * (1.0 - vLifeT * 0.65);

    vec3 baseCol = vColorHeat.rgb;
    vec3 whiteCore = vec3(4.8, 4.3, 3.4);
    vec3 col = mix(baseCol * (1.6 + vColorHeat.w), whiteCore, clamp(headHot * 0.82, 0.0, 0.9));
    col *= (0.55 + 0.75 * fade);

    float alpha = clamp(mask * fade, 0.0, 1.0);
    gl_FragColor = vec4(clamp(col, 0.0, 16.0), alpha);
  }
`;

const DEBRIS_VERT = /* glsl */ `
  uniform float uSimTime;

  attribute vec3 aSpawnPos;
  attribute vec3 aSpawnVel;
  attribute float aSpawnTime;
  attribute float aLife;
  attribute float aSeed;
  attribute vec4 aInitQuat;
  attribute vec3 aAngularVel;
  attribute vec3 aDebrisMeta; // x: baseScale, y: heat, z: prism

  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  varying vec4 vHeatLife;

  vec3 rotateQuat(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  vec4 quatMul(vec4 a, vec4 b) {
    return vec4(
      a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz),
      a.w * b.w - dot(a.xyz, b.xyz)
    );
  }

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  ${KINEMATIC_HELPERS_GLSL}

  void main() {
    float age = uSimTime - aSpawnTime;
    float life = max(aLife, 1e-4);
    float lifeT = age / life;
    float baseScale = aDebrisMeta.x;

    if (age < 0.0 || lifeT >= 1.0 || aLife <= 1e-4 || baseScale <= 1e-4) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vWorldNormal = vec3(0.0, 1.0, 0.0);
      vWorldPos = vec3(0.0);
      vLocalPos = vec3(0.0);
      vHeatLife = vec4(1.0, 0.0, 0.0, 0.0);
      return;
    }

    // Ballistic trajectory with exponential aerodynamic drag (k = 0.24) and gravity (46 m/s^2)
    float dLin = dragLinear(0.24, age);
    float dQuad = dragQuad(0.24, age);
    vec3 center = aSpawnPos + aSpawnVel * dLin + vec3(0.0, -46.0 * dQuad, 0.0);

    // Exact analytical quaternion spin from constant world-space angular velocity
    float omega = length(aAngularVel);
    vec4 q = aInitQuat;
    if (omega > 1e-5) {
      vec3 axis = aAngularVel / omega;
      float halfAngle = 0.5 * omega * age;
      vec4 qDelta = vec4(axis * sin(halfAngle), cos(halfAngle));
      q = quatMul(qDelta, aInitQuat);
    }
    float qLen = length(q);
    q = qLen > 1e-5 ? q / qLen : vec4(0.0, 0.0, 0.0, 1.0);

    float curScale = baseScale * (1.0 - lifeT * 0.48);
    vec3 scaledPos = position * curScale;
    vec3 worldPos = center + rotateQuat(q, scaledPos);
    vec3 worldN = safeNormalize(rotateQuat(q, normal));

    vWorldPos = worldPos;
    vWorldNormal = worldN;
    vLocalPos = position;
    vHeatLife = vec4(lifeT, aDebrisMeta.y, aDebrisMeta.z, aSeed);

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const DEBRIS_FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uFlashPos;
  uniform vec3 uFlashColor;
  uniform float uFlashIntensity;
  uniform float uTime;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  varying vec4 vHeatLife;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec3 N = safeNormalize(vWorldNormal);
    vec3 V = safeNormalize(cameraPosition - vWorldPos);
    vec3 L = safeNormalize(uSunDir);
    vec3 H = safeNormalize(L + V);

    float ndotl = max(dot(N, L), 0.0);
    float spec = pow(max(dot(N, H), 1e-4), 24.0);
    float fresnel = pow(max(1.0 - max(dot(N, V), 0.0), 1e-4), 2.5);

    // Charred aerospace titanium/carbon skin
    vec3 hullAlbedo = vec3(0.11, 0.10, 0.12);
    vec3 lit = hullAlbedo * (vec3(0.18, 0.22, 0.30) + vec3(1.4, 0.9, 0.55) * ndotl);
    lit += vec3(0.85, 0.72, 0.58) * spec * 0.85 + vec3(0.28, 0.36, 0.48) * fresnel * 0.35;

    // Core-flash bounce on tumbling metallic hull
    if (uFlashIntensity > 0.01) {
      vec3 toFlash = uFlashPos - vWorldPos;
      float d = length(toFlash);
      float atten = uFlashIntensity / max(1.0 + d * d * 0.00022, 1e-4);
      float fDiff = max(dot(N, safeNormalize(toFlash)), 0.0);
      lit += uFlashColor * atten * (0.2 + 0.8 * fDiff) * 0.55;
    }

    // Molten sheared edges glowing with black-body heat
    float lifeT = clamp(vHeatLife.x, 0.0, 1.0);
    float heat = max(vHeatLife.y * (1.0 - lifeT * 0.85), 0.0);
    float edgeMask = smoothstep(0.35, 1.25, length(vLocalPos));
    float flicker = 0.82 + 0.18 * sin(uTime * 22.0 + vHeatLife.w * 19.0);
    vec3 moltenCol = mix(vec3(1.5, 0.22, 0.03), vec3(3.8, 1.85, 0.45), clamp(heat * 0.7, 0.0, 1.0));
    if (vHeatLife.z > 0.5) {
      vec3 prism = hsv2rgb(vec3(fract(vHeatLife.w + uTime * 0.4), 0.92, 1.0)) * 2.6;
      moltenCol = mix(moltenCol, prism, 0.55);
    }

    vec3 finalCol = lit + moltenCol * heat * (0.28 + 0.85 * edgeMask) * flicker;
    gl_FragColor = vec4(clamp(finalCol, 0.0, 14.0), 1.0);
  }
`;

function createUnitQuadInstancedGeometry(): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const positions = new Float32Array([
    -0.5, -0.5, 0,
     0.5, -0.5, 0,
     0.5,  0.5, 0,
    -0.5,  0.5, 0,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.instanceCount = 0;
  return geo;
}

function createDebrisShardInstancedGeometry(): THREE.InstancedBufferGeometry {
  const base = new THREE.OctahedronGeometry(0.88, 0);
  base.scale(1.9, 0.28, 1.15);
  base.computeVertexNormals();

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', base.attributes.position.clone());
  geo.setAttribute('normal', base.attributes.normal.clone());
  if (base.index) {
    geo.setIndex(base.index.clone());
  }
  geo.instanceCount = 0;
  base.dispose();
  return geo;
}

function flushAttributeDirtySlice(
  attr: THREE.InstancedBufferAttribute,
  dirtyStart: number,
  dirtyCount: number,
  capacity: number,
): void {
  const itemSize = attr.itemSize;
  attr.clearUpdateRanges();
  if (dirtyCount >= capacity) {
    attr.addUpdateRange(0, capacity * itemSize);
  } else if (dirtyStart + dirtyCount <= capacity) {
    attr.addUpdateRange(dirtyStart * itemSize, dirtyCount * itemSize);
  } else {
    const tailCount = capacity - dirtyStart;
    const headCount = dirtyCount - tailCount;
    attr.addUpdateRange(dirtyStart * itemSize, tailCount * itemSize);
    attr.addUpdateRange(0, headCount * itemSize);
  }
  attr.needsUpdate = true;
}

/**
 * Zero-GC GPU-kinematic instanced particle engine with write-once spawn buffers
 * and dirty-slice sub-buffer uploads via BufferAttribute.addUpdateRange():
 *  - 6,400 black-body lit volumetric fireball & smoke puffs
 *  - 4,200 velocity-stretched glowing magnesium sparks
 *  - 360 tumbling flaming fuselage debris shards
 */
export class GpuParticleSystem {
  public readonly group = new THREE.Group();
  public readonly puffCapacity = PUFF_CAPACITY;
  public readonly sparkCapacity = SPARK_CAPACITY;
  public readonly debrisCapacity = DEBRIS_CAPACITY;

  public activePuffs = 0;
  public activeSparks = 0;
  public activeDebris = 0;

  // Exposed geometries & meshes for diagnostics and scene graph binding
  public readonly puffGeo: THREE.InstancedBufferGeometry;
  public readonly sparkGeo: THREE.InstancedBufferGeometry;
  public readonly debrisGeo: THREE.InstancedBufferGeometry;
  public readonly puffMesh: THREE.Mesh;
  public readonly sparkMesh: THREE.Mesh;
  public readonly debrisMesh: THREE.Mesh;

  private readonly puffMat: THREE.ShaderMaterial;
  private readonly sparkMat: THREE.ShaderMaterial;
  private readonly debrisMat: THREE.ShaderMaterial;

  // Internal monotonic simulation clock (advances strictly by simDt so pause & slow-mo are exact)
  private simTime = 0;

  // --- Puff immutable spawn-time ring-buffer attributes ---
  private readonly puffSpawnPosData = new Float32Array(PUFF_CAPACITY * 3);
  private readonly puffSpawnVelData = new Float32Array(PUFF_CAPACITY * 3);
  private readonly puffSpawnTimeData = new Float32Array(PUFF_CAPACITY);
  private readonly puffLifeData = new Float32Array(PUFF_CAPACITY);
  private readonly puffSeedData = new Float32Array(PUFF_CAPACITY);
  private readonly puffKinematicsData = new Float32Array(PUFF_CAPACITY * 4);
  private readonly puffScaleTempData = new Float32Array(PUFF_CAPACITY * 4);
  private readonly puffColorAlphaData = new Float32Array(PUFF_CAPACITY * 4);

  private readonly puffSpawnPosAttr: THREE.InstancedBufferAttribute;
  private readonly puffSpawnVelAttr: THREE.InstancedBufferAttribute;
  private readonly puffSpawnTimeAttr: THREE.InstancedBufferAttribute;
  private readonly puffLifeAttr: THREE.InstancedBufferAttribute;
  private readonly puffSeedAttr: THREE.InstancedBufferAttribute;
  private readonly puffKinematicsAttr: THREE.InstancedBufferAttribute;
  private readonly puffScaleTempAttr: THREE.InstancedBufferAttribute;
  private readonly puffColorAlphaAttr: THREE.InstancedBufferAttribute;
  private readonly puffAttrs: readonly THREE.InstancedBufferAttribute[];

  private puffCursor = 0;
  private puffHighWater = 0;
  private puffDirtyStart = 0;
  private puffDirtyCount = 0;
  private puffMaxExpiry = 0;

  // --- Spark immutable spawn-time ring-buffer attributes ---
  private readonly sparkSpawnPosData = new Float32Array(SPARK_CAPACITY * 3);
  private readonly sparkSpawnVelData = new Float32Array(SPARK_CAPACITY * 3);
  private readonly sparkSpawnTimeData = new Float32Array(SPARK_CAPACITY);
  private readonly sparkLifeData = new Float32Array(SPARK_CAPACITY);
  private readonly sparkSeedData = new Float32Array(SPARK_CAPACITY);
  private readonly sparkParamsData = new Float32Array(SPARK_CAPACITY * 3);
  private readonly sparkColorHeatData = new Float32Array(SPARK_CAPACITY * 4);

  private readonly sparkSpawnPosAttr: THREE.InstancedBufferAttribute;
  private readonly sparkSpawnVelAttr: THREE.InstancedBufferAttribute;
  private readonly sparkSpawnTimeAttr: THREE.InstancedBufferAttribute;
  private readonly sparkLifeAttr: THREE.InstancedBufferAttribute;
  private readonly sparkSeedAttr: THREE.InstancedBufferAttribute;
  private readonly sparkParamsAttr: THREE.InstancedBufferAttribute;
  private readonly sparkColorHeatAttr: THREE.InstancedBufferAttribute;
  private readonly sparkAttrs: readonly THREE.InstancedBufferAttribute[];

  private sparkCursor = 0;
  private sparkHighWater = 0;
  private sparkDirtyStart = 0;
  private sparkDirtyCount = 0;
  private sparkMaxExpiry = 0;

  // --- Debris immutable spawn-time ring-buffer attributes ---
  private readonly debrisSpawnPosData = new Float32Array(DEBRIS_CAPACITY * 3);
  private readonly debrisSpawnVelData = new Float32Array(DEBRIS_CAPACITY * 3);
  private readonly debrisSpawnTimeData = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisLifeData = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisSeedData = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisInitQuatData = new Float32Array(DEBRIS_CAPACITY * 4);
  private readonly debrisAngularVelData = new Float32Array(DEBRIS_CAPACITY * 3);
  private readonly debrisMetaData = new Float32Array(DEBRIS_CAPACITY * 3);

  private readonly debrisSpawnPosAttr: THREE.InstancedBufferAttribute;
  private readonly debrisSpawnVelAttr: THREE.InstancedBufferAttribute;
  private readonly debrisSpawnTimeAttr: THREE.InstancedBufferAttribute;
  private readonly debrisLifeAttr: THREE.InstancedBufferAttribute;
  private readonly debrisSeedAttr: THREE.InstancedBufferAttribute;
  private readonly debrisInitQuatAttr: THREE.InstancedBufferAttribute;
  private readonly debrisAngularVelAttr: THREE.InstancedBufferAttribute;
  private readonly debrisMetaAttr: THREE.InstancedBufferAttribute;
  private readonly debrisAttrs: readonly THREE.InstancedBufferAttribute[];

  private debrisCursor = 0;
  private debrisHighWater = 0;
  private debrisDirtyStart = 0;
  private debrisDirtyCount = 0;
  private debrisMaxExpiry = 0;

  // Shared lighting uniforms
  private readonly sunDir = DEFAULT_SUN_DIR.clone();
  private readonly flashPos = new THREE.Vector3();
  private readonly flashColor = new THREE.Vector3(3.4, 2.1, 1.1);
  private flashIntensity = 0;

  constructor(parent: THREE.Object3D) {
    this.group.name = 'GpuParticleSystem';
    parent.add(this.group);

    // 1. Volumetric Fireball & Smoke Puff Pool (6,400 instances)
    this.puffGeo = createUnitQuadInstancedGeometry();
    this.puffSpawnPosAttr = new THREE.InstancedBufferAttribute(this.puffSpawnPosData, 3);
    this.puffSpawnVelAttr = new THREE.InstancedBufferAttribute(this.puffSpawnVelData, 3);
    this.puffSpawnTimeAttr = new THREE.InstancedBufferAttribute(this.puffSpawnTimeData, 1);
    this.puffLifeAttr = new THREE.InstancedBufferAttribute(this.puffLifeData, 1);
    this.puffSeedAttr = new THREE.InstancedBufferAttribute(this.puffSeedData, 1);
    this.puffKinematicsAttr = new THREE.InstancedBufferAttribute(this.puffKinematicsData, 4);
    this.puffScaleTempAttr = new THREE.InstancedBufferAttribute(this.puffScaleTempData, 4);
    this.puffColorAlphaAttr = new THREE.InstancedBufferAttribute(this.puffColorAlphaData, 4);
    this.puffAttrs = [
      this.puffSpawnPosAttr,
      this.puffSpawnVelAttr,
      this.puffSpawnTimeAttr,
      this.puffLifeAttr,
      this.puffSeedAttr,
      this.puffKinematicsAttr,
      this.puffScaleTempAttr,
      this.puffColorAlphaAttr,
    ];
    for (let i = 0; i < this.puffAttrs.length; i++) {
      this.puffAttrs[i].setUsage(THREE.DynamicDrawUsage);
    }

    this.puffGeo.setAttribute('aSpawnPos', this.puffSpawnPosAttr);
    this.puffGeo.setAttribute('aSpawnVel', this.puffSpawnVelAttr);
    this.puffGeo.setAttribute('aSpawnTime', this.puffSpawnTimeAttr);
    this.puffGeo.setAttribute('aLife', this.puffLifeAttr);
    this.puffGeo.setAttribute('aSeed', this.puffSeedAttr);
    this.puffGeo.setAttribute('aPuffKinematics', this.puffKinematicsAttr);
    this.puffGeo.setAttribute('aPuffScaleTemp', this.puffScaleTempAttr);
    this.puffGeo.setAttribute('aColorAlpha', this.puffColorAlphaAttr);

    this.puffMat = new THREE.ShaderMaterial({
      vertexShader: PUFF_VERT,
      fragmentShader: PUFF_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uSimTime: { value: 0 },
        uTime: { value: 0 },
        uTrip: { value: 0 },
        uSunDir: { value: this.sunDir },
        uFlashPos: { value: this.flashPos },
        uFlashColor: { value: this.flashColor },
        uFlashIntensity: { value: 0 },
      },
    });
    this.puffMesh = new THREE.Mesh(this.puffGeo, this.puffMat);
    this.puffMesh.frustumCulled = false;
    this.puffMesh.visible = false;
    this.puffMesh.renderOrder = 20;
    this.group.add(this.puffMesh);

    // 2. Velocity-Stretched Glowing Spark Pool (4,200 instances)
    this.sparkGeo = createUnitQuadInstancedGeometry();
    this.sparkSpawnPosAttr = new THREE.InstancedBufferAttribute(this.sparkSpawnPosData, 3);
    this.sparkSpawnVelAttr = new THREE.InstancedBufferAttribute(this.sparkSpawnVelData, 3);
    this.sparkSpawnTimeAttr = new THREE.InstancedBufferAttribute(this.sparkSpawnTimeData, 1);
    this.sparkLifeAttr = new THREE.InstancedBufferAttribute(this.sparkLifeData, 1);
    this.sparkSeedAttr = new THREE.InstancedBufferAttribute(this.sparkSeedData, 1);
    this.sparkParamsAttr = new THREE.InstancedBufferAttribute(this.sparkParamsData, 3);
    this.sparkColorHeatAttr = new THREE.InstancedBufferAttribute(this.sparkColorHeatData, 4);
    this.sparkAttrs = [
      this.sparkSpawnPosAttr,
      this.sparkSpawnVelAttr,
      this.sparkSpawnTimeAttr,
      this.sparkLifeAttr,
      this.sparkSeedAttr,
      this.sparkParamsAttr,
      this.sparkColorHeatAttr,
    ];
    for (let i = 0; i < this.sparkAttrs.length; i++) {
      this.sparkAttrs[i].setUsage(THREE.DynamicDrawUsage);
    }

    this.sparkGeo.setAttribute('aSpawnPos', this.sparkSpawnPosAttr);
    this.sparkGeo.setAttribute('aSpawnVel', this.sparkSpawnVelAttr);
    this.sparkGeo.setAttribute('aSpawnTime', this.sparkSpawnTimeAttr);
    this.sparkGeo.setAttribute('aLife', this.sparkLifeAttr);
    this.sparkGeo.setAttribute('aSeed', this.sparkSeedAttr);
    this.sparkGeo.setAttribute('aSparkParams', this.sparkParamsAttr);
    this.sparkGeo.setAttribute('aColorHeat', this.sparkColorHeatAttr);

    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSimTime: { value: 0 },
      },
    });
    this.sparkMesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.visible = false;
    this.sparkMesh.renderOrder = 24;
    this.group.add(this.sparkMesh);

    // 3. Tumbling Flaming Debris Pool (360 instances)
    this.debrisGeo = createDebrisShardInstancedGeometry();
    this.debrisSpawnPosAttr = new THREE.InstancedBufferAttribute(this.debrisSpawnPosData, 3);
    this.debrisSpawnVelAttr = new THREE.InstancedBufferAttribute(this.debrisSpawnVelData, 3);
    this.debrisSpawnTimeAttr = new THREE.InstancedBufferAttribute(this.debrisSpawnTimeData, 1);
    this.debrisLifeAttr = new THREE.InstancedBufferAttribute(this.debrisLifeData, 1);
    this.debrisSeedAttr = new THREE.InstancedBufferAttribute(this.debrisSeedData, 1);
    this.debrisInitQuatAttr = new THREE.InstancedBufferAttribute(this.debrisInitQuatData, 4);
    this.debrisAngularVelAttr = new THREE.InstancedBufferAttribute(this.debrisAngularVelData, 3);
    this.debrisMetaAttr = new THREE.InstancedBufferAttribute(this.debrisMetaData, 3);
    this.debrisAttrs = [
      this.debrisSpawnPosAttr,
      this.debrisSpawnVelAttr,
      this.debrisSpawnTimeAttr,
      this.debrisLifeAttr,
      this.debrisSeedAttr,
      this.debrisInitQuatAttr,
      this.debrisAngularVelAttr,
      this.debrisMetaAttr,
    ];
    for (let i = 0; i < this.debrisAttrs.length; i++) {
      this.debrisAttrs[i].setUsage(THREE.DynamicDrawUsage);
    }

    this.debrisGeo.setAttribute('aSpawnPos', this.debrisSpawnPosAttr);
    this.debrisGeo.setAttribute('aSpawnVel', this.debrisSpawnVelAttr);
    this.debrisGeo.setAttribute('aSpawnTime', this.debrisSpawnTimeAttr);
    this.debrisGeo.setAttribute('aLife', this.debrisLifeAttr);
    this.debrisGeo.setAttribute('aSeed', this.debrisSeedAttr);
    this.debrisGeo.setAttribute('aInitQuat', this.debrisInitQuatAttr);
    this.debrisGeo.setAttribute('aAngularVel', this.debrisAngularVelAttr);
    this.debrisGeo.setAttribute('aDebrisMeta', this.debrisMetaAttr);

    this.debrisMat = new THREE.ShaderMaterial({
      vertexShader: DEBRIS_VERT,
      fragmentShader: DEBRIS_FRAG,
      transparent: false,
      depthWrite: true,
      uniforms: {
        uSimTime: { value: 0 },
        uSunDir: { value: this.sunDir },
        uFlashPos: { value: this.flashPos },
        uFlashColor: { value: this.flashColor },
        uFlashIntensity: { value: 0 },
        uTime: { value: 0 },
      },
    });
    this.debrisMesh = new THREE.Mesh(this.debrisGeo, this.debrisMat);
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.visible = false;
    this.debrisMesh.renderOrder = 15;
    this.group.add(this.debrisMesh);
  }

  public setCoreFlash(
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    intensity: number,
  ): void {
    this.flashPos.set(x, y, z);
    this.flashColor.set(r, g, b);
    this.flashIntensity = Math.max(0, intensity);
    this.puffMat.uniforms.uFlashIntensity.value = this.flashIntensity;
    this.debrisMat.uniforms.uFlashIntensity.value = this.flashIntensity;
  }

  public emitPuff(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    startScale: number,
    endScale: number,
    life: number,
    startTemp: number,
    endTemp: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    drag = 1.4,
    buoyancy = 9.0,
    spin = 0.55,
    mode = 0,
  ): void {
    const idx = this.puffCursor;
    if (this.puffDirtyCount === 0) {
      this.puffDirtyStart = idx;
    }
    if (this.puffDirtyCount < PUFF_CAPACITY) {
      this.puffDirtyCount++;
    }

    this.puffCursor = (idx + 1) % PUFF_CAPACITY;
    if (idx + 1 > this.puffHighWater) {
      this.puffHighWater = idx + 1;
    }

    const safeLife = Math.max(0.05, life);
    const expiry = this.simTime + safeLife;
    if (expiry > this.puffMaxExpiry) {
      this.puffMaxExpiry = expiry;
    }

    const i3 = idx * 3;
    this.puffSpawnPosData[i3] = x;
    this.puffSpawnPosData[i3 + 1] = y;
    this.puffSpawnPosData[i3 + 2] = z;

    this.puffSpawnVelData[i3] = vx;
    this.puffSpawnVelData[i3 + 1] = vy;
    this.puffSpawnVelData[i3 + 2] = vz;

    this.puffSpawnTimeData[idx] = this.simTime;
    this.puffLifeData[idx] = safeLife;
    this.puffSeedData[idx] = Math.floor(mode) + Math.random() * 0.999;

    const i4 = idx * 4;
    this.puffKinematicsData[i4] = drag;
    this.puffKinematicsData[i4 + 1] = buoyancy;
    this.puffKinematicsData[i4 + 2] = Math.random() * Math.PI * 2;
    this.puffKinematicsData[i4 + 3] = spin;

    this.puffScaleTempData[i4] = startScale;
    this.puffScaleTempData[i4 + 1] = endScale;
    this.puffScaleTempData[i4 + 2] = startTemp;
    this.puffScaleTempData[i4 + 3] = endTemp;

    this.puffColorAlphaData[i4] = r;
    this.puffColorAlphaData[i4 + 1] = g;
    this.puffColorAlphaData[i4 + 2] = b;
    this.puffColorAlphaData[i4 + 3] = alpha;

    this.activePuffs = this.puffHighWater;
    this.puffGeo.instanceCount = this.puffHighWater;
    this.puffMesh.visible = true;
  }

  public emitSpark(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    life: number,
    r: number,
    g: number,
    b: number,
    heat = 1.25,
    drag = 0.58,
    gravity = 26.0,
  ): void {
    const idx = this.sparkCursor;
    if (this.sparkDirtyCount === 0) {
      this.sparkDirtyStart = idx;
    }
    if (this.sparkDirtyCount < SPARK_CAPACITY) {
      this.sparkDirtyCount++;
    }

    this.sparkCursor = (idx + 1) % SPARK_CAPACITY;
    if (idx + 1 > this.sparkHighWater) {
      this.sparkHighWater = idx + 1;
    }

    const safeLife = Math.max(0.05, life);
    const expiry = this.simTime + safeLife;
    if (expiry > this.sparkMaxExpiry) {
      this.sparkMaxExpiry = expiry;
    }

    const i3 = idx * 3;
    this.sparkSpawnPosData[i3] = x;
    this.sparkSpawnPosData[i3 + 1] = y;
    this.sparkSpawnPosData[i3 + 2] = z;

    this.sparkSpawnVelData[i3] = vx;
    this.sparkSpawnVelData[i3 + 1] = vy;
    this.sparkSpawnVelData[i3 + 2] = vz;

    this.sparkSpawnTimeData[idx] = this.simTime;
    this.sparkLifeData[idx] = safeLife;
    this.sparkSeedData[idx] = Math.random();

    this.sparkParamsData[i3] = size;
    this.sparkParamsData[i3 + 1] = drag;
    this.sparkParamsData[i3 + 2] = gravity;

    const i4 = idx * 4;
    this.sparkColorHeatData[i4] = r;
    this.sparkColorHeatData[i4 + 1] = g;
    this.sparkColorHeatData[i4 + 2] = b;
    this.sparkColorHeatData[i4 + 3] = heat;

    this.activeSparks = this.sparkHighWater;
    this.sparkGeo.instanceCount = this.sparkHighWater;
    this.sparkMesh.visible = true;
  }

  public emitDebris(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    wx: number,
    wy: number,
    wz: number,
    scale: number,
    life: number,
    heat = 1.35,
    prism = 0,
  ): void {
    const idx = this.debrisCursor;
    if (this.debrisDirtyCount === 0) {
      this.debrisDirtyStart = idx;
    }
    if (this.debrisDirtyCount < DEBRIS_CAPACITY) {
      this.debrisDirtyCount++;
    }

    this.debrisCursor = (idx + 1) % DEBRIS_CAPACITY;
    if (idx + 1 > this.debrisHighWater) {
      this.debrisHighWater = idx + 1;
    }

    const safeLife = Math.max(0.1, life);
    const expiry = this.simTime + safeLife;
    if (expiry > this.debrisMaxExpiry) {
      this.debrisMaxExpiry = expiry;
    }

    const i3 = idx * 3;
    this.debrisSpawnPosData[i3] = x;
    this.debrisSpawnPosData[i3 + 1] = y;
    this.debrisSpawnPosData[i3 + 2] = z;

    this.debrisSpawnVelData[i3] = vx;
    this.debrisSpawnVelData[i3 + 1] = vy;
    this.debrisSpawnVelData[i3 + 2] = vz;

    this.debrisSpawnTimeData[idx] = this.simTime;
    this.debrisLifeData[idx] = safeLife;
    this.debrisSeedData[idx] = Math.random();

    // Seed an arbitrary unit quaternion without allocating objects
    const qx = Math.random() - 0.5;
    const qy = Math.random() - 0.5;
    const qz = Math.random() - 0.5;
    const qw = Math.random() - 0.5;
    const qLen = Math.hypot(qx, qy, qz, qw) || 1;
    const i4 = idx * 4;
    this.debrisInitQuatData[i4] = qx / qLen;
    this.debrisInitQuatData[i4 + 1] = qy / qLen;
    this.debrisInitQuatData[i4 + 2] = qz / qLen;
    this.debrisInitQuatData[i4 + 3] = qw / qLen;

    this.debrisAngularVelData[i3] = wx;
    this.debrisAngularVelData[i3 + 1] = wy;
    this.debrisAngularVelData[i3 + 2] = wz;

    this.debrisMetaData[i3] = scale;
    this.debrisMetaData[i3 + 1] = heat;
    this.debrisMetaData[i3 + 2] = prism;

    this.activeDebris = this.debrisHighWater;
    this.debrisGeo.instanceCount = this.debrisHighWater;
    this.debrisMesh.visible = true;
  }

  public clear(): void {
    this.simTime = 0;

    this.puffCursor = 0;
    this.puffHighWater = 0;
    this.puffDirtyStart = 0;
    this.puffDirtyCount = 0;
    this.puffMaxExpiry = 0;
    this.activePuffs = 0;
    this.puffGeo.instanceCount = 0;
    this.puffMesh.visible = false;

    this.sparkCursor = 0;
    this.sparkHighWater = 0;
    this.sparkDirtyStart = 0;
    this.sparkDirtyCount = 0;
    this.sparkMaxExpiry = 0;
    this.activeSparks = 0;
    this.sparkGeo.instanceCount = 0;
    this.sparkMesh.visible = false;

    this.debrisCursor = 0;
    this.debrisHighWater = 0;
    this.debrisDirtyStart = 0;
    this.debrisDirtyCount = 0;
    this.debrisMaxExpiry = 0;
    this.activeDebris = 0;
    this.debrisGeo.instanceCount = 0;
    this.debrisMesh.visible = false;

    this.flashIntensity = 0;
    this.puffMat.uniforms.uSimTime.value = 0;
    this.puffMat.uniforms.uFlashIntensity.value = 0;
    this.sparkMat.uniforms.uSimTime.value = 0;
    this.debrisMat.uniforms.uSimTime.value = 0;
    this.debrisMat.uniforms.uFlashIntensity.value = 0;
  }

  public update(dt: number, time: number, tripIntensity: number): void {
    const safeDt = Math.max(0, Math.min(dt, 0.05));
    this.simTime += safeDt;

    this.puffMat.uniforms.uSimTime.value = this.simTime;
    this.puffMat.uniforms.uTime.value = time;
    this.puffMat.uniforms.uTrip.value = tripIntensity;

    this.sparkMat.uniforms.uSimTime.value = this.simTime;

    this.debrisMat.uniforms.uSimTime.value = this.simTime;
    this.debrisMat.uniforms.uTime.value = time;

    // Upload ONLY newly spawned dirty ring-buffer slices to GPU (zero CPU particle loops)
    if (this.puffDirtyCount > 0) {
      for (let i = 0; i < this.puffAttrs.length; i++) {
        flushAttributeDirtySlice(
          this.puffAttrs[i],
          this.puffDirtyStart,
          this.puffDirtyCount,
          PUFF_CAPACITY,
        );
      }
      this.puffDirtyCount = 0;
      this.puffDirtyStart = this.puffCursor;
    } else if (this.puffHighWater > 0 && this.simTime > this.puffMaxExpiry) {
      // Every spawned puff has expired; reclaim pool draw call in O(1)
      this.puffHighWater = 0;
      this.puffCursor = 0;
      this.activePuffs = 0;
      this.puffGeo.instanceCount = 0;
      this.puffMesh.visible = false;
    }

    if (this.sparkDirtyCount > 0) {
      for (let i = 0; i < this.sparkAttrs.length; i++) {
        flushAttributeDirtySlice(
          this.sparkAttrs[i],
          this.sparkDirtyStart,
          this.sparkDirtyCount,
          SPARK_CAPACITY,
        );
      }
      this.sparkDirtyCount = 0;
      this.sparkDirtyStart = this.sparkCursor;
    } else if (this.sparkHighWater > 0 && this.simTime > this.sparkMaxExpiry) {
      this.sparkHighWater = 0;
      this.sparkCursor = 0;
      this.activeSparks = 0;
      this.sparkGeo.instanceCount = 0;
      this.sparkMesh.visible = false;
    }

    if (this.debrisDirtyCount > 0) {
      for (let i = 0; i < this.debrisAttrs.length; i++) {
        flushAttributeDirtySlice(
          this.debrisAttrs[i],
          this.debrisDirtyStart,
          this.debrisDirtyCount,
          DEBRIS_CAPACITY,
        );
      }
      this.debrisDirtyCount = 0;
      this.debrisDirtyStart = this.debrisCursor;
    } else if (this.debrisHighWater > 0 && this.simTime > this.debrisMaxExpiry) {
      this.debrisHighWater = 0;
      this.debrisCursor = 0;
      this.activeDebris = 0;
      this.debrisGeo.instanceCount = 0;
      this.debrisMesh.visible = false;
    }
  }
}
