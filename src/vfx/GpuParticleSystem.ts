import * as THREE from 'three';

export const PUFF_CAPACITY = 6400;
export const SPARK_CAPACITY = 4200;
export const DEBRIS_CAPACITY = 360;

const DEFAULT_SUN_DIR = new THREE.Vector3(-0.35, 0.18, -0.92).normalize();

const PUFF_VERT = /* glsl */ `
  attribute vec4 aPosScale;
  attribute vec4 aMeta;
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

  void main() {
    if (aPosScale.w <= 1e-4 || aMeta.x >= 1.0 || aColorAlpha.a <= 1e-4) {
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

    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 camForward = safeNormalize(cameraPosition - aPosScale.xyz);

    float c = cos(aMeta.z);
    float s = sin(aMeta.z);
    vec2 rotated = vec2(
      position.x * c - position.y * s,
      position.x * s + position.y * c
    );

    vec3 worldPos = aPosScale.xyz + (camRight * rotated.x + camUp * rotated.y) * aPosScale.w;

    vLocalPos = position.xy * 2.0;
    vWorldCenter = aPosScale.xyz;
    vMeta = aMeta;
    vColorAlpha = aColorAlpha;
    vCamRight = camRight;
    vCamUp = camUp;
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
  attribute vec4 aPosSize;
  attribute vec4 aVelLife;
  attribute vec4 aColorHeat;

  varying vec2 vUv;
  varying vec4 vColorHeat;
  varying float vLifeT;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    float lifeT = aVelLife.w;
    if (aPosSize.w <= 1e-4 || lifeT >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vUv = vec2(0.0);
      vColorHeat = vec4(0.0);
      vLifeT = 1.0;
      return;
    }

    vec3 vel = aVelLife.xyz;
    float speed = length(vel);
    vec3 dir = speed > 1e-3 ? vel / speed : vec3(0.0, 1.0, 0.0);
    vec3 toCam = safeNormalize(cameraPosition - aPosSize.xyz);

    vec3 side = cross(dir, toCam);
    if (length(side) < 1e-3) {
      side = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    }
    side = safeNormalize(side);

    float fade = 1.0 - clamp(lifeT, 0.0, 1.0);
    float width = aPosSize.w * (0.42 + 0.58 * fade);
    float streakLen = max(width * 2.4, aPosSize.w * (2.0 + speed * 0.044) * (0.35 + 0.65 * fade));

    vec3 worldPos = aPosSize.xyz
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
    float headCap = smoothstep(1.0, 0.72, along);
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
  attribute vec4 aPosScale;
  attribute vec4 aQuat;
  attribute vec4 aHeatLife;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  varying vec4 vHeatLife;

  vec3 rotateQuat(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    if (aPosScale.w <= 1e-4 || aHeatLife.x >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vWorldNormal = vec3(0.0, 1.0, 0.0);
      vWorldPos = vec3(0.0);
      vLocalPos = vec3(0.0);
      vHeatLife = vec4(1.0, 0.0, 0.0, 0.0);
      return;
    }

    vec3 scaledPos = position * aPosScale.w;
    vec3 worldPos = aPosScale.xyz + rotateQuat(aQuat, scaledPos);
    vec3 worldN = safeNormalize(rotateQuat(aQuat, normal));

    vWorldPos = worldPos;
    vWorldNormal = worldN;
    vLocalPos = position;
    vHeatLife = aHeatLife;

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

/**
 * Zero-GC GPU-instanced particle engine with pre-allocated ring-buffered
 * InstancedBufferGeometry pools:
 *  - 6,400 black-body lit volumetric fireball & smoke puffs
 *  - 4,200 velocity-stretched glowing magnesium sparks
 *  - 360 tumbling flaming fuselage debris chunks trailing volumetric smoke
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

  // --- Puff ring-buffer GPU & CPU state ---
  private readonly puffPosScaleData = new Float32Array(PUFF_CAPACITY * 4);
  private readonly puffMetaData = new Float32Array(PUFF_CAPACITY * 4);
  private readonly puffColorAlphaData = new Float32Array(PUFF_CAPACITY * 4);
  private readonly puffPosScaleAttr: THREE.InstancedBufferAttribute;
  private readonly puffMetaAttr: THREE.InstancedBufferAttribute;
  private readonly puffColorAlphaAttr: THREE.InstancedBufferAttribute;

  private readonly puffVx = new Float32Array(PUFF_CAPACITY);
  private readonly puffVy = new Float32Array(PUFF_CAPACITY);
  private readonly puffVz = new Float32Array(PUFF_CAPACITY);
  private readonly puffAge = new Float32Array(PUFF_CAPACITY);
  private readonly puffLife = new Float32Array(PUFF_CAPACITY);
  private readonly puffStartScale = new Float32Array(PUFF_CAPACITY);
  private readonly puffEndScale = new Float32Array(PUFF_CAPACITY);
  private readonly puffStartTemp = new Float32Array(PUFF_CAPACITY);
  private readonly puffEndTemp = new Float32Array(PUFF_CAPACITY);
  private readonly puffDrag = new Float32Array(PUFF_CAPACITY);
  private readonly puffBuoyancy = new Float32Array(PUFF_CAPACITY);
  private readonly puffSpin = new Float32Array(PUFF_CAPACITY);
  private puffCursor = 0;
  private puffHighWater = 0;

  // --- Spark ring-buffer GPU & CPU state ---
  private readonly sparkPosSizeData = new Float32Array(SPARK_CAPACITY * 4);
  private readonly sparkVelLifeData = new Float32Array(SPARK_CAPACITY * 4);
  private readonly sparkColorHeatData = new Float32Array(SPARK_CAPACITY * 4);
  private readonly sparkPosSizeAttr: THREE.InstancedBufferAttribute;
  private readonly sparkVelLifeAttr: THREE.InstancedBufferAttribute;
  private readonly sparkColorHeatAttr: THREE.InstancedBufferAttribute;

  private readonly sparkAge = new Float32Array(SPARK_CAPACITY);
  private readonly sparkLife = new Float32Array(SPARK_CAPACITY);
  private readonly sparkBaseSize = new Float32Array(SPARK_CAPACITY);
  private readonly sparkDrag = new Float32Array(SPARK_CAPACITY);
  private readonly sparkGravity = new Float32Array(SPARK_CAPACITY);
  private sparkCursor = 0;
  private sparkHighWater = 0;

  // --- Debris ring-buffer GPU & CPU state ---
  private readonly debrisPosScaleData = new Float32Array(DEBRIS_CAPACITY * 4);
  private readonly debrisQuatData = new Float32Array(DEBRIS_CAPACITY * 4);
  private readonly debrisHeatLifeData = new Float32Array(DEBRIS_CAPACITY * 4);
  private readonly debrisPosScaleAttr: THREE.InstancedBufferAttribute;
  private readonly debrisQuatAttr: THREE.InstancedBufferAttribute;
  private readonly debrisHeatLifeAttr: THREE.InstancedBufferAttribute;

  private readonly debrisVx = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisVy = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisVz = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisWx = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisWy = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisWz = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisAge = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisLife = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisBaseScale = new Float32Array(DEBRIS_CAPACITY);
  private readonly debrisSmokeTimer = new Float32Array(DEBRIS_CAPACITY);
  private debrisCursor = 0;
  private debrisHighWater = 0;

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
    this.puffPosScaleAttr = new THREE.InstancedBufferAttribute(this.puffPosScaleData, 4);
    this.puffPosScaleAttr.setUsage(THREE.DynamicDrawUsage);
    this.puffMetaAttr = new THREE.InstancedBufferAttribute(this.puffMetaData, 4);
    this.puffMetaAttr.setUsage(THREE.DynamicDrawUsage);
    this.puffColorAlphaAttr = new THREE.InstancedBufferAttribute(this.puffColorAlphaData, 4);
    this.puffColorAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.puffGeo.setAttribute('aPosScale', this.puffPosScaleAttr);
    this.puffGeo.setAttribute('aMeta', this.puffMetaAttr);
    this.puffGeo.setAttribute('aColorAlpha', this.puffColorAlphaAttr);

    this.puffMat = new THREE.ShaderMaterial({
      vertexShader: PUFF_VERT,
      fragmentShader: PUFF_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
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
    this.puffMesh.renderOrder = 20;
    this.group.add(this.puffMesh);

    // 2. Velocity-Stretched Glowing Spark Pool (4,200 instances)
    this.sparkGeo = createUnitQuadInstancedGeometry();
    this.sparkPosSizeAttr = new THREE.InstancedBufferAttribute(this.sparkPosSizeData, 4);
    this.sparkPosSizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.sparkVelLifeAttr = new THREE.InstancedBufferAttribute(this.sparkVelLifeData, 4);
    this.sparkVelLifeAttr.setUsage(THREE.DynamicDrawUsage);
    this.sparkColorHeatAttr = new THREE.InstancedBufferAttribute(this.sparkColorHeatData, 4);
    this.sparkColorHeatAttr.setUsage(THREE.DynamicDrawUsage);
    this.sparkGeo.setAttribute('aPosSize', this.sparkPosSizeAttr);
    this.sparkGeo.setAttribute('aVelLife', this.sparkVelLifeAttr);
    this.sparkGeo.setAttribute('aColorHeat', this.sparkColorHeatAttr);

    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sparkMesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = 24;
    this.group.add(this.sparkMesh);

    // 3. Tumbling Flaming Debris Pool (360 instances)
    this.debrisGeo = createDebrisShardInstancedGeometry();
    this.debrisPosScaleAttr = new THREE.InstancedBufferAttribute(this.debrisPosScaleData, 4);
    this.debrisPosScaleAttr.setUsage(THREE.DynamicDrawUsage);
    this.debrisQuatAttr = new THREE.InstancedBufferAttribute(this.debrisQuatData, 4);
    this.debrisQuatAttr.setUsage(THREE.DynamicDrawUsage);
    this.debrisHeatLifeAttr = new THREE.InstancedBufferAttribute(this.debrisHeatLifeData, 4);
    this.debrisHeatLifeAttr.setUsage(THREE.DynamicDrawUsage);
    this.debrisGeo.setAttribute('aPosScale', this.debrisPosScaleAttr);
    this.debrisGeo.setAttribute('aQuat', this.debrisQuatAttr);
    this.debrisGeo.setAttribute('aHeatLife', this.debrisHeatLifeAttr);

    this.debrisMat = new THREE.ShaderMaterial({
      vertexShader: DEBRIS_VERT,
      fragmentShader: DEBRIS_FRAG,
      transparent: false,
      depthWrite: true,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uFlashPos: { value: this.flashPos },
        uFlashColor: { value: this.flashColor },
        uFlashIntensity: { value: 0 },
        uTime: { value: 0 },
      },
    });
    this.debrisMesh = new THREE.Mesh(this.debrisGeo, this.debrisMat);
    this.debrisMesh.frustumCulled = false;
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
    this.puffCursor = (this.puffCursor + 1) % PUFF_CAPACITY;
    if (idx + 1 > this.puffHighWater) {
      this.puffHighWater = idx + 1;
    }

    const i4 = idx * 4;
    this.puffPosScaleData[i4] = x;
    this.puffPosScaleData[i4 + 1] = y;
    this.puffPosScaleData[i4 + 2] = z;
    this.puffPosScaleData[i4 + 3] = startScale;

    this.puffMetaData[i4] = 0;
    this.puffMetaData[i4 + 1] = startTemp;
    this.puffMetaData[i4 + 2] = Math.random() * Math.PI * 2;
    this.puffMetaData[i4 + 3] = Math.floor(mode) + Math.random() * 0.999;

    this.puffColorAlphaData[i4] = r;
    this.puffColorAlphaData[i4 + 1] = g;
    this.puffColorAlphaData[i4 + 2] = b;
    this.puffColorAlphaData[i4 + 3] = alpha;

    this.puffVx[idx] = vx;
    this.puffVy[idx] = vy;
    this.puffVz[idx] = vz;
    this.puffAge[idx] = 0;
    this.puffLife[idx] = Math.max(0.05, life);
    this.puffStartScale[idx] = startScale;
    this.puffEndScale[idx] = endScale;
    this.puffStartTemp[idx] = startTemp;
    this.puffEndTemp[idx] = endTemp;
    this.puffDrag[idx] = drag;
    this.puffBuoyancy[idx] = buoyancy;
    this.puffSpin[idx] = spin;

    this.puffGeo.instanceCount = this.puffHighWater;
    this.puffPosScaleAttr.needsUpdate = true;
    this.puffMetaAttr.needsUpdate = true;
    this.puffColorAlphaAttr.needsUpdate = true;
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
    this.sparkCursor = (this.sparkCursor + 1) % SPARK_CAPACITY;
    if (idx + 1 > this.sparkHighWater) {
      this.sparkHighWater = idx + 1;
    }

    const i4 = idx * 4;
    this.sparkPosSizeData[i4] = x;
    this.sparkPosSizeData[i4 + 1] = y;
    this.sparkPosSizeData[i4 + 2] = z;
    this.sparkPosSizeData[i4 + 3] = size;

    this.sparkVelLifeData[i4] = vx;
    this.sparkVelLifeData[i4 + 1] = vy;
    this.sparkVelLifeData[i4 + 2] = vz;
    this.sparkVelLifeData[i4 + 3] = 0;

    this.sparkColorHeatData[i4] = r;
    this.sparkColorHeatData[i4 + 1] = g;
    this.sparkColorHeatData[i4 + 2] = b;
    this.sparkColorHeatData[i4 + 3] = heat;

    this.sparkAge[idx] = 0;
    this.sparkLife[idx] = Math.max(0.05, life);
    this.sparkBaseSize[idx] = size;
    this.sparkDrag[idx] = drag;
    this.sparkGravity[idx] = gravity;

    this.sparkGeo.instanceCount = this.sparkHighWater;
    this.sparkPosSizeAttr.needsUpdate = true;
    this.sparkVelLifeAttr.needsUpdate = true;
    this.sparkColorHeatAttr.needsUpdate = true;
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
    this.debrisCursor = (this.debrisCursor + 1) % DEBRIS_CAPACITY;
    if (idx + 1 > this.debrisHighWater) {
      this.debrisHighWater = idx + 1;
    }

    const i4 = idx * 4;
    this.debrisPosScaleData[i4] = x;
    this.debrisPosScaleData[i4 + 1] = y;
    this.debrisPosScaleData[i4 + 2] = z;
    this.debrisPosScaleData[i4 + 3] = scale;

    // Seed an arbitrary unit quaternion without allocating objects
    const qx = Math.random() - 0.5;
    const qy = Math.random() - 0.5;
    const qz = Math.random() - 0.5;
    const qw = Math.random() - 0.5;
    const qLen = Math.hypot(qx, qy, qz, qw) || 1;
    this.debrisQuatData[i4] = qx / qLen;
    this.debrisQuatData[i4 + 1] = qy / qLen;
    this.debrisQuatData[i4 + 2] = qz / qLen;
    this.debrisQuatData[i4 + 3] = qw / qLen;

    this.debrisHeatLifeData[i4] = 0;
    this.debrisHeatLifeData[i4 + 1] = heat;
    this.debrisHeatLifeData[i4 + 2] = prism;
    this.debrisHeatLifeData[i4 + 3] = Math.random();

    this.debrisVx[idx] = vx;
    this.debrisVy[idx] = vy;
    this.debrisVz[idx] = vz;
    this.debrisWx[idx] = wx;
    this.debrisWy[idx] = wy;
    this.debrisWz[idx] = wz;
    this.debrisAge[idx] = 0;
    this.debrisLife[idx] = Math.max(0.1, life);
    this.debrisBaseScale[idx] = scale;
    this.debrisSmokeTimer[idx] = Math.random() * 0.035;

    this.debrisGeo.instanceCount = this.debrisHighWater;
    this.debrisPosScaleAttr.needsUpdate = true;
    this.debrisQuatAttr.needsUpdate = true;
    this.debrisHeatLifeAttr.needsUpdate = true;
  }

  public clear(): void {
    this.puffLife.fill(0);
    this.puffPosScaleData.fill(0);
    this.puffCursor = 0;
    this.puffHighWater = 0;
    this.activePuffs = 0;
    this.puffGeo.instanceCount = 0;
    this.puffPosScaleAttr.needsUpdate = true;

    this.sparkLife.fill(0);
    this.sparkPosSizeData.fill(0);
    this.sparkCursor = 0;
    this.sparkHighWater = 0;
    this.activeSparks = 0;
    this.sparkGeo.instanceCount = 0;
    this.sparkPosSizeAttr.needsUpdate = true;

    this.debrisLife.fill(0);
    this.debrisPosScaleData.fill(0);
    this.debrisCursor = 0;
    this.debrisHighWater = 0;
    this.activeDebris = 0;
    this.debrisGeo.instanceCount = 0;
    this.debrisPosScaleAttr.needsUpdate = true;

    this.flashIntensity = 0;
    this.puffMat.uniforms.uFlashIntensity.value = 0;
    this.debrisMat.uniforms.uFlashIntensity.value = 0;
  }

  public update(dt: number, time: number, tripIntensity: number): void {
    const safeDt = Math.max(0, Math.min(dt, 0.05));
    this.puffMat.uniforms.uTime.value = time;
    this.puffMat.uniforms.uTrip.value = tripIntensity;
    this.debrisMat.uniforms.uTime.value = time;

    // 1. Integrate tumbling flaming debris FIRST so live shards emit trailing smoke & embers
    if (this.debrisHighWater > 0) {
      let liveDebris = 0;
      const hw = this.debrisHighWater;
      const posScale = this.debrisPosScaleData;
      const quat = this.debrisQuatData;
      const heatLife = this.debrisHeatLifeData;

      for (let i = 0; i < hw; i++) {
        const life = this.debrisLife[i];
        if (life <= 0) continue;

        const age = this.debrisAge[i] + safeDt;
        const i4 = i * 4;
        if (age >= life) {
          this.debrisLife[i] = 0;
          posScale[i4 + 3] = 0;
          heatLife[i4] = 1;
          continue;
        }

        this.debrisAge[i] = age;
        const t = age / life;
        liveDebris++;

        const dragFactor = Math.max(0, 1 - 0.24 * safeDt);
        const vx = this.debrisVx[i] * dragFactor;
        const vy = (this.debrisVy[i] - 46 * safeDt) * dragFactor;
        const vz = this.debrisVz[i] * dragFactor;
        this.debrisVx[i] = vx;
        this.debrisVy[i] = vy;
        this.debrisVz[i] = vz;

        const px = posScale[i4] + vx * safeDt;
        const py = posScale[i4 + 1] + vy * safeDt;
        const pz = posScale[i4 + 2] + vz * safeDt;
        posScale[i4] = px;
        posScale[i4 + 1] = py;
        posScale[i4 + 2] = pz;
        posScale[i4 + 3] = this.debrisBaseScale[i] * (1 - t * 0.48);

        // Scalar quaternion integration: q' = q + 0.5 * dt * (w, 0) * q
        const qx = quat[i4];
        const qy = quat[i4 + 1];
        const qz = quat[i4 + 2];
        const qw = quat[i4 + 3];
        const wx = this.debrisWx[i];
        const wy = this.debrisWy[i];
        const wz = this.debrisWz[i];
        const halfDt = 0.5 * safeDt;

        const nqx = qx + halfDt * (wx * qw + wy * qz - wz * qy);
        const nqy = qy + halfDt * (wy * qw + wz * qx - wx * qz);
        const nqz = qz + halfDt * (wz * qw + wx * qy - wy * qx);
        const nqw = qw + halfDt * (-wx * qx - wy * qy - wz * qz);
        const qLen = Math.hypot(nqx, nqy, nqz, nqw) || 1;
        quat[i4] = nqx / qLen;
        quat[i4 + 1] = nqy / qLen;
        quat[i4 + 2] = nqz / qLen;
        quat[i4 + 3] = nqw / qLen;

        heatLife[i4] = t;

        // Emit curling dark soot & glowing ember trail behind live flaming fuselage shards
        if (safeDt > 0 && t < 0.85) {
          const timer = this.debrisSmokeTimer[i] + safeDt;
          if (timer >= 0.036) {
            this.debrisSmokeTimer[i] = timer - 0.036;
            const trailHeat = Math.max(0.05, heatLife[i4 + 1] * (1 - t) * 0.72);
            const isPrism = heatLife[i4 + 2] > 0.5 ? 1 : 0;
            this.emitPuff(
              px,
              py,
              pz,
              vx * 0.14 + (Math.random() - 0.5) * 8,
              vy * 0.14 + 5 + Math.random() * 6,
              vz * 0.14 + (Math.random() - 0.5) * 8,
              2.6 + this.debrisBaseScale[i] * 1.4,
              9.5 + this.debrisBaseScale[i] * 4.2,
              0.75 + Math.random() * 0.65,
              trailHeat,
              0.0,
              0.16,
              0.14,
              0.15,
              0.55,
              1.6,
              8.0,
              (Math.random() - 0.5) * 1.6,
              isPrism,
            );
            if (t < 0.45 && Math.random() < 0.35) {
              this.emitSpark(
                px,
                py,
                pz,
                vx * 0.35 + (Math.random() - 0.5) * 24,
                vy * 0.35 + (Math.random() - 0.5) * 24,
                vz * 0.35 + (Math.random() - 0.5) * 24,
                0.75,
                0.35 + Math.random() * 0.3,
                1.0,
                0.55,
                0.15,
                1.1,
                0.9,
                18.0,
              );
            }
          } else {
            this.debrisSmokeTimer[i] = timer;
          }
        }
      }

      this.activeDebris = liveDebris;
      if (liveDebris === 0) {
        this.debrisHighWater = 0;
        this.debrisCursor = 0;
        this.debrisGeo.instanceCount = 0;
      } else {
        this.debrisGeo.instanceCount = this.debrisHighWater;
      }
      this.debrisPosScaleAttr.needsUpdate = true;
      this.debrisQuatAttr.needsUpdate = true;
      this.debrisHeatLifeAttr.needsUpdate = true;
    }

    // 2. Integrate volumetric fireball & billowing smoke puffs (6,400 pool)
    if (this.puffHighWater > 0) {
      let livePuffs = 0;
      const hw = this.puffHighWater;
      const posScale = this.puffPosScaleData;
      const meta = this.puffMetaData;

      for (let i = 0; i < hw; i++) {
        const life = this.puffLife[i];
        if (life <= 0) continue;

        const age = this.puffAge[i] + safeDt;
        const i4 = i * 4;
        if (age >= life) {
          this.puffLife[i] = 0;
          posScale[i4 + 3] = 0;
          meta[i4] = 1;
          continue;
        }

        this.puffAge[i] = age;
        const t = age / life;
        livePuffs++;

        const drag = Math.max(0, 1 - this.puffDrag[i] * safeDt);
        const vx = this.puffVx[i] * drag;
        const vy = (this.puffVy[i] + this.puffBuoyancy[i] * safeDt) * drag;
        const vz = this.puffVz[i] * drag;
        this.puffVx[i] = vx;
        this.puffVy[i] = vy;
        this.puffVz[i] = vz;

        posScale[i4] += vx * safeDt;
        posScale[i4 + 1] += vy * safeDt;
        posScale[i4 + 2] += vz * safeDt;

        // Smooth ease-out expansion for roiling billows
        const expand = 1 - (1 - t) * (1 - t);
        posScale[i4 + 3] =
          this.puffStartScale[i] + (this.puffEndScale[i] - this.puffStartScale[i]) * expand;

        // Exponentially rapid cooling from white plasma into ember-lit smoke
        const cool = 1 - (1 - t) * (1 - t) * (1 - t);
        meta[i4] = t;
        meta[i4 + 1] = this.puffStartTemp[i] + (this.puffEndTemp[i] - this.puffStartTemp[i]) * cool;
        meta[i4 + 2] += this.puffSpin[i] * safeDt;
      }

      this.activePuffs = livePuffs;
      if (livePuffs === 0) {
        this.puffHighWater = 0;
        this.puffCursor = 0;
        this.puffGeo.instanceCount = 0;
      } else {
        this.puffGeo.instanceCount = this.puffHighWater;
      }
      this.puffPosScaleAttr.needsUpdate = true;
      this.puffMetaAttr.needsUpdate = true;
    }

    // 3. Integrate velocity-stretched glowing magnesium sparks (4,200 pool)
    if (this.sparkHighWater > 0) {
      let liveSparks = 0;
      const hw = this.sparkHighWater;
      const posSize = this.sparkPosSizeData;
      const velLife = this.sparkVelLifeData;

      for (let i = 0; i < hw; i++) {
        const life = this.sparkLife[i];
        if (life <= 0) continue;

        const age = this.sparkAge[i] + safeDt;
        const i4 = i * 4;
        if (age >= life) {
          this.sparkLife[i] = 0;
          posSize[i4 + 3] = 0;
          velLife[i4 + 3] = 1;
          continue;
        }

        this.sparkAge[i] = age;
        const t = age / life;
        liveSparks++;

        const drag = Math.max(0, 1 - this.sparkDrag[i] * safeDt);
        const vx = velLife[i4] * drag;
        const vy = (velLife[i4 + 1] - this.sparkGravity[i] * safeDt) * drag;
        const vz = velLife[i4 + 2] * drag;

        velLife[i4] = vx;
        velLife[i4 + 1] = vy;
        velLife[i4 + 2] = vz;
        velLife[i4 + 3] = t;

        posSize[i4] += vx * safeDt;
        posSize[i4 + 1] += vy * safeDt;
        posSize[i4 + 2] += vz * safeDt;
        posSize[i4 + 3] = this.sparkBaseSize[i] * (1 - t * 0.45);
      }

      this.activeSparks = liveSparks;
      if (liveSparks === 0) {
        this.sparkHighWater = 0;
        this.sparkCursor = 0;
        this.sparkGeo.instanceCount = 0;
      } else {
        this.sparkGeo.instanceCount = this.sparkHighWater;
      }
      this.sparkPosSizeAttr.needsUpdate = true;
      this.sparkVelLifeAttr.needsUpdate = true;
    }
  }
}
