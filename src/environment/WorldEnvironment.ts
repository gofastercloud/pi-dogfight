import * as THREE from 'three';
import { createCloudTexture } from '../aircraft/textures';

const SKY_VERT = /* glsl */ `
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

const SKY_FRAG = /* glsl */ `
  varying vec3 vWorldDir;
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

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = rot * p * 2.04;
      a *= 0.5;
    }
    return v;
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec3 dir = safeNormalize(vWorldDir);
    vec3 sunDir = safeNormalize(uSunDir);
    float y = max(dir.y, -0.15);

    // Base golden-hour Ridley Scott / Top Gun atmospheric gradient
    vec3 goldZenith = vec3(0.04, 0.11, 0.24);
    vec3 goldMid = vec3(0.16, 0.25, 0.38);
    vec3 goldHorizon = vec3(1.05, 0.44, 0.16);

    // Brooding storm-cathedral palette
    vec3 stormZenith = vec3(0.02, 0.04, 0.10);
    vec3 stormMid = vec3(0.06, 0.16, 0.22);
    vec3 stormHorizon = vec3(0.32, 0.14, 0.26);

    vec3 zenith = mix(goldZenith, stormZenith, uStorm);
    vec3 midCol = mix(goldMid, stormMid, uStorm);
    vec3 horizon = mix(goldHorizon, stormHorizon, uStorm * 0.72);

    float invY = 1.0 - clamp(y, 0.0, 1.0);
    float hFactor = pow(max(invY, 1e-4), 3.6);
    float midFactor = pow(max(invY, 1e-4), 1.4);
    vec3 col = mix(zenith, midCol, midFactor);
    col = mix(col, horizon, hFactor);

    // Procedural high-altitude streaked clouds & psychedelic nebula swirls
    vec2 skyUv = dir.xz / (abs(dir.y) + 0.22);
    float cloudN = fbm(skyUv * 0.75 + vec2(uTime * 0.02, -uTime * 0.015));
    float cloudBand = smoothstep(0.38, 0.82, cloudN) * smoothstep(0.0, 0.28, dir.y);
    vec3 cloudLit = mix(vec3(1.1, 0.56, 0.24), vec3(0.38, 0.18, 0.52), uStorm);
    col = mix(col, cloudLit * (0.45 + 0.75 * cloudN), cloudBand * 0.52);

    // LSD Chromatic Supercell Aurora & Fractal Nebula
    if (uTrip > 0.01) {
      float safeX = (abs(dir.x) < 1e-5 && abs(dir.z) < 1e-5) ? 1e-5 : dir.x;
      float angle = atan(dir.z, safeX);
      float warp = fbm(skyUv * 1.45 + vec2(sin(uTime * 0.25), cos(uTime * 0.22)) * 1.6);
      float ribbon = pow(max(sin(angle * 4.0 + warp * 8.5 - uTime * 0.9) * 0.5 + 0.5, 1e-4), 3.0);
      vec3 acidCol = hsv2rgb(vec3(fract(warp * 1.3 + angle * 0.16 - uTime * 0.12), 0.88, 1.0));
      float upperMask = smoothstep(-0.02, 0.45, dir.y);
      col += acidCol * ribbon * upperMask * uTrip * 0.95;

      // Subtle prismatic ring halo around the eclipse sun
      float sunAngle = acos(clamp(dot(dir, sunDir), -0.9999, 0.9999));
      float d1 = (sunAngle - 0.32) * 14.0;
      float d2 = (sunAngle - 0.52) * 18.0;
      float haloRing = exp(-(d1 * d1)) + exp(-(d2 * d2)) * 0.65;
      vec3 haloPrism = hsv2rgb(vec3(fract(sunAngle * 5.0 - uTime * 0.35), 0.92, 1.0));
      col += haloPrism * haloRing * uTrip * 1.35;
    }

    // Twin Eclipse Sun + Anamorphic Mie Glow
    float sunDot = max(dot(dir, sunDir), 0.0);
    float mieGlow = pow(max(sunDot, 1e-4), 12.0) * 0.95 + pow(max(sunDot, 1e-4), 96.0) * 1.8;
    vec3 sunTint = mix(vec3(1.4, 0.78, 0.34), vec3(1.45, 0.45, 0.95), uTrip * 0.55);
    col += sunTint * mieGlow;

    // Sharp sun disc with eerie Ridley Scott eclipse ring during climax
    float sunDisc = smoothstep(0.9965, 0.9985, sunDot);
    float eclipseCore = smoothstep(0.9982, 0.9992, sunDot) * smoothstep(0.15, 0.85, uTrip);
    col += vec3(3.6, 2.5, 1.5) * sunDisc * (1.0 - eclipseCore * 0.82);

    // Ghost twin secondary sun offset slightly
    vec3 twinDir = safeNormalize(sunDir + vec3(0.11, 0.06, -0.05));
    float twinDot = max(dot(dir, twinDir), 0.0);
    float twinDisc = smoothstep(0.9988, 0.9995, twinDot);
    col += mix(vec3(1.2, 0.55, 0.25), vec3(0.45, 0.95, 1.6), uTrip) * (pow(max(twinDot, 1e-4), 80.0) * 0.55 + twinDisc * 1.6);

    // Storm lightning & explosion sky bounce
    col += vec3(0.75, 0.48, 1.35) * uLightning * (0.35 + 0.65 * cloudN);
    col += vec3(1.35, 0.72, 0.35) * uExplosionFlash * 0.45;

    // Underwater horizon blend
    float below = smoothstep(0.02, -0.08, dir.y);
    col = mix(col, mix(vec3(0.03, 0.06, 0.11), vec3(0.08, 0.02, 0.14), uTrip), below);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const OCEAN_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uShockOrigin;
  uniform float uShockRadius;
  uniform float uShockStrength;

  varying vec3 vWorldPos;
  varying float vWaveHeight;
  varying float vShockWave;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);

    // Multi-octave Gerstner-like rolling Pacific swells
    float w1 = sin(wp.x * 0.014 + uTime * 1.35 + wp.z * 0.008) * 3.8;
    float w2 = cos(wp.z * 0.022 - uTime * 1.75 + wp.x * 0.011) * 2.4;
    float w3 = sin((wp.x - wp.z) * 0.038 + uTime * 2.6) * 1.15;
    float h = w1 + w2 + w3;

    // Expanding aerial detonation shockwave ring on the water surface
    float distShock = length(wp.xz - uShockOrigin.xz);
    float shockDelta = (distShock - uShockRadius) * 0.014;
    float ringBand = exp(-(shockDelta * shockDelta)) * uShockStrength;
    h += ringBand * 16.0 * sin((distShock - uShockRadius) * 0.09);

    wp.y += h;
    vWorldPos = wp.xyz;
    vWaveHeight = h;
    vShockWave = ringBand;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const OCEAN_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform float uStorm;
  uniform float uTrip;
  uniform float uLightning;

  varying vec3 vWorldPos;
  varying float vWaveHeight;
  varying float vShockWave;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec3 V = safeNormalize(cameraPosition - vWorldPos);
    vec3 L = safeNormalize(uSunDir);

    // High-frequency ocean normal ripples
    vec2 uv1 = vWorldPos.xz * 0.032 + vec2(uTime * 0.45, -uTime * 0.32);
    vec2 uv2 = vWorldPos.xz * 0.085 + vec2(-uTime * 0.62, uTime * 0.48);
    float n1 = noise(uv1);
    float n2 = noise(uv2);
    float n3 = noise(vWorldPos.xz * 0.22 + uTime * 0.9);

    vec3 N = safeNormalize(vec3(
      (n1 - 0.5) * 0.42 + (n2 - 0.5) * 0.26 + (n3 - 0.5) * 0.14,
      1.0,
      (n2 - 0.5) * 0.42 - (n1 - 0.5) * 0.26 + (n3 - 0.5) * 0.14
    ));

    float fresnel = pow(max(1.0 - max(dot(N, V), 0.0), 1e-4), 4.2);

    // Deep Pacific teal -> dark storm slate
    vec3 deepCol = mix(vec3(0.015, 0.055, 0.095), vec3(0.015, 0.025, 0.065), uStorm);
    vec3 skyReflect = mix(vec3(0.95, 0.44, 0.18), vec3(0.28, 0.18, 0.44), uStorm);

    // Psychedelic liquid-chrome oil-slick ocean during LSD acts
    if (uTrip > 0.02) {
      float oilPhase = vWorldPos.x * 0.004 + vWorldPos.z * 0.004 + n1 * 1.8 - uTime * 0.32;
      vec3 chrome = hsv2rgb(vec3(fract(oilPhase), 0.85, 1.0));
      skyReflect = mix(skyReflect, chrome * 1.35, clamp(uTrip * 0.82, 0.0, 0.92));
      deepCol = mix(deepCol, vec3(0.04, 0.01, 0.09), uTrip * 0.65);
    }

    vec3 col = mix(deepCol, skyReflect, clamp(0.12 + fresnel * 0.88, 0.0, 1.0));

    // Blinding sunset specular glitter highway
    vec3 H = safeNormalize(L + V);
    float ndoth = max(dot(N, H), 1e-4);
    float specBroad = pow(max(ndoth, 1e-4), 42.0) * 0.85;
    float specSharp = pow(max(ndoth, 1e-4), 420.0) * 4.5;
    vec3 specCol = mix(vec3(1.5, 0.85, 0.38), vec3(1.4, 0.6, 1.5), uTrip * 0.6);
    col += specCol * (specBroad + specSharp);

    // Subtle sea-foam crests & luminous explosion shockwave ring
    float foam = smoothstep(3.8, 6.8, vWaveHeight + n2 * 2.2);
    col += vec3(0.65, 0.78, 0.86) * foam * 0.25;
    col += mix(vec3(1.5, 0.85, 0.35), vec3(0.4, 1.6, 1.8), uTrip) * vShockWave * 1.4;

    // Lightning flash reflection
    col += vec3(0.55, 0.42, 1.15) * uLightning * fresnel * 0.8;

    // Atmospheric horizon distance haze blend
    float dist = length(cameraPosition - vWorldPos);
    float fogAmt = smoothstep(900.0, 6200.0, dist);
    vec3 fogCol = mix(vec3(0.76, 0.38, 0.20), vec3(0.18, 0.14, 0.26), uStorm);
    if (uTrip > 0.05) {
      fogCol = mix(fogCol, vec3(0.32, 0.08, 0.42), uTrip * 0.55);
    }
    col = mix(col, fogCol, fogAmt);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const GODRAY_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GODRAY_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uColor;
  void main() {
    float xFade = max(sin(vUv.x * 3.14159), 0.0);
    float yFade = pow(max(vUv.y, 1e-4), 0.85) * smoothstep(1.0, 0.18, vUv.y);
    float shimmer = 0.78 + 0.22 * sin(vUv.x * 16.0 + uTime * 0.8);
    float a = pow(max(xFade, 1e-4), 2.2) * yFade * shimmer * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

export class WorldEnvironment {
  public readonly group = new THREE.Group();
  public readonly sunDirection = new THREE.Vector3(-0.35, 0.18, -0.92).normalize();
  public readonly sunLight: THREE.DirectionalLight;
  public readonly rimLight: THREE.DirectionalLight;
  public readonly hemiLight: THREE.HemisphereLight;
  public readonly lightningLight: THREE.DirectionalLight;

  private readonly skyMesh: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly oceanMesh: THREE.Mesh;
  private readonly oceanMat: THREE.ShaderMaterial;
  private readonly cloudSprites: { sprite: THREE.Sprite; baseColor: THREE.Color; layer: number }[] = [];
  private readonly godRayMats: THREE.ShaderMaterial[] = [];
  private readonly monoliths: THREE.Group[] = [];
  private readonly monolithRings: THREE.Mesh[] = [];
  private readonly monolithGlowMats: THREE.MeshStandardMaterial[] = [];
  private readonly lightningBolts: THREE.Line[] = [];
  private lightningTimer = 0;
  private lightningFlash = 0;
  private shockOrigin = new THREE.Vector3();
  private shockRadius = 9999;
  private shockStrength = 0;
  private readonly _rayCol = new THREE.Color();
  private readonly _stormTint = new THREE.Color(0x3a2b52);
  private readonly _acidTint = new THREE.Color();
  private readonly _flashTint = new THREE.Color(0xffd0a0);

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    scene.add(this.group);

    // ------------------------------------------------------------------
    // 1. PROCEDURAL HDR-STYLE PMREM ENVIRONMENT MAP (PHOTOREALISTIC METAL)
    // ------------------------------------------------------------------
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x162236);

    const sunOrb = new THREE.Mesh(
      new THREE.SphereGeometry(2.8, 16, 16),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(6.0, 3.2, 1.4) }),
    );
    sunOrb.position.copy(this.sunDirection).multiplyScalar(14);
    envScene.add(sunOrb);

    const cyanBand = new THREE.Mesh(
      new THREE.SphereGeometry(12, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.1, 1.6), side: THREE.BackSide }),
    );
    envScene.add(cyanBand);

    const warmHorizonRing = new THREE.Mesh(
      new THREE.TorusGeometry(10, 2.2, 8, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.0, 0.45) }),
    );
    warmHorizonRing.rotation.x = Math.PI / 2;
    warmHorizonRing.position.y = -1.5;
    envScene.add(warmHorizonRing);

    const magentaAccent = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 12, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.4, 2.8) }),
    );
    magentaAccent.position.set(10, 6, 8);
    envScene.add(magentaAccent);

    const envRT = pmrem.fromScene(envScene, 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();

    // ------------------------------------------------------------------
    // 2. LIGHTING RIG (MOLTEN SUN KEY + TEAL/VIOLET RIM + LIGHTNING)
    // ------------------------------------------------------------------
    this.hemiLight = new THREE.HemisphereLight(0x88b4e6, 0x3b2218, 1.1);
    scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xffb168, 3.8);
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(1200);
    scene.add(this.sunLight);

    this.rimLight = new THREE.DirectionalLight(0x44d8ff, 1.65);
    this.rimLight.position.set(600, 320, 900);
    scene.add(this.rimLight);

    this.lightningLight = new THREE.DirectionalLight(0xd29bff, 0);
    this.lightningLight.position.set(-400, 950, 200);
    scene.add(this.lightningLight);

    // ------------------------------------------------------------------
    // 3. CUSTOM GLSL SKY DOME
    // ------------------------------------------------------------------
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: this.sunDirection.clone() },
        uTime: { value: 0 },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
        uExplosionFlash: { value: 0 },
      },
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(9500, 48, 32), this.skyMat);
    this.group.add(this.skyMesh);

    // ------------------------------------------------------------------
    // 4. INFINITE GERSTNER OCEAN PLANE
    // ------------------------------------------------------------------
    this.oceanMat = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: this.sunDirection.clone() },
        uStorm: { value: 0 },
        uTrip: { value: 0 },
        uLightning: { value: 0 },
        uShockOrigin: { value: this.shockOrigin },
        uShockRadius: { value: this.shockRadius },
        uShockStrength: { value: 0 },
      },
    });
    const oceanGeo = new THREE.PlaneGeometry(14000, 14000, 150, 150);
    oceanGeo.rotateX(-Math.PI / 2);
    this.oceanMesh = new THREE.Mesh(oceanGeo, this.oceanMat);
    this.oceanMesh.position.y = 0;
    this.group.add(this.oceanMesh);

    // ------------------------------------------------------------------
    // 5. TOWERING BASALT SEA-STACKS (RIDLEY SCOTT MONUMENTAL CANYON)
    // ------------------------------------------------------------------
    this.buildSeaStacks();

    // ------------------------------------------------------------------
    // 6. VOLUMETRIC GOD-RAY SUN SHAFTS
    // ------------------------------------------------------------------
    this.buildGodRays();

    // ------------------------------------------------------------------
    // 7. BACKLIT CUMULONIMBUS CLOUD CATHEDRALS
    // ------------------------------------------------------------------
    this.buildCloudCathedral();

    // ------------------------------------------------------------------
    // 8. FLOATING OBSIDIAN LSD SKY-MONOLITHS (REVEALED IN ACTS III-IV)
    // ------------------------------------------------------------------
    this.buildFloatingMonoliths();

    // ------------------------------------------------------------------
    // 9. FORKED SUPERCELL LIGHTNING BOLTS
    // ------------------------------------------------------------------
    this.buildLightningPool();
  }

  private buildSeaStacks(): void {
    const stackGeo = new THREE.ConeGeometry(42, 340, 7, 5);
    const posAttr = stackGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const z = posAttr.getZ(i);
      const crag = 1.0 + 0.28 * Math.sin(y * 0.055 + x * 0.14) * Math.cos(z * 0.12);
      posAttr.setXYZ(i, x * crag, y, z * crag);
    }
    stackGeo.computeVertexNormals();

    const stackMat = new THREE.MeshStandardMaterial({
      color: 0x1b2029,
      roughness: 0.88,
      metalness: 0.12,
      flatShading: true,
    });

    const placements: [number, number, number, number][] = [
      // Canyon corridor framing the Act I/II action without clipping flight splines
      [-210, -320, 1.35, 1.2],
      [230, -480, 1.5, 1.4],
      [-340, -820, 1.9, 1.65],
      [290, -1080, 1.6, 1.35],
      [-260, -1480, 2.2, 1.85],
      [390, -1720, 1.8, 1.55],
      [-520, -2100, 2.5, 2.1],
      [480, -2450, 2.3, 1.9],
      [-760, -500, 2.7, 2.2],
      [780, -780, 2.6, 2.0],
      [-860, -1420, 3.1, 2.4],
      [840, -1620, 2.9, 2.3],
      [-450, 280, 2.1, 1.7],
      [510, 340, 2.3, 1.8],
      [-1150, -1100, 3.6, 2.7],
      [1180, -1250, 3.4, 2.5],
      [-620, -2850, 2.8, 2.4],
      [640, -3050, 3.1, 2.6],
    ];

    const inst = new THREE.InstancedMesh(stackGeo, stackMat, placements.length);
    const dummy = new THREE.Object3D();
    placements.forEach(([x, z, sx, sy], idx) => {
      dummy.position.set(x, sy * 125 - 40, z);
      dummy.scale.set(sx, sy, sx * (0.85 + (idx % 3) * 0.15));
      dummy.rotation.set(0, idx * 1.17, (idx % 2 === 0 ? 1 : -1) * 0.05);
      dummy.updateMatrix();
      inst.setMatrixAt(idx, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
  }

  private buildGodRays(): void {
    const rayGeo = new THREE.PlaneGeometry(180, 1500);
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: GODRAY_VERT,
        fragmentShader: GODRAY_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0.14 },
          uColor: { value: new THREE.Color(1.0, 0.62, 0.28) },
        },
      });
      const mesh = new THREE.Mesh(rayGeo, mat);
      const spreadX = (i - 5.5) * 260;
      const spreadZ = -650 - (i % 4) * 580;
      mesh.position.set(spreadX, 460, spreadZ);
      mesh.rotation.z = -0.36 + (i % 3) * 0.04;
      mesh.rotation.y = 0.25;
      this.group.add(mesh);
      this.godRayMats.push(mat);
    }
  }

  private buildCloudCathedral(): void {
    const cloudTex = createCloudTexture();
    let seed = 4242;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    // 190 massive backlit cumulonimbus cloud puffs building canyon walls & high supercell ring
    for (let i = 0; i < 190; i++) {
      const layer = i < 110 ? 0 : 1; // 0 = low canyon clouds, 1 = high supercell amphitheatre
      const mat = new THREE.SpriteMaterial({
        map: cloudTex,
        color: new THREE.Color(0xffcfa0),
        transparent: true,
        opacity: layer === 0 ? 0.28 + rand() * 0.2 : 0.34 + rand() * 0.24,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);

      if (layer === 0) {
        const side = i % 2 === 0 ? -1 : 1;
        const x = side * (360 + rand() * 1400);
        const y = 90 + rand() * 340;
        const z = 400 - rand() * 4400;
        const sc = 260 + rand() * 340;
        sprite.position.set(x, y, z);
        sprite.scale.set(sc * 1.45, sc * 0.85, 1);
      } else {
        const angle = ((i - 110) / 80) * Math.PI * 2 + rand() * 0.25;
        const radius = 520 + rand() * 1150;
        const x = Math.cos(angle) * radius;
        const y = 420 + rand() * 520;
        const z = -1500 + Math.sin(angle) * radius;
        const sc = 360 + rand() * 420;
        sprite.position.set(x, y, z);
        sprite.scale.set(sc * 1.5, sc * 0.95, 1);
      }

      this.group.add(sprite);
      this.cloudSprites.push({
        sprite,
        baseColor: new THREE.Color().setHSL(0.07 + rand() * 0.04, 0.52, 0.65 + rand() * 0.18),
        layer,
      });
    }
  }

  private buildFloatingMonoliths(): void {
    // Colossal Ridley Scott × LSD sky-cathedral floating rings & obsidian obelisks
    const obsidianMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b0c14,
      roughness: 0.16,
      metalness: 0.92,
      iridescence: 1.0,
      iridescenceIOR: 1.5,
      clearcoat: 1.0,
    });

    const configs = [
      { pos: new THREE.Vector3(0, 520, -1550), radius: 240, tiltX: 0.24, tiltZ: 0.15 },
      { pos: new THREE.Vector3(-420, 610, -1880), radius: 165, tiltX: -0.35, tiltZ: 0.42 },
      { pos: new THREE.Vector3(460, 570, -1350), radius: 185, tiltX: 0.42, tiltZ: -0.28 },
    ];

    for (const cfg of configs) {
      const mg = new THREE.Group();
      mg.position.copy(cfg.pos);

      const outerRing = new THREE.Mesh(
        new THREE.TorusGeometry(cfg.radius, 11, 10, 48),
        obsidianMat,
      );
      outerRing.rotation.set(cfg.tiltX, 0, cfg.tiltZ);
      mg.add(outerRing);
      this.monolithRings.push(outerRing);

      const glowMat = new THREE.MeshStandardMaterial({
        color: 0xff44cc,
        emissive: 0xff22bb,
        emissiveIntensity: 3.0,
        roughness: 0.2,
      });
      this.monolithGlowMats.push(glowMat);

      const innerGlowRing = new THREE.Mesh(
        new THREE.TorusGeometry(cfg.radius - 13, 2.4, 8, 48),
        glowMat,
      );
      innerGlowRing.rotation.copy(outerRing.rotation);
      mg.add(innerGlowRing);

      // Floating inverted brutalist obsidian shards around the ring
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const shard = new THREE.Mesh(new THREE.OctahedronGeometry(22, 0), obsidianMat);
        shard.scale.set(0.6, 2.8, 0.6);
        shard.position.set(Math.cos(a) * (cfg.radius + 36), Math.sin(a) * 55, Math.sin(a) * (cfg.radius + 36));
        mg.add(shard);
      }

      mg.visible = false;
      this.group.add(mg);
      this.monoliths.push(mg);
    }
  }

  private buildLightningPool(): void {
    for (let i = 0; i < 4; i++) {
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(18 * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: i % 2 === 0 ? 0xc280ff : 0x55f7ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.group.add(line);
      this.lightningBolts.push(line);
    }
  }

  private triggerLightningBolt(center: THREE.Vector3, trip: number): void {
    this.lightningFlash = 1.0;
    for (let b = 0; b < this.lightningBolts.length; b++) {
      const line = this.lightningBolts[b];
      const posAttr = line.geometry.attributes.position as THREE.BufferAttribute;
      const angle = Math.random() * Math.PI * 2;
      const dist = 350 + Math.random() * 900;
      const startX = center.x + Math.cos(angle) * dist;
      const startZ = center.z + Math.sin(angle) * dist;
      const topY = 850 + Math.random() * 300;
      const botY = 40 + Math.random() * 180;

      for (let i = 0; i < 18; i++) {
        const t = i / 17;
        const jitter = (1 - Math.abs(t - 0.5) * 2) * 110;
        posAttr.setXYZ(
          i,
          startX + (Math.random() - 0.5) * jitter,
          THREE.MathUtils.lerp(topY, botY, t),
          startZ + (Math.random() - 0.5) * jitter,
        );
      }
      posAttr.needsUpdate = true;
      const mat = line.material as THREE.LineBasicMaterial;
      mat.opacity = 0.95;
      mat.color.setHSL(trip > 0.3 ? (b % 2 === 0 ? 0.84 : 0.52) : 0.62, 0.95, 0.72);
    }
  }

  public triggerOceanShockwave(origin: THREE.Vector3, strength = 1.0): void {
    this.shockOrigin.copy(origin);
    this.shockRadius = 15;
    this.shockStrength = Math.max(this.shockStrength, strength);
  }

  public update(
    time: number,
    dt: number,
    cameraPos: THREE.Vector3,
    stormIntensity: number,
    tripIntensity: number,
    explosionFlash: number,
  ): void {
    // Keep sky dome centred on camera and ocean snapped to grid around camera
    this.skyMesh.position.copy(cameraPos);
    const snap = 14000 / 150;
    this.oceanMesh.position.x = Math.round(cameraPos.x / snap) * snap;
    this.oceanMesh.position.z = Math.round(cameraPos.z / snap) * snap;

    // Expand ocean shockwave ring
    if (this.shockStrength > 0.005) {
      this.shockRadius += dt * 420;
      this.shockStrength = Math.max(0, this.shockStrength - dt * 0.42);
    }

    // Supercell lightning cadence
    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 5.2);
    for (const bolt of this.lightningBolts) {
      const m = bolt.material as THREE.LineBasicMaterial;
      m.opacity = Math.max(0, m.opacity - dt * 4.5);
    }
    if (stormIntensity > 0.35) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.triggerLightningBolt(cameraPos, tripIntensity);
        this.lightningTimer = 0.75 + Math.random() * 1.9;
      }
    }

    // Update sky uniforms
    this.skyMat.uniforms.uTime.value = time;
    this.skyMat.uniforms.uStorm.value = stormIntensity;
    this.skyMat.uniforms.uTrip.value = tripIntensity;
    this.skyMat.uniforms.uLightning.value = this.lightningFlash;
    this.skyMat.uniforms.uExplosionFlash.value = explosionFlash;

    // Update ocean uniforms
    this.oceanMat.uniforms.uTime.value = time;
    this.oceanMat.uniforms.uStorm.value = stormIntensity;
    this.oceanMat.uniforms.uTrip.value = tripIntensity;
    this.oceanMat.uniforms.uLightning.value = this.lightningFlash;
    this.oceanMat.uniforms.uShockOrigin.value.copy(this.shockOrigin);
    this.oceanMat.uniforms.uShockRadius.value = this.shockRadius;
    this.oceanMat.uniforms.uShockStrength.value = this.shockStrength;

    // Dynamic lights
    this.sunLight.color.setRGB(
      1.0,
      THREE.MathUtils.lerp(0.68, 0.48, tripIntensity * 0.6),
      THREE.MathUtils.lerp(0.36, 0.85, tripIntensity * 0.5),
    );
    this.sunLight.intensity = 3.6 - stormIntensity * 1.1 + explosionFlash * 2.2;
    this.rimLight.color.setHSL(
      (0.54 + tripIntensity * 0.32 * Math.sin(time * 0.45)) % 1.0,
      0.88,
      0.62,
    );
    this.rimLight.intensity = 1.65 + tripIntensity * 1.85;
    this.lightningLight.intensity = this.lightningFlash * 7.5;

    // God rays tint & pulse
    this._rayCol.setHSL(
      (0.08 + tripIntensity * 0.72 * (0.5 + 0.5 * Math.sin(time * 0.35))) % 1.0,
      0.92,
      0.62,
    );
    for (let i = 0; i < this.godRayMats.length; i++) {
      const m = this.godRayMats[i];
      m.uniforms.uTime.value = time + i * 0.7;
      m.uniforms.uOpacity.value = (0.13 + tripIntensity * 0.08) * (1.0 - stormIntensity * 0.35);
      m.uniforms.uColor.value.copy(this._rayCol);
    }

    // Cloud tint modulation (backlit sunset -> storm purple -> acid iridescent)
    for (let i = 0; i < this.cloudSprites.length; i++) {
      const c = this.cloudSprites[i];
      const mat = c.sprite.material as THREE.SpriteMaterial;
      mat.color.copy(c.baseColor).lerp(this._stormTint, stormIntensity * 0.72);
      if (tripIntensity > 0.05) {
        const hue = (0.78 + (i % 9) * 0.055 + time * 0.06) % 1.0;
        this._acidTint.setHSL(hue, 0.86, 0.56);
        mat.color.lerp(this._acidTint, tripIntensity * (c.layer === 1 ? 0.72 : 0.45));
      }
      if (this.lightningFlash > 0.05 || explosionFlash > 0.05) {
        mat.color.lerp(this._flashTint, Math.min(0.8, this.lightningFlash * 0.6 + explosionFlash * 0.5));
      }
    }

    // Floating obsidian sky-monoliths emerge dramatically during Acts III-IV
    const monolithVis = THREE.MathUtils.smoothstep(tripIntensity, 0.12, 0.48);
    for (let i = 0; i < this.monoliths.length; i++) {
      const mg = this.monoliths[i];
      mg.visible = monolithVis > 0.01;
      if (mg.visible) {
        mg.scale.setScalar(0.35 + monolithVis * 0.65);
        mg.rotation.y = time * (0.09 + i * 0.04) * (i % 2 === 0 ? 1 : -1);
        this.monolithRings[i].rotation.z = time * 0.22 * (i % 2 === 0 ? 1 : -1);
        this.monolithGlowMats[i].emissive.setHSL((0.86 + time * 0.14 + i * 0.25) % 1.0, 1.0, 0.55);
        this.monolithGlowMats[i].emissiveIntensity = 1.8 + tripIntensity * 3.8;
      }
    }
  }
}
