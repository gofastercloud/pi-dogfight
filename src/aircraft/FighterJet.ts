import * as THREE from 'three';
import { createHullTextureSet } from './textures';
import {
  buildAirfoilWingGeometry,
  buildLoftedGeometry,
  buildNozzlePetalGeometry,
  buildSductIntakeGeometries,
  createChinedSection,
  createSuperellipseSection,
  createTwinNacelleSection,
  LoftStation,
  SductIntakeStation,
} from './loftGeometry';

export type FighterRole = 'hero' | 'bandit' | 'ace';

const AFTERBURNER_VERT = /* glsl */ `
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
    // High-frequency exhaust flutter growing toward the far plume tip
    float flutter = sin(p.z * 8.0 - uTime * 55.0) * 0.045 * uv.y * uThrottle;
    p.x *= 1.0 + flutter;
    p.y *= 1.0 - flutter;
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    vViewPos = -mvPos.xyz;
    vNormal = safeNormalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const AFTERBURNER_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  uniform float uTime;
  uniform float uThrottle;
  uniform float uTrip;
  uniform vec3 uCoreColor;
  uniform vec3 uOuterColor;

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
    // vUv.y = 0 at wide nozzle base, 1 at far pointed tip
    float along = 1.0 - vUv.y;
    vec3 n = safeNormalize(vNormal);
    vec3 v = safeNormalize(vViewPos);
    float fresnel = pow(max(abs(dot(n, v)), 1e-4), 0.65);

    // Supersonic Mach shock diamonds pulsing along the jet wash
    float diamonds = pow(max(sin(along * 26.0 + uTime * 34.0) * 0.5 + 0.5, 1e-4), 2.4);
    float flicker = 0.85 + 0.15 * sin(uTime * 90.0 + along * 14.0);

    vec3 core = uCoreColor;
    vec3 outer = uOuterColor;
    if (uTrip > 0.05) {
      vec3 prism = hsv2rgb(vec3(fract(along * 1.4 - uTime * 0.9), 0.9, 1.0));
      outer = mix(outer, prism, clamp(uTrip * 0.72, 0.0, 0.85));
    }

    vec3 col = mix(outer, core, smoothstep(0.15, 0.85, along) * 0.75 + diamonds * 0.55);
    col *= (1.35 + diamonds * 1.85) * flicker * max(0.3, uThrottle);

    float fadeTip = smoothstep(0.0, 0.65, along);
    float fadeNozzle = smoothstep(1.0, 0.92, along);
    float alpha = fadeTip * fadeNozzle * (0.42 + fresnel * 0.68) * clamp(uThrottle, 0.15, 1.4);

    gl_FragColor = vec4(col, alpha);
  }
`;

const VAPOR_CONE_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;

  vec3 safeNormalize(vec3 v) {
    float len = length(v);
    return len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  }

  void main() {
    vUv = uv;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewPos = -mvPos.xyz;
    vNormal = safeNormalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const VAPOR_CONE_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uTrip;

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
    float rim = pow(max(1.0 - ndotv, 1e-4), 1.85);
    float streak = 0.7 + 0.3 * sin(vUv.x * 38.0 + uTime * 16.0) * sin(vUv.y * 18.0 - uTime * 22.0);
    float edgeFade = smoothstep(0.0, 0.28, vUv.y) * smoothstep(1.0, 0.35, vUv.y);

    vec3 baseCol = vec3(0.95, 0.97, 1.0);
    vec3 prism = rainbow(vUv.x * 1.5 + vUv.y * 0.7 - uTime * 0.6);
    vec3 col = mix(baseCol, prism * 1.45, clamp(0.18 + uTrip * 0.82, 0.0, 1.0));

    float alpha = edgeFade * (0.22 + rim * 0.85) * streak * uIntensity;
    gl_FragColor = vec4(col * (1.0 + uTrip * 0.6), clamp(alpha, 0.0, 0.92));
  }
`;

// ---------------------------------------------------------------------------
// SHARED COMPONENT GEOMETRIES (BUILT ONCE FOR LOW MEMORY & FAST STARTUP)
// ---------------------------------------------------------------------------

interface SharedParts {
  nozzlePetalGeo: THREE.BufferGeometry;
  bladeGeo: THREE.BufferGeometry;
  spinnerGeo: THREE.BufferGeometry;
  sidewinderBodyGeo: THREE.BufferGeometry;
  sidewinderSeekerGeo: THREE.BufferGeometry;
  sidewinderFinGeo: THREE.BufferGeometry;
  amraamBodyGeo: THREE.BufferGeometry;
  amraamNoseGeo: THREE.BufferGeometry;
  amraamFinGeo: THREE.BufferGeometry;
  pylonGeo: THREE.BufferGeometry;
}

let sharedParts: SharedParts | null = null;

function getSharedParts(): SharedParts {
  if (sharedParts) return sharedParts;

  const nozzlePetalGeo = buildNozzlePetalGeometry({
    length: 1.18,
    rootWidth: 0.31,
    tipWidth: 0.21,
    thickness: 0.055,
    arch: 0.032,
  });

  const bladeGeo = new THREE.BoxGeometry(0.095, 0.44, 0.022);
  bladeGeo.translate(0, 0.24, 0);

  const spinnerGeo = new THREE.ConeGeometry(0.14, 0.38, 12);
  spinnerGeo.rotateX(-Math.PI / 2);

  // AIM-9X Sidewinder wingtip missile parts
  const sidewinderBodyGeo = new THREE.CylinderGeometry(0.068, 0.068, 2.45, 12);
  sidewinderBodyGeo.rotateX(Math.PI / 2);

  const sidewinderSeekerGeo = new THREE.SphereGeometry(0.068, 12, 8);
  sidewinderSeekerGeo.scale(1, 1, 1.55);

  const sidewinderFinGeo = new THREE.BoxGeometry(0.28, 0.014, 0.26);

  // AIM-120 AMRAAM underwing missile parts
  const amraamBodyGeo = new THREE.CylinderGeometry(0.088, 0.088, 2.95, 12);
  amraamBodyGeo.rotateX(Math.PI / 2);

  const amraamNoseGeo = new THREE.ConeGeometry(0.088, 0.62, 12);
  amraamNoseGeo.rotateX(-Math.PI / 2);

  const amraamFinGeo = new THREE.BoxGeometry(0.38, 0.018, 0.34);

  // Swept airfoil underwing pylon
  const pylonGeo = buildAirfoilWingGeometry({
    side: 1,
    chordSegments: 6,
    bevelFactor: 0.7,
    stations: [
      { span: 0, chord: 1.85, sweepZ: -0.95, dihedralY: 0, thicknessRatio: 0.075, camber: 0 },
      { span: 0.52, chord: 1.45, sweepZ: -0.62, dihedralY: 0, thicknessRatio: 0.065, camber: 0 },
    ],
  });
  pylonGeo.rotateZ(-Math.PI / 2); // Orient span downward along -Y

  sharedParts = {
    nozzlePetalGeo,
    bladeGeo,
    spinnerGeo,
    sidewinderBodyGeo,
    sidewinderSeekerGeo,
    sidewinderFinGeo,
    amraamBodyGeo,
    amraamNoseGeo,
    amraamFinGeo,
    pylonGeo,
  };
  return sharedParts;
}

// ---------------------------------------------------------------------------
// FUSELAGE & CANOPY LOFT PROFILES PER ROLE
// ---------------------------------------------------------------------------

function buildHeroFuselageGeometry(): THREE.BufferGeometry {
  const segs = 32;
  const stations: LoftStation[] = [
    // Needle radome tip (-Z forward)
    { z: -9.55, centerY: -0.02, points: createChinedSection({ halfWidth: 0.035, topHeight: 0.032, bottomDepth: 0.032, chineSharpness: 0.1, segments: segs }) },
    { z: -8.85, centerY: -0.01, points: createChinedSection({ halfWidth: 0.24, topHeight: 0.18, bottomDepth: 0.15, chineY: -0.02, chineSharpness: 0.35, segments: segs }) },
    { z: -7.75, centerY: 0.0, points: createChinedSection({ halfWidth: 0.56, topHeight: 0.34, bottomDepth: 0.26, chineY: -0.04, dorsalFullness: 0.52, bellyFlatness: 0.58, chineSharpness: 0.68, segments: segs }) },
    { z: -6.35, centerY: 0.02, points: createChinedSection({ halfWidth: 0.94, topHeight: 0.49, bottomDepth: 0.38, chineY: -0.04, dorsalFullness: 0.58, bellyFlatness: 0.74, chineSharpness: 0.85, segments: segs }) },
    // Forebody chine sweep ahead of canopy windscreen
    { z: -4.95, centerY: 0.04, points: createChinedSection({ halfWidth: 1.24, topHeight: 0.58, bottomDepth: 0.48, chineY: 0.02, dorsalFullness: 0.66, bellyFlatness: 0.82, chineSharpness: 0.92, segments: segs }) },
    // Recessed cockpit saddle flanked by flared LERX chines
    { z: -3.75, centerY: 0.04, points: createChinedSection({ halfWidth: 1.54, topHeight: 0.62, bottomDepth: 0.54, chineY: 0.06, dorsalFullness: 0.72, bellyFlatness: 0.86, chineSharpness: 0.95, dorsalValley: 0.14, segments: segs }) },
    { z: -2.45, centerY: 0.05, points: createChinedSection({ halfWidth: 1.82, topHeight: 0.76, bottomDepth: 0.58, chineY: 0.08, dorsalFullness: 0.68, bellyFlatness: 0.88, chineSharpness: 0.92, dorsalValley: 0.04, segments: segs }) },
    // Dorsal avionics spine & broad blended lifting-body mid-fuselage
    { z: -1.05, centerY: 0.06, points: createChinedSection({ halfWidth: 2.02, topHeight: 0.96, bottomDepth: 0.60, chineY: 0.06, dorsalFullness: 0.54, bellyFlatness: 0.88, chineSharpness: 0.86, segments: segs }) },
    { z: 0.65, centerY: 0.05, points: createChinedSection({ halfWidth: 2.04, topHeight: 0.94, bottomDepth: 0.60, chineY: 0.04, dorsalFullness: 0.58, bellyFlatness: 0.86, chineSharpness: 0.84, segments: segs }) },
    { z: 2.35, centerY: 0.03, points: createTwinNacelleSection({ halfWidth: 1.96, topHeight: 0.74, bottomDepth: 0.54, chineY: 0.02, nacelleX: 0.94, nacelleBump: 0.24, valleyDepth: 0.16, segments: segs }) },
    // Twin sculpted rear engine nacelles with recessed inter-nozzle beaver-tail valley
    { z: 4.15, centerY: 0.01, points: createTwinNacelleSection({ halfWidth: 1.86, topHeight: 0.56, bottomDepth: 0.44, chineY: 0.0, nacelleX: 0.94, nacelleBump: 0.34, valleyDepth: 0.28, segments: segs }) },
    { z: 5.45, centerY: -0.01, points: createTwinNacelleSection({ halfWidth: 1.66, topHeight: 0.44, bottomDepth: 0.36, chineY: -0.01, nacelleX: 0.94, nacelleBump: 0.34, valleyDepth: 0.34, segments: segs }) },
    { z: 5.92, centerY: -0.02, points: createTwinNacelleSection({ halfWidth: 1.48, topHeight: 0.38, bottomDepth: 0.32, chineY: -0.02, nacelleX: 0.92, nacelleBump: 0.30, valleyDepth: 0.32, segments: segs }) },
  ];

  return buildLoftedGeometry(stations, {
    subdivisionsPerSpan: 2,
    capFront: true,
    capBack: true,
    uScale: 1,
    vScale: 1,
    smoothSeamNormals: true,
  });
}

function buildStealthBanditFuselageGeometry(isAce: boolean): THREE.BufferGeometry {
  const segs = 32;
  const spineBoost = isAce ? 0.12 : 0.0;
  const stations: LoftStation[] = [
    // Razor-sharp stealth needle nose (-Z forward)
    { z: -10.25, centerY: -0.02, points: createChinedSection({ halfWidth: 0.03, topHeight: 0.026, bottomDepth: 0.024, chineSharpness: 0.15, segments: segs }) },
    { z: -9.35, centerY: -0.01, points: createChinedSection({ halfWidth: 0.25, topHeight: 0.15, bottomDepth: 0.12, chineY: -0.02, chineSharpness: 0.55, segments: segs }) },
    { z: -8.0, centerY: 0.0, points: createChinedSection({ halfWidth: 0.62, topHeight: 0.30, bottomDepth: 0.22, chineY: -0.04, dorsalFullness: 0.46, bellyFlatness: 0.72, chineSharpness: 0.88, segments: segs }) },
    { z: -6.3, centerY: 0.02, points: createChinedSection({ halfWidth: 1.06, topHeight: 0.44, bottomDepth: 0.34, chineY: -0.03, dorsalFullness: 0.52, bellyFlatness: 0.84, chineSharpness: 0.96, segments: segs }) },
    // Sharp faceted diamond chine deck at canard mount
    { z: -4.7, centerY: 0.04, points: createChinedSection({ halfWidth: 1.38, topHeight: 0.54, bottomDepth: 0.44, chineY: 0.02, dorsalFullness: 0.62, bellyFlatness: 0.90, chineSharpness: 0.98, segments: segs }) },
    { z: -3.4, centerY: 0.04, points: createChinedSection({ halfWidth: 1.66, topHeight: 0.58, bottomDepth: 0.48, chineY: 0.05, dorsalFullness: 0.66, bellyFlatness: 0.92, chineSharpness: 0.98, dorsalValley: 0.12, segments: segs }) },
    { z: -1.9, centerY: 0.05, points: createChinedSection({ halfWidth: 1.88, topHeight: 0.84 + spineBoost, bottomDepth: 0.52, chineY: 0.05, dorsalFullness: 0.48, bellyFlatness: 0.92, chineSharpness: 0.96, segments: segs }) },
    // Broad stealth lifting-body deck
    { z: 0.25, centerY: 0.04, points: createChinedSection({ halfWidth: 1.98, topHeight: 0.86 + spineBoost, bottomDepth: 0.54, chineY: 0.03, dorsalFullness: 0.52, bellyFlatness: 0.90, chineSharpness: 0.94, segments: segs }) },
    { z: 2.4, centerY: 0.02, points: createTwinNacelleSection({ halfWidth: 1.94, topHeight: 0.68 + spineBoost * 0.5, bottomDepth: 0.48, chineY: 0.0, nacelleX: 0.96, nacelleBump: 0.26, valleyDepth: 0.22, segments: segs }) },
    { z: 4.5, centerY: 0.0, points: createTwinNacelleSection({ halfWidth: 1.82, topHeight: 0.50, bottomDepth: 0.40, chineY: -0.02, nacelleX: 0.96, nacelleBump: 0.34, valleyDepth: 0.34, segments: segs }) },
    { z: 5.8, centerY: -0.01, points: createTwinNacelleSection({ halfWidth: 1.62, topHeight: 0.40, bottomDepth: 0.34, chineY: -0.02, nacelleX: 0.96, nacelleBump: 0.32, valleyDepth: 0.36, segments: segs }) },
    { z: 6.22, centerY: -0.02, points: createTwinNacelleSection({ halfWidth: 1.46, topHeight: 0.36, bottomDepth: 0.30, chineY: -0.02, nacelleX: 0.95, nacelleBump: 0.28, valleyDepth: 0.34, segments: segs }) },
  ];

  return buildLoftedGeometry(stations, {
    subdivisionsPerSpan: 2,
    capFront: true,
    capBack: true,
    uScale: 1,
    vScale: 1,
    smoothSeamNormals: true,
  });
}

function buildSculptedCanopyGeometry(isHero: boolean): THREE.BufferGeometry {
  const segs = 24;
  const zFront = isHero ? -4.85 : -4.95;
  const zBack = isHero ? -1.55 : -1.45;
  const len = zBack - zFront;

  const profile: { t: number; rx: number; ry: number; y: number }[] = [
    { t: 0.0, rx: 0.08, ry: 0.04, y: 0.54 },
    { t: 0.14, rx: 0.46, ry: 0.34, y: 0.62 },
    { t: 0.36, rx: 0.64, ry: 0.66, y: 0.72 },
    { t: 0.58, rx: 0.66, ry: 0.72, y: 0.74 },
    { t: 0.80, rx: 0.54, ry: 0.56, y: 0.72 },
    { t: 0.94, rx: 0.32, ry: 0.32, y: 0.68 },
    { t: 1.0, rx: 0.06, ry: 0.05, y: 0.64 },
  ];

  const stations: LoftStation[] = profile.map((p) => ({
    z: zFront + p.t * len,
    centerY: p.y,
    points: createSuperellipseSection({
      rx: p.rx,
      ry: p.ry,
      exp: isHero ? 2.15 : 2.55,
      topTaper: isHero ? 0.12 : 0.26,
      segments: segs,
    }),
  }));

  return buildLoftedGeometry(stations, {
    subdivisionsPerSpan: 2,
    capFront: true,
    capBack: true,
    smoothSeamNormals: true,
  });
}

// ---------------------------------------------------------------------------
// FIGHTER JET CLASS
// ---------------------------------------------------------------------------

export class FighterJet {
  public readonly id: string;
  public readonly callsign: string;
  public readonly role: FighterRole;
  public readonly group: THREE.Group;
  public readonly cockpitAnchor: THREE.Object3D;
  public readonly chaseAnchor: THREE.Object3D;
  public readonly gunMuzzle: THREE.Object3D;
  public readonly wingtipLeft: THREE.Object3D;
  public readonly wingtipRight: THREE.Object3D;

  public alive = true;
  public health = 1.0;
  public velocity = new THREE.Vector3(0, 0, -180);
  public speed = 180;
  public gForce = 1.0;
  public throttle = 1.0;
  public vaporIntensity = 0.0;

  private readonly hullMat: THREE.MeshPhysicalMaterial;
  private readonly darkMat: THREE.MeshPhysicalMaterial;
  private readonly canopyMat: THREE.MeshPhysicalMaterial;
  private readonly glowMat: THREE.MeshStandardMaterial;
  private readonly hotLinerMat: THREE.MeshStandardMaterial;

  private readonly leftWingPivot: THREE.Group;
  private readonly rightWingPivot: THREE.Group;
  private readonly leftAileronPivot: THREE.Group;
  private readonly rightAileronPivot: THREE.Group;
  private readonly leftStabPivot: THREE.Group | null = null;
  private readonly rightStabPivot: THREE.Group | null = null;
  private readonly leftCanardPivot: THREE.Group | null = null;
  private readonly rightCanardPivot: THREE.Group | null = null;
  private readonly counterPylonPivots: THREE.Group[] = [];
  private readonly counterPylonSigns: number[] = [];
  private readonly fanRotors: THREE.Group[] = [];
  private readonly nozzlePetalPivots: THREE.Group[] = [];
  private readonly afterburnerMats: THREE.ShaderMaterial[] = [];
  private readonly afterburnerMeshes: THREE.Mesh[] = [];
  private readonly afterburnerLight: THREE.PointLight;
  private readonly vaporMat: THREE.ShaderMaterial;
  private readonly vaporMesh: THREE.Mesh;
  private readonly strobeMeshes: THREE.Mesh[] = [];

  // Pre-allocated state & scratch objects (zero per-frame heap allocations)
  private readonly iridescenceRange: [number, number] = [160, 460];
  private fanPhase = 0;
  private lastVisualTime = -1;
  private readonly prevPos = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly _accel = new THREE.Vector3();
  private readonly _lookTarget = new THREE.Vector3();
  private readonly _upAxis = new THREE.Vector3(0, 1, 0);
  private readonly _rollAxis = new THREE.Vector3(0, 0, -1);
  private readonly _pitchAxis = new THREE.Vector3(1, 0, 0);
  private readonly _lookMat = new THREE.Matrix4();
  private readonly _poseQ = new THREE.Quaternion();
  private readonly _rollQ = new THREE.Quaternion();
  private readonly _pitchQ = new THREE.Quaternion();

  constructor(id: string, callsign: string, role: FighterRole) {
    this.id = id;
    this.callsign = callsign;
    this.role = role;
    this.group = new THREE.Group();
    this.group.name = `Fighter_${id}`;

    const texSet = createHullTextureSet(role);
    const parts = getSharedParts();
    const isHero = role === 'hero';
    const isAce = role === 'ace';

    const scale = isAce ? 1.28 : 1.0;
    this.group.scale.setScalar(scale);

    // ------------------------------------------------------------------
    // MATERIALS (2K FULL PBR STACK: ALBEDO, SOBEL NORMAL, ROUGH, METAL, AO, EMISSIVE)
    // ------------------------------------------------------------------
    this.hullMat = new THREE.MeshPhysicalMaterial({
      map: texSet.map,
      normalMap: texSet.normalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughnessMap: texSet.roughnessMap,
      roughness: 1.0,
      metalnessMap: texSet.metalnessMap,
      metalness: 1.0,
      aoMap: texSet.aoMap,
      aoMapIntensity: 0.72,
      emissiveMap: texSet.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: isHero ? 0.58 : isAce ? 2.15 : 1.35,
      clearcoat: isAce ? 0.65 : isHero ? 0.42 : 0.28,
      clearcoatRoughness: 0.2,
      iridescence: isAce ? 0.35 : 0.14,
      iridescenceIOR: 1.42,
      iridescenceThicknessRange: this.iridescenceRange,
    });

    this.darkMat = new THREE.MeshPhysicalMaterial({
      color: isHero ? 0x202632 : 0x0d0e14,
      roughness: 0.38,
      metalness: 0.9,
      clearcoat: 0.28,
      clearcoatRoughness: 0.28,
    });

    const intakeInnerMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b0d12,
      roughness: 0.76,
      metalness: 0.35,
    });

    const fanBladeMat = new THREE.MeshPhysicalMaterial({
      color: isHero ? 0x9aa6b4 : 0x484d59,
      roughness: 0.24,
      metalness: 0.96,
      clearcoat: 0.4,
    });

    const ordnanceMat = new THREE.MeshPhysicalMaterial({
      color: isHero ? 0xd8dee6 : 0x1a1c24,
      roughness: 0.36,
      metalness: isHero ? 0.42 : 0.72,
      clearcoat: 0.25,
    });

    this.canopyMat = new THREE.MeshPhysicalMaterial({
      color: isHero ? 0xffcb6b : isAce ? 0xff1e4a : 0xff5432,
      roughness: 0.05,
      metalness: 0.22,
      transmission: 0.42,
      ior: 1.52,
      thickness: 0.32,
      iridescence: 1.0,
      iridescenceIOR: 1.48,
      iridescenceThicknessRange: [220, 680],
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      transparent: true,
      opacity: 0.66,
      depthWrite: false,
    });

    this.glowMat = new THREE.MeshStandardMaterial({
      color: isHero ? 0x72f8dc : 0xff2848,
      emissive: isHero ? 0x4ae8c4 : 0xff183a,
      emissiveIntensity: isHero ? 1.15 : isAce ? 3.6 : 2.3,
      roughness: 0.18,
      metalness: 0.15,
    });

    this.hotLinerMat = new THREE.MeshStandardMaterial({
      color: isHero ? 0x443228 : 0x381822,
      emissive: isHero ? 0xff7c2c : isAce ? 0xff1866 : 0xff3b1c,
      emissiveIntensity: 2.2,
      roughness: 0.45,
      metalness: 0.55,
      side: THREE.DoubleSide,
    });

    const mfdMat = new THREE.MeshStandardMaterial({
      color: isHero ? 0x183830 : 0x381218,
      emissive: isHero ? 0x26ffbe : 0xff2a48,
      emissiveIntensity: 2.4,
      roughness: 0.15,
      metalness: 0.1,
    });

    const body = new THREE.Group();
    this.group.add(body);

    // ------------------------------------------------------------------
    // 1. SEAMLESS MULTI-STATION CHINED NOSE-TO-FUSELAGE LOFT
    // ------------------------------------------------------------------
    const fuselageGeo = isHero
      ? buildHeroFuselageGeometry()
      : buildStealthBanditFuselageGeometry(isAce);
    const fuselageMesh = new THREE.Mesh(fuselageGeo, this.hullMat);
    body.add(fuselageMesh);

    // Supersonic nose pitot boom & AOA sensor vanes
    const noseTipZ = isHero ? -9.55 : -10.25;
    const pitot = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.042, 1.35, 10), this.darkMat);
    pitot.rotation.x = Math.PI / 2;
    pitot.position.set(0, -0.02, noseTipZ - 0.65);
    body.add(pitot);

    // Starboard M61A2 Vulcan 20mm flush gun fairing on VIPER-1
    if (isHero) {
      const gunFairing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.14, 1.75, 10),
        this.darkMat,
      );
      gunFairing.rotation.x = Math.PI / 2;
      gunFairing.position.set(0.84, -0.18, -5.45);
      body.add(gunFairing);
    }

    // Glowing stealth dorsal & chine seam accents on WRAITH / CRIMSON-1
    if (!isHero) {
      for (const side of [-1, 1] as const) {
        const chineSeam = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.04, 6.2), this.glowMat);
        chineSeam.position.set(side * 1.44, 0.08, -3.55);
        chineSeam.rotation.y = side * 0.14;
        body.add(chineSeam);

        const dorsalTrace = new THREE.Mesh(
          new THREE.BoxGeometry(0.045, 0.035, 5.4),
          this.glowMat,
        );
        dorsalTrace.position.set(side * 0.42, 0.72 + (isAce ? 0.11 : 0), 0.75);
        body.add(dorsalTrace);
      }

      if (isAce) {
        // Extra twin stealth blade antennas on CRIMSON-1 Ace spine
        for (const side of [-1, 1] as const) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.48, 1.1), this.darkMat);
          blade.position.set(side * 0.28, 1.06, 0.6);
          blade.rotation.x = -0.35;
          blade.rotation.z = side * -0.18;
          body.add(blade);
        }
      }
    }

    // ------------------------------------------------------------------
    // 2. CURVED S-DUCT STEALTH INTAKES + SPINNING 3D COMPRESSOR FANS
    // ------------------------------------------------------------------
    for (const side of [-1, 1] as const) {
      const intakeStations: SductIntakeStation[] = isHero
        ? [
            { z: -3.05, centerX: side * 1.56, centerY: -0.14, halfWidth: 0.56, halfHeight: 0.48, cantRad: -0.22, topSkewZ: -0.34, inboardSkewZ: -0.22 },
            { z: -1.75, centerX: side * 1.52, centerY: -0.12, halfWidth: 0.58, halfHeight: 0.50, cantRad: -0.18, topSkewZ: -0.10 },
            { z: 0.15, centerX: side * 1.38, centerY: -0.08, halfWidth: 0.58, halfHeight: 0.50, cantRad: -0.12 },
            { z: 2.35, centerX: side * 1.14, centerY: -0.04, halfWidth: 0.56, halfHeight: 0.48, cantRad: -0.06 },
            { z: 4.65, centerX: side * 0.96, centerY: -0.02, halfWidth: 0.52, halfHeight: 0.44, cantRad: 0.0 },
          ]
        : [
            { z: -2.85, centerX: side * 1.48, centerY: -0.16, halfWidth: 0.54, halfHeight: 0.42, cantRad: -0.32, topSkewZ: -0.42, inboardSkewZ: -0.28 },
            { z: -1.45, centerX: side * 1.44, centerY: -0.14, halfWidth: 0.55, halfHeight: 0.44, cantRad: -0.24, topSkewZ: -0.12 },
            { z: 0.55, centerX: side * 1.28, centerY: -0.08, halfWidth: 0.55, halfHeight: 0.45, cantRad: -0.14 },
            { z: 2.85, centerX: side * 1.08, centerY: -0.04, halfWidth: 0.53, halfHeight: 0.43, cantRad: -0.06 },
            { z: 4.95, centerX: side * 0.96, centerY: -0.02, halfWidth: 0.48, halfHeight: 0.40, cantRad: 0.0 },
          ];

      const { outer, inner } = buildSductIntakeGeometries({
        side,
        stations: intakeStations,
        wallThickness: 0.075,
        segments: 24,
        ductDepthFraction: 0.58,
      });

      body.add(new THREE.Mesh(outer, this.hullMat));
      body.add(new THREE.Mesh(inner, intakeInnerMat));

      // Boundary-layer splitter diverter plate between intake and fuselage
      const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.72, 1.35), this.darkMat);
      splitter.position.set(side * 1.04, -0.12, -2.55);
      splitter.rotation.z = side * -0.18;
      body.add(splitter);

      // Spinning 16-blade 3D titanium compressor fan inside recessed S-duct throat
      const fanRotor = new THREE.Group();
      fanRotor.position.set(
        side * (isHero ? 1.52 : 1.44),
        isHero ? -0.12 : -0.14,
        isHero ? -2.02 : -1.85,
      );
      // Fit blade tips cleanly inside the recessed inner S-duct throat
      fanRotor.scale.setScalar(isHero ? 0.86 : 0.74);
      const bladeCount = 16;
      for (let b = 0; b < bladeCount; b++) {
        const bladeHolder = new THREE.Group();
        bladeHolder.rotation.z = (b / bladeCount) * Math.PI * 2;
        const blade = new THREE.Mesh(parts.bladeGeo, fanBladeMat);
        blade.rotation.y = 0.52; // Aerodynamic compressor blade pitch
        bladeHolder.add(blade);
        fanRotor.add(bladeHolder);
      }
      const spinner = new THREE.Mesh(parts.spinnerGeo, this.darkMat);
      spinner.position.z = -0.14;
      fanRotor.add(spinner);
      body.add(fanRotor);
      this.fanRotors.push(fanRotor);

      // Glowing recessed intake throat accent (subtle cyan sensor on hero; fierce crimson on WRAITH/Ace)
      const throatAccent = new THREE.Mesh(
        new THREE.BoxGeometry(isHero ? 0.62 : 0.74, isHero ? 0.045 : 0.085, 0.05),
        this.glowMat,
      );
      throatAccent.position.set(
        side * (isHero ? 1.54 : 1.46),
        isHero ? -0.44 : -0.42,
        isHero ? -2.68 : -2.52,
      );
      throatAccent.rotation.z = side * (isHero ? -0.2 : -0.3);
      body.add(throatAccent);

      if (!isHero) {
        // Upper crimson intake eyebrow glow on WRAITH & CRIMSON-1
        const lipGlow = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.055, 0.08), this.glowMat);
        lipGlow.position.set(side * 1.48, 0.16, -2.92);
        lipGlow.rotation.z = side * -0.32;
        body.add(lipGlow);
      }
    }

    // ------------------------------------------------------------------
    // 3. DETAILED BACKLIT COCKPIT, HUD COMBINER, SEAT RAILS & LOFTED CANOPY
    // ------------------------------------------------------------------
    const cockpitGroup = new THREE.Group();
    body.add(cockpitGroup);

    // Dark recessed cockpit tub & coaming glare shield
    const tub = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.42, 2.85), this.darkMat);
    tub.position.set(0, 0.48, -3.35);
    cockpitGroup.add(tub);

    const glareShield = new THREE.Mesh(new THREE.BoxGeometry(0.80, 0.14, 0.62), this.darkMat);
    glareShield.position.set(0, 0.77, -4.16);
    glareShield.rotation.x = 0.22;
    cockpitGroup.add(glareShield);

    // Three backlit MFD instrument displays (left radar, centre HSI, right stores)
    const mfdGeo = new THREE.PlaneGeometry(0.20, 0.16);
    const mfdOffsets: [number, number, number, number][] = [
      [-0.23, 0.75, -3.98, 0.18],
      [0.0, 0.73, -4.00, 0.0],
      [0.23, 0.75, -3.98, -0.18],
    ];
    for (let i = 0; i < mfdOffsets.length; i++) {
      const [mx, my, mz, ry] = mfdOffsets[i];
      const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.19, 0.04), this.darkMat);
      bezel.position.set(mx, my, mz - 0.025);
      bezel.rotation.y = ry;
      bezel.rotation.x = -0.32;
      cockpitGroup.add(bezel);

      const screen = new THREE.Mesh(mfdGeo, mfdMat);
      screen.position.set(mx, my, mz);
      screen.rotation.y = ry;
      screen.rotation.x = -0.32;
      cockpitGroup.add(screen);
    }

    // HUD combiner frame (twin machined posts + top crossbar) & holographic combiner glass
    // Positioned cleanly inside the forward bubble canopy windscreen envelope
    const hudFramePostGeo = new THREE.BoxGeometry(0.026, 0.26, 0.03);
    for (const side of [-1, 1] as const) {
      const post = new THREE.Mesh(hudFramePostGeo, this.darkMat);
      post.position.set(side * 0.20, 0.94, -3.98);
      post.rotation.x = -0.38;
      cockpitGroup.add(post);
    }
    const hudTopBar = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.024, 0.03), this.darkMat);
    hudTopBar.position.set(0, 1.06, -3.93);
    cockpitGroup.add(hudTopBar);

    const hudGlass = new THREE.Mesh(
      new THREE.PlaneGeometry(0.38, 0.24),
      new THREE.MeshBasicMaterial({
        color: isHero ? 0x44ffaa : 0xff3b58,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    hudGlass.position.set(0, 0.94, -3.97);
    hudGlass.rotation.x = -0.38;
    cockpitGroup.add(hudGlass);

    // ACES-II ejection seat with twin metallic ejection seat rails & headrest
    const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.72, 0.18), this.darkMat);
    seatBack.position.set(0, 0.86, -2.66);
    seatBack.rotation.x = -0.24;
    cockpitGroup.add(seatBack);

    const railMat = new THREE.MeshPhysicalMaterial({
      color: 0xb8c4d0,
      roughness: 0.28,
      metalness: 0.92,
    });
    const railGeo = new THREE.BoxGeometry(0.045, 0.88, 0.055);
    for (const side of [-1, 1] as const) {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(side * 0.26, 0.88, -2.56);
      rail.rotation.x = -0.24;
      cockpitGroup.add(rail);
    }

    const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.20), this.darkMat);
    headrest.position.set(0, 1.24, -2.58);
    headrest.rotation.x = -0.18;
    cockpitGroup.add(headrest);

    // Flight-suited pilot shoulders, helmet & reflective visor
    const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.26, 0.28), this.darkMat);
    shoulders.position.set(0, 0.76, -3.02);
    cockpitGroup.add(shoulders);

    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshPhysicalMaterial({
        color: isHero ? 0xeef3fa : 0x16171f,
        roughness: 0.14,
        metalness: 0.72,
        clearcoat: 1.0,
      }),
    );
    helmet.position.set(0, 1.04, -3.08);
    cockpitGroup.add(helmet);

    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.228, 14, 10, -Math.PI * 0.36, Math.PI * 0.72, Math.PI * 0.26, Math.PI * 0.36),
      new THREE.MeshPhysicalMaterial({
        color: isHero ? 0xffb833 : isAce ? 0xff2244 : 0xff6633,
        metalness: 0.96,
        roughness: 0.06,
        iridescence: 1.0,
        clearcoat: 1.0,
      }),
    );
    visor.position.copy(helmet.position);
    visor.rotation.y = -Math.PI / 2;
    cockpitGroup.add(visor);

    // Sculpted lofted stealth bubble canopy + dark titanium sill & bow frame
    const canopyGeo = buildSculptedCanopyGeometry(isHero);
    const canopyMesh = new THREE.Mesh(canopyGeo, this.canopyMat);
    cockpitGroup.add(canopyMesh);

    const canopyBow = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.036, 8, 18, Math.PI),
      this.darkMat,
    );
    canopyBow.scale.set(1.02, 1.12, 1.0);
    canopyBow.position.set(0, 0.68, -3.76);
    canopyBow.rotation.x = 0.28;
    cockpitGroup.add(canopyBow);

    // ------------------------------------------------------------------
    // 4. BEVELLED AIRFOIL WINGS, ARTICULATED FLAPS/AILERONS & ORDNANCE
    // ------------------------------------------------------------------
    this.leftWingPivot = new THREE.Group();
    this.rightWingPivot = new THREE.Group();
    this.leftWingPivot.position.set(-1.68, 0.10, -0.35);
    this.rightWingPivot.position.set(1.68, 0.10, -0.35);
    body.add(this.leftWingPivot, this.rightWingPivot);

    // Fixed bevelled wing-glove strakes (LERX) blending into the chined hull
    for (const side of [-1, 1] as const) {
      const lerxGeo = buildAirfoilWingGeometry({
        side,
        chordSegments: 8,
        bevelFactor: 0.75,
        stations: [
          { span: 0.0, chord: 4.8, sweepZ: -4.65, dihedralY: 0.04, thicknessRatio: 0.085 },
          { span: 0.72, chord: 3.1, sweepZ: -2.4, dihedralY: 0.05, thicknessRatio: 0.07 },
          { span: 1.32, chord: 1.55, sweepZ: -0.95, dihedralY: 0.06, thicknessRatio: 0.055 },
        ],
      });
      const lerxMesh = new THREE.Mesh(lerxGeo, this.hullMat);
      lerxMesh.position.set(side * 0.92, 0.08, 0.0);
      body.add(lerxMesh);
    }

    const buildMissileAssembly = (type: 'sidewinder' | 'amraam'): THREE.Group => {
      const mg = new THREE.Group();
      if (type === 'sidewinder') {
        mg.add(new THREE.Mesh(parts.sidewinderBodyGeo, ordnanceMat));
        const seeker = new THREE.Mesh(parts.sidewinderSeekerGeo, this.darkMat);
        seeker.position.z = -1.24;
        mg.add(seeker);

        // Cruciform forward guidance canards & rear stabiliser fins
        for (const zPos of [-0.88, 1.02]) {
          const finH = new THREE.Mesh(parts.sidewinderFinGeo, this.darkMat);
          finH.position.z = zPos;
          const finV = new THREE.Mesh(parts.sidewinderFinGeo, this.darkMat);
          finV.position.z = zPos;
          finV.rotation.z = Math.PI / 2;
          mg.add(finH, finV);
        }
      } else {
        mg.add(new THREE.Mesh(parts.amraamBodyGeo, ordnanceMat));
        const nose = new THREE.Mesh(parts.amraamNoseGeo, this.darkMat);
        nose.position.z = -1.78;
        mg.add(nose);

        for (const zPos of [0.05, 1.24]) {
          const finH = new THREE.Mesh(parts.amraamFinGeo, this.darkMat);
          finH.position.z = zPos;
          const finV = new THREE.Mesh(parts.amraamFinGeo, this.darkMat);
          finV.position.z = zPos;
          finV.rotation.z = Math.PI / 2;
          mg.add(finH, finV);
        }
      }
      return mg;
    };

    const buildWingAssembly = (
      side: -1 | 1,
    ): { wingGroup: THREE.Group; aileronPivot: THREE.Group; tipAnchor: THREE.Object3D } => {
      const wg = new THREE.Group();

      const wingGeo = isHero
        ? buildAirfoilWingGeometry({
            side,
            chordSegments: 14,
            bevelFactor: 0.52,
            uScale: 1,
            vScale: 1,
            stations: [
              // Variable-sweep supersonic F-14/F-22 hybrid wing
              { span: 0.0, chord: 4.15, sweepZ: -1.55, dihedralY: 0.0, thicknessRatio: 0.072, camber: 0.012 },
              { span: 1.9, chord: 3.35, sweepZ: -0.35, dihedralY: -0.02, thicknessRatio: 0.062, camber: 0.010 },
              { span: 4.2, chord: 2.35, sweepZ: 1.15, dihedralY: -0.06, thicknessRatio: 0.052, camber: 0.008, twistRad: -0.02 },
              { span: 6.32, chord: 1.32, sweepZ: 2.48, dihedralY: -0.10, thicknessRatio: 0.044, camber: 0.005, twistRad: -0.04 },
            ],
          })
        : buildAirfoilWingGeometry({
            side,
            chordSegments: 14,
            bevelFactor: 0.68,
            uScale: 1,
            vScale: 1,
            stations: [
              // Menacing Su-47 forward-swept stealth wing!
              { span: 0.0, chord: 4.05, sweepZ: -0.85, dihedralY: 0.0, thicknessRatio: 0.068, camber: 0.010 },
              { span: 1.85, chord: 2.95, sweepZ: -1.62, dihedralY: 0.04, thicknessRatio: 0.058, camber: 0.008 },
              { span: 4.1, chord: 2.02, sweepZ: -2.42, dihedralY: 0.08, thicknessRatio: 0.048, camber: 0.006, twistRad: 0.025 },
              { span: 6.12, chord: 1.18, sweepZ: -2.98, dihedralY: 0.12, thicknessRatio: 0.042, camber: 0.004, twistRad: 0.04 },
            ],
          });
      wg.add(new THREE.Mesh(wingGeo, this.hullMat));

      // Articulated trailing-edge flap / aileron hinged flush along wing trailing edge
      const aileronPivot = new THREE.Group();
      aileronPivot.rotation.order = 'YXZ';
      if (isHero) {
        aileronPivot.position.set(side * 2.85, -0.04, 2.94);
        aileronPivot.rotation.y = side * -0.188;
      } else {
        aileronPivot.position.set(side * 2.95, 0.06, 0.36);
        aileronPivot.rotation.y = side * 0.655;
      }
      const aileronGeo = buildAirfoilWingGeometry({
        side,
        chordSegments: 6,
        bevelFactor: 0.68,
        stations: [
          { span: -1.18, chord: 0.44, sweepZ: 0.0, dihedralY: 0, thicknessRatio: 0.095, camber: 0 },
          { span: 1.18, chord: 0.38, sweepZ: 0.02, dihedralY: 0, thicknessRatio: 0.085, camber: 0 },
        ],
      });
      aileronPivot.add(new THREE.Mesh(aileronGeo, this.hullMat));
      wg.add(aileronPivot);

      // Sleek tactical wing-root accent strip
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(isHero ? 2.15 : 2.85, 0.032, isHero ? 0.055 : 0.09),
        this.glowMat,
      );
      strip.position.set(side * 2.15, 0.095, isHero ? 1.15 : -0.82);
      strip.rotation.y = isHero ? side * -0.54 : side * 0.36;
      wg.add(strip);

      // Underwing weapon pylons + AMRAAM air-to-air missiles
      const pylonStations: [number, number, number][] = isHero
        ? [
            [1.65, -0.08, 0.65],
            [3.45, -0.10, 1.75],
          ]
        : [[2.15, -0.04, -0.65]];

      for (let p = 0; p < pylonStations.length; p++) {
        const [px, py, pz] = pylonStations[p];
        const pylonPivot = new THREE.Group();
        pylonPivot.position.set(side * px, py, pz);

        const pylonMesh = new THREE.Mesh(parts.pylonGeo, this.darkMat);
        pylonPivot.add(pylonMesh);

        const railBar = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 1.95), this.darkMat);
        railBar.position.set(0, -0.52, 0.05);
        pylonPivot.add(railBar);

        const amraam = buildMissileAssembly('amraam');
        amraam.position.set(0, -0.62, 0.0);
        pylonPivot.add(amraam);

        wg.add(pylonPivot);
        if (isHero) {
          this.counterPylonPivots.push(pylonPivot);
          this.counterPylonSigns.push(side);
        }
      }

      // External wingtip launch rail + AIM-9X Sidewinder missile
      const tipX = side * (isHero ? 6.36 : 6.16);
      const tipY = isHero ? -0.10 : 0.12;
      const tipZ = isHero ? 2.95 : -2.35;

      const tipRail = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 1.85), this.darkMat);
      tipRail.position.set(tipX, tipY, tipZ);
      wg.add(tipRail);

      const sidewinder = buildMissileAssembly('sidewinder');
      sidewinder.position.set(tipX + side * 0.09, tipY - 0.04, tipZ - 0.15);
      wg.add(sidewinder);

      // Wingtip navigation strobe light
      const strobeColor = side < 0 ? 0xff2244 : 0x22ff88;
      const strobe = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 8, 8),
        new THREE.MeshBasicMaterial({ color: strobeColor }),
      );
      strobe.position.set(tipX, tipY + 0.08, tipZ + 0.62);
      wg.add(strobe);
      this.strobeMeshes.push(strobe);

      const tipAnchor = new THREE.Object3D();
      tipAnchor.position.set(tipX + side * 0.12, tipY, tipZ + 0.85);
      wg.add(tipAnchor);

      return { wingGroup: wg, aileronPivot, tipAnchor };
    };

    const leftWing = buildWingAssembly(-1);
    const rightWing = buildWingAssembly(1);
    this.leftWingPivot.add(leftWing.wingGroup);
    this.rightWingPivot.add(rightWing.wingGroup);
    this.leftAileronPivot = leftWing.aileronPivot;
    this.rightAileronPivot = rightWing.aileronPivot;
    this.wingtipLeft = leftWing.tipAnchor;
    this.wingtipRight = rightWing.tipAnchor;

    // ------------------------------------------------------------------
    // 5. ARTICULATED FORWARD STEALTH CANARDS (WRAITH & CRIMSON-1)
    // ------------------------------------------------------------------
    if (!isHero) {
      for (const side of [-1, 1] as const) {
        const canardPivot = new THREE.Group();
        canardPivot.position.set(side * 1.18, 0.14, -4.55);

        const canardGeo = buildAirfoilWingGeometry({
          side,
          chordSegments: 10,
          bevelFactor: 0.72,
          stations: [
            { span: 0.0, chord: 1.52, sweepZ: -0.62, dihedralY: 0.0, thicknessRatio: 0.068, camber: 0.004 },
            { span: 1.2, chord: 1.04, sweepZ: -0.04, dihedralY: 0.05, thicknessRatio: 0.055, camber: 0.002 },
            { span: 2.25, chord: 0.56, sweepZ: 0.58, dihedralY: 0.10, thicknessRatio: 0.045, camber: 0.0 },
          ],
        });
        canardPivot.add(new THREE.Mesh(canardGeo, this.hullMat));

        // Subtle crimson leading-edge accent on Ace canards
        if (isAce) {
          const cTrim = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.032, 0.06), this.glowMat);
          cTrim.position.set(side * 0.95, 0.06, 0.04);
          cTrim.rotation.y = side * -0.46;
          canardPivot.add(cTrim);
        }

        body.add(canardPivot);
        if (side < 0) this.leftCanardPivot = canardPivot;
        else this.rightCanardPivot = canardPivot;
      }
    }

    // ------------------------------------------------------------------
    // 6. TWIN CANTED VERTICAL STABILISERS / V-TAILS & HORIZONTAL STABILATORS
    // ------------------------------------------------------------------
    for (const side of [-1, 1] as const) {
      // Build bevelled airfoil fin oriented vertically along +Y
      const finGeo = buildAirfoilWingGeometry({
        side: 1,
        chordSegments: 10,
        bevelFactor: 0.64,
        stations: isHero
          ? [
              { span: 0.0, chord: 2.95, sweepZ: -0.25, dihedralY: 0, thicknessRatio: 0.062, camber: 0 },
              { span: 1.45, chord: 2.05, sweepZ: 0.78, dihedralY: 0, thicknessRatio: 0.052, camber: 0 },
              { span: 2.75, chord: 1.18, sweepZ: 1.72, dihedralY: 0, thicknessRatio: 0.044, camber: 0 },
            ]
          : [
              // Swept low-observable canted V-tail for WRAITH & CRIMSON-1
              { span: 0.0, chord: 3.25, sweepZ: -0.35, dihedralY: 0, thicknessRatio: 0.058, camber: 0 },
              { span: 1.65, chord: 2.15, sweepZ: 0.95, dihedralY: 0, thicknessRatio: 0.048, camber: 0 },
              { span: 3.15, chord: 1.02, sweepZ: 2.12, dihedralY: 0, thicknessRatio: 0.042, camber: 0 },
            ],
      });
      finGeo.rotateZ(Math.PI / 2); // Span +X -> +Y

      const fin = new THREE.Mesh(finGeo, this.hullMat);
      fin.position.set(side * (isHero ? 1.44 : 1.38), 0.38, isHero ? 2.85 : 3.05);
      fin.rotation.z = side * (isHero ? -0.34 : -0.64);
      body.add(fin);

      // Subtle glowing formation strip on tail fin tip
      const finLight = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.38, 0.14), this.glowMat);
      finLight.position.set(
        side * (isHero ? 2.26 : 2.98),
        isHero ? 2.72 : 2.52,
        isHero ? 4.92 : 5.38,
      );
      finLight.rotation.z = side * (isHero ? -0.34 : -0.64);
      body.add(finLight);

      if (isHero) {
        // Articulated all-moving supersonic horizontal stabilator on VIPER-1
        const stabPivot = new THREE.Group();
        stabPivot.position.set(side * 1.42, -0.02, 4.95);
        const stabGeo = buildAirfoilWingGeometry({
          side,
          chordSegments: 10,
          bevelFactor: 0.62,
          stations: [
            { span: 0.0, chord: 2.25, sweepZ: -0.95, dihedralY: 0, thicknessRatio: 0.06, camber: 0 },
            { span: 1.75, chord: 1.52, sweepZ: 0.05, dihedralY: -0.04, thicknessRatio: 0.048, camber: 0 },
            { span: 3.25, chord: 0.84, sweepZ: 0.92, dihedralY: -0.08, thicknessRatio: 0.04, camber: 0 },
          ],
        });
        stabPivot.add(new THREE.Mesh(stabGeo, this.hullMat));
        body.add(stabPivot);

        if (side < 0) this.leftStabPivot = stabPivot;
        else this.rightStabPivot = stabPivot;

        // Ventral stability strake under aft nacelle
        const vStrake = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.44, 2.25), this.darkMat);
        vStrake.position.set(side * 1.34, -0.52, 3.85);
        vStrake.rotation.z = side * 0.28;
        body.add(vStrake);
      } else {
        // Compact stealth aft taileron boom flanking V-tail on WRAITH / CRIMSON-1
        const taileronPivot = new THREE.Group();
        taileronPivot.position.set(side * 1.46, -0.06, 5.15);
        const taileronGeo = buildAirfoilWingGeometry({
          side,
          chordSegments: 8,
          bevelFactor: 0.72,
          stations: [
            { span: 0.0, chord: 1.85, sweepZ: -0.78, dihedralY: 0, thicknessRatio: 0.056, camber: 0 },
            { span: 2.15, chord: 0.78, sweepZ: 0.42, dihedralY: -0.14, thicknessRatio: 0.04, camber: 0 },
          ],
        });
        taileronPivot.add(new THREE.Mesh(taileronGeo, this.hullMat));
        body.add(taileronPivot);

        if (side < 0) this.leftStabPivot = taileronPivot;
        else this.rightStabPivot = taileronPivot;
      }
    }

    // ------------------------------------------------------------------
    // 7. SEGMENTED TURKEY-FEATHER VECTORING NOZZLES & MACH-DIAMOND PLUMES
    // ------------------------------------------------------------------
    const coreColor = isHero
      ? new THREE.Color(0xc8f4ff)
      : isAce
        ? new THREE.Color(0xff9eff)
        : new THREE.Color(0xffd2a8);
    const outerColor = isHero
      ? new THREE.Color(0xff741c)
      : isAce
        ? new THREE.Color(0xff1058)
        : new THREE.Color(0xff3314);

    const nozzleX = isHero ? 0.94 : 0.96;
    const nozzleZ = isHero ? 5.82 : 6.12;

    for (const side of [-1, 1] as const) {
      const nozzleRoot = new THREE.Group();
      nozzleRoot.position.set(side * nozzleX, -0.02, nozzleZ);
      body.add(nozzleRoot);

      // Machined titanium shroud ring
      const collar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.68, 0.72, 0.48, 20, 1, false),
        this.darkMat,
      );
      collar.rotation.x = Math.PI / 2;
      collar.position.z = 0.16;
      nozzleRoot.add(collar);

      // Inner incandescent ceramic afterburner liner sleeve
      const innerLiner = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.59, 1.12, 18, 1, true),
        this.hotLinerMat,
      );
      innerLiner.rotation.x = Math.PI / 2;
      innerLiner.position.z = 0.62;
      nozzleRoot.add(innerLiner);

      // 14 overlapping articulated turkey-feather titanium nozzle petals
      const petalCount = 14;
      const petalRadius = 0.65;
      for (let p = 0; p < petalCount; p++) {
        const theta = (p / petalCount) * Math.PI * 2;
        const radialMount = new THREE.Group();
        radialMount.rotation.z = theta;

        const petalPivot = new THREE.Group();
        petalPivot.position.set(0, petalRadius, 0.18);

        const petalMesh = new THREE.Mesh(parts.nozzlePetalGeo, this.darkMat);
        // Alternate slight radial stagger for overlapping turkey-feather realism
        petalMesh.position.y = p % 2 === 0 ? 0.015 : -0.015;
        petalPivot.add(petalMesh);

        radialMount.add(petalPivot);
        nozzleRoot.add(radialMount);
        this.nozzlePetalPivots.push(petalPivot);
      }

      // Glowing turbine flameholder core disc
      const burnerCore = new THREE.Mesh(
        new THREE.CircleGeometry(0.53, 18),
        new THREE.MeshBasicMaterial({
          color: isHero ? 0x99f2ff : isAce ? 0xff4488 : 0xff6644,
        }),
      );
      burnerCore.position.z = 1.08;
      nozzleRoot.add(burnerCore);

      // Animated Mach-diamond plasma cone (wide base at nozzle, tapered tip aft)
      const plumeGeo = new THREE.ConeGeometry(0.66, 7.8, 20, 18, true);
      plumeGeo.translate(0, 3.9, 0);
      plumeGeo.rotateX(Math.PI / 2);

      const abMat = new THREE.ShaderMaterial({
        vertexShader: AFTERBURNER_VERT,
        fragmentShader: AFTERBURNER_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uThrottle: { value: 1.0 },
          uTrip: { value: 0 },
          uCoreColor: { value: coreColor.clone() },
          uOuterColor: { value: outerColor.clone() },
        },
      });
      const plumeMesh = new THREE.Mesh(plumeGeo, abMat);
      plumeMesh.position.z = 1.05;
      nozzleRoot.add(plumeMesh);
      this.afterburnerMats.push(abMat);
      this.afterburnerMeshes.push(plumeMesh);
    }

    // Dynamic afterburner illumination light
    this.afterburnerLight = new THREE.PointLight(
      isHero ? 0xff9438 : 0xff2855,
      isHero ? 35 : isAce ? 30 : 12,
      48,
      1.6,
    );
    this.afterburnerLight.position.set(0, 0.2, 8.6);
    body.add(this.afterburnerLight);

    // ------------------------------------------------------------------
    // 8. SUPERSONIC PRANDTL-GLAUERT VAPOUR CONE
    // ------------------------------------------------------------------
    const coneGeo = new THREE.ConeGeometry(5.6, 6.4, 36, 1, true);
    coneGeo.rotateX(-Math.PI / 2);
    this.vaporMat = new THREE.ShaderMaterial({
      vertexShader: VAPOR_CONE_VERT,
      fragmentShader: VAPOR_CONE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uIntensity: { value: 0 },
        uTime: { value: 0 },
        uTrip: { value: 0 },
      },
    });
    this.vaporMesh = new THREE.Mesh(coneGeo, this.vaporMat);
    this.vaporMesh.position.set(0, 0.1, 1.4);
    this.vaporMesh.visible = false;
    body.add(this.vaporMesh);

    // ------------------------------------------------------------------
    // 9. CAMERA & WEAPON ANCHORS (100% COMPATIBLE WITH CALLERS)
    // ------------------------------------------------------------------
    // Positioned cleanly above & forward of the canopy sill for an unobstructed cockpit view
    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.position.set(0, 1.85, -4.8);
    body.add(this.cockpitAnchor);

    this.chaseAnchor = new THREE.Object3D();
    this.chaseAnchor.position.set(0, 4.4, 18.5);
    body.add(this.chaseAnchor);

    this.gunMuzzle = new THREE.Object3D();
    this.gunMuzzle.position.set(0.85, -0.25, -6.2);
    body.add(this.gunMuzzle);
  }

  public setPoseFromMotion(
    pos: THREE.Vector3,
    forward: THREE.Vector3,
    bankRad: number,
    dt: number,
    extraPitchRad = 0,
  ): void {
    if (dt > 0.0001) {
      this.velocity.subVectors(pos, this.prevPos).divideScalar(dt);
      this._accel.subVectors(this.velocity, this.prevVel).divideScalar(Math.max(dt, 0.016));
      this.gForce = THREE.MathUtils.lerp(
        this.gForce,
        1.0 + Math.min(11.5, this._accel.length() / 22),
        0.14,
      );
      this.prevVel.copy(this.velocity);
      this.speed = THREE.MathUtils.lerp(this.speed, Math.max(95, this.velocity.length()), 0.15);
    }
    this.prevPos.copy(pos);

    this.group.position.copy(pos);

    this._lookTarget.copy(pos).add(forward);
    this._lookMat.lookAt(pos, this._lookTarget, this._upAxis);
    this._poseQ.setFromRotationMatrix(this._lookMat);

    // Apply aerodynamic banking roll and optional Cobra pitch-up
    this._rollQ.setFromAxisAngle(this._rollAxis, bankRad);
    this._poseQ.multiply(this._rollQ);
    if (Math.abs(extraPitchRad) > 0.001) {
      this._pitchQ.setFromAxisAngle(this._pitchAxis, extraPitchRad);
      this._poseQ.multiply(this._pitchQ);
    }
    this.group.quaternion.copy(this._poseQ);
    this.group.updateMatrixWorld(true);
  }

  public updateVisuals(time: number, tripIntensity: number): void {
    this.group.visible = this.alive;
    if (!this.alive) return;

    const dt =
      this.lastVisualTime >= 0
        ? Math.min(0.05, Math.max(0, time - this.lastVisualTime))
        : 0.016;
    this.lastVisualTime = time;

    // 1. Variable wing sweep & counter-rotating underwing pylons on Hero jet
    if (this.role === 'hero') {
      const sweep = THREE.MathUtils.clamp((this.throttle - 0.6) * 0.42, 0.0, 0.34);
      this.leftWingPivot.rotation.y = sweep;
      this.rightWingPivot.rotation.y = -sweep;
      for (let i = 0; i < this.counterPylonPivots.length; i++) {
        // Keep underwing AMRAAM missiles aligned straight into the airstream
        this.counterPylonPivots[i].rotation.y = this.counterPylonSigns[i] * sweep;
      }
    }

    // 2. Articulated aerodynamic control surfaces (ailerons, stabilators, stealth canards)
    const gNorm = THREE.MathUtils.clamp((this.gForce - 1.0) / 7.5, 0, 1);
    const rollTrim = Math.sin(time * 2.4) * 0.08;
    const flapBias = gNorm * 0.16;
    this.leftAileronPivot.rotation.x = flapBias + rollTrim;
    this.rightAileronPivot.rotation.x = flapBias - rollTrim;

    if (this.leftStabPivot && this.rightStabPivot) {
      const pitchDeflect = -0.04 - gNorm * 0.24;
      this.leftStabPivot.rotation.x = pitchDeflect + rollTrim * 0.5;
      this.rightStabPivot.rotation.x = pitchDeflect - rollTrim * 0.5;
    }

    if (this.leftCanardPivot && this.rightCanardPivot) {
      const canardPitch = 0.05 + gNorm * 0.28 + Math.sin(time * 3.1) * 0.04;
      this.leftCanardPivot.rotation.x = canardPitch;
      this.rightCanardPivot.rotation.x = canardPitch;
    }

    // 3. High-RPM spinning 3D titanium compressor fan rotors inside S-duct intakes
    this.fanPhase += dt * (22 + this.throttle * 34);
    for (let i = 0; i < this.fanRotors.length; i++) {
      this.fanRotors[i].rotation.z = i === 0 ? this.fanPhase : -this.fanPhase;
    }

    // 4. Segmented turkey-feather nozzle constriction/dilation & hot ceramic glow
    // Higher throttle opens the convergent-divergent petals wider
    const petalPitch = THREE.MathUtils.clamp(0.16 - this.throttle * 0.14, -0.02, 0.16);
    for (let i = 0; i < this.nozzlePetalPivots.length; i++) {
      this.nozzlePetalPivots[i].rotation.x = petalPitch;
    }
    this.hotLinerMat.emissiveIntensity = 0.9 + this.throttle * 2.4 + Math.sin(time * 52) * 0.15;

    // 5. Dynamic Mach-diamond afterburner plumes
    const plumeScaleZ = 0.55 + this.throttle * 0.95 + Math.sin(time * 48) * 0.06;
    for (let i = 0; i < this.afterburnerMats.length; i++) {
      const m = this.afterburnerMats[i];
      m.uniforms.uTime.value = time;
      m.uniforms.uThrottle.value = this.throttle;
      m.uniforms.uTrip.value = tripIntensity;
      this.afterburnerMeshes[i].scale.set(1, 1, plumeScaleZ);
    }

    this.afterburnerLight.intensity =
      (this.role === 'hero' ? 32 : this.role === 'ace' ? 36 : 10) *
      (0.75 + 0.25 * Math.sin(time * 62)) *
      this.throttle;

    // 6. Supersonic Prandtl-Glauert vapour cone
    this.vaporMat.uniforms.uTime.value = time;
    this.vaporMat.uniforms.uIntensity.value = this.vaporIntensity;
    this.vaporMat.uniforms.uTrip.value = tripIntensity;
    this.vaporMesh.visible = this.vaporIntensity > 0.02;
    const coneScale = 0.85 + this.vaporIntensity * 0.45;
    this.vaporMesh.scale.set(coneScale, coneScale, 0.9 + this.vaporIntensity * 0.35);

    // 7. Oil-slick psychedelic hull iridescence ramp (in-place tuple mutation, zero allocation)
    this.hullMat.iridescence = THREE.MathUtils.clamp(
      (this.role === 'ace' ? 0.35 : 0.14) + tripIntensity * 0.88,
      0,
      1,
    );
    this.iridescenceRange[0] = 160 + tripIntensity * 180;
    this.iridescenceRange[1] = 460 + tripIntensity * 420;

    // 8. Wingtip navigation strobe blink
    const strobeOn = Math.sin(time * 12 + (this.role === 'hero' ? 0 : 2.1)) > 0.65;
    for (let i = 0; i < this.strobeMeshes.length; i++) {
      this.strobeMeshes[i].visible = strobeOn;
    }
  }

  public getWorldWingtips(leftOut: THREE.Vector3, rightOut: THREE.Vector3): void {
    this.wingtipLeft.getWorldPosition(leftOut);
    this.wingtipRight.getWorldPosition(rightOut);
  }
}
