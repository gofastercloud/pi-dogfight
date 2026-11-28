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
  MergeGeometryEntry,
  mergeSubGeometries,
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
    float fadeNozzle = 1.0 - smoothstep(0.92, 1.0, along);
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
    float edgeFade = smoothstep(0.0, 0.28, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));

    vec3 baseCol = vec3(0.95, 0.97, 1.0);
    vec3 prism = rainbow(vUv.x * 1.5 + vUv.y * 0.7 - uTime * 0.6);
    vec3 col = mix(baseCol, prism * 1.45, clamp(0.18 + uTrip * 0.82, 0.0, 1.0));

    float alpha = edgeFade * (0.22 + rim * 0.85) * streak * uIntensity;
    gl_FragColor = vec4(col * (1.0 + uTrip * 0.6), clamp(alpha, 0.0, 0.92));
  }
`;

// Schlick Fresnel canopy glass shader chunks (zero transmissionRenderTarget second pass)
const CANOPY_FRESNEL_PARS = /* glsl */ `
  uniform vec3 uCanopyFresnelColor;
  uniform float uCanopyF0;
  uniform float uCanopyBaseAlpha;
  uniform float uCanopyEdgeAlpha;
`;

const CANOPY_FRESNEL_FRAG = /* glsl */ `
  float canopyNdotV = clamp(abs(dot(geometryNormal, geometryViewDir)), 0.0, 1.0);
  float canopyFresnel = uCanopyF0 + (1.0 - uCanopyF0) * pow(max(1.0 - canopyNdotV, 1e-4), 5.0);
  outgoingLight += uCanopyFresnelColor * canopyFresnel * 0.45;
  diffuseColor.a = mix(uCanopyBaseAlpha, uCanopyEdgeAlpha, clamp(canopyFresnel, 0.0, 1.0));
`;

// GPU aeroelastic 9G cantilever wing flex + transonic buffet vibration shader chunks
const AERO_WING_PARS = /* glsl */ `
  uniform float uWingFlex;
  uniform float uBuffetAmp;
  uniform float uAeroTime;
  uniform float uWingRootX;
  uniform float uWingSpan;
`;

const AERO_WING_NORMAL = /* glsl */ `
  float aeroSpanN = clamp((abs(position.x) - uWingRootX) / max(uWingSpan, 1e-4), 0.0, 1.0);
  float aeroSlope = sign(position.x) * (uWingFlex / max(uWingSpan, 1e-4)) * (2.5 * aeroSpanN - 0.75 * aeroSpanN * aeroSpanN);
  float aeroCos = cos(aeroSlope);
  float aeroSin = sin(aeroSlope);
  objectNormal.xy = vec2(
    objectNormal.x * aeroCos - objectNormal.y * aeroSin,
    objectNormal.x * aeroSin + objectNormal.y * aeroCos
  );
`;

const AERO_WING_VERTEX = /* glsl */ `
  float aeroSpan = clamp((abs(position.x) - uWingRootX) / max(uWingSpan, 1e-4), 0.0, 1.0);
  float aeroBendShape = aeroSpan * aeroSpan * (1.25 - 0.25 * aeroSpan);
  float aeroBendY = uWingFlex * aeroBendShape;
  float aeroBuffetWave =
    sin(uAeroTime * 48.0 + abs(position.x) * 2.2) * 0.65 +
    sin(uAeroTime * 73.0 + position.z * 3.1 - abs(position.x) * 1.4) * 0.35;
  float aeroBuffetY = uBuffetAmp * aeroSpan * aeroSpan * aeroBuffetWave;
  transformed.y += aeroBendY + aeroBuffetY;
  transformed.x -= sign(position.x) * aeroBendY * aeroBendY * 0.08;
`;

// ---------------------------------------------------------------------------
// SHARED COMPONENT GEOMETRIES (CONSOLIDATED & CACHED ONCE ACROSS ALL JETS)
// ---------------------------------------------------------------------------

interface SharedParts {
  fanBladesGeo: THREE.BufferGeometry;
  spinnerGeo: THREE.BufferGeometry;
  nozzlePetalRingGeo: THREE.BufferGeometry;
  nozzleInnerLinerGeo: THREE.BufferGeometry;
  burnerCoreGeo: THREE.BufferGeometry;
  plumeGeo: THREE.BufferGeometry;
  vaporConeGeo: THREE.BufferGeometry;
  strobeGeo: THREE.BufferGeometry;
  pylonAmraamDarkGeo: THREE.BufferGeometry;
  amraamBodyGeo: THREE.BufferGeometry;
  sidewinderDarkLeftGeo: THREE.BufferGeometry;
  sidewinderDarkRightGeo: THREE.BufferGeometry;
  sidewinderBodyLeftGeo: THREE.BufferGeometry;
  sidewinderBodyRightGeo: THREE.BufferGeometry;
  mfdScreensGeo: THREE.BufferGeometry;
  seatRailsGeo: THREE.BufferGeometry;
  hudGlassGeo: THREE.BufferGeometry;
  helmetGeo: THREE.BufferGeometry;
  visorGeo: THREE.BufferGeometry;
}

let sharedParts: SharedParts | null = null;

function buildSidewinderDarkGeo(side: -1 | 1): THREE.BufferGeometry {
  const tipRailGeo = new THREE.BoxGeometry(0.11, 0.09, 1.85);
  const seekerGeo = new THREE.SphereGeometry(0.068, 12, 8);
  seekerGeo.scale(1, 1, 1.55);
  const finGeo = new THREE.BoxGeometry(0.28, 0.014, 0.26);

  const sx = side * 0.09;
  const sy = -0.04;
  const sz = -0.15;

  const entries: MergeGeometryEntry[] = [
    { geometry: tipRailGeo, disposeSource: true },
    { geometry: seekerGeo, position: [sx, sy, sz - 1.24], disposeSource: true },
  ];

  for (const zPos of [-0.88, 1.02]) {
    entries.push({ geometry: finGeo, position: [sx, sy, sz + zPos] });
    entries.push({ geometry: finGeo, position: [sx, sy, sz + zPos], rotation: [0, 0, Math.PI / 2] });
  }

  const merged = mergeSubGeometries(entries);
  finGeo.dispose();
  return merged;
}

function buildSidewinderBodyGeo(side: -1 | 1): THREE.BufferGeometry {
  const bodyGeo = new THREE.CylinderGeometry(0.068, 0.068, 2.45, 12);
  bodyGeo.rotateX(Math.PI / 2);
  bodyGeo.translate(side * 0.09, -0.04, -0.15);
  bodyGeo.computeBoundingBox();
  bodyGeo.computeBoundingSphere();
  return bodyGeo;
}

function getSharedParts(): SharedParts {
  if (sharedParts) return sharedParts;

  // 16-blade titanium compressor fan rotor merged into a single GPU geometry
  const singleBladeGeo = new THREE.BoxGeometry(0.095, 0.44, 0.022);
  singleBladeGeo.translate(0, 0.24, 0);
  const bladeCount = 16;
  const bladeEntries: MergeGeometryEntry[] = [];
  for (let b = 0; b < bladeCount; b++) {
    const theta = (b / bladeCount) * Math.PI * 2;
    bladeEntries.push({
      geometry: singleBladeGeo,
      rotation: [0, 0.52, theta],
      rotationOrder: 'ZYX',
    });
  }
  const fanBladesGeo = mergeSubGeometries(bladeEntries);
  singleBladeGeo.dispose();

  const spinnerGeo = new THREE.ConeGeometry(0.14, 0.38, 12);
  spinnerGeo.rotateX(-Math.PI / 2);
  spinnerGeo.translate(0, 0, -0.14);
  spinnerGeo.computeBoundingSphere();

  // 14 overlapping turkey-feather titanium nozzle petals merged into 1 ring geometry
  const singlePetalGeo = buildNozzlePetalGeometry({
    length: 1.18,
    rootWidth: 0.31,
    tipWidth: 0.21,
    thickness: 0.055,
    arch: 0.032,
  });
  const petalCount = 14;
  const petalRadius = 0.65;
  const petalEntries: MergeGeometryEntry[] = [];
  for (let p = 0; p < petalCount; p++) {
    const theta = (p / petalCount) * Math.PI * 2;
    const r = petalRadius + (p % 2 === 0 ? 0.015 : -0.015);
    petalEntries.push({
      geometry: singlePetalGeo,
      position: [-Math.sin(theta) * r, Math.cos(theta) * r, 0],
      rotation: [0.04, 0, theta],
      rotationOrder: 'ZYX',
    });
  }
  const nozzlePetalRingGeo = mergeSubGeometries(petalEntries);
  singlePetalGeo.dispose();

  const nozzleInnerLinerGeo = new THREE.CylinderGeometry(0.55, 0.59, 1.12, 18, 1, true);
  nozzleInnerLinerGeo.rotateX(Math.PI / 2);
  nozzleInnerLinerGeo.translate(0, 0, 0.44);
  nozzleInnerLinerGeo.computeBoundingSphere();

  const burnerCoreGeo = new THREE.CircleGeometry(0.53, 18);
  burnerCoreGeo.translate(0, 0, 0.90);
  burnerCoreGeo.computeBoundingSphere();

  const plumeGeo = new THREE.ConeGeometry(0.66, 7.8, 20, 18, true);
  plumeGeo.translate(0, 3.9, 0);
  plumeGeo.rotateX(Math.PI / 2);
  plumeGeo.computeBoundingSphere();

  const vaporConeGeo = new THREE.ConeGeometry(5.6, 6.4, 36, 1, true);
  vaporConeGeo.rotateX(-Math.PI / 2);
  vaporConeGeo.computeBoundingSphere();

  const strobeGeo = new THREE.SphereGeometry(0.11, 8, 8);

  // Underwing swept airfoil pylon + launch rail + AMRAAM dark nose & fins consolidated
  const pylonGeo = buildAirfoilWingGeometry({
    side: 1,
    chordSegments: 6,
    bevelFactor: 0.7,
    stations: [
      { span: 0, chord: 1.85, sweepZ: -0.95, dihedralY: 0, thicknessRatio: 0.075, camber: 0 },
      { span: 0.52, chord: 1.45, sweepZ: -0.62, dihedralY: 0, thicknessRatio: 0.065, camber: 0 },
    ],
  });
  pylonGeo.rotateZ(-Math.PI / 2);

  const railBarGeo = new THREE.BoxGeometry(0.10, 0.06, 1.95);
  const amraamNoseGeo = new THREE.ConeGeometry(0.088, 0.62, 12);
  amraamNoseGeo.rotateX(-Math.PI / 2);
  const amraamFinGeo = new THREE.BoxGeometry(0.38, 0.018, 0.34);

  const pylonEntries: MergeGeometryEntry[] = [
    { geometry: pylonGeo, disposeSource: true },
    { geometry: railBarGeo, position: [0, -0.52, 0.05], disposeSource: true },
    { geometry: amraamNoseGeo, position: [0, -0.62, -1.78], disposeSource: true },
  ];
  for (const zPos of [0.05, 1.24]) {
    pylonEntries.push({ geometry: amraamFinGeo, position: [0, -0.62, zPos] });
    pylonEntries.push({
      geometry: amraamFinGeo,
      position: [0, -0.62, zPos],
      rotation: [0, 0, Math.PI / 2],
    });
  }
  const pylonAmraamDarkGeo = mergeSubGeometries(pylonEntries);
  amraamFinGeo.dispose();

  const amraamBodyGeo = new THREE.CylinderGeometry(0.088, 0.088, 2.95, 12);
  amraamBodyGeo.rotateX(Math.PI / 2);
  amraamBodyGeo.translate(0, -0.62, 0);
  amraamBodyGeo.computeBoundingSphere();

  const sidewinderDarkLeftGeo = buildSidewinderDarkGeo(-1);
  const sidewinderDarkRightGeo = buildSidewinderDarkGeo(1);
  const sidewinderBodyLeftGeo = buildSidewinderBodyGeo(-1);
  const sidewinderBodyRightGeo = buildSidewinderBodyGeo(1);

  // Backlit cockpit MFDs merged into 1 geometry
  const singleMfdGeo = new THREE.PlaneGeometry(0.20, 0.16);
  const mfdOffsets: readonly [number, number, number, number][] = [
    [-0.23, 0.75, -3.98, 0.18],
    [0.0, 0.73, -4.00, 0.0],
    [0.23, 0.75, -3.98, -0.18],
  ];
  const mfdEntries: MergeGeometryEntry[] = mfdOffsets.map(([mx, my, mz, ry]) => ({
    geometry: singleMfdGeo,
    position: [mx, my, mz],
    rotation: [-0.32, ry, 0],
  }));
  const mfdScreensGeo = mergeSubGeometries(mfdEntries);
  singleMfdGeo.dispose();

  // ACES-II twin metallic ejection seat rails merged into 1 geometry
  const singleRailGeo = new THREE.BoxGeometry(0.045, 0.88, 0.055);
  const seatRailsGeo = mergeSubGeometries([
    { geometry: singleRailGeo, position: [-0.26, 0.88, -2.56], rotation: [-0.24, 0, 0] },
    { geometry: singleRailGeo, position: [0.26, 0.88, -2.56], rotation: [-0.24, 0, 0] },
  ]);
  singleRailGeo.dispose();

  const hudGlassGeo = new THREE.PlaneGeometry(0.38, 0.24);
  hudGlassGeo.rotateX(-0.38);
  hudGlassGeo.translate(0, 0.94, -3.97);
  hudGlassGeo.computeBoundingSphere();

  const helmetGeo = new THREE.SphereGeometry(0.22, 16, 12);
  helmetGeo.translate(0, 1.04, -3.08);
  helmetGeo.computeBoundingSphere();

  const visorGeo = new THREE.SphereGeometry(
    0.228,
    14,
    10,
    -Math.PI * 0.36,
    Math.PI * 0.72,
    Math.PI * 0.26,
    Math.PI * 0.36,
  );
  visorGeo.rotateY(-Math.PI / 2);
  visorGeo.translate(0, 1.04, -3.08);
  visorGeo.computeBoundingSphere();

  sharedParts = {
    fanBladesGeo,
    spinnerGeo,
    nozzlePetalRingGeo,
    nozzleInnerLinerGeo,
    burnerCoreGeo,
    plumeGeo,
    vaporConeGeo,
    strobeGeo,
    pylonAmraamDarkGeo,
    amraamBodyGeo,
    sidewinderDarkLeftGeo,
    sidewinderDarkRightGeo,
    sidewinderBodyLeftGeo,
    sidewinderBodyRightGeo,
    mfdScreensGeo,
    seatRailsGeo,
    hudGlassGeo,
    helmetGeo,
    visorGeo,
  };
  return sharedParts;
}

// ---------------------------------------------------------------------------
// SHARED CACHED MATERIALS (PER ROLE + GLOBALLY SHARED COMMON MATERIALS)
// ---------------------------------------------------------------------------

interface CommonMaterialSet {
  intakeInnerMat: THREE.MeshStandardMaterial;
  railMat: THREE.MeshStandardMaterial;
  strobePortMat: THREE.MeshBasicMaterial;
  strobeStbdMat: THREE.MeshBasicMaterial;
}

interface RoleMaterialSet {
  hullMat: THREE.MeshPhysicalMaterial;
  darkMat: THREE.MeshPhysicalMaterial;
  intakeInnerMat: THREE.MeshStandardMaterial;
  fanBladeMat: THREE.MeshPhysicalMaterial;
  ordnanceMat: THREE.MeshPhysicalMaterial;
  canopyMat: THREE.MeshPhysicalMaterial;
  glowMat: THREE.MeshStandardMaterial;
  hotLinerMat: THREE.MeshStandardMaterial;
  mfdMat: THREE.MeshStandardMaterial;
  railMat: THREE.MeshStandardMaterial;
  hudGlassMat: THREE.MeshBasicMaterial;
  helmetMat: THREE.MeshPhysicalMaterial;
  visorMat: THREE.MeshPhysicalMaterial;
  burnerCoreMat: THREE.MeshBasicMaterial;
  strobePortMat: THREE.MeshBasicMaterial;
  strobeStbdMat: THREE.MeshBasicMaterial;
  iridescenceRange: [number, number];
  coreColor: THREE.Color;
  outerColor: THREE.Color;
}

interface WingAeroUniforms {
  uWingFlex: { value: number };
  uBuffetAmp: { value: number };
  uAeroTime: { value: number };
  uWingRootX: { value: number };
  uWingSpan: { value: number };
}

const ZERO_AERO_UNIFORMS: WingAeroUniforms = {
  uWingFlex: { value: 0 },
  uBuffetAmp: { value: 0 },
  uAeroTime: { value: 0 },
  uWingRootX: { value: 999 },
  uWingSpan: { value: 1 },
};

function attachAeroWingShaderHook(
  material: THREE.MeshPhysicalMaterial,
  uniforms: WingAeroUniforms,
): void {
  material.customProgramCacheKey = () => 'fighter-aero-wing-v1';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWingFlex = uniforms.uWingFlex;
    shader.uniforms.uBuffetAmp = uniforms.uBuffetAmp;
    shader.uniforms.uAeroTime = uniforms.uAeroTime;
    shader.uniforms.uWingRootX = uniforms.uWingRootX;
    shader.uniforms.uWingSpan = uniforms.uWingSpan;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${AERO_WING_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${AERO_WING_NORMAL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${AERO_WING_VERTEX}`);
  };
}

let commonMaterials: CommonMaterialSet | null = null;
const roleMaterialCache: Partial<Record<FighterRole, RoleMaterialSet>> = {};

function getCommonMaterials(): CommonMaterialSet {
  if (commonMaterials) return commonMaterials;
  commonMaterials = {
    intakeInnerMat: new THREE.MeshStandardMaterial({
      color: 0x0b0d12,
      roughness: 0.76,
      metalness: 0.35,
    }),
    railMat: new THREE.MeshStandardMaterial({
      color: 0xb8c4d0,
      roughness: 0.28,
      metalness: 0.92,
    }),
    strobePortMat: new THREE.MeshBasicMaterial({ color: 0xff2244 }),
    strobeStbdMat: new THREE.MeshBasicMaterial({ color: 0x22ff88 }),
  };
  return commonMaterials;
}

function getRoleMaterialSet(role: FighterRole): RoleMaterialSet {
  const cached = roleMaterialCache[role];
  if (cached) return cached;

  const common = getCommonMaterials();
  const texSet = createHullTextureSet(role);
  const isHero = role === 'hero';
  const isAce = role === 'ace';
  const iridescenceRange: [number, number] = [160, 460];

  const hullMat = new THREE.MeshPhysicalMaterial({
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
    iridescenceThicknessRange: iridescenceRange,
  });
  // Share compiled WebGLProgram with aeroelastic wing material (zero flex on hull)
  attachAeroWingShaderHook(hullMat, ZERO_AERO_UNIFORMS);

  const darkMat = new THREE.MeshPhysicalMaterial({
    color: isHero ? 0x202632 : 0x0d0e14,
    roughness: 0.38,
    metalness: 0.9,
    clearcoat: 0.28,
    clearcoatRoughness: 0.28,
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

  // Physically based Schlick Fresnel + PMREM iridescent gold/crimson glass canopy
  // Explicitly transmission: 0 so Three.js executes zero transmissionRenderTarget second passes
  const canopyFresnelColor = new THREE.Color(
    isHero ? 0xffd478 : isAce ? 0xff2658 : 0xff6238,
  );
  const canopyF0 = isHero ? 0.08 : 0.11;
  const canopyBaseAlpha = isHero ? 0.34 : 0.40;
  const canopyEdgeAlpha = isHero ? 0.90 : 0.92;

  const canopyMat = new THREE.MeshPhysicalMaterial({
    color: isHero ? 0xffc85e : isAce ? 0xff1e4a : 0xff4e2c,
    roughness: 0.045,
    metalness: 0.14,
    transmission: 0,
    ior: 1.52,
    reflectivity: 1.0,
    iridescence: 1.0,
    iridescenceIOR: 1.48,
    iridescenceThicknessRange: [220, 680],
    clearcoat: 1.0,
    clearcoatRoughness: 0.025,
    envMapIntensity: isHero ? 2.45 : isAce ? 2.6 : 2.25,
    transparent: true,
    opacity: canopyBaseAlpha,
    depthWrite: false,
  });
  canopyMat.customProgramCacheKey = () => 'fighter-canopy-schlick-fresnel-v1';
  canopyMat.onBeforeCompile = (shader) => {
    shader.uniforms.uCanopyFresnelColor = { value: canopyFresnelColor };
    shader.uniforms.uCanopyF0 = { value: canopyF0 };
    shader.uniforms.uCanopyBaseAlpha = { value: canopyBaseAlpha };
    shader.uniforms.uCanopyEdgeAlpha = { value: canopyEdgeAlpha };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CANOPY_FRESNEL_PARS}`)
      .replace('#include <opaque_fragment>', `${CANOPY_FRESNEL_FRAG}\n#include <opaque_fragment>`);
  };

  const glowMat = new THREE.MeshStandardMaterial({
    color: isHero ? 0x72f8dc : 0xff2848,
    emissive: isHero ? 0x4ae8c4 : 0xff183a,
    emissiveIntensity: isHero ? 1.15 : isAce ? 3.6 : 2.3,
    roughness: 0.18,
    metalness: 0.15,
  });

  const hotLinerMat = new THREE.MeshStandardMaterial({
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

  const hudGlassMat = new THREE.MeshBasicMaterial({
    color: isHero ? 0x44ffaa : 0xff3b58,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const helmetMat = new THREE.MeshPhysicalMaterial({
    color: isHero ? 0xeef3fa : 0x16171f,
    roughness: 0.14,
    metalness: 0.72,
    clearcoat: 1.0,
  });

  const visorMat = new THREE.MeshPhysicalMaterial({
    color: isHero ? 0xffb833 : isAce ? 0xff2244 : 0xff6633,
    metalness: 0.96,
    roughness: 0.06,
    iridescence: 1.0,
    clearcoat: 1.0,
  });

  const burnerCoreMat = new THREE.MeshBasicMaterial({
    color: isHero ? 0x99f2ff : isAce ? 0xff4488 : 0xff6644,
  });

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

  const set: RoleMaterialSet = {
    hullMat,
    darkMat,
    intakeInnerMat: common.intakeInnerMat,
    fanBladeMat,
    ordnanceMat,
    canopyMat,
    glowMat,
    hotLinerMat,
    mfdMat,
    railMat: common.railMat,
    hudGlassMat,
    helmetMat,
    visorMat,
    burnerCoreMat,
    strobePortMat: common.strobePortMat,
    strobeStbdMat: common.strobeStbdMat,
    iridescenceRange,
    coreColor,
    outerColor,
  };
  roleMaterialCache[role] = set;
  return set;
}

/**
 * Builds an aeroelastic wing hull material sharing the cached 2K PBR texture set
 * and single compiled WebGL program (`fighter-aero-wing-v1`), while maintaining
 * independent per-aircraft flex and transonic buffet uniforms.
 */
function createAeroWingHullMaterial(
  role: FighterRole,
  roleMats: RoleMaterialSet,
  wingRootX: number,
  wingSpan: number,
): { material: THREE.MeshPhysicalMaterial; uniforms: WingAeroUniforms } {
  const texSet = createHullTextureSet(role);
  const isHero = role === 'hero';
  const isAce = role === 'ace';

  const uniforms: WingAeroUniforms = {
    uWingFlex: { value: 0 },
    uBuffetAmp: { value: 0 },
    uAeroTime: { value: 0 },
    uWingRootX: { value: wingRootX },
    uWingSpan: { value: wingSpan },
  };

  const material = new THREE.MeshPhysicalMaterial({
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
    iridescenceThicknessRange: roleMats.iridescenceRange,
  });

  attachAeroWingShaderHook(material, uniforms);

  return { material, uniforms };
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
// CONSOLIDATED ROLE GEOMETRY CACHE (ONE SET PER ROLE SHARED ACROSS WINGMEN)
// ---------------------------------------------------------------------------

interface RoleGeometrySet {
  staticHullGeo: THREE.BufferGeometry;
  staticDarkGeo: THREE.BufferGeometry;
  staticIntakeInnerGeo: THREE.BufferGeometry;
  staticGlowGeo: THREE.BufferGeometry;
  staticOrdnanceGeo: THREE.BufferGeometry | null;
  canopyGeo: THREE.BufferGeometry;
  leftWingGeo: THREE.BufferGeometry | null;
  rightWingGeo: THREE.BufferGeometry | null;
  mergedWingsGeo: THREE.BufferGeometry | null;
  heroLeftStripGeo: THREE.BufferGeometry | null;
  heroRightStripGeo: THREE.BufferGeometry | null;
  leftAileronGeo: THREE.BufferGeometry;
  rightAileronGeo: THREE.BufferGeometry;
  leftStabGeo: THREE.BufferGeometry;
  rightStabGeo: THREE.BufferGeometry;
  rudderGeo: THREE.BufferGeometry;
  leftCanardGeo: THREE.BufferGeometry | null;
  rightCanardGeo: THREE.BufferGeometry | null;
  leftCanardTrimGeo: THREE.BufferGeometry | null;
  rightCanardTrimGeo: THREE.BufferGeometry | null;
}

const roleGeometryCache: Partial<Record<FighterRole, RoleGeometrySet>> = {};

function getRoleGeometrySet(role: FighterRole): RoleGeometrySet {
  const cached = roleGeometryCache[role];
  if (cached) return cached;

  const parts = getSharedParts();
  const isHero = role === 'hero';
  const isAce = role === 'ace';

  const hullEntries: MergeGeometryEntry[] = [];
  const darkEntries: MergeGeometryEntry[] = [];
  const intakeInnerEntries: MergeGeometryEntry[] = [];
  const glowEntries: MergeGeometryEntry[] = [];
  const ordnanceEntries: MergeGeometryEntry[] = [];

  // 1. Fuselage loft
  hullEntries.push({
    geometry: isHero ? buildHeroFuselageGeometry() : buildStealthBanditFuselageGeometry(isAce),
    disposeSource: true,
  });

  // Nose pitot boom
  const noseTipZ = isHero ? -9.55 : -10.25;
  darkEntries.push({
    geometry: new THREE.CylinderGeometry(0.015, 0.042, 1.35, 10),
    position: [0, -0.02, noseTipZ - 0.65],
    rotation: [Math.PI / 2, 0, 0],
    disposeSource: true,
  });

  let chineSeamGeo: THREE.BoxGeometry | null = null;
  let dorsalTraceGeo: THREE.BoxGeometry | null = null;
  let aceBladeGeo: THREE.BoxGeometry | null = null;

  if (isHero) {
    // Starboard M61A2 Vulcan 20mm flush gun fairing
    darkEntries.push({
      geometry: new THREE.CylinderGeometry(0.11, 0.14, 1.75, 10),
      position: [0.84, -0.18, -5.45],
      rotation: [Math.PI / 2, 0, 0],
      disposeSource: true,
    });
  } else {
    // Glowing stealth dorsal & chine seam accents on WRAITH / CRIMSON-1
    chineSeamGeo = new THREE.BoxGeometry(0.055, 0.04, 6.2);
    dorsalTraceGeo = new THREE.BoxGeometry(0.045, 0.035, 5.4);
    for (const side of [-1, 1] as const) {
      glowEntries.push({
        geometry: chineSeamGeo,
        position: [side * 1.44, 0.08, -3.55],
        rotation: [0, side * 0.14, 0],
      });
      glowEntries.push({
        geometry: dorsalTraceGeo,
        position: [side * 0.42, 0.72 + (isAce ? 0.11 : 0), 0.75],
      });
    }

    if (isAce) {
      aceBladeGeo = new THREE.BoxGeometry(0.04, 0.48, 1.1);
      for (const side of [-1, 1] as const) {
        darkEntries.push({
          geometry: aceBladeGeo,
          position: [side * 0.28, 1.06, 0.6],
          rotation: [-0.35, 0, side * -0.18],
        });
      }
    }
  }

  // 2. Curved S-duct stealth intakes (outer cowl -> hull, inner throat -> intakeInner, splitter -> dark)
  const splitterGeo = new THREE.BoxGeometry(0.06, 0.72, 1.35);
  const throatAccentGeo = new THREE.BoxGeometry(
    isHero ? 0.62 : 0.74,
    isHero ? 0.045 : 0.085,
    0.05,
  );
  const lipGlowGeo = isHero ? null : new THREE.BoxGeometry(0.76, 0.055, 0.08);

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
    hullEntries.push({ geometry: outer, disposeSource: true });
    intakeInnerEntries.push({ geometry: inner, disposeSource: true });

    darkEntries.push({
      geometry: splitterGeo,
      position: [side * 1.04, -0.12, -2.55],
      rotation: [0, 0, side * -0.18],
    });

    glowEntries.push({
      geometry: throatAccentGeo,
      position: [
        side * (isHero ? 1.54 : 1.46),
        isHero ? -0.44 : -0.42,
        isHero ? -2.68 : -2.52,
      ],
      rotation: [0, 0, side * (isHero ? -0.2 : -0.3)],
    });

    if (lipGlowGeo) {
      glowEntries.push({
        geometry: lipGlowGeo,
        position: [side * 1.48, 0.16, -2.92],
        rotation: [0, 0, side * -0.32],
      });
    }
  }

  // 3. Static dark cockpit structure consolidated into staticDarkGeo
  darkEntries.push({
    geometry: new THREE.BoxGeometry(0.98, 0.42, 2.85),
    position: [0, 0.48, -3.35],
    disposeSource: true,
  });
  darkEntries.push({
    geometry: new THREE.BoxGeometry(0.80, 0.14, 0.62),
    position: [0, 0.77, -4.16],
    rotation: [0.22, 0, 0],
    disposeSource: true,
  });

  const bezelGeo = new THREE.BoxGeometry(0.23, 0.19, 0.04);
  const mfdOffsets: readonly [number, number, number, number][] = [
    [-0.23, 0.75, -3.98, 0.18],
    [0.0, 0.73, -4.00, 0.0],
    [0.23, 0.75, -3.98, -0.18],
  ];
  for (let i = 0; i < mfdOffsets.length; i++) {
    const [mx, my, mz, ry] = mfdOffsets[i];
    darkEntries.push({
      geometry: bezelGeo,
      position: [mx, my, mz - 0.025],
      rotation: [-0.32, ry, 0],
    });
  }

  const hudPostGeo = new THREE.BoxGeometry(0.026, 0.26, 0.03);
  for (const side of [-1, 1] as const) {
    darkEntries.push({
      geometry: hudPostGeo,
      position: [side * 0.20, 0.94, -3.98],
      rotation: [-0.38, 0, 0],
    });
  }
  darkEntries.push({
    geometry: new THREE.BoxGeometry(0.43, 0.024, 0.03),
    position: [0, 1.06, -3.93],
    disposeSource: true,
  });
  darkEntries.push({
    geometry: new THREE.BoxGeometry(0.50, 0.72, 0.18),
    position: [0, 0.86, -2.66],
    rotation: [-0.24, 0, 0],
    disposeSource: true,
  });
  darkEntries.push({
    geometry: new THREE.BoxGeometry(0.34, 0.22, 0.20),
    position: [0, 1.24, -2.58],
    rotation: [-0.18, 0, 0],
    disposeSource: true,
  });
  darkEntries.push({
    geometry: new THREE.BoxGeometry(0.46, 0.26, 0.28),
    position: [0, 0.76, -3.02],
    disposeSource: true,
  });
  darkEntries.push({
    geometry: new THREE.TorusGeometry(0.62, 0.036, 8, 18, Math.PI),
    position: [0, 0.68, -3.76],
    rotation: [0.28, 0, 0],
    scale: [1.02, 1.12, 1.0],
    disposeSource: true,
  });

  // 4. Fixed wing-glove strakes (LERX) consolidated into staticHullGeo
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
    hullEntries.push({
      geometry: lerxGeo,
      position: [side * 0.92, 0.08, 0.0],
      disposeSource: true,
    });
  }

  // 5. Fixed canted vertical stabilisers / V-tails (with trailing-edge cut-out for articulated rudders)
  const finLightGeo = new THREE.BoxGeometry(0.06, 0.38, 0.14);
  const vStrakeGeo = isHero ? new THREE.BoxGeometry(0.06, 0.44, 2.25) : null;
  for (const side of [-1, 1] as const) {
    const finGeo = buildAirfoilWingGeometry({
      side: 1,
      chordSegments: 10,
      bevelFactor: 0.64,
      stations: isHero
        ? [
            { span: 0.0, chord: 2.40, sweepZ: -0.25, dihedralY: 0, thicknessRatio: 0.062, camber: 0 },
            { span: 1.45, chord: 1.62, sweepZ: 0.78, dihedralY: 0, thicknessRatio: 0.052, camber: 0 },
            { span: 2.75, chord: 0.90, sweepZ: 1.72, dihedralY: 0, thicknessRatio: 0.044, camber: 0 },
          ]
        : [
            { span: 0.0, chord: 2.65, sweepZ: -0.35, dihedralY: 0, thicknessRatio: 0.058, camber: 0 },
            { span: 1.65, chord: 1.58, sweepZ: 0.95, dihedralY: 0, thicknessRatio: 0.048, camber: 0 },
            { span: 3.15, chord: 0.62, sweepZ: 2.12, dihedralY: 0, thicknessRatio: 0.042, camber: 0 },
          ],
    });
    finGeo.rotateZ(Math.PI / 2); // Span +X -> +Y
    hullEntries.push({
      geometry: finGeo,
      position: [side * (isHero ? 1.44 : 1.38), 0.38, isHero ? 2.85 : 3.05],
      rotation: [0, 0, side * (isHero ? -0.34 : -0.64)],
      disposeSource: true,
    });

    glowEntries.push({
      geometry: finLightGeo,
      position: [
        side * (isHero ? 2.26 : 2.98),
        isHero ? 2.72 : 2.52,
        isHero ? 4.92 : 5.38,
      ],
      rotation: [0, 0, side * (isHero ? -0.34 : -0.64)],
    });

    if (vStrakeGeo) {
      darkEntries.push({
        geometry: vStrakeGeo,
        position: [side * 1.34, -0.52, 3.85],
        rotation: [0, 0, side * 0.28],
      });
    }
  }

  // 6. Fixed machined titanium nozzle shroud collars consolidated into staticDarkGeo
  const nozzleX = isHero ? 0.94 : 0.96;
  const nozzleZ = isHero ? 5.82 : 6.12;
  const collarGeo = new THREE.CylinderGeometry(0.68, 0.72, 0.48, 20, 1, false);
  for (const side of [-1, 1] as const) {
    darkEntries.push({
      geometry: collarGeo,
      position: [side * nozzleX, -0.02, nozzleZ + 0.16],
      rotation: [Math.PI / 2, 0, 0],
    });
  }

  // 7. Non-hero (bandit/ace) fixed-sweep underwing pylons, AMRAAMs & wing root glow strips
  if (!isHero) {
    const stripGeo = new THREE.BoxGeometry(2.85, 0.032, 0.09);
    for (const side of [-1, 1] as const) {
      // Underwing pylon + AMRAAM at wing-local (side * 2.15, -0.04, -0.65) -> body (side * 3.83, 0.06, -1.00)
      darkEntries.push({
        geometry: parts.pylonAmraamDarkGeo,
        position: [side * 3.83, 0.06, -1.00],
      });
      ordnanceEntries.push({
        geometry: parts.amraamBodyGeo,
        position: [side * 3.83, 0.06, -1.00],
      });
      glowEntries.push({
        geometry: stripGeo,
        position: [side * 3.83, 0.195, -1.17],
        rotation: [0, side * 0.36, 0],
      });
    }
    stripGeo.dispose();
  }

  const staticHullGeo = mergeSubGeometries(hullEntries);
  const staticDarkGeo = mergeSubGeometries(darkEntries);
  const staticIntakeInnerGeo = mergeSubGeometries(intakeInnerEntries);
  const staticGlowGeo = mergeSubGeometries(glowEntries);
  const staticOrdnanceGeo = ordnanceEntries.length > 0 ? mergeSubGeometries(ordnanceEntries) : null;

  // Dispose temporary reusable primitive geometries used in merge batches
  if (chineSeamGeo) chineSeamGeo.dispose();
  if (dorsalTraceGeo) dorsalTraceGeo.dispose();
  if (aceBladeGeo) aceBladeGeo.dispose();
  splitterGeo.dispose();
  throatAccentGeo.dispose();
  if (lipGlowGeo) lipGlowGeo.dispose();
  bezelGeo.dispose();
  hudPostGeo.dispose();
  finLightGeo.dispose();
  if (vStrakeGeo) vStrakeGeo.dispose();
  collarGeo.dispose();

  // 8. Main aeroelastic wings (Hero: separate sweepable port/starboard; Bandit/Ace: merged single mesh)
  const buildWingGeo = (side: -1 | 1): THREE.BufferGeometry =>
    isHero
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
            // Menacing Su-47 forward-swept stealth wing
            { span: 0.0, chord: 4.05, sweepZ: -0.85, dihedralY: 0.0, thicknessRatio: 0.068, camber: 0.010 },
            { span: 1.85, chord: 2.95, sweepZ: -1.62, dihedralY: 0.04, thicknessRatio: 0.058, camber: 0.008 },
            { span: 4.1, chord: 2.02, sweepZ: -2.42, dihedralY: 0.08, thicknessRatio: 0.048, camber: 0.006, twistRad: 0.025 },
            { span: 6.12, chord: 1.18, sweepZ: -2.98, dihedralY: 0.12, thicknessRatio: 0.042, camber: 0.004, twistRad: 0.04 },
          ],
        });

  let leftWingGeo: THREE.BufferGeometry | null = null;
  let rightWingGeo: THREE.BufferGeometry | null = null;
  let mergedWingsGeo: THREE.BufferGeometry | null = null;
  let heroLeftStripGeo: THREE.BufferGeometry | null = null;
  let heroRightStripGeo: THREE.BufferGeometry | null = null;

  if (isHero) {
    leftWingGeo = buildWingGeo(-1);
    rightWingGeo = buildWingGeo(1);

    const buildHeroStrip = (side: -1 | 1): THREE.BufferGeometry => {
      const g = new THREE.BoxGeometry(2.15, 0.032, 0.055);
      g.rotateY(side * -0.54);
      g.translate(side * 2.15, 0.095, 1.15);
      g.computeBoundingSphere();
      return g;
    };
    heroLeftStripGeo = buildHeroStrip(-1);
    heroRightStripGeo = buildHeroStrip(1);
  } else {
    mergedWingsGeo = mergeSubGeometries([
      { geometry: buildWingGeo(-1), position: [-1.68, 0.10, -0.35], disposeSource: true },
      { geometry: buildWingGeo(1), position: [1.68, 0.10, -0.35], disposeSource: true },
    ]);
  }

  // 9. Articulated control surface geometries (ailerons, stabilators, twin rudders, stealth canards)
  const buildAileron = (side: -1 | 1): THREE.BufferGeometry =>
    buildAirfoilWingGeometry({
      side,
      chordSegments: 6,
      bevelFactor: 0.68,
      stations: [
        { span: -1.18, chord: 0.44, sweepZ: 0.0, dihedralY: 0, thicknessRatio: 0.095, camber: 0 },
        { span: 1.18, chord: 0.38, sweepZ: 0.02, dihedralY: 0, thicknessRatio: 0.085, camber: 0 },
      ],
    });
  const leftAileronGeo = buildAileron(-1);
  const rightAileronGeo = buildAileron(1);

  const buildStab = (side: -1 | 1): THREE.BufferGeometry =>
    isHero
      ? buildAirfoilWingGeometry({
          side,
          chordSegments: 10,
          bevelFactor: 0.62,
          stations: [
            { span: 0.0, chord: 2.25, sweepZ: -0.95, dihedralY: 0, thicknessRatio: 0.06, camber: 0 },
            { span: 1.75, chord: 1.52, sweepZ: 0.05, dihedralY: -0.04, thicknessRatio: 0.048, camber: 0 },
            { span: 3.25, chord: 0.84, sweepZ: 0.92, dihedralY: -0.08, thicknessRatio: 0.04, camber: 0 },
          ],
        })
      : buildAirfoilWingGeometry({
          side,
          chordSegments: 8,
          bevelFactor: 0.72,
          stations: [
            { span: 0.0, chord: 1.85, sweepZ: -0.78, dihedralY: 0, thicknessRatio: 0.056, camber: 0 },
            { span: 2.15, chord: 0.78, sweepZ: 0.42, dihedralY: -0.14, thicknessRatio: 0.04, camber: 0 },
          ],
        });
  const leftStabGeo = buildStab(-1);
  const rightStabGeo = buildStab(1);

  // Articulated bevelled airfoil rudder hinged along the vertical fin / V-tail trailing edge
  const rudderGeo = buildAirfoilWingGeometry({
    side: 1,
    chordSegments: 6,
    bevelFactor: 0.68,
    stations: isHero
      ? [
          { span: 0.14, chord: 0.62, sweepZ: -0.04, dihedralY: 0, thicknessRatio: 0.095, camber: 0 },
          { span: 2.42, chord: 0.36, sweepZ: -0.02, dihedralY: 0, thicknessRatio: 0.085, camber: 0 },
        ]
      : [
          { span: 0.16, chord: 0.64, sweepZ: -0.04, dihedralY: 0, thicknessRatio: 0.090, camber: 0 },
          { span: 2.84, chord: 0.36, sweepZ: -0.02, dihedralY: 0, thicknessRatio: 0.080, camber: 0 },
        ],
  });
  rudderGeo.rotateZ(Math.PI / 2); // Span +X -> +Y (hinge along local Y, chord along +Z)

  let leftCanardGeo: THREE.BufferGeometry | null = null;
  let rightCanardGeo: THREE.BufferGeometry | null = null;
  let leftCanardTrimGeo: THREE.BufferGeometry | null = null;
  let rightCanardTrimGeo: THREE.BufferGeometry | null = null;

  if (!isHero) {
    const buildCanard = (side: -1 | 1): THREE.BufferGeometry =>
      buildAirfoilWingGeometry({
        side,
        chordSegments: 10,
        bevelFactor: 0.72,
        stations: [
          { span: 0.0, chord: 1.52, sweepZ: -0.62, dihedralY: 0.0, thicknessRatio: 0.068, camber: 0.004 },
          { span: 1.2, chord: 1.04, sweepZ: -0.04, dihedralY: 0.05, thicknessRatio: 0.055, camber: 0.002 },
          { span: 2.25, chord: 0.56, sweepZ: 0.58, dihedralY: 0.10, thicknessRatio: 0.045, camber: 0.0 },
        ],
      });
    leftCanardGeo = buildCanard(-1);
    rightCanardGeo = buildCanard(1);

    if (isAce) {
      const buildTrim = (side: -1 | 1): THREE.BufferGeometry => {
        const g = new THREE.BoxGeometry(1.4, 0.032, 0.06);
        g.rotateY(side * -0.46);
        g.translate(side * 0.95, 0.06, 0.04);
        g.computeBoundingSphere();
        return g;
      };
      leftCanardTrimGeo = buildTrim(-1);
      rightCanardTrimGeo = buildTrim(1);
    }
  }

  const canopyGeo = buildSculptedCanopyGeometry(isHero);

  const set: RoleGeometrySet = {
    staticHullGeo,
    staticDarkGeo,
    staticIntakeInnerGeo,
    staticGlowGeo,
    staticOrdnanceGeo,
    canopyGeo,
    leftWingGeo,
    rightWingGeo,
    mergedWingsGeo,
    heroLeftStripGeo,
    heroRightStripGeo,
    leftAileronGeo,
    rightAileronGeo,
    leftStabGeo,
    rightStabGeo,
    rudderGeo,
    leftCanardGeo,
    rightCanardGeo,
    leftCanardTrimGeo,
    rightCanardTrimGeo,
  };
  roleGeometryCache[role] = set;
  return set;
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
  public rollRate = 0.0;
  public pitchRate = 0.0;
  public yawRate = 0.0;

  private readonly roleMats: RoleMaterialSet;
  private readonly hullMat: THREE.MeshPhysicalMaterial;
  private readonly wingHullMat: THREE.MeshPhysicalMaterial;
  private readonly wingAeroUniforms: WingAeroUniforms;
  private readonly darkMat: THREE.MeshPhysicalMaterial;
  private readonly canopyMat: THREE.MeshPhysicalMaterial;
  private readonly glowMat: THREE.MeshStandardMaterial;
  private readonly hotLinerMat: THREE.MeshStandardMaterial;

  private readonly leftWingPivot: THREE.Group | null = null;
  private readonly rightWingPivot: THREE.Group | null = null;
  private readonly leftTipFlexGroup: THREE.Group;
  private readonly rightTipFlexGroup: THREE.Group;
  private readonly leftTipBaseY: number;
  private readonly rightTipBaseY: number;
  private readonly leftAileronPivot: THREE.Group;
  private readonly rightAileronPivot: THREE.Group;
  private readonly aileronBaseY: number;
  private readonly leftStabPivot: THREE.Group;
  private readonly rightStabPivot: THREE.Group;
  private readonly leftRudderPivot: THREE.Group;
  private readonly rightRudderPivot: THREE.Group;
  private readonly leftCanardPivot: THREE.Group | null = null;
  private readonly rightCanardPivot: THREE.Group | null = null;
  private readonly counterPylonPivots: THREE.Group[] = [];
  private readonly counterPylonSigns: number[] = [];
  private readonly counterPylonBaseY: number[] = [];
  private readonly counterPylonBendFactor: number[] = [];
  private readonly fanRotors: THREE.Group[] = [];
  private readonly nozzleGimbalPivots: THREE.Group[] = [];
  private readonly nozzlePetalRings: THREE.Mesh[] = [];
  private readonly afterburnerMat: THREE.ShaderMaterial;
  private readonly afterburnerMeshes: THREE.Mesh[] = [];
  private readonly afterburnerLight: THREE.PointLight;
  private readonly vaporMat: THREE.ShaderMaterial;
  private readonly vaporMesh: THREE.Mesh;
  private readonly strobeMeshes: THREE.Mesh[] = [];

  // Pre-allocated state & scratch objects (zero per-frame heap allocations)
  private readonly wingSpan: number;
  private aeroFlex = 0;
  private fanPhase = 0;
  private lastVisualTime = -1;
  private hasPrevPose = false;
  private readonly prevPos = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly _accel = new THREE.Vector3();
  private readonly _lookTarget = new THREE.Vector3();
  private readonly _upAxis = new THREE.Vector3(0, 1, 0);
  private readonly _rollAxis = new THREE.Vector3(0, 0, -1);
  private readonly _pitchAxis = new THREE.Vector3(1, 0, 0);
  private readonly _lookMat = new THREE.Matrix4();
  private readonly _poseQ = new THREE.Quaternion();
  private readonly _rollQ = new THREE.Quaternion();
  private readonly _pitchQ = new THREE.Quaternion();
  private readonly _deltaQ = new THREE.Quaternion();

  constructor(id: string, callsign: string, role: FighterRole) {
    this.id = id;
    this.callsign = callsign;
    this.role = role;
    this.group = new THREE.Group();
    this.group.name = `Fighter_${id}`;

    const isHero = role === 'hero';
    const isAce = role === 'ace';
    const parts = getSharedParts();
    const roleMats = getRoleMaterialSet(role);
    const roleGeos = getRoleGeometrySet(role);

    this.roleMats = roleMats;
    this.hullMat = roleMats.hullMat;
    this.darkMat = roleMats.darkMat;
    this.canopyMat = roleMats.canopyMat;
    this.glowMat = roleMats.glowMat;
    this.hotLinerMat = roleMats.hotLinerMat;
    this.wingSpan = isHero ? 6.32 : 6.12;

    const wingAero = createAeroWingHullMaterial(
      role,
      roleMats,
      isHero ? 0.0 : 1.68,
      this.wingSpan,
    );
    this.wingHullMat = wingAero.material;
    this.wingAeroUniforms = wingAero.uniforms;

    const scale = isAce ? 1.28 : 1.0;
    this.group.scale.setScalar(scale);

    const body = new THREE.Group();
    this.group.add(body);

    // ------------------------------------------------------------------
    // 1. CONSOLIDATED STATIC HULL, INTAKES, COCKPIT, FINS & ACCENTS
    // ------------------------------------------------------------------
    body.add(new THREE.Mesh(roleGeos.staticHullGeo, this.hullMat));
    body.add(new THREE.Mesh(roleGeos.staticDarkGeo, this.darkMat));
    body.add(new THREE.Mesh(roleGeos.staticIntakeInnerGeo, roleMats.intakeInnerMat));
    body.add(new THREE.Mesh(roleGeos.staticGlowGeo, this.glowMat));
    if (roleGeos.staticOrdnanceGeo) {
      body.add(new THREE.Mesh(roleGeos.staticOrdnanceGeo, roleMats.ordnanceMat));
    }

    // Consolidated backlit cockpit interior & Schlick Fresnel PMREM canopy
    body.add(new THREE.Mesh(parts.mfdScreensGeo, roleMats.mfdMat));
    body.add(new THREE.Mesh(parts.seatRailsGeo, roleMats.railMat));
    body.add(new THREE.Mesh(parts.hudGlassGeo, roleMats.hudGlassMat));
    body.add(new THREE.Mesh(parts.helmetGeo, roleMats.helmetMat));
    body.add(new THREE.Mesh(parts.visorGeo, roleMats.visorMat));
    body.add(new THREE.Mesh(roleGeos.canopyGeo, this.canopyMat));

    // ------------------------------------------------------------------
    // 2. SPINNING 16-BLADE 3D TITANIUM COMPRESSOR FANS (MERGED BLADES)
    // ------------------------------------------------------------------
    for (const side of [-1, 1] as const) {
      const fanRotor = new THREE.Group();
      fanRotor.position.set(
        side * (isHero ? 1.52 : 1.44),
        isHero ? -0.12 : -0.14,
        isHero ? -2.02 : -1.85,
      );
      fanRotor.scale.setScalar(isHero ? 0.86 : 0.74);
      fanRotor.add(new THREE.Mesh(parts.fanBladesGeo, roleMats.fanBladeMat));
      fanRotor.add(new THREE.Mesh(parts.spinnerGeo, this.darkMat));
      body.add(fanRotor);
      this.fanRotors.push(fanRotor);
    }

    // ------------------------------------------------------------------
    // 3. AEROELASTIC MAIN WINGS, ARTICULATED AILERONS & ORDNANCE
    // ------------------------------------------------------------------
    const buildWingtipMount = (
      side: -1 | 1,
      parent: THREE.Group,
      tipX: number,
      tipY: number,
      tipZ: number,
    ): { tipFlexGroup: THREE.Group; tipAnchor: THREE.Object3D } => {
      const tipFlexGroup = new THREE.Group();
      tipFlexGroup.position.set(tipX, tipY, tipZ);

      tipFlexGroup.add(
        new THREE.Mesh(
          side < 0 ? parts.sidewinderDarkLeftGeo : parts.sidewinderDarkRightGeo,
          this.darkMat,
        ),
      );
      tipFlexGroup.add(
        new THREE.Mesh(
          side < 0 ? parts.sidewinderBodyLeftGeo : parts.sidewinderBodyRightGeo,
          roleMats.ordnanceMat,
        ),
      );

      const strobe = new THREE.Mesh(
        parts.strobeGeo,
        side < 0 ? roleMats.strobePortMat : roleMats.strobeStbdMat,
      );
      strobe.position.set(0, 0.08, 0.62);
      tipFlexGroup.add(strobe);
      this.strobeMeshes.push(strobe);

      const tipAnchor = new THREE.Object3D();
      tipAnchor.position.set(side * 0.12, 0, 0.85);
      tipFlexGroup.add(tipAnchor);

      parent.add(tipFlexGroup);
      return { tipFlexGroup, tipAnchor };
    };

    if (isHero) {
      this.leftWingPivot = new THREE.Group();
      this.rightWingPivot = new THREE.Group();
      this.leftWingPivot.position.set(-1.68, 0.10, -0.35);
      this.rightWingPivot.position.set(1.68, 0.10, -0.35);
      body.add(this.leftWingPivot, this.rightWingPivot);

      this.aileronBaseY = -0.04;
      this.leftTipBaseY = -0.10;
      this.rightTipBaseY = -0.10;

      const buildHeroWingSide = (
        side: -1 | 1,
        wingPivot: THREE.Group,
        wingGeo: THREE.BufferGeometry,
        stripGeo: THREE.BufferGeometry,
        aileronGeo: THREE.BufferGeometry,
      ) => {
        wingPivot.add(new THREE.Mesh(wingGeo, this.wingHullMat));
        wingPivot.add(new THREE.Mesh(stripGeo, this.glowMat));

        const aileronPivot = new THREE.Group();
        aileronPivot.rotation.order = 'YXZ';
        aileronPivot.position.set(side * 2.85, this.aileronBaseY, 2.94);
        aileronPivot.rotation.y = side * -0.188;
        aileronPivot.add(new THREE.Mesh(aileronGeo, this.hullMat));
        wingPivot.add(aileronPivot);

        const pylonStations: readonly [number, number, number][] = [
          [1.65, -0.08, 0.65],
          [3.45, -0.10, 1.75],
        ];
        for (let p = 0; p < pylonStations.length; p++) {
          const [px, py, pz] = pylonStations[p];
          const pylonPivot = new THREE.Group();
          pylonPivot.position.set(side * px, py, pz);
          pylonPivot.add(new THREE.Mesh(parts.pylonAmraamDarkGeo, this.darkMat));
          pylonPivot.add(new THREE.Mesh(parts.amraamBodyGeo, roleMats.ordnanceMat));
          wingPivot.add(pylonPivot);

          const sFrac = THREE.MathUtils.clamp(px / this.wingSpan, 0, 1);
          this.counterPylonPivots.push(pylonPivot);
          this.counterPylonSigns.push(side);
          this.counterPylonBaseY.push(py);
          this.counterPylonBendFactor.push(sFrac * sFrac * (1.25 - 0.25 * sFrac));
        }

        const tip = buildWingtipMount(side, wingPivot, side * 6.36, -0.10, 2.95);
        return { aileronPivot, ...tip };
      };

      const leftHero = buildHeroWingSide(
        -1,
        this.leftWingPivot,
        roleGeos.leftWingGeo!,
        roleGeos.heroLeftStripGeo!,
        roleGeos.leftAileronGeo,
      );
      const rightHero = buildHeroWingSide(
        1,
        this.rightWingPivot,
        roleGeos.rightWingGeo!,
        roleGeos.heroRightStripGeo!,
        roleGeos.rightAileronGeo,
      );
      this.leftAileronPivot = leftHero.aileronPivot;
      this.rightAileronPivot = rightHero.aileronPivot;
      this.leftTipFlexGroup = leftHero.tipFlexGroup;
      this.rightTipFlexGroup = rightHero.tipFlexGroup;
      this.wingtipLeft = leftHero.tipAnchor;
      this.wingtipRight = rightHero.tipAnchor;
    } else {
      // Bandit / Ace: both forward-swept wings consolidated into 1 single aeroelastic mesh
      body.add(new THREE.Mesh(roleGeos.mergedWingsGeo!, this.wingHullMat));

      this.aileronBaseY = 0.16;
      this.leftTipBaseY = 0.22;
      this.rightTipBaseY = 0.22;

      const buildBanditAileron = (side: -1 | 1, geo: THREE.BufferGeometry): THREE.Group => {
        const pivot = new THREE.Group();
        pivot.rotation.order = 'YXZ';
        pivot.position.set(side * 4.63, this.aileronBaseY, 0.01);
        pivot.rotation.y = side * 0.655;
        pivot.add(new THREE.Mesh(geo, this.hullMat));
        body.add(pivot);
        return pivot;
      };
      this.leftAileronPivot = buildBanditAileron(-1, roleGeos.leftAileronGeo);
      this.rightAileronPivot = buildBanditAileron(1, roleGeos.rightAileronGeo);

      const leftTip = buildWingtipMount(-1, body, -7.84, this.leftTipBaseY, -2.70);
      const rightTip = buildWingtipMount(1, body, 7.84, this.rightTipBaseY, -2.70);
      this.leftTipFlexGroup = leftTip.tipFlexGroup;
      this.rightTipFlexGroup = rightTip.tipFlexGroup;
      this.wingtipLeft = leftTip.tipAnchor;
      this.wingtipRight = rightTip.tipAnchor;
    }

    // ------------------------------------------------------------------
    // 4. ARTICULATED FORWARD STEALTH CANARDS (WRAITH & CRIMSON-1)
    // ------------------------------------------------------------------
    if (!isHero) {
      for (const side of [-1, 1] as const) {
        const canardPivot = new THREE.Group();
        canardPivot.position.set(side * 1.18, 0.14, -4.55);
        canardPivot.add(
          new THREE.Mesh(
            side < 0 ? roleGeos.leftCanardGeo! : roleGeos.rightCanardGeo!,
            this.hullMat,
          ),
        );
        if (isAce) {
          canardPivot.add(
            new THREE.Mesh(
              side < 0 ? roleGeos.leftCanardTrimGeo! : roleGeos.rightCanardTrimGeo!,
              this.glowMat,
            ),
          );
        }
        body.add(canardPivot);
        if (side < 0) this.leftCanardPivot = canardPivot;
        else this.rightCanardPivot = canardPivot;
      }
    }

    // ------------------------------------------------------------------
    // 5. ARTICULATED TWIN RUDDERS & ALL-MOVING HORIZONTAL STABILATORS
    // ------------------------------------------------------------------
    let leftStabPivot!: THREE.Group;
    let rightStabPivot!: THREE.Group;
    let leftRudderPivot!: THREE.Group;
    let rightRudderPivot!: THREE.Group;

    const rudderHingeZ = isHero ? 2.15 : 2.30;
    const rudderHingeSweep = isHero ? 0.1693 : 0.1388;

    for (const side of [-1, 1] as const) {
      // Canted rudder mount aligned with the vertical fin / V-tail trailing-edge hinge line
      const finCantMount = new THREE.Group();
      finCantMount.position.set(side * (isHero ? 1.44 : 1.38), 0.38, isHero ? 2.85 : 3.05);
      finCantMount.rotation.z = side * (isHero ? -0.34 : -0.64);
      body.add(finCantMount);

      const rudderHinge = new THREE.Group();
      rudderHinge.position.set(0, 0, rudderHingeZ);
      rudderHinge.rotation.x = rudderHingeSweep;
      finCantMount.add(rudderHinge);

      const rudderPivot = new THREE.Group();
      rudderPivot.add(new THREE.Mesh(roleGeos.rudderGeo, this.hullMat));
      rudderHinge.add(rudderPivot);

      if (side < 0) leftRudderPivot = rudderPivot;
      else rightRudderPivot = rudderPivot;

      // All-moving horizontal stabilator (Hero) / aft stealth taileron (Bandit & Ace)
      const stabPivot = new THREE.Group();
      stabPivot.position.set(
        side * (isHero ? 1.42 : 1.46),
        isHero ? -0.02 : -0.06,
        isHero ? 4.95 : 5.15,
      );
      stabPivot.add(
        new THREE.Mesh(side < 0 ? roleGeos.leftStabGeo : roleGeos.rightStabGeo, this.hullMat),
      );
      body.add(stabPivot);

      if (side < 0) leftStabPivot = stabPivot;
      else rightStabPivot = stabPivot;
    }

    this.leftStabPivot = leftStabPivot;
    this.rightStabPivot = rightStabPivot;
    this.leftRudderPivot = leftRudderPivot;
    this.rightRudderPivot = rightRudderPivot;

    // ------------------------------------------------------------------
    // 6. THRUST-VECTORING GIMBALLED TURKEY-FEATHER NOZZLES & PLUMES
    // ------------------------------------------------------------------
    const nozzleX = isHero ? 0.94 : 0.96;
    const nozzleZ = isHero ? 5.82 : 6.12;

    // Single shared afterburner ShaderMaterial across both twin exhaust plumes per jet
    this.afterburnerMat = new THREE.ShaderMaterial({
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
        uCoreColor: { value: roleMats.coreColor },
        uOuterColor: { value: roleMats.outerColor },
      },
    });

    for (const side of [-1, 1] as const) {
      const nozzleGimbal = new THREE.Group();
      nozzleGimbal.position.set(side * nozzleX, -0.02, nozzleZ + 0.18);
      body.add(nozzleGimbal);

      // Merged 14-petal turkey-feather ring (1 draw call instead of 14!)
      const petalRing = new THREE.Mesh(parts.nozzlePetalRingGeo, this.darkMat);
      nozzleGimbal.add(petalRing);
      this.nozzlePetalRings.push(petalRing);

      // Inner incandescent ceramic afterburner liner sleeve
      nozzleGimbal.add(new THREE.Mesh(parts.nozzleInnerLinerGeo, this.hotLinerMat));

      // Glowing turbine flameholder core disc
      nozzleGimbal.add(new THREE.Mesh(parts.burnerCoreGeo, roleMats.burnerCoreMat));

      // Animated Mach-diamond plasma plume
      const plumeMesh = new THREE.Mesh(parts.plumeGeo, this.afterburnerMat);
      plumeMesh.position.z = 0.87;
      nozzleGimbal.add(plumeMesh);
      this.afterburnerMeshes.push(plumeMesh);

      this.nozzleGimbalPivots.push(nozzleGimbal);
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
    // 7. SUPERSONIC PRANDTL-GLAUERT VAPOUR CONE
    // ------------------------------------------------------------------
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
    this.vaporMesh = new THREE.Mesh(parts.vaporConeGeo, this.vaporMat);
    this.vaporMesh.position.set(0, 0.1, 1.4);
    this.vaporMesh.visible = false;
    body.add(this.vaporMesh);

    // ------------------------------------------------------------------
    // 8. CAMERA & WEAPON ANCHORS (100% COMPATIBLE WITH CALLERS)
    // ------------------------------------------------------------------
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

    // Compute smoothed body-frame angular pitch/yaw/roll rates (zero per-frame allocations)
    if (this.hasPrevPose && dt > 0.0001 && dt <= 0.25) {
      this._deltaQ.copy(this.prevQuat).invert().multiply(this._poseQ);
      if (this._deltaQ.w < 0) {
        this._deltaQ.set(-this._deltaQ.x, -this._deltaQ.y, -this._deltaQ.z, -this._deltaQ.w);
      }

      const sinHalf = Math.hypot(this._deltaQ.x, this._deltaQ.y, this._deltaQ.z);
      let rawPitch = 0;
      let rawYaw = 0;
      let rawRoll = 0;
      if (sinHalf > 1e-6) {
        const angle = 2 * Math.atan2(sinHalf, this._deltaQ.w);
        const rateScale = angle / (sinHalf * dt);
        rawPitch = THREE.MathUtils.clamp(this._deltaQ.x * rateScale, -4.5, 4.5);
        rawYaw = THREE.MathUtils.clamp(this._deltaQ.y * rateScale, -3.5, 3.5);
        rawRoll = THREE.MathUtils.clamp(-this._deltaQ.z * rateScale, -6.0, 6.0);
      }

      const alpha = 1 - Math.exp(-dt * 12);
      this.pitchRate = THREE.MathUtils.lerp(this.pitchRate, rawPitch, alpha);
      this.yawRate = THREE.MathUtils.lerp(this.yawRate, rawYaw, alpha);
      this.rollRate = THREE.MathUtils.lerp(this.rollRate, rawRoll, alpha);
    } else if (dt > 0.25) {
      // Large timeline seek: reset angular rates cleanly without impulse spike
      this.pitchRate = 0;
      this.yawRate = 0;
      this.rollRate = 0;
    }

    this.prevQuat.copy(this._poseQ);
    this.hasPrevPose = true;

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

    // 1. GPU aeroelastic 9G cantilever wing flex + transonic buffet vibration
    const gClamped = THREE.MathUtils.clamp(this.gForce, 0, 11.5);
    const targetFlex = (gClamped / 11.0) * 0.52;
    this.aeroFlex = THREE.MathUtils.lerp(this.aeroFlex, targetFlex, Math.min(1, dt * 14));

    const buffetFactor =
      this.vaporIntensity > 0.1
        ? THREE.MathUtils.clamp((this.vaporIntensity - 0.1) / 0.9, 0, 1)
        : 0;
    const buffetAmp = buffetFactor * 0.065;

    this.wingAeroUniforms.uWingFlex.value = this.aeroFlex;
    this.wingAeroUniforms.uBuffetAmp.value = buffetAmp;
    this.wingAeroUniforms.uAeroTime.value = time;

    // Sync wingtip rails/Sidewinders/contrail anchors and ailerons with aeroelastic flex
    const tipBuffet =
      buffetAmp > 0
        ? buffetAmp * (Math.sin(time * 48.0 + this.wingSpan * 2.2) * 0.65 + Math.sin(time * 73.0 - this.wingSpan * 1.4) * 0.35)
        : 0;
    const tipFlexY = this.aeroFlex + tipBuffet;
    const tipSlope = (this.aeroFlex / this.wingSpan) * 1.75;

    this.leftTipFlexGroup.position.y = this.leftTipBaseY + tipFlexY;
    this.leftTipFlexGroup.rotation.z = -tipSlope;
    this.rightTipFlexGroup.position.y = this.rightTipBaseY + tipFlexY;
    this.rightTipFlexGroup.rotation.z = tipSlope;

    const aileronFlexY = this.aeroFlex * 0.24;
    this.leftAileronPivot.position.y = this.aileronBaseY + aileronFlexY;
    this.rightAileronPivot.position.y = this.aileronBaseY + aileronFlexY;

    // 2. Variable wing sweep & counter-rotating underwing pylons on Hero jet
    if (this.role === 'hero' && this.leftWingPivot && this.rightWingPivot) {
      const sweep = THREE.MathUtils.clamp((this.throttle - 0.6) * 0.42, 0.0, 0.34);
      this.leftWingPivot.rotation.y = sweep;
      this.rightWingPivot.rotation.y = -sweep;
      for (let i = 0; i < this.counterPylonPivots.length; i++) {
        // Keep underwing AMRAAM missiles aligned into airstream and flush with wing flex
        this.counterPylonPivots[i].rotation.y = this.counterPylonSigns[i] * sweep;
        this.counterPylonPivots[i].position.y =
          this.counterPylonBaseY[i] + this.aeroFlex * this.counterPylonBendFactor[i];
      }
    }

    // 3. Fly-by-wire articulated control surfaces driven by smoothed roll/pitch/yaw rates
    const gNorm = THREE.MathUtils.clamp((this.gForce - 1.0) / 7.5, 0, 1);
    const aileronRoll = THREE.MathUtils.clamp(this.rollRate * 0.28, -0.42, 0.42);
    const pitchCmd = THREE.MathUtils.clamp(this.pitchRate * 0.26 + gNorm * 0.20, -0.36, 0.42);
    const yawCmd = THREE.MathUtils.clamp(this.yawRate * 0.34, -0.42, 0.42);

    // Trailing-edge ailerons / flaperons
    const flapBias = gNorm * 0.14;
    this.leftAileronPivot.rotation.x = THREE.MathUtils.clamp(flapBias + aileronRoll, -0.45, 0.48);
    this.rightAileronPivot.rotation.x = THREE.MathUtils.clamp(flapBias - aileronRoll, -0.45, 0.48);

    // All-moving horizontal stabilators / differential tailerons
    this.leftStabPivot.rotation.x = THREE.MathUtils.clamp(
      -pitchCmd + aileronRoll * 0.45,
      -0.46,
      0.42,
    );
    this.rightStabPivot.rotation.x = THREE.MathUtils.clamp(
      -pitchCmd - aileronRoll * 0.45,
      -0.46,
      0.42,
    );

    // Articulated twin rudders (Hero) / V-tail ruddervators (Bandit & Ace) with high-G toe-in
    const toeIn = gNorm * 0.12 + (this.role !== 'hero' ? pitchCmd * 0.35 : 0);
    this.leftRudderPivot.rotation.y = THREE.MathUtils.clamp(-yawCmd + toeIn, -0.48, 0.48);
    this.rightRudderPivot.rotation.y = THREE.MathUtils.clamp(-yawCmd - toeIn, -0.48, 0.48);

    // Forward stealth canards on WRAITH & CRIMSON-1
    if (this.leftCanardPivot && this.rightCanardPivot) {
      const canardPitch = THREE.MathUtils.clamp(0.04 + pitchCmd * 0.85, -0.32, 0.44);
      this.leftCanardPivot.rotation.x = canardPitch;
      this.rightCanardPivot.rotation.x = canardPitch;
    }

    // 4. High-RPM spinning 3D titanium compressor fan rotors inside S-duct intakes
    this.fanPhase += dt * (22 + this.throttle * 34);
    for (let i = 0; i < this.fanRotors.length; i++) {
      this.fanRotors[i].rotation.z = i === 0 ? this.fanPhase : -this.fanPhase;
    }

    // 5. Thrust-vectoring nozzle gimbal & turkey-feather aperture dilation
    const gimbalPitch = THREE.MathUtils.clamp(this.pitchRate * 0.18 + gNorm * 0.14, -0.26, 0.28);
    const gimbalYaw = THREE.MathUtils.clamp(-this.yawRate * 0.20, -0.22, 0.22);
    const rollTvc = THREE.MathUtils.clamp(this.rollRate * 0.05, -0.08, 0.08);
    const petalScale = THREE.MathUtils.clamp(0.90 + this.throttle * 0.10, 0.88, 1.04);

    for (let i = 0; i < this.nozzleGimbalPivots.length; i++) {
      const sideSign = i === 0 ? -1 : 1;
      const gimbal = this.nozzleGimbalPivots[i];
      gimbal.rotation.x = THREE.MathUtils.clamp(gimbalPitch - sideSign * rollTvc, -0.30, 0.30);
      gimbal.rotation.y = gimbalYaw;
      this.nozzlePetalRings[i].scale.set(petalScale, petalScale, 1.0);
    }
    this.hotLinerMat.emissiveIntensity = 0.9 + this.throttle * 2.4 + Math.sin(time * 52) * 0.15;

    // 6. Dynamic Mach-diamond afterburner plumes
    const plumeScaleZ = 0.55 + this.throttle * 0.95 + Math.sin(time * 48) * 0.06;
    this.afterburnerMat.uniforms.uTime.value = time;
    this.afterburnerMat.uniforms.uThrottle.value = this.throttle;
    this.afterburnerMat.uniforms.uTrip.value = tripIntensity;
    for (let i = 0; i < this.afterburnerMeshes.length; i++) {
      this.afterburnerMeshes[i].scale.set(1, 1, plumeScaleZ);
    }

    this.afterburnerLight.intensity =
      (this.role === 'hero' ? 32 : this.role === 'ace' ? 36 : 10) *
      (0.75 + 0.25 * Math.sin(time * 62)) *
      this.throttle;

    // 7. Supersonic Prandtl-Glauert vapour cone
    this.vaporMat.uniforms.uTime.value = time;
    this.vaporMat.uniforms.uIntensity.value = this.vaporIntensity;
    this.vaporMat.uniforms.uTrip.value = tripIntensity;
    this.vaporMesh.visible = this.vaporIntensity > 0.02;
    const coneScale = 0.85 + this.vaporIntensity * 0.45;
    this.vaporMesh.scale.set(coneScale, coneScale, 0.9 + this.vaporIntensity * 0.35);

    // 8. Oil-slick psychedelic hull iridescence ramp (in-place tuple mutation, zero allocation)
    const hullIridescence = THREE.MathUtils.clamp(
      (this.role === 'ace' ? 0.35 : 0.14) + tripIntensity * 0.88,
      0,
      1,
    );
    this.hullMat.iridescence = hullIridescence;
    this.wingHullMat.iridescence = hullIridescence;
    this.roleMats.iridescenceRange[0] = 160 + tripIntensity * 180;
    this.roleMats.iridescenceRange[1] = 460 + tripIntensity * 420;

    // 9. Wingtip navigation strobe blink
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
