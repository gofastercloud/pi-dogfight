import * as THREE from 'three';
import { createGlowTexture } from '../aircraft/textures';
import { FighterJet } from '../aircraft/FighterJet';
import { GpuParticleSystem } from './GpuParticleSystem';
import { MissileTrailSystem, VolumetricRibbon } from './MissileTrails';

const DEFAULT_SUN_DIR = new THREE.Vector3(-0.35, 0.18, -0.92).normalize();

const FIREBALL_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewPos;
  varying float vDisp;
  uniform float uTime;
  uniform float uProgress;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash(i);
    float n100 = hash(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    vec3 p = position;
    vec3 dirP = safeNormalize(p);
    float n1 = noise(dirP * 3.4 + vec3(0.0, -uTime * 1.4, uProgress * 2.5));
    float n2 = noise(dirP * 7.2 - vec3(uTime * 2.2, uProgress * 4.0, 0.0));
    float n3 = noise(dirP * 12.6 + vec3(uProgress * 5.2, uTime * 3.1, -uProgress * 3.0));
    float disp = n1 * 0.56 + n2 * 0.30 + n3 * 0.14;
    vDisp = disp;
    p += normal * (disp - 0.36) * (0.48 + uProgress * 0.88);
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    vViewPos = -mvPos.xyz;
    vNormal = safeNormalize(normalMatrix * normal);
    vWorldNormal = safeNormalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const FIREBALL_FRAG = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vViewPos;
  varying float vDisp;
  uniform float uProgress;
  uniform float uTrip;
  uniform float uSupernova;
  uniform vec3 uSunDir;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 0.0, 1.0);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    float ndotv = clamp(abs(dot(safeNormalize(vNormal), safeNormalize(vViewPos))), 0.0, 1.0);
    float sunWrap = clamp(dot(safeNormalize(vWorldNormal), safeNormalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);

    // Cool from blinding white plasma -> molten orange -> glowing soot crust
    float heat = clamp((1.08 - uProgress * 1.02) + (vDisp - 0.42) * 0.92, 0.0, 1.5);

    vec3 soot = vec3(0.05, 0.04, 0.06) + vec3(0.18, 0.12, 0.09) * sunWrap;
    vec3 red = vec3(1.35, 0.20, 0.04);
    vec3 orange = vec3(2.8, 0.96, 0.16);
    vec3 yellow = vec3(4.2, 3.1, 1.65);
    vec3 white = vec3(5.8, 5.2, 4.4);

    vec3 col = mix(soot, red, smoothstep(0.10, 0.36, heat));
    col = mix(col, orange, smoothstep(0.34, 0.68, heat));
    col = mix(col, yellow, smoothstep(0.66, 1.02, heat));
    col = mix(col, white, smoothstep(1.00, 1.38, heat));

    if (uTrip > 0.15 || uSupernova > 0.5) {
      vec3 prism = hsv2rgb(vec3(fract(vDisp * 2.2 - uProgress * 1.4), 0.95, 1.0)) * 2.5;
      float rim = pow(max(1.0 - ndotv, 1e-4), 1.6);
      col += prism * rim * max(uTrip * 0.85, uSupernova * 1.15) * (1.0 - uProgress * 0.65);
    }

    float edgeAlpha = smoothstep(0.0, 0.35, ndotv) * (1.0 - smoothstep(0.54, 1.0, uProgress));
    float alpha = clamp(edgeAlpha * (0.68 + vDisp * 0.52), 0.0, 1.0);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(clamp(col, 0.0, 14.0), alpha);
  }
`;

const SHOCK_DOME_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vObjDir;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    vObjDir = safeNormalize(position);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewPos = -mvPos.xyz;
    vNormal = safeNormalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const SHOCK_DOME_FRAG = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vObjDir;
  uniform float uProgress;
  uniform float uTrip;
  uniform float uSupernova;
  uniform float uTime;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 0.0, 1.0);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    float ndotv = clamp(abs(dot(safeNormalize(vNormal), safeNormalize(vViewPos))), 0.0, 1.0);
    float fresnel = pow(max(1.0 - ndotv, 1e-4), 2.8);
    float ripple = 0.78 + 0.22 * sin(vObjDir.y * 22.0 - uTime * 18.0 + uProgress * 12.0);

    vec3 warmWave = mix(vec3(1.6, 1.25, 0.85), vec3(0.85, 1.45, 2.2), fresnel);
    vec3 prism = hsv2rgb(vec3(fract(vObjDir.y * 1.4 + vObjDir.x * 0.8 - uTime * 0.6), 0.92, 1.0)) * 2.4;
    vec3 col = mix(warmWave, prism, clamp(max(uSupernova * 0.78, uTrip * 0.65), 0.0, 0.92));

    float fade = pow(max(1.0 - clamp(uProgress, 0.0, 1.0), 1e-4), 1.65);
    float alpha = clamp(fresnel * ripple * fade * (0.58 + uSupernova * 0.28), 0.0, 0.85);
    if (alpha < 0.008) discard;

    gl_FragColor = vec4(clamp(col, 0.0, 10.0), alpha);
  }
`;

const PRANDTL_GLAUERT_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  uniform float uTime;
  uniform float uShellIndex;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    vUv = uv;
    vec3 p = position;
    float wave = sin(uv.y * 18.0 - uTime * 32.0 + uShellIndex * 2.1) * 0.055 * (1.0 - uv.y);
    p.x *= 1.0 + wave;
    p.y *= 1.0 + wave;
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    vViewPos = -mvPos.xyz;
    vNormal = safeNormalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const PRANDTL_GLAUERT_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uTrip;
  uniform float uShellIndex;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 0.0, 1.0);
  }

  vec3 rainbow(float t) {
    return 0.55 + 0.45 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  }

  void main() {
    if (uIntensity < 0.01) discard;
    float ndotv = clamp(abs(dot(safeNormalize(vNormal), safeNormalize(vViewPos))), 0.0, 1.0);
    float rim = pow(max(1.0 - ndotv, 1e-4), 1.9 + uShellIndex * 0.6);

    float rings = 0.72 + 0.28 * sin(vUv.y * 28.0 - uTime * 36.0 + uShellIndex * 1.7);
    float axial = smoothstep(0.0, 0.22, vUv.y) * smoothstep(1.0, 0.28, vUv.y);
    float streaks = 0.75 + 0.25 * sin(vUv.x * 42.0 + uTime * 14.0);

    vec3 refractBase = mix(vec3(0.92, 0.97, 1.05), vec3(0.68, 0.92, 1.35), uShellIndex);
    vec3 prism = rainbow(vUv.x * 1.4 + vUv.y * 0.9 - uTime * 0.75 + uShellIndex * 0.25);
    vec3 col = mix(refractBase, prism * 1.7, clamp(0.24 + uTrip * 0.72 + uShellIndex * 0.16, 0.0, 0.95));

    float shellWeight = uShellIndex < 0.5 ? 0.65 : 0.42;
    float alpha = axial * (0.16 + rim * 0.88) * rings * streaks * uIntensity * shellWeight;
    if (alpha < 0.008) discard;

    gl_FragColor = vec4(clamp(col * (1.05 + uTrip * 0.55), 0.0, 8.0), clamp(alpha, 0.0, 0.82));
  }
`;

const HEAT_SHIMMER_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  uniform float uTime;
  uniform float uThrottle;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    vUv = uv;
    vec3 p = position;
    float along = 1.0 - uv.y;
    float shimmer = sin(along * 22.0 - uTime * 68.0) * 0.075 * along * uThrottle;
    p.x *= 1.0 + shimmer;
    p.y *= 1.0 - shimmer;
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    vViewPos = -mvPos.xyz;
    vNormal = safeNormalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const HEAT_SHIMMER_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  uniform float uTime;
  uniform float uThrottle;
  uniform float uTrip;
  uniform vec3 uAccentColor;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 0.0, 1.0);
  }

  void main() {
    float along = 1.0 - vUv.y;
    float ndotv = clamp(abs(dot(safeNormalize(vNormal), safeNormalize(vViewPos))), 0.0, 1.0);
    float rim = pow(max(1.0 - ndotv, 1e-4), 1.45);
    float diamonds = pow(max(sin(along * 30.0 + uTime * 42.0) * 0.5 + 0.5, 1e-4), 3.0);
    float haze = 0.65 + 0.35 * sin(vUv.x * 24.0 + uTime * 35.0) * cos(along * 18.0 - uTime * 48.0);

    float fadeEnds = smoothstep(0.0, 0.32, along) * smoothstep(1.0, 0.85, along);
    vec3 col = mix(vec3(0.55, 0.78, 1.15), uAccentColor * 1.8, diamonds * 0.72 + uTrip * 0.25);
    float alpha = fadeEnds * (0.08 + rim * 0.28 + diamonds * 0.22) * haze * clamp(uThrottle - 0.35, 0.0, 1.2);
    if (alpha < 0.006) discard;

    gl_FragColor = vec4(clamp(col, 0.0, 6.0), clamp(alpha, 0.0, 0.45));
  }
`;

interface ExplosionSlot {
  active: boolean;
  group: THREE.Group;
  origin: THREE.Vector3;
  fireball: THREE.Mesh;
  fireballMat: THREE.ShaderMaterial;
  coreSprite: THREE.Sprite;
  coreMat: THREE.SpriteMaterial;
  shockRing: THREE.Mesh;
  shockRingMat: THREE.MeshBasicMaterial;
  shockRing2: THREE.Mesh;
  shockRing2Mat: THREE.MeshBasicMaterial;
  shockDome: THREE.Mesh;
  shockDomeMat: THREE.ShaderMaterial;
  light: THREE.PointLight;
  age: number;
  duration: number;
  maxScale: number;
  supernova: boolean;
  tripIntensity: number;
  stage2Done: boolean;
  stage3Done: boolean;
  emberAccum: number;
}

export interface GuidedMissile {
  id: string;
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: FighterJet | null;
  targetPoint: THREE.Vector3;
  age: number;
  maxAge: number;
  speed: number;
  turnRate: number;
  prism: boolean;
  alive: boolean;
  trailPositions: THREE.Vector3[];
  trailMesh: THREE.Mesh;
  trailMat: THREE.ShaderMaterial;
  onImpact?: (pos: THREE.Vector3) => void;
}

interface MissileSlot {
  active: boolean;
  missile: GuidedMissile;
  glowMat: THREE.SpriteMaterial;
  ribbon: VolumetricRibbon | null;
  exhaustAccum: number;
  hueOffset: number;
}

interface MuzzleRingSlot {
  active: boolean;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
}

interface FlareSlot {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  ribbon: VolumetricRibbon | null;
  age: number;
  life: number;
  sparkTimer: number;
}

interface ContrailRig {
  jet: FighterJet;
  leftRibbon: VolumetricRibbon;
  rightRibbon: VolumetricRibbon;
  aeroGroup: THREE.Group;
  outerCone: THREE.Mesh;
  outerConeMat: THREE.ShaderMaterial;
  innerCone: THREE.Mesh;
  innerConeMat: THREE.ShaderMaterial;
  shimmerLeft: THREE.Mesh;
  shimmerRight: THREE.Mesh;
  shimmerMat: THREE.ShaderMaterial;
  vaporAccum: number;
}

const MAX_EXPLOSIONS = 10;
const MAX_MISSILES = 24;
const MAX_TRACERS = 160;
const MAX_MUZZLE_RINGS = 16;
const MAX_FLARES = 48;

export class BayhemVFX {
  public readonly group = new THREE.Group();
  public explosionFlash = 0;
  public shockImpact = 0;
  public activeMissiles: GuidedMissile[] = [];

  public readonly particles: GpuParticleSystem;
  public readonly trails: MissileTrailSystem;

  private readonly glowTex: THREE.CanvasTexture;
  private readonly sunDir = DEFAULT_SUN_DIR.clone();

  private readonly explosionPool: ExplosionSlot[] = [];
  private explosionCursor = 0;

  private readonly missilePool: MissileSlot[] = [];
  private missileCursor = 0;

  // Instanced 20mm Vulcan tracers + expanding muzzle flash rings
  private readonly tracerInst: THREE.InstancedMesh;
  private readonly tracerPos = new Float32Array(MAX_TRACERS * 3);
  private readonly tracerVel = new Float32Array(MAX_TRACERS * 3);
  private readonly tracerAge = new Float32Array(MAX_TRACERS);
  private readonly tracerLife = new Float32Array(MAX_TRACERS);
  private readonly tracerVariant = new Uint8Array(MAX_TRACERS);
  private tracerCursor = 0;
  private readonly muzzleRings: MuzzleRingSlot[] = [];
  private muzzleRingCursor = 0;

  // Pooled decoy flares
  private readonly flarePool: FlareSlot[] = [];
  private flareCursor = 0;

  // Registered aircraft wingtip contrails, Prandtl-Glauert cones & Mach heat shimmer
  private readonly contrails: ContrailRig[] = [];

  // High-speed Mach wind streaks around the camera
  private readonly speedLines: THREE.LineSegments;
  private readonly speedLinesMat: THREE.LineBasicMaterial;

  // Shared geometries
  private readonly fireballGeo = new THREE.IcosahedronGeometry(1, 4);
  private readonly shockRingGeo = new THREE.TorusGeometry(1, 0.068, 12, 56);
  private readonly shockDomeGeo = new THREE.SphereGeometry(1, 24, 18);
  private readonly tracerGeo = new THREE.BoxGeometry(0.22, 0.22, 16.0);
  private readonly muzzleRingGeo = new THREE.RingGeometry(0.35, 1.25, 24);
  private readonly outerConeGeo: THREE.ConeGeometry;
  private readonly innerConeGeo: THREE.ConeGeometry;
  private readonly shimmerGeo: THREE.ConeGeometry;

  // Pre-allocated scratch objects (zero per-frame heap allocations)
  private readonly dummy = new THREE.Object3D();
  private readonly _lTip = new THREE.Vector3();
  private readonly _rTip = new THREE.Vector3();
  private readonly _toTarget = new THREE.Vector3();
  private readonly _curDir = new THREE.Vector3();
  private readonly _missileLook = new THREE.Vector3();
  private readonly _muzzleWorld = new THREE.Vector3();
  private readonly _baseDir = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _eject = new THREE.Vector3();
  private readonly _impactPos = new THREE.Vector3();
  private readonly _tracerLook = new THREE.Vector3();
  private readonly _ringLook = new THREE.Vector3();
  private readonly _vaporWorld = new THREE.Vector3();
  private readonly _tmpColor = new THREE.Color();
  private readonly _tracerGold = new THREE.Color(2.6, 2.0, 0.72);
  private readonly _tracerAmber = new THREE.Color(2.5, 0.95, 0.28);

  constructor(scene: THREE.Scene) {
    this.group.name = 'BayhemVFX';
    scene.add(this.group);
    this.glowTex = createGlowTexture();

    // True GPU-instanced ring-buffered particle engine (6,400 puffs + 4,200 sparks + 360 debris)
    this.particles = new GpuParticleSystem(this.group);
    // Volumetric camera-facing twist-free ribbon trail system
    this.trails = new MissileTrailSystem(this.group);

    // Pre-build shared aero shock-cone & heat-shimmer geometries
    this.outerConeGeo = new THREE.ConeGeometry(6.4, 7.6, 36, 4, true);
    this.outerConeGeo.rotateX(-Math.PI / 2);
    this.innerConeGeo = new THREE.ConeGeometry(4.4, 5.0, 32, 3, true);
    this.innerConeGeo.rotateX(-Math.PI / 2);
    this.shimmerGeo = new THREE.ConeGeometry(0.95, 10.5, 18, 6, true);
    this.shimmerGeo.translate(0, 5.25, 0);
    this.shimmerGeo.rotateX(Math.PI / 2);

    // Pre-allocate multi-stage explosion pool (zero GPU allocations during combat)
    for (let i = 0; i < MAX_EXPLOSIONS; i++) {
      const g = new THREE.Group();
      g.visible = false;

      const fbMat = new THREE.ShaderMaterial({
        vertexShader: FIREBALL_VERT,
        fragmentShader: FIREBALL_FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uProgress: { value: 0 },
          uTrip: { value: 0 },
          uSupernova: { value: 0 },
          uSunDir: { value: this.sunDir },
        },
      });
      const fireball = new THREE.Mesh(this.fireballGeo, fbMat);
      g.add(fireball);

      const coreMat = new THREE.SpriteMaterial({
        map: this.glowTex,
        color: 0xffe8bb,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const coreSprite = new THREE.Sprite(coreMat);
      g.add(coreSprite);

      const shockRingMat = new THREE.MeshBasicMaterial({
        color: 0xffc070,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const shockRing = new THREE.Mesh(this.shockRingGeo, shockRingMat);
      g.add(shockRing);

      const shockRing2Mat = new THREE.MeshBasicMaterial({
        color: 0x7df4ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const shockRing2 = new THREE.Mesh(this.shockRingGeo, shockRing2Mat);
      shockRing2.visible = false;
      g.add(shockRing2);

      const shockDomeMat = new THREE.ShaderMaterial({
        vertexShader: SHOCK_DOME_VERT,
        fragmentShader: SHOCK_DOME_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uProgress: { value: 0 },
          uTrip: { value: 0 },
          uSupernova: { value: 0 },
          uTime: { value: 0 },
        },
      });
      const shockDome = new THREE.Mesh(this.shockDomeGeo, shockDomeMat);
      g.add(shockDome);

      const light = new THREE.PointLight(0xff8828, 0, 1200, 1.3);
      g.add(light);

      this.group.add(g);
      this.explosionPool.push({
        active: false,
        group: g,
        origin: new THREE.Vector3(),
        fireball,
        fireballMat: fbMat,
        coreSprite,
        coreMat,
        shockRing,
        shockRingMat,
        shockRing2,
        shockRing2Mat,
        shockDome,
        shockDomeMat,
        light,
        age: 0,
        duration: 2.6,
        maxScale: 42,
        supernova: false,
        tripIntensity: 0,
        stage2Done: false,
        stage3Done: false,
        emberAccum: 0,
      });
    }

    // Pre-allocate guided missile pool (reusable fuselage + exhaust glow)
    const missileBodyGeo = new THREE.CylinderGeometry(0.14, 0.17, 3.8, 8);
    missileBodyGeo.rotateX(Math.PI / 2);
    const missileFinGeo = new THREE.BoxGeometry(0.92, 0.05, 0.65);
    const missileBodyMat = new THREE.MeshStandardMaterial({
      color: 0xeef3fa,
      metalness: 0.68,
      roughness: 0.28,
    });
    const dummyRibbonMat = new THREE.ShaderMaterial();
    const dummyRibbonMesh = new THREE.Mesh();

    for (let i = 0; i < MAX_MISSILES; i++) {
      const mGroup = new THREE.Group();
      mGroup.visible = false;

      const body = new THREE.Mesh(missileBodyGeo, missileBodyMat);
      mGroup.add(body);

      const finH = new THREE.Mesh(missileFinGeo, missileBodyMat);
      finH.position.set(0, 0, -1.35);
      mGroup.add(finH);

      const finV = new THREE.Mesh(missileFinGeo, missileBodyMat);
      finV.position.set(0, 0, -1.35);
      finV.rotation.z = Math.PI / 2;
      mGroup.add(finV);

      const glowMat = new THREE.SpriteMaterial({
        map: this.glowTex,
        color: 0xffaa44,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.position.set(0, 0, -2.15);
      glow.scale.setScalar(6.2);
      mGroup.add(glow);

      this.group.add(mGroup);

      const missile: GuidedMissile = {
        id: '',
        mesh: mGroup,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        target: null,
        targetPoint: new THREE.Vector3(),
        age: 0,
        maxAge: 6.2,
        speed: 460,
        turnRate: 7.5,
        prism: false,
        alive: false,
        trailPositions: [],
        trailMesh: dummyRibbonMesh,
        trailMat: dummyRibbonMat,
      };

      this.missilePool.push({
        active: false,
        missile,
        glowMat,
        ribbon: null,
        exhaustAccum: 0,
        hueOffset: 0,
      });
    }

    // Pre-allocate instanced 20mm Vulcan tracer bolts
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.tracerInst = new THREE.InstancedMesh(this.tracerGeo, tracerMat, MAX_TRACERS);
    this.tracerInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerInst.frustumCulled = false;
    this.tracerInst.count = 0;
    this.group.add(this.tracerInst);

    // Pre-allocate expanding Vulcan muzzle flash rings
    for (let i = 0; i < MAX_MUZZLE_RINGS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd578,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.muzzleRingGeo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.muzzleRings.push({ active: false, mesh, mat, age: 0, life: 0.09 });
    }

    // Pre-allocate decoy flare pool
    for (let i = 0; i < MAX_FLARES; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.glowTex,
        color: 0xfff2be,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.group.add(sprite);
      this.flarePool.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        sprite,
        mat,
        ribbon: null,
        age: 0,
        life: 2.2,
        sparkTimer: 0,
      });
    }

    // High-speed Mach wind streaks around the camera
    const lineCount = 140;
    const linePositions = new Float32Array(lineCount * 2 * 3);
    for (let i = 0; i < lineCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 16 + Math.random() * 68;
      const z = (Math.random() - 0.5) * 260;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      linePositions[i * 6] = x;
      linePositions[i * 6 + 1] = y;
      linePositions[i * 6 + 2] = z;
      linePositions[i * 6 + 3] = x;
      linePositions[i * 6 + 4] = y;
      linePositions[i * 6 + 5] = z + 20 + Math.random() * 26;
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    this.speedLinesMat = new THREE.LineBasicMaterial({
      color: 0xd8f0ff,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.speedLines = new THREE.LineSegments(lineGeo, this.speedLinesMat);
    this.speedLines.frustumCulled = false;
    this.group.add(this.speedLines);
  }

  public registerContrails(jets: FighterJet[]): void {
    for (let idx = 0; idx < jets.length; idx++) {
      const jet = jets[idx];
      const baseHex = jet.role === 'hero' ? 0xdff5ff : jet.role === 'ace' ? 0xff4477 : 0xffaa88;
      const hueBase = idx * 0.17;

      const leftRibbon = this.trails.createContrailRibbon(baseHex, hueBase);
      const rightRibbon = this.trails.createContrailRibbon(baseHex, hueBase + 0.08);

      // Multi-shell refracting Prandtl-Glauert shock cones + Mach-diamond heat-shimmer plumes
      // Positioned cleanly aft of cockpitAnchor (z = -4.8) so cockpit view is always unobstructed
      const aeroGroup = new THREE.Group();
      aeroGroup.visible = false;

      const outerConeMat = new THREE.ShaderMaterial({
        vertexShader: PRANDTL_GLAUERT_VERT,
        fragmentShader: PRANDTL_GLAUERT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uIntensity: { value: 0 },
          uTime: { value: 0 },
          uTrip: { value: 0 },
          uShellIndex: { value: 0.0 },
        },
      });
      const outerCone = new THREE.Mesh(this.outerConeGeo, outerConeMat);
      outerCone.position.set(0, 0.1, 1.85);
      aeroGroup.add(outerCone);

      const innerConeMat = new THREE.ShaderMaterial({
        vertexShader: PRANDTL_GLAUERT_VERT,
        fragmentShader: PRANDTL_GLAUERT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uIntensity: { value: 0 },
          uTime: { value: 0 },
          uTrip: { value: 0 },
          uShellIndex: { value: 1.0 },
        },
      });
      const innerCone = new THREE.Mesh(this.innerConeGeo, innerConeMat);
      innerCone.position.set(0, 0.1, 3.05);
      aeroGroup.add(innerCone);

      const accent =
        jet.role === 'hero'
          ? new THREE.Color(0.55, 0.92, 1.35)
          : jet.role === 'ace'
            ? new THREE.Color(1.45, 0.25, 0.65)
            : new THREE.Color(1.25, 0.55, 0.25);

      const shimmerMat = new THREE.ShaderMaterial({
        vertexShader: HEAT_SHIMMER_VERT,
        fragmentShader: HEAT_SHIMMER_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uThrottle: { value: 1.0 },
          uTrip: { value: 0 },
          uAccentColor: { value: accent },
        },
      });
      const shimmerLeft = new THREE.Mesh(this.shimmerGeo, shimmerMat);
      shimmerLeft.position.set(-0.92, -0.02, 7.6);
      const shimmerRight = new THREE.Mesh(this.shimmerGeo, shimmerMat);
      shimmerRight.position.set(0.92, -0.02, 7.6);
      aeroGroup.add(shimmerLeft, shimmerRight);

      this.group.add(aeroGroup);

      this.contrails.push({
        jet,
        leftRibbon,
        rightRibbon,
        aeroGroup,
        outerCone,
        outerConeMat,
        innerCone,
        innerConeMat,
        shimmerLeft,
        shimmerRight,
        shimmerMat,
        vaporAccum: 0,
      });
    }
  }

  public clearDynamic(): void {
    for (let i = 0; i < this.explosionPool.length; i++) {
      const e = this.explosionPool[i];
      e.active = false;
      e.group.visible = false;
      e.light.intensity = 0;
    }

    for (let i = 0; i < this.missilePool.length; i++) {
      const slot = this.missilePool[i];
      slot.active = false;
      slot.missile.alive = false;
      slot.missile.mesh.visible = false;
      slot.missile.trailPositions.length = 0;
      slot.ribbon = null;
    }
    this.activeMissiles.length = 0;

    this.tracerLife.fill(0);
    this.tracerInst.count = 0;

    for (let i = 0; i < this.muzzleRings.length; i++) {
      this.muzzleRings[i].active = false;
      this.muzzleRings[i].mesh.visible = false;
    }

    for (let i = 0; i < this.flarePool.length; i++) {
      const f = this.flarePool[i];
      f.active = false;
      f.sprite.visible = false;
      f.ribbon = null;
    }

    this.particles.clear();
    this.trails.clearDynamic();
    this.explosionFlash = 0;
    this.shockImpact = 0;
  }

  public spawnExplosion(
    origin: THREE.Vector3,
    scale = 42,
    supernova = false,
    tripIntensity = 0,
  ): void {
    // Acquire pooled explosion slot without heap allocation
    let slot: ExplosionSlot | null = null;
    for (let i = 0; i < this.explosionPool.length; i++) {
      const idx = (this.explosionCursor + i) % this.explosionPool.length;
      if (!this.explosionPool[idx].active) {
        slot = this.explosionPool[idx];
        this.explosionCursor = (idx + 1) % this.explosionPool.length;
        break;
      }
    }
    if (!slot) {
      slot = this.explosionPool[this.explosionCursor];
      this.explosionCursor = (this.explosionCursor + 1) % this.explosionPool.length;
    }

    slot.active = true;
    slot.origin.copy(origin);
    slot.group.position.copy(origin);
    slot.group.visible = true;
    slot.age = 0;
    slot.duration = supernova ? 5.2 : 2.8;
    slot.maxScale = scale;
    slot.supernova = supernova;
    slot.tripIntensity = tripIntensity;
    slot.stage2Done = false;
    slot.stage3Done = false;
    slot.emberAccum = 0;

    slot.fireball.scale.setScalar(scale * 0.14);
    slot.fireballMat.uniforms.uProgress.value = 0;
    slot.fireballMat.uniforms.uTrip.value = tripIntensity;
    slot.fireballMat.uniforms.uSupernova.value = supernova ? 1.0 : 0.0;

    slot.coreMat.color.setHex(supernova ? 0xffbbff : 0xffe8bb);
    slot.coreMat.opacity = 1.0;
    slot.coreSprite.scale.setScalar(scale * (supernova ? 5.8 : 3.5));

    slot.shockRingMat.color.setHex(supernova ? 0x82f6ff : 0xffbe68);
    slot.shockRingMat.opacity = 0.96;
    slot.shockRing.rotation.set(Math.random() * 0.85, Math.random() * Math.PI, Math.random() * 0.85);
    slot.shockRing.scale.setScalar(scale * 0.25);

    slot.shockRing2.visible = supernova;
    if (supernova) {
      slot.shockRing2Mat.color.setHex(0xff66ee);
      slot.shockRing2Mat.opacity = 0.92;
      slot.shockRing2.rotation.set(
        slot.shockRing.rotation.x + Math.PI * 0.45,
        slot.shockRing.rotation.y + 0.9,
        slot.shockRing.rotation.z - 0.6,
      );
      slot.shockRing2.scale.setScalar(scale * 0.22);
    }

    slot.shockDome.scale.setScalar(scale * 0.35);
    slot.shockDomeMat.uniforms.uProgress.value = 0;
    slot.shockDomeMat.uniforms.uTrip.value = tripIntensity;
    slot.shockDomeMat.uniforms.uSupernova.value = supernova ? 1.0 : 0.0;

    slot.light.color.setHex(supernova ? 0xff77ee : 0xff8c2c);
    slot.light.intensity = supernova ? 4200 : 1650;
    slot.light.distance = supernova ? 2800 : 1100;

    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const isPrism = supernova || tripIntensity > 0.55 ? 1 : 0;

    // STAGE 1: White plasma core flash puffs + massive radial magnesium spark shower + tumbling debris
    const corePuffCount = supernova ? 170 : 75;
    for (let i = 0; i < corePuffCount; i++) {
      const dx = Math.random() - 0.5;
      const dy = Math.random() - 0.5;
      const dz = Math.random() - 0.5;
      const invLen = 1 / (Math.hypot(dx, dy, dz) || 1);
      const nx = dx * invLen;
      const ny = dy * invLen;
      const nz = dz * invLen;
      const spd = (supernova ? 70 : 34) + Math.random() * (supernova ? 145 : 75);
      const rOff = Math.random() * scale * 0.16;

      this.particles.emitPuff(
        ox + nx * rOff,
        oy + ny * rOff,
        oz + nz * rOff,
        nx * spd,
        ny * spd + (supernova ? 16 : 8),
        nz * spd,
        scale * (0.22 + Math.random() * 0.18),
        scale * (0.72 + Math.random() * 0.48),
        (supernova ? 1.55 : 0.95) + Math.random() * 0.75,
        1.65,
        0.22,
        0.16,
        0.13,
        0.14,
        0.88,
        2.0,
        supernova ? 18 : 11,
        (Math.random() - 0.5) * 1.8,
        isPrism,
      );
    }

    // Blazing velocity-stretched magnesium sparks (360 standard, 920 supernova)
    const sparkCount = supernova ? 920 : 360;
    for (let i = 0; i < sparkCount; i++) {
      const dx = Math.random() - 0.5;
      const dy = Math.random() - 0.5;
      const dz = Math.random() - 0.5;
      const invLen = 1 / (Math.hypot(dx, dy, dz) || 1);
      const nx = dx * invLen;
      const ny = dy * invLen;
      const nz = dz * invLen;
      const spd = (supernova ? 120 : 62) + Math.random() * (supernova ? 380 : 225);

      if (supernova || tripIntensity > 0.45) {
        this._tmpColor.setHSL((0.04 + Math.random() * 0.94) % 1.0, 1.0, 0.64);
      } else {
        this._tmpColor.setHSL(0.05 + Math.random() * 0.085, 1.0, 0.58 + Math.random() * 0.30);
      }

      const rOff = Math.random() * scale * 0.18;
      this.particles.emitSpark(
        ox + nx * rOff,
        oy + ny * rOff,
        oz + nz * rOff,
        nx * spd,
        ny * spd,
        nz * spd,
        (supernova ? 1.65 : 1.05) + Math.random() * 1.15,
        (supernova ? 1.9 : 1.05) + Math.random() * 1.45,
        this._tmpColor.r,
        this._tmpColor.g,
        this._tmpColor.b,
        supernova ? 1.8 : 1.35,
        0.52,
        supernova ? 22.0 : 28.0,
      );
    }

    // Tumbling flaming fuselage debris shards trailing smoke (42 standard, 115 supernova)
    const debrisCount = supernova ? 115 : 42;
    for (let i = 0; i < debrisCount; i++) {
      const dx = Math.random() - 0.5;
      const dy = Math.random() * 0.85 - 0.2;
      const dz = Math.random() - 0.5;
      const invLen = 1 / (Math.hypot(dx, dy, dz) || 1);
      const spd = 50 + Math.random() * (supernova ? 235 : 135);
      this.particles.emitDebris(
        ox + dx * scale * 0.12,
        oy + dy * scale * 0.12,
        oz + dz * scale * 0.12,
        dx * invLen * spd,
        dy * invLen * spd + 14,
        dz * invLen * spd,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (supernova ? 1.1 : 0.75) + Math.random() * 1.85,
        (supernova ? 3.2 : 2.3) + Math.random() * 1.8,
        1.45,
        isPrism,
      );
    }

    // Immediately illuminate surrounding smoke volumes with the new core flash
    this.particles.setCoreFlash(
      ox,
      oy,
      oz,
      supernova ? 3.2 : 2.8,
      supernova ? 1.4 : 1.7,
      supernova ? 2.8 : 0.8,
      supernova ? 3.2 : 2.0,
    );

    this.explosionFlash = Math.min(1.5, this.explosionFlash + (supernova ? 1.45 : 0.8));
    this.shockImpact = Math.min(1.4, this.shockImpact + (supernova ? 1.25 : 0.62));
  }

  private emitExplosionStage2Fireball(slot: ExplosionSlot): void {
    const { origin, maxScale: scale, supernova, tripIntensity } = slot;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const isPrism = supernova || tripIntensity > 0.5 ? 1 : 0;
    const count = supernova ? 460 : 200;

    for (let i = 0; i < count; i++) {
      const dx = Math.random() - 0.5;
      const dy = Math.random() * 0.9 - 0.3;
      const dz = Math.random() - 0.5;
      const invLen = 1 / (Math.hypot(dx, dy, dz) || 1);
      const nx = dx * invLen;
      const ny = dy * invLen;
      const nz = dz * invLen;
      const spd = (supernova ? 48 : 22) + Math.random() * (supernova ? 115 : 58);
      const rOff = (0.15 + Math.random() * 0.32) * scale;

      this.particles.emitPuff(
        ox + nx * rOff,
        oy + ny * rOff,
        oz + nz * rOff,
        nx * spd,
        ny * spd + (supernova ? 22 : 12),
        nz * spd,
        scale * (0.28 + Math.random() * 0.24),
        scale * (0.95 + Math.random() * 0.65),
        (supernova ? 2.6 : 1.65) + Math.random() * 1.1,
        1.22 + Math.random() * 0.28,
        0.04,
        0.13,
        0.11,
        0.13,
        0.78,
        1.55,
        supernova ? 16 : 10,
        (Math.random() - 0.5) * 1.3,
        isPrism,
      );
    }
  }

  private emitExplosionStage3SmokeAndEmbers(slot: ExplosionSlot): void {
    const { origin, maxScale: scale, supernova, tripIntensity } = slot;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const isPrism = supernova ? 1 : 0;

    // Billowing dark ember-lit smoke canopy surrounding the cooling fireball
    const smokeCount = supernova ? 420 : 175;
    for (let i = 0; i < smokeCount; i++) {
      const dx = Math.random() - 0.5;
      const dy = Math.random() * 0.95 - 0.25;
      const dz = Math.random() - 0.5;
      const invLen = 1 / (Math.hypot(dx, dy, dz) || 1);
      const nx = dx * invLen;
      const ny = dy * invLen;
      const nz = dz * invLen;
      const spd = (supernova ? 36 : 18) + Math.random() * (supernova ? 82 : 42);
      const rOff = (0.28 + Math.random() * 0.45) * scale;

      const shade = 0.08 + Math.random() * 0.11;
      this.particles.emitPuff(
        ox + nx * rOff,
        oy + ny * rOff,
        oz + nz * rOff,
        nx * spd,
        ny * spd + (supernova ? 24 : 13),
        nz * spd,
        scale * (0.34 + Math.random() * 0.28),
        scale * (1.25 + Math.random() * 0.85),
        (supernova ? 3.8 : 2.35) + Math.random() * 1.5,
        0.38 + Math.random() * 0.22,
        0.0,
        shade,
        shade * 0.92,
        shade * 1.06,
        0.72,
        1.25,
        supernova ? 14 : 9,
        (Math.random() - 0.5) * 0.95,
        isPrism,
      );
    }

    // Secondary cascading spark shower on thermobaric climax supernovas
    if (supernova) {
      const extraSparks = 380;
      for (let i = 0; i < extraSparks; i++) {
        const dx = Math.random() - 0.5;
        const dy = Math.random() - 0.35;
        const dz = Math.random() - 0.5;
        const invLen = 1 / (Math.hypot(dx, dy, dz) || 1);
        const spd = 85 + Math.random() * 290;
        this._tmpColor.setHSL((0.02 + Math.random() * 0.96) % 1.0, 1.0, 0.66);
        this.particles.emitSpark(
          ox + dx * scale * 0.35,
          oy + dy * scale * 0.35,
          oz + dz * scale * 0.35,
          dx * invLen * spd,
          dy * invLen * spd,
          dz * invLen * spd,
          1.4 + Math.random() * 1.2,
          1.8 + Math.random() * 1.5,
          this._tmpColor.r,
          this._tmpColor.g,
          this._tmpColor.b,
          1.6,
          0.48,
          20.0,
        );
      }
    } else if (tripIntensity > 0.35) {
      // Extra ember burst for supercell aerial kills
      for (let i = 0; i < 80; i++) {
        const dx = Math.random() - 0.5;
        const dy = Math.random() - 0.5;
        const dz = Math.random() - 0.5;
        const invLen = 1 / (Math.hypot(dx, dy, dz) || 1);
        const spd = 45 + Math.random() * 155;
        this._tmpColor.setHSL((0.06 + Math.random() * 0.88) % 1.0, 1.0, 0.65);
        this.particles.emitSpark(
          ox,
          oy,
          oz,
          dx * invLen * spd,
          dy * invLen * spd,
          dz * invLen * spd,
          1.0,
          1.2 + Math.random() * 0.8,
          this._tmpColor.r,
          this._tmpColor.g,
          this._tmpColor.b,
          1.35,
          0.55,
          24.0,
        );
      }
    }
  }

  public fireVulcanBurst(shooter: FighterJet, targetDir: THREE.Vector3, count = 4): void {
    shooter.gunMuzzle.getWorldPosition(this._muzzleWorld);
    this._baseDir.copy(targetDir);
    if (this._baseDir.lengthSq() < 1e-6) {
      this._baseDir.set(0, 0, -1).applyQuaternion(shooter.group.quaternion);
    } else {
      this._baseDir.normalize();
    }

    const mx = this._muzzleWorld.x;
    const my = this._muzzleWorld.y;
    const mz = this._muzzleWorld.z;

    // 1. Expanding blazing muzzle flash ring aligned to gun barrel
    const ringSlot = this.muzzleRings[this.muzzleRingCursor];
    this.muzzleRingCursor = (this.muzzleRingCursor + 1) % MAX_MUZZLE_RINGS;
    ringSlot.active = true;
    ringSlot.age = 0;
    ringSlot.life = 0.095;
    ringSlot.mesh.visible = true;
    ringSlot.mesh.position.set(mx, my, mz);
    this._ringLook.set(mx + this._baseDir.x, my + this._baseDir.y, mz + this._baseDir.z);
    ringSlot.mesh.lookAt(this._ringLook);
    ringSlot.mesh.scale.setScalar(0.55);
    ringSlot.mat.opacity = 0.95;

    // 2. Pooled instanced 20mm Vulcan tracer bolts (zero heap allocations)
    for (let i = 0; i < count; i++) {
      const idx = this.tracerCursor;
      this.tracerCursor = (this.tracerCursor + 1) % MAX_TRACERS;
      const i3 = idx * 3;

      this._dir.set(
        this._baseDir.x + (Math.random() - 0.5) * 0.032,
        this._baseDir.y + (Math.random() - 0.5) * 0.032,
        this._baseDir.z + (Math.random() - 0.5) * 0.032,
      ).normalize();

      const lead = i * 16;
      this.tracerPos[i3] = mx + this._dir.x * lead;
      this.tracerPos[i3 + 1] = my + this._dir.y * lead;
      this.tracerPos[i3 + 2] = mz + this._dir.z * lead;

      this.tracerVel[i3] = this._dir.x * 1180;
      this.tracerVel[i3 + 1] = this._dir.y * 1180;
      this.tracerVel[i3 + 2] = this._dir.z * 1180;

      this.tracerAge[idx] = 0;
      this.tracerLife[idx] = 0.85;
      this.tracerVariant[idx] = i % 2;
    }

    // 3. Incandescent muzzle flash sparks + hot gunsmoke puff
    for (let i = 0; i < 12; i++) {
      this.particles.emitSpark(
        mx,
        my,
        mz,
        this._baseDir.x * 260 + (Math.random() - 0.5) * 58,
        this._baseDir.y * 260 + (Math.random() - 0.5) * 58,
        this._baseDir.z * 260 + (Math.random() - 0.5) * 58,
        0.85 + Math.random() * 0.45,
        0.14 + Math.random() * 0.08,
        1.0,
        0.78,
        0.28,
        1.65,
        1.2,
        12.0,
      );
    }

    this.particles.emitPuff(
      mx + this._baseDir.x * 1.4,
      my + this._baseDir.y * 1.4,
      mz + this._baseDir.z * 1.4,
      this._baseDir.x * 45 + shooter.velocity.x * 0.35,
      this._baseDir.y * 45 + shooter.velocity.y * 0.35 + 4,
      this._baseDir.z * 45 + shooter.velocity.z * 0.35,
      1.2,
      4.8,
      0.32,
      0.85,
      0.0,
      0.32,
      0.29,
      0.27,
      0.42,
      2.6,
      5.0,
      1.4,
      0,
    );
  }

  public launchMissile(
    id: string,
    origin: THREE.Vector3,
    initialVel: THREE.Vector3,
    target: FighterJet | null,
    prism = false,
    speed = 460,
    onImpact?: (pos: THREE.Vector3) => void,
  ): GuidedMissile {
    // Acquire reusable pooled missile slot
    let slot: MissileSlot | null = null;
    for (let i = 0; i < this.missilePool.length; i++) {
      const idx = (this.missileCursor + i) % this.missilePool.length;
      if (!this.missilePool[idx].active) {
        slot = this.missilePool[idx];
        this.missileCursor = (idx + 1) % this.missilePool.length;
        break;
      }
    }
    if (!slot) {
      slot = this.missilePool[this.missileCursor];
      this.missileCursor = (this.missileCursor + 1) % this.missilePool.length;
      if (slot.ribbon) {
        slot.ribbon.detach(0.4);
      }
      const existingIdx = this.activeMissiles.indexOf(slot.missile);
      if (existingIdx !== -1) this.activeMissiles.splice(existingIdx, 1);
    }

    const hueOffset = Math.random();
    const ribbon = this.trails.acquireMissileRibbon(prism, hueOffset);
    ribbon.pushPoint(origin.x, origin.y, origin.z, 0.8);

    slot.active = true;
    slot.ribbon = ribbon;
    slot.exhaustAccum = 0;
    slot.hueOffset = hueOffset;
    slot.glowMat.color.setHex(prism ? 0xff66f2 : 0xffb24c);

    const m = slot.missile;
    m.id = id;
    m.pos.copy(origin);
    m.vel.copy(initialVel);
    m.target = target;
    if (target) {
      m.targetPoint.copy(target.group.position);
    } else {
      m.targetPoint.copy(origin).addScaledVector(initialVel, 4);
    }
    m.age = 0;
    m.maxAge = 6.2;
    m.speed = speed;
    m.turnRate = 7.6;
    m.prism = prism;
    m.alive = true;
    m.trailPositions.length = 0;
    m.trailMesh = ribbon.mesh;
    m.trailMat = ribbon.material;
    m.onImpact = onImpact;

    m.mesh.position.copy(origin);
    m.mesh.visible = true;

    // Launch ignition puff + spark kick
    this.particles.emitPuff(
      origin.x,
      origin.y,
      origin.z,
      -initialVel.x * 0.08,
      -initialVel.y * 0.08 + 3,
      -initialVel.z * 0.08,
      2.2,
      8.5,
      0.55,
      1.15,
      0.0,
      0.72,
      0.70,
      0.68,
      0.62,
      2.2,
      6.0,
      1.2,
      prism ? 1 : 0,
    );

    this.activeMissiles.push(m);
    return m;
  }

  public popDecoyFlares(jet: FighterJet, count = 8): void {
    const bx = jet.group.position.x;
    const by = jet.group.position.y;
    const bz = jet.group.position.z;
    const jvx = jet.velocity.x * 0.35;
    const jvy = jet.velocity.y * 0.35;
    const jvz = jet.velocity.z * 0.35;

    for (let i = 0; i < count; i++) {
      let slot: FlareSlot | null = null;
      for (let k = 0; k < this.flarePool.length; k++) {
        const idx = (this.flareCursor + k) % this.flarePool.length;
        if (!this.flarePool[idx].active) {
          slot = this.flarePool[idx];
          this.flareCursor = (idx + 1) % this.flarePool.length;
          break;
        }
      }
      if (!slot) {
        slot = this.flarePool[this.flareCursor];
        this.flareCursor = (this.flareCursor + 1) % this.flarePool.length;
        if (slot.ribbon) slot.ribbon.detach(0.35);
      }

      const side = i % 2 === 0 ? -1 : 1;
      this._eject
        .set(
          side * (26 + Math.random() * 28),
          -12 - Math.random() * 20,
          18 + Math.random() * 28,
        )
        .applyQuaternion(jet.group.quaternion);

      const ribbon = this.trails.acquireFlareRibbon(Math.random());
      ribbon.pushPoint(bx, by, bz, 0.55);

      slot.active = true;
      slot.pos.set(bx, by, bz);
      slot.vel.set(jvx + this._eject.x, jvy + this._eject.y, jvz + this._eject.z);
      slot.sprite.position.set(bx, by, bz);
      slot.sprite.scale.setScalar(11.5 + Math.random() * 5.5);
      slot.sprite.visible = true;
      slot.mat.opacity = 1.0;
      slot.ribbon = ribbon;
      slot.age = 0;
      slot.life = 2.0 + Math.random() * 1.1;
      slot.sparkTimer = 0;
    }
  }

  public update(
    dt: number,
    time: number,
    camera: THREE.PerspectiveCamera,
    tripIntensity: number,
    speedIntensity: number,
  ): void {
    const safeDt = Math.max(0, Math.min(dt, 0.05));
    this.explosionFlash = Math.max(0, this.explosionFlash - safeDt * 2.35);
    this.shockImpact = Math.max(0, this.shockImpact - safeDt * 1.85);

    const camPos = camera.position;

    // 1. Update multi-stage aerial detonations & locate strongest active core flash
    let bestFlashIntensity = 0;
    let flashX = 0;
    let flashY = 0;
    let flashZ = 0;
    let flashR = 3.6;
    let flashG = 2.2;
    let flashB = 1.0;

    for (let i = 0; i < this.explosionPool.length; i++) {
      const e = this.explosionPool[i];
      if (!e.active) continue;

      e.age += safeDt;
      const p = e.age / e.duration;
      if (p >= 1) {
        e.active = false;
        e.group.visible = false;
        e.light.intensity = 0;
        continue;
      }

      // Trigger multi-stage volumetric fireball & billowing smoke waves
      if (!e.stage2Done && e.age >= 0.08) {
        e.stage2Done = true;
        this.emitExplosionStage2Fireball(e);
      }
      if (!e.stage3Done && e.age >= 0.24) {
        e.stage3Done = true;
        this.emitExplosionStage3SmokeAndEmbers(e);
      }

      // Continuous rising ember & smoke tail during climax supernovas
      if (e.supernova && safeDt > 0 && e.age > 0.3 && e.age < 2.2) {
        e.emberAccum += safeDt;
        if (e.emberAccum >= 0.055) {
          e.emberAccum = 0;
          const rSpread = e.maxScale * 0.42;
          this.particles.emitPuff(
            e.origin.x + (Math.random() - 0.5) * rSpread,
            e.origin.y + (Math.random() - 0.2) * rSpread * 0.8,
            e.origin.z + (Math.random() - 0.5) * rSpread,
            (Math.random() - 0.5) * 35,
            26 + Math.random() * 24,
            (Math.random() - 0.5) * 35,
            e.maxScale * 0.28,
            e.maxScale * 0.95,
            2.4 + Math.random() * 1.1,
            Math.max(0.15, 0.95 - p * 1.1),
            0.0,
            0.12,
            0.10,
            0.14,
            0.65,
            1.15,
            15.0,
            (Math.random() - 0.5) * 1.2,
            1,
          );
        }
      }

      const easeOut = 1 - Math.pow(1 - p, 3);
      e.fireball.scale.setScalar(e.maxScale * (0.18 + easeOut * 1.12));
      e.fireball.rotation.y += safeDt * 0.58;
      e.fireballMat.uniforms.uTime.value = time;
      e.fireballMat.uniforms.uProgress.value = p;
      e.fireballMat.uniforms.uTrip.value = tripIntensity;

      const flashFade = Math.max(0, 1 - p * 3.8);
      e.coreMat.opacity = flashFade;
      e.coreSprite.scale.setScalar(e.maxScale * (e.supernova ? 3.9 : 2.6) * (0.58 + p * 1.25));

      e.shockRing.scale.setScalar(e.maxScale * (0.35 + p * (e.supernova ? 12.2 : 5.0)));
      e.shockRingMat.opacity = Math.max(0, 1 - p * 1.32);

      if (e.supernova) {
        const p2 = Math.max(0, (p - 0.05) / 0.95);
        e.shockRing2.scale.setScalar(e.maxScale * (0.28 + p2 * 10.6));
        e.shockRing2Mat.opacity = Math.max(0, 1 - p2 * 1.28);
      }

      const domeP = Math.min(1, p * 2.1);
      e.shockDome.visible = domeP < 0.99;
      if (e.shockDome.visible) {
        e.shockDome.scale.setScalar(e.maxScale * (0.45 + domeP * (e.supernova ? 7.8 : 3.6)));
        e.shockDomeMat.uniforms.uProgress.value = domeP;
        e.shockDomeMat.uniforms.uTrip.value = tripIntensity;
        e.shockDomeMat.uniforms.uTime.value = time;
      }

      const lightDecay = Math.pow(Math.max(0, 1 - p * 1.45), 2);
      e.light.intensity = (e.supernova ? 3200 : 1450) * lightDecay;

      const gpuFlash = (e.supernova ? 3.2 : 2.0) * lightDecay;
      if (gpuFlash > bestFlashIntensity) {
        bestFlashIntensity = gpuFlash;
        flashX = e.origin.x;
        flashY = e.origin.y;
        flashZ = e.origin.z;
        flashR = e.supernova ? 3.2 : 2.8;
        flashG = e.supernova ? 1.4 : 1.7;
        flashB = e.supernova ? 2.8 : 0.8;
      }
    }

    this.particles.setCoreFlash(flashX, flashY, flashZ, flashR, flashG, flashB, bestFlashIntensity);

    // 2. Update guided Sidewinder / Macross missiles & curving volumetric prism ribbons
    for (let i = 0; i < this.missilePool.length; i++) {
      const slot = this.missilePool[i];
      if (!slot.active) continue;

      const m = slot.missile;
      m.age += safeDt;
      if (!m.alive || m.age >= m.maxAge) {
        slot.active = false;
        m.alive = false;
        m.mesh.visible = false;
        if (slot.ribbon) {
          slot.ribbon.detach(1.35);
          slot.ribbon = null;
        }
        const activeIdx = this.activeMissiles.indexOf(m);
        if (activeIdx !== -1) this.activeMissiles.splice(activeIdx, 1);
        continue;
      }

      if (m.target && m.target.alive) {
        m.targetPoint.copy(m.target.group.position);
      }

      this._toTarget.subVectors(m.targetPoint, m.pos);
      const dist = this._toTarget.length();
      if (dist < 22) {
        m.alive = false;
        slot.active = false;
        m.mesh.visible = false;
        if (slot.ribbon) {
          slot.ribbon.detach(1.45);
          slot.ribbon = null;
        }
        const activeIdx = this.activeMissiles.indexOf(m);
        if (activeIdx !== -1) this.activeMissiles.splice(activeIdx, 1);
        this._impactPos.copy(m.pos);
        m.onImpact?.(this._impactPos);
        continue;
      }

      const desiredDir = this._toTarget.divideScalar(Math.max(dist, 1e-4));
      // Macross corkscrew weave early in flight for sweeping ribbon arcs
      if (m.age < 1.25) {
        const weave = 1 - m.age / 1.25;
        desiredDir.x += Math.sin(m.age * 15.5 + i * 1.7) * 0.36 * weave;
        desiredDir.y += Math.cos(m.age * 13.8 + i * 2.3) * 0.26 * weave;
        desiredDir.normalize();
      }

      this._curDir.copy(m.vel);
      if (this._curDir.lengthSq() < 1e-4) this._curDir.set(0, 0, -1);
      else this._curDir.normalize();
      this._curDir.lerp(desiredDir, Math.min(1, safeDt * m.turnRate)).normalize();
      m.vel.copy(this._curDir).multiplyScalar(m.speed);
      m.pos.addScaledVector(m.vel, safeDt);

      m.mesh.position.copy(m.pos);
      this._missileLook.copy(m.pos).add(this._curDir);
      m.mesh.lookAt(this._missileLook);

      if (slot.ribbon) {
        slot.ribbon.pushPoint(m.pos.x, m.pos.y, m.pos.z, 1.05);
        slot.ribbon.rebuildGeometry(camPos);
      }

      // Emit rocket booster smoke puffs & incandescent tail sparks
      if (safeDt > 0) {
        slot.exhaustAccum += safeDt;
        if (slot.exhaustAccum >= 0.028) {
          slot.exhaustAccum = 0;
          const tailX = m.pos.x - this._curDir.x * 2.1;
          const tailY = m.pos.y - this._curDir.y * 2.1;
          const tailZ = m.pos.z - this._curDir.z * 2.1;

          this.particles.emitPuff(
            tailX,
            tailY,
            tailZ,
            -this._curDir.x * 22 + (Math.random() - 0.5) * 6,
            -this._curDir.y * 22 + 3.5 + (Math.random() - 0.5) * 6,
            -this._curDir.z * 22 + (Math.random() - 0.5) * 6,
            1.6,
            6.8,
            0.65 + Math.random() * 0.35,
            0.55,
            0.0,
            0.84,
            0.81,
            0.78,
            0.42,
            1.8,
            5.0,
            (Math.random() - 0.5) * 2.0,
            m.prism ? 1 : 0,
          );

          if (m.prism) {
            this._tmpColor.setHSL((time * 0.38 + slot.hueOffset) % 1.0, 1.0, 0.65);
          } else {
            this._tmpColor.setRGB(1.0, 0.72, 0.25);
          }
          this.particles.emitSpark(
            tailX,
            tailY,
            tailZ,
            -this._curDir.x * 90 + (Math.random() - 0.5) * 24,
            -this._curDir.y * 90 + (Math.random() - 0.5) * 24,
            -this._curDir.z * 90 + (Math.random() - 0.5) * 24,
            0.75,
            0.22 + Math.random() * 0.14,
            this._tmpColor.r,
            this._tmpColor.g,
            this._tmpColor.b,
            1.4,
            1.2,
            8.0,
          );
        }
      }
    }

    // 3. Update instanced 20mm Vulcan tracers & expanding muzzle flash rings
    let liveTracers = 0;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const life = this.tracerLife[i];
      if (life <= 0) continue;

      const age = this.tracerAge[i] + safeDt;
      if (age >= life) {
        this.tracerLife[i] = 0;
        continue;
      }
      this.tracerAge[i] = age;

      const i3 = i * 3;
      const vx = this.tracerVel[i3];
      const vy = this.tracerVel[i3 + 1];
      const vz = this.tracerVel[i3 + 2];

      const px = this.tracerPos[i3] + vx * safeDt;
      const py = this.tracerPos[i3 + 1] + vy * safeDt;
      const pz = this.tracerPos[i3 + 2] + vz * safeDt;
      this.tracerPos[i3] = px;
      this.tracerPos[i3 + 1] = py;
      this.tracerPos[i3 + 2] = pz;

      this.dummy.position.set(px, py, pz);
      this._tracerLook.set(px + vx, py + vy, pz + vz);
      this.dummy.lookAt(this._tracerLook);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.tracerInst.setMatrixAt(liveTracers, this.dummy.matrix);
      this.tracerInst.setColorAt(
        liveTracers,
        this.tracerVariant[i] === 0 ? this._tracerGold : this._tracerAmber,
      );
      liveTracers++;
    }
    this.tracerInst.count = liveTracers;
    if (liveTracers > 0) {
      this.tracerInst.instanceMatrix.needsUpdate = true;
      if (this.tracerInst.instanceColor) this.tracerInst.instanceColor.needsUpdate = true;
    }

    for (let i = 0; i < this.muzzleRings.length; i++) {
      const r = this.muzzleRings[i];
      if (!r.active) continue;
      r.age += safeDt;
      const p = r.age / r.life;
      if (p >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      r.mesh.scale.setScalar(0.55 + p * 3.8);
      r.mat.opacity = (1 - p) * 0.92;
    }

    // 4. Update decoy countermeasure flares + volumetric flare ribbons
    for (let i = 0; i < this.flarePool.length; i++) {
      const f = this.flarePool[i];
      if (!f.active) continue;
      f.age += safeDt;
      if (f.age >= f.life) {
        f.active = false;
        f.sprite.visible = false;
        if (f.ribbon) {
          f.ribbon.detach(0.8);
          f.ribbon = null;
        }
        continue;
      }

      f.vel.y -= 28 * safeDt;
      f.vel.multiplyScalar(Math.max(0, 1 - 0.65 * safeDt));
      f.pos.addScaledVector(f.vel, safeDt);
      f.sprite.position.copy(f.pos);

      const fade = 1 - f.age / f.life;
      f.mat.opacity = fade;
      f.sprite.scale.setScalar((10.5 + Math.sin(time * 42 + i) * 2.5) * (0.42 + fade * 0.82));

      if (f.ribbon) {
        f.ribbon.pushPoint(f.pos.x, f.pos.y, f.pos.z, 0.55);
        f.ribbon.rebuildGeometry(camPos);
      }

      if (safeDt > 0) {
        f.sparkTimer += safeDt;
        if (f.sparkTimer >= 0.042) {
          f.sparkTimer = 0;
          this.particles.emitSpark(
            f.pos.x,
            f.pos.y,
            f.pos.z,
            (Math.random() - 0.5) * 16,
            6 + Math.random() * 8,
            (Math.random() - 0.5) * 16,
            0.72,
            0.42,
            1.0,
            0.84,
            0.46,
            1.35,
            0.85,
            14.0,
          );
        }
      }
    }

    // 5. Update wingtip contrail ribbons, multi-shell Prandtl-Glauert cones & Mach heat shimmer
    for (let i = 0; i < this.contrails.length; i++) {
      const c = this.contrails[i];
      const jet = c.jet;

      if (jet.alive) {
        jet.getWorldWingtips(this._lTip, this._rTip);
        c.leftRibbon.pushPoint(this._lTip.x, this._lTip.y, this._lTip.z, 1.15);
        c.rightRibbon.pushPoint(this._rTip.x, this._rTip.y, this._rTip.z, 1.15);

        // Sync multi-shell Prandtl-Glauert cones & Mach-diamond heat shimmer to jet pose
        c.aeroGroup.visible = true;
        c.aeroGroup.position.copy(jet.group.position);
        c.aeroGroup.quaternion.copy(jet.group.quaternion);
        c.aeroGroup.scale.copy(jet.group.scale);

        const vapor = jet.vaporIntensity;
        const showVapor = vapor > 0.02;
        c.outerCone.visible = showVapor;
        c.innerCone.visible = showVapor;
        if (showVapor) {
          c.outerConeMat.uniforms.uIntensity.value = vapor;
          c.outerConeMat.uniforms.uTime.value = time;
          c.outerConeMat.uniforms.uTrip.value = tripIntensity;
          c.innerConeMat.uniforms.uIntensity.value = vapor;
          c.innerConeMat.uniforms.uTime.value = time;
          c.innerConeMat.uniforms.uTrip.value = tripIntensity;

          const sPulse = 0.88 + vapor * 0.34;
          c.outerCone.scale.set(sPulse, sPulse, 0.92 + vapor * 0.25);
          c.innerCone.scale.set(sPulse * 0.95, sPulse * 0.95, 0.95 + vapor * 0.2);

          // Shed crisp supersonic condensation micro-puffs from the shock collar
          if (safeDt > 0 && vapor > 0.42) {
            c.vaporAccum += safeDt;
            if (c.vaporAccum >= 0.032) {
              c.vaporAccum = 0;
              const angle = Math.random() * Math.PI * 2;
              const rad = 2.6 + Math.random() * 2.2;
              this._vaporWorld
                .set(Math.cos(angle) * rad, Math.sin(angle) * rad, 2.5)
                .applyQuaternion(jet.group.quaternion)
                .add(jet.group.position);
              this.particles.emitPuff(
                this._vaporWorld.x,
                this._vaporWorld.y,
                this._vaporWorld.z,
                jet.velocity.x * 0.08 + (Math.random() - 0.5) * 12,
                jet.velocity.y * 0.08 + (Math.random() - 0.5) * 12,
                jet.velocity.z * 0.08 + (Math.random() - 0.5) * 12,
                1.4,
                5.4,
                0.35 + Math.random() * 0.2,
                0.0,
                0.0,
                0.95,
                0.98,
                1.0,
                0.36 * vapor,
                2.8,
                2.0,
                (Math.random() - 0.5) * 2.0,
                2,
              );
            }
          }
        }

        // Mach-diamond heat-shimmer plumes behind twin nozzles
        const showShimmer = jet.throttle > 0.45;
        c.shimmerLeft.visible = showShimmer;
        c.shimmerRight.visible = showShimmer;
        if (showShimmer) {
          c.shimmerMat.uniforms.uTime.value = time;
          c.shimmerMat.uniforms.uThrottle.value = jet.throttle;
          c.shimmerMat.uniforms.uTrip.value = tripIntensity;
          const stretch = 0.72 + jet.throttle * 0.58;
          c.shimmerLeft.scale.set(1, 1, stretch);
          c.shimmerRight.scale.set(1, 1, stretch);
        }
      } else {
        c.aeroGroup.visible = false;
      }

      const baseHex = jet.role === 'hero' ? 0xdff5ff : jet.role === 'ace' ? 0xff4477 : 0xffaa88;
      const gBoost = Math.min(0.85, Math.max(0, jet.gForce - 1) * 0.14);
      const opacity = tripIntensity > 0.12
        ? 0.44 + tripIntensity * 0.34
        : 0.34 + Math.min(0.32, Math.max(0, jet.gForce - 1) * 0.055);
      const width = 0.48 + gBoost;
      const prismOn = tripIntensity > 0.14;

      c.leftRibbon.setDynamicAppearance(baseHex, opacity, width, prismOn);
      c.rightRibbon.setDynamicAppearance(baseHex, opacity, width, prismOn);
      c.leftRibbon.rebuildGeometry(camPos);
      c.rightRibbon.rebuildGeometry(camPos);
    }

    // 6. Step GPU-instanced particle engine & lingering volumetric trails
    this.particles.update(safeDt, time, tripIntensity);
    this.trails.update(safeDt, time, camPos, tripIntensity);

    // 7. Speed lines aligned to camera
    this.speedLines.position.copy(camPos);
    this.speedLines.quaternion.copy(camera.quaternion);
    this.speedLinesMat.opacity = Math.max(0, (speedIntensity - 0.35) * 0.48 + tripIntensity * 0.18);
    if (tripIntensity > 0.2) {
      this.speedLinesMat.color.setHSL((time * 0.4) % 1.0, 0.95, 0.72);
    } else {
      this.speedLinesMat.color.setHex(0xd8f0ff);
    }
  }
}
