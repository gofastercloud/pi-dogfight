import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Reusable aerospace geometry lofting, bevelled supersonic airfoil builders,
 * and static sub-mesh buffer consolidation helpers.
 * Every builder guarantees outward-facing triangle winding, continuous UVs,
 * and smooth vertex normals across UV seams.
 */

export interface LoftStation {
  /** Axial coordinate along the aircraft fuselage (-Z is nose, +Z is tail). */
  z: number;
  /** Vertical offset applied to all cross-section points at this station. */
  centerY?: number;
  /** Horizontal offset applied to all cross-section points at this station. */
  centerX?: number;
  /** Ordered 2D perimeter points [x, y] around the station centre. */
  points: [number, number][];
}

export interface LoftOptions {
  /** Number of Catmull-Rom interpolated sub-spans between consecutive stations. Default: 1 (linear). */
  subdivisionsPerSpan?: number;
  /** Cap the forward-most station. Default: true. */
  capFront?: boolean;
  /** Cap the aft-most station. Default: true. */
  capBack?: boolean;
  /** UV repeat along the perimeter (U). Default: 1. */
  uScale?: number;
  /** UV repeat along the axial length (V). Default: 1. */
  vScale?: number;
  /** Blend vertex normals seamlessly across the perimeter UV seam. Default: true. */
  smoothSeamNormals?: boolean;
}

export interface ChinedSectionParams {
  halfWidth: number;
  topHeight: number;
  bottomDepth: number;
  /** Vertical height of the sharp stealth lateral chine ridge. */
  chineY?: number;
  /** Dorsal crown fullness (0.35 = narrow spine, 0.85 = broad canopy deck). */
  dorsalFullness?: number;
  /** Ventral belly flatness (0.35 = V-keel, 0.90 = flat stealth weapons bay). */
  bellyFlatness?: number;
  /** Sharpness of the lateral chine crease (0 = rounded, 1 = razor stealth chine). */
  chineSharpness?: number;
  /** Optional dorsal centre-line dip (e.g. recessed cockpit sill or aft twin-engine valley). */
  dorsalValley?: number;
  /** Perimeter sample count (must be even and >= 12). Default: 32. */
  segments?: number;
}

export interface TwinNacelleSectionParams {
  halfWidth: number;
  topHeight: number;
  bottomDepth: number;
  chineY?: number;
  /** Horizontal distance from centre-line to each engine nacelle peak. */
  nacelleX: number;
  /** Vertical radius of each cylindrical-blended engine hump. */
  nacelleBump: number;
  /** Depth of the dorsal/ventral trough between the twin engines. */
  valleyDepth: number;
  segments?: number;
}

export interface SuperellipseSectionParams {
  rx: number;
  ry: number;
  /** Exponent controlling squareness (2 = ellipse, 3..5 = rounded stealth trapezoid). */
  exp?: number;
  /** Optional trapezoidal taper: > 0 narrows top, < 0 narrows bottom. */
  topTaper?: number;
  /** Optional roll cant in radians. */
  cantRad?: number;
  segments?: number;
}

export interface AirfoilSpanStation {
  /** Positive distance from wing root along the span axis. */
  span: number;
  /** Chord length from leading edge to trailing edge. */
  chord: number;
  /** Z-coordinate of the leading edge at this span station (-Z forward, +Z aft). */
  sweepZ: number;
  /** Vertical offset (dihedral / anhedral). */
  dihedralY: number;
  /** Maximum thickness-to-chord ratio (e.g. 0.055 for supersonic wing, 0.11 at root LERX). */
  thicknessRatio: number;
  /** Optional camber ratio (e.g. 0.015). Default: 0.008. */
  camber?: number;
  /** Optional aerodynamic twist in radians around quarter-chord. Default: 0. */
  twistRad?: number;
}

export interface AirfoilWingSpec {
  side: -1 | 1;
  stations: AirfoilSpanStation[];
  /** Number of chordwise samples per surface (upper + lower). Default: 14. */
  chordSegments?: number;
  /** Blend toward sharp diamond-bevelled stealth leading/trailing edge (0..1). Default: 0.45. */
  bevelFactor?: number;
  /** Minimum trailing edge half-thickness in world units so edges catch rim highlights. Default: 0.014. */
  minTrailingHalfThickness?: number;
  /** Cap root face. Default: true. */
  capRoot?: boolean;
  /** Cap tip face. Default: true. */
  capTip?: boolean;
  /** UV scale along chord (U) and span (V). */
  uScale?: number;
  vScale?: number;
}

export interface SductIntakeStation {
  z: number;
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  /** Caret / stealth intake cant angle in radians. */
  cantRad?: number;
  /** Forward lip sweep skew (top protrudes further forward than bottom). */
  topSkewZ?: number;
  /** Lateral skew (inboard lip protrudes further forward than outboard). */
  inboardSkewZ?: number;
}

export interface SductIntakeSpec {
  side: -1 | 1;
  stations: SductIntakeStation[];
  /** Wall thickness between outer fairing cowl and recessed internal S-duct throat. */
  wallThickness?: number;
  /** Perimeter ring segments. Default: 24. */
  segments?: number;
  /** Depth index along stations where the inner recessed duct stops (compressor face). */
  ductDepthFraction?: number;
}

export interface NozzlePetalSpec {
  /** Axial length of each turkey-feather petal. */
  length: number;
  /** Width at nozzle hinge ring. */
  rootWidth: number;
  /** Tapered width at exhaust lip. */
  tipWidth: number;
  /** Radial thickness of the bevelled titanium petal. */
  thickness: number;
  /** Subtle outward/inward curvature along the petal length. */
  arch?: number;
}

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

function signedRingArea2D(pts: [number, number][]): number {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function subdivideStations(stations: LoftStation[], subdivisionsPerSpan: number): LoftStation[] {
  if (subdivisionsPerSpan <= 1 || stations.length < 2) {
    return stations;
  }

  const out: LoftStation[] = [];
  const count = stations.length;
  const ringLen = stations[0].points.length;

  for (let i = 0; i < count - 1; i++) {
    const s0 = stations[Math.max(0, i - 1)];
    const s1 = stations[i];
    const s2 = stations[i + 1];
    const s3 = stations[Math.min(count - 1, i + 2)];

    const cY0 = s0.centerY ?? 0;
    const cY1 = s1.centerY ?? 0;
    const cY2 = s2.centerY ?? 0;
    const cY3 = s3.centerY ?? 0;

    const cX0 = s0.centerX ?? 0;
    const cX1 = s1.centerX ?? 0;
    const cX2 = s2.centerX ?? 0;
    const cX3 = s3.centerX ?? 0;

    const steps = subdivisionsPerSpan;
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const z = THREE.MathUtils.lerp(s1.z, s2.z, t);
      const centerY = catmullRom(cY0, cY1, cY2, cY3, t);
      const centerX = catmullRom(cX0, cX1, cX2, cX3, t);
      const pts: [number, number][] = new Array(ringLen);

      for (let j = 0; j < ringLen; j++) {
        const px = catmullRom(
          s0.points[j][0],
          s1.points[j][0],
          s2.points[j][0],
          s3.points[j][0],
          t,
        );
        const py = catmullRom(
          s0.points[j][1],
          s1.points[j][1],
          s2.points[j][1],
          s3.points[j][1],
          t,
        );
        pts[j] = [px, py];
      }
      out.push({ z, centerX, centerY, points: pts });
    }
  }

  out.push(stations[count - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// 1. CROSS-SECTION PROFILE GENERATORS (CW ORDER STARTING AT TOP-CENTRE)
// ---------------------------------------------------------------------------

/**
 * Generates a stealth chined aerospace fuselage cross-section with a sculpted
 * dorsal spine, crisp lateral chine edges, and flattened ventral weapons bay.
 * Points run clockwise from top-centre (0, +topHeight) -> right -> bottom -> left.
 */
export function createChinedSection(params: ChinedSectionParams): [number, number][] {
  const {
    halfWidth,
    topHeight,
    bottomDepth,
    chineY = 0,
    dorsalFullness = 0.62,
    bellyFlatness = 0.72,
    chineSharpness = 0.78,
    dorsalValley = 0,
    segments = 32,
  } = params;

  const pts: [number, number][] = [];
  const w = Math.max(0.008, halfWidth);
  const hTop = Math.max(0.008, topHeight);
  const hBot = Math.max(0.008, bottomDepth);

  for (let i = 0; i < segments; i++) {
    // theta = 0 at top (0, +hTop), PI/2 at right (+w, chineY), PI at bottom (0, -hBot), 3PI/2 at left (-w, chineY)
    const theta = (i / segments) * Math.PI * 2;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const absSin = Math.abs(sinT);
    const absCos = Math.abs(cosT);

    // Pull perimeter smoothly outward near the lateral chine (sinT = ±1)
    const chineBoost = 1 + chineSharpness * 0.12 * Math.pow(absSin, 3.0);
    const x = Math.sign(sinT) * Math.pow(absSin, 0.86 - chineSharpness * 0.14) * w * Math.min(1.06, chineBoost);

    let y: number;
    if (cosT >= 0) {
      // Upper dorsal deck: smooth arch blending into sharp chine ridge
      const dorsalExp = THREE.MathUtils.lerp(1.45, 0.68, dorsalFullness);
      const arch = Math.pow(absCos, dorsalExp);
      // Optional recessed central spine channel / cockpit tub dip
      const valley = dorsalValley > 0 ? dorsalValley * Math.exp(-Math.pow(absSin / 0.34, 2)) : 0;
      y = chineY + (hTop - chineY) * arch - valley;
    } else {
      // Lower ventral belly: radar-deflecting flat bay with crisp lower corners
      const bellyExp = THREE.MathUtils.lerp(1.25, 0.44, bellyFlatness);
      const arch = Math.pow(absCos, bellyExp);
      y = chineY - (hBot + chineY) * arch;
    }

    pts.push([x, y]);
  }

  return pts;
}

/**
 * Generates an aft fuselage cross-section where the lifting body bifurcates
 * smoothly into twin sculpted engine nacelles with an inter-nozzle trough.
 */
export function createTwinNacelleSection(params: TwinNacelleSectionParams): [number, number][] {
  const {
    halfWidth,
    topHeight,
    bottomDepth,
    chineY = -0.02,
    nacelleX,
    nacelleBump,
    valleyDepth,
    segments = 32,
  } = params;

  const base = createChinedSection({
    halfWidth,
    topHeight,
    bottomDepth,
    chineY,
    dorsalFullness: 0.72,
    bellyFlatness: 0.78,
    chineSharpness: 0.85,
    segments,
  });

  const pts: [number, number][] = new Array(segments);
  const sigma = Math.max(0.28, nacelleX * 0.56);

  for (let i = 0; i < segments; i++) {
    const [x, y] = base[i];
    const absX = Math.abs(x);
    // Gaussian hump centred over each engine shaft + central beaver-tail trough
    const hump = Math.exp(-Math.pow((absX - nacelleX) / sigma, 2)) * nacelleBump;
    const trough = Math.exp(-Math.pow(absX / (sigma * 0.85), 2)) * valleyDepth;
    const signY = y >= chineY ? 1 : -1;
    const ny = y + signY * (hump - trough * (signY > 0 ? 1.0 : 0.72));
    pts[i] = [x, ny];
  }

  return pts;
}

/**
 * Generates a smooth superellipse / trapezoidal stealth cross-section
 * (used for canopies, dorsal spines, S-duct fairings, and weapon pods).
 */
export function createSuperellipseSection(params: SuperellipseSectionParams): [number, number][] {
  const {
    rx,
    ry,
    exp = 2.4,
    topTaper = 0,
    cantRad = 0,
    segments = 24,
  } = params;

  const pts: [number, number][] = [];
  const invExp = 2 / Math.max(1.2, exp);
  const cosC = Math.cos(cantRad);
  const sinC = Math.sin(cantRad);

  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    let x = Math.sign(s) * Math.pow(Math.abs(s), invExp) * rx;
    const y = Math.sign(c) * Math.pow(Math.abs(c), invExp) * ry;

    // Apply subtle stealth trapezoidal taper
    if (topTaper !== 0) {
      const normY = ry > 1e-4 ? y / ry : 0;
      x *= 1 - topTaper * normY * 0.5;
    }

    const rotX = x * cosC - y * sinC;
    const rotY = x * sinC + y * cosC;
    pts.push([rotX, rotY]);
  }

  return pts;
}

// ---------------------------------------------------------------------------
// 2. MULTI-STATION SMOOTH LOFT BUILDER
// ---------------------------------------------------------------------------

/**
 * Lofts an ordered list of cross-section stations along the Z axis into a
 * single seamless BufferGeometry with arc-length UVs and outward normals.
 */
export function buildLoftedGeometry(
  rawStations: LoftStation[],
  options: LoftOptions = {},
): THREE.BufferGeometry {
  const {
    subdivisionsPerSpan = 1,
    capFront = true,
    capBack = true,
    uScale = 1,
    vScale = 1,
    smoothSeamNormals = true,
  } = options;

  if (rawStations.length < 2) {
    throw new Error('buildLoftedGeometry requires at least 2 stations');
  }

  // Ensure stations advance monotonically in +Z (nose -> tail)
  const ordered =
    rawStations[rawStations.length - 1].z < rawStations[0].z
      ? [...rawStations].reverse()
      : rawStations;

  // Ensure rings are consistently clockwise in XY so outward normals are guaranteed
  const midIdx = Math.floor(ordered.length / 2);
  const needsRingFlip = signedRingArea2D(ordered[midIdx].points) > 0;
  const normalised: LoftStation[] = needsRingFlip
    ? ordered.map((s) => ({
        z: s.z,
        centerX: s.centerX,
        centerY: s.centerY,
        points: [...s.points].reverse(),
      }))
    : ordered;

  const stations = subdivideStations(normalised, subdivisionsPerSpan);
  const stationCount = stations.length;
  const segs = stations[0].points.length;
  const ringVerts = segs + 1; // Duplicate seam vertex for clean 0..1 U wrapping

  // Compute normalised perimeter arc-length U from the widest reference station
  let refStation = stations[midIdx];
  let maxPerimeter = 0;
  for (let i = 0; i < stationCount; i++) {
    const pts = stations[i].points;
    let p = 0;
    for (let j = 0; j < segs; j++) {
      const a = pts[j];
      const b = pts[(j + 1) % segs];
      p += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (p > maxPerimeter) {
      maxPerimeter = p;
      refStation = stations[i];
    }
  }

  const uCoords = new Float32Array(ringVerts);
  let accumU = 0;
  uCoords[0] = 0;
  for (let j = 0; j < segs; j++) {
    const a = refStation.points[j];
    const b = refStation.points[(j + 1) % segs];
    accumU += Math.hypot(b[0] - a[0], b[1] - a[1]);
    uCoords[j + 1] = maxPerimeter > 1e-5 ? (accumU / maxPerimeter) * uScale : ((j + 1) / segs) * uScale;
  }

  const zMin = stations[0].z;
  const zSpan = Math.max(1e-4, stations[stationCount - 1].z - zMin);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < stationCount; i++) {
    const st = stations[i];
    const cx = st.centerX ?? 0;
    const cy = st.centerY ?? 0;
    const v = ((st.z - zMin) / zSpan) * vScale;

    for (let j = 0; j <= segs; j++) {
      const pt = st.points[j % segs];
      positions.push(pt[0] + cx, pt[1] + cy, st.z);
      uvs.push(uCoords[j], v);
    }
  }

  for (let i = 0; i < stationCount - 1; i++) {
    const rowA = i * ringVerts;
    const rowB = (i + 1) * ringVerts;
    for (let j = 0; j < segs; j++) {
      const a = rowA + j;
      const b = rowB + j;
      const c = rowA + j + 1;
      const d = rowB + j + 1;
      // Outward CCW winding for +Z stations & CW XY rings
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  // Optional front cap (-Z outward normal)
  if (capFront) {
    const first = stations[0];
    const cx = first.centerX ?? 0;
    const cy = first.centerY ?? 0;
    let avgX = 0;
    let avgY = 0;
    for (let j = 0; j < segs; j++) {
      avgX += first.points[j][0];
      avgY += first.points[j][1];
    }
    avgX = avgX / segs + cx;
    avgY = avgY / segs + cy;

    const centerIdx = positions.length / 3;
    positions.push(avgX, avgY, first.z);
    uvs.push(0.5 * uScale, 0);

    const capStart = positions.length / 3;
    for (let j = 0; j < segs; j++) {
      const pt = first.points[j];
      positions.push(pt[0] + cx, pt[1] + cy, first.z);
      uvs.push(uCoords[j], 0);
    }
    for (let j = 0; j < segs; j++) {
      const next = (j + 1) % segs;
      indices.push(centerIdx, capStart + j, capStart + next);
    }
  }

  // Optional back cap (+Z outward normal)
  if (capBack) {
    const last = stations[stationCount - 1];
    const cx = last.centerX ?? 0;
    const cy = last.centerY ?? 0;
    let avgX = 0;
    let avgY = 0;
    for (let j = 0; j < segs; j++) {
      avgX += last.points[j][0];
      avgY += last.points[j][1];
    }
    avgX = avgX / segs + cx;
    avgY = avgY / segs + cy;

    const centerIdx = positions.length / 3;
    positions.push(avgX, avgY, last.z);
    uvs.push(0.5 * uScale, vScale);

    const capStart = positions.length / 3;
    for (let j = 0; j < segs; j++) {
      const pt = last.points[j];
      positions.push(pt[0] + cx, pt[1] + cy, last.z);
      uvs.push(uCoords[j], vScale);
    }
    for (let j = 0; j < segs; j++) {
      const next = (j + 1) % segs;
      indices.push(centerIdx, capStart + next, capStart + j);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  // Stitch vertex normals seamlessly along the j = 0 / j = segs UV seam
  if (smoothSeamNormals) {
    const normAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < stationCount; i++) {
      const idx0 = i * ringVerts;
      const idx1 = i * ringVerts + segs;
      const nx = normAttr.getX(idx0) + normAttr.getX(idx1);
      const ny = normAttr.getY(idx0) + normAttr.getY(idx1);
      const nz = normAttr.getZ(idx0) + normAttr.getZ(idx1);
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-5) {
        const inv = 1 / len;
        normAttr.setXYZ(idx0, nx * inv, ny * inv, nz * inv);
        normAttr.setXYZ(idx1, nx * inv, ny * inv, nz * inv);
      }
    }
    normAttr.needsUpdate = true;
  }

  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// 3. NACA-STYLE BEVELLED SUPERSONIC AIRFOIL WING / STABILISER BUILDER
// ---------------------------------------------------------------------------

/**
 * Evaluates a blended NACA-4 / stealth bevelled supersonic airfoil half-thickness
 * at normalised chord fraction u in [0, 1] (0 = leading edge, 1 = trailing edge).
 */
function sampleSupersonicAirfoil(
  u: number,
  thicknessRatio: number,
  camber: number,
  bevelFactor: number,
  minTrailingHalf: number,
  chord: number,
): { yUpper: number; yLower: number } {
  const uc = THREE.MathUtils.clamp(u, 0, 1);

  // Classic NACA 4-digit closed-TE thickness distribution
  const naca =
    5 *
    thicknessRatio *
    (0.2969 * Math.sqrt(Math.max(uc, 0)) -
      0.126 * uc -
      0.3516 * uc * uc +
      0.2843 * uc * uc * uc -
      0.1036 * uc * uc * uc * uc);

  // Crisp supersonic biconvex diamond bevel (peak thickness at 38% chord)
  const peak = 0.38;
  const diamond =
    uc < peak
      ? thicknessRatio * 0.52 * (uc / peak)
      : thicknessRatio * 0.52 * ((1 - uc) / (1 - peak));

  const halfT = Math.max(
    minTrailingHalf * (0.35 + 0.65 * uc),
    THREE.MathUtils.lerp(naca, diamond, bevelFactor) * chord,
  );

  // Subtle parabolic camber line
  const camberLine = camber * chord * 4 * uc * (1 - uc);
  return {
    yUpper: camberLine + halfT,
    yLower: camberLine - halfT,
  };
}

/**
 * Builds a multi-station 3D NACA-style bevelled airfoil wing, horizontal
 * stabilator, canard, or vertical tail surface with clean chord/span UVs
 * and guaranteed outward-facing normals for both port (-1) and starboard (+1).
 */
export function buildAirfoilWingGeometry(spec: AirfoilWingSpec): THREE.BufferGeometry {
  const {
    side,
    stations,
    chordSegments = 14,
    bevelFactor = 0.45,
    minTrailingHalfThickness = 0.014,
    capRoot = true,
    capTip = true,
    uScale = 1,
    vScale = 1,
  } = spec;

  if (stations.length < 2) {
    throw new Error('buildAirfoilWingGeometry requires at least 2 span stations');
  }

  // Cosine-clustered chord samples (dense near leading & trailing bevels)
  const chordU: number[] = [];
  for (let k = 0; k <= chordSegments; k++) {
    const beta = (k / chordSegments) * Math.PI;
    chordU.push(0.5 * (1 - Math.cos(beta)));
  }

  // Perimeter ring: TE -> upper -> LE -> lower -> TE (2 * chordSegments + 1 vertices)
  const ringCount = chordSegments * 2 + 1;
  const spanCount = stations.length;
  const spanMin = stations[0].span;
  const spanRange = Math.max(1e-4, stations[spanCount - 1].span - spanMin);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < spanCount; i++) {
    const st = stations[i];
    const x = side * st.span;
    const camber = st.camber ?? 0.008;
    const twist = st.twistRad ?? 0;
    const cosTw = Math.cos(twist);
    const sinTw = Math.sin(twist);
    const pivotZ = st.sweepZ + st.chord * 0.25;
    const vCoord = ((st.span - spanMin) / spanRange) * vScale;

    const pushSample = (uFrac: number, yLocal: number, uUv: number) => {
      const zLocal = st.sweepZ + uFrac * st.chord - pivotZ;
      const zRot = zLocal * cosTw - yLocal * sinTw + pivotZ;
      const yRot = zLocal * sinTw + yLocal * cosTw + st.dihedralY;
      positions.push(x, yRot, zRot);
      uvs.push(uUv * uScale, vCoord);
    };

    // Upper skin: TE (u=1) -> LE (u=0)
    for (let k = chordSegments; k >= 0; k--) {
      const uFrac = chordU[k];
      const { yUpper } = sampleSupersonicAirfoil(
        uFrac,
        st.thicknessRatio,
        camber,
        bevelFactor,
        minTrailingHalfThickness,
        st.chord,
      );
      pushSample(uFrac, yUpper, uFrac * 0.5);
    }

    // Lower skin: LE (skip duplicate k=0) -> TE (u=1)
    for (let k = 1; k <= chordSegments; k++) {
      const uFrac = chordU[k];
      const { yLower } = sampleSupersonicAirfoil(
        uFrac,
        st.thicknessRatio,
        camber,
        bevelFactor,
        minTrailingHalfThickness,
        st.chord,
      );
      pushSample(uFrac, yLower, 0.5 + uFrac * 0.5);
    }
  }

  const pushTri = (a: number, b: number, c: number) => {
    if (side >= 0) {
      indices.push(a, b, c);
    } else {
      indices.push(a, c, b);
    }
  };

  for (let i = 0; i < spanCount - 1; i++) {
    const rowA = i * ringCount;
    const rowB = (i + 1) * ringCount;
    for (let j = 0; j < ringCount - 1; j++) {
      const a = rowA + j;
      const b = rowB + j;
      const c = rowA + j + 1;
      const d = rowB + j + 1;
      pushTri(a, b, c);
      pushTri(b, d, c);
    }
    // Close trailing edge strip cleanly between j = ringCount - 1 (lower TE) and j = 0 (upper TE)
    const aTE = rowA + ringCount - 1;
    const bTE = rowB + ringCount - 1;
    const cTE = rowA;
    const dTE = rowB;
    pushTri(aTE, bTE, cTE);
    pushTri(bTE, dTE, cTE);
  }

  // Cap helper using centroid fan with clean separate vertices for crisp tip bevel normals
  const addSpanCap = (stationIdx: number, isTip: boolean) => {
    const row = stationIdx * ringCount;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const count = ringCount;
    for (let j = 0; j < count; j++) {
      const base = (row + j) * 3;
      cx += positions[base];
      cy += positions[base + 1];
      cz += positions[base + 2];
    }
    cx /= count;
    cy /= count;
    cz /= count;

    const vUv = isTip ? vScale : 0;
    const centerIdx = positions.length / 3;
    positions.push(cx, cy, cz);
    uvs.push(0.5 * uScale, vUv);

    const ringStart = positions.length / 3;
    for (let j = 0; j < count; j++) {
      const base = (row + j) * 3;
      positions.push(positions[base], positions[base + 1], positions[base + 2]);
      uvs.push(uvs[(row + j) * 2], vUv);
    }

    for (let j = 0; j < count; j++) {
      const next = (j + 1) % count;
      if (isTip) {
        pushTri(centerIdx, ringStart + next, ringStart + j);
      } else {
        pushTri(centerIdx, ringStart + j, ringStart + next);
      }
    }
  };

  if (capRoot) addSpanCap(0, false);
  if (capTip) addSpanCap(spanCount - 1, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// 4. CURVED S-DUCT STEALTH INTAKE BUILDER (OUTER COWL + INNER THROAT)
// ---------------------------------------------------------------------------

/**
 * Builds a paired outer stealth cowl + recessed inner S-duct throat geometry.
 * Returns { outer, inner } so the outer cowl receives weathered hull PBR and
 * the recessed inner duct receives dark matte composite shading.
 */
export function buildSductIntakeGeometries(spec: SductIntakeSpec): {
  outer: THREE.BufferGeometry;
  inner: THREE.BufferGeometry;
} {
  const {
    side,
    stations,
    wallThickness = 0.085,
    segments = 24,
    ductDepthFraction = 0.55,
  } = spec;

  const buildShell = (
    stationList: SductIntakeStation[],
    shrink: number,
    flipInward: boolean,
    capRear: boolean,
  ): THREE.BufferGeometry => {
    const ringVerts = segments + 1;
    const count = stationList.length;
    const zMin = stationList[0].z;
    const zSpan = Math.max(1e-4, stationList[count - 1].z - zMin);

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < count; i++) {
      const st = stationList[i];
      const hw = Math.max(0.05, st.halfWidth - shrink);
      const hh = Math.max(0.05, st.halfHeight - shrink);
      const ring = createSuperellipseSection({
        rx: hw,
        ry: hh,
        exp: 3.4,
        topTaper: -0.14,
        cantRad: side * (st.cantRad ?? -0.18),
        segments,
      });

      const topSkew = st.topSkewZ ?? 0;
      const inSkew = st.inboardSkewZ ?? 0;
      const v = (st.z - zMin) / zSpan;

      for (let j = 0; j <= segments; j++) {
        const pt = ring[j % segments];
        const normY = hh > 1e-4 ? pt[1] / hh : 0;
        const normInboard = hw > 1e-4 ? (-side * pt[0]) / hw : 0;
        const zOff = topSkew * normY + inSkew * normInboard;
        positions.push(st.centerX + pt[0], st.centerY + pt[1], st.z + zOff);
        uvs.push(j / segments, v);
      }
    }

    for (let i = 0; i < count - 1; i++) {
      const rowA = i * ringVerts;
      const rowB = (i + 1) * ringVerts;
      for (let j = 0; j < segments; j++) {
        const a = rowA + j;
        const b = rowB + j;
        const c = rowA + j + 1;
        const d = rowB + j + 1;
        if (!flipInward) {
          indices.push(a, b, c, b, d, c);
        } else {
          indices.push(a, c, b, b, c, d);
        }
      }
    }

    // Add crisp bevelled front lip rim connecting outer rim to inner throat on outer mesh
    if (!flipInward) {
      const lipSt = stationList[0];
      const hwIn = Math.max(0.05, lipSt.halfWidth - wallThickness);
      const hhIn = Math.max(0.05, lipSt.halfHeight - wallThickness);
      const innerRing = createSuperellipseSection({
        rx: hwIn,
        ry: hhIn,
        exp: 3.4,
        topTaper: -0.14,
        cantRad: side * (lipSt.cantRad ?? -0.18),
        segments,
      });
      const topSkew = lipSt.topSkewZ ?? 0;
      const inSkew = lipSt.inboardSkewZ ?? 0;

      const lipOuterStart = positions.length / 3;
      for (let j = 0; j <= segments; j++) {
        const base = j * 3;
        positions.push(positions[base], positions[base + 1], positions[base + 2]);
        uvs.push(j / segments, 0);
      }
      const lipInnerStart = positions.length / 3;
      for (let j = 0; j <= segments; j++) {
        const pt = innerRing[j % segments];
        const normY = hhIn > 1e-4 ? pt[1] / hhIn : 0;
        const normInboard = hwIn > 1e-4 ? (-side * pt[0]) / hwIn : 0;
        const zOff = topSkew * normY + inSkew * normInboard;
        positions.push(lipSt.centerX + pt[0], lipSt.centerY + pt[1], lipSt.z + zOff + 0.04);
        uvs.push(j / segments, 0.04);
      }

      // Forward-facing bevel lip ring (-Z outward normal)
      for (let j = 0; j < segments; j++) {
        const o0 = lipOuterStart + j;
        const o1 = lipOuterStart + j + 1;
        const i0 = lipInnerStart + j;
        const i1 = lipInnerStart + j + 1;
        indices.push(o0, o1, i0, o1, i1, i0);
      }
    }

    if (capRear) {
      const last = stationList[count - 1];
      const lastRow = (count - 1) * ringVerts;
      const centerIdx = positions.length / 3;
      positions.push(last.centerX, last.centerY, last.z);
      uvs.push(0.5, 1);
      for (let j = 0; j < segments; j++) {
        if (!flipInward) {
          indices.push(centerIdx, lastRow + j + 1, lastRow + j);
        } else {
          indices.push(centerIdx, lastRow + j, lastRow + j + 1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  };

  const outer = buildShell(stations, 0, false, true);

  // Truncate inner duct right behind the compressor fan stage
  const innerCount = Math.max(2, Math.round(stations.length * ductDepthFraction));
  const innerStations = stations.slice(0, innerCount);
  const inner = buildShell(innerStations, wallThickness, true, true);

  return { outer, inner };
}

// ---------------------------------------------------------------------------
// 5. SEGMENTED TURKEY-FEATHER EXHAUST NOZZLE PETAL BUILDER
// ---------------------------------------------------------------------------

/**
 * Builds a single bevelled, tapered "turkey-feather" exhaust nozzle petal
 * anchored at z = 0 (hinge) extending aft along +Z to z = length.
 */
export function buildNozzlePetalGeometry(spec: NozzlePetalSpec): THREE.BufferGeometry {
  const { length, rootWidth, tipWidth, thickness, arch = 0.04 } = spec;
  const stations: LoftStation[] = [];
  const steps = 4;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const hw = THREE.MathUtils.lerp(rootWidth, tipWidth, t) * 0.5;
    const hh = thickness * (1 - t * 0.42) * 0.5;
    const z = t * length;
    const yArch = Math.sin(t * Math.PI) * arch;

    // 8-point bevelled trapezoidal titanium feather profile (CW in XY)
    const pts: [number, number][] = [
      [0, hh],
      [hw * 0.72, hh * 0.92],
      [hw, 0],
      [hw * 0.78, -hh],
      [0, -hh * 0.92],
      [-hw * 0.78, -hh],
      [-hw, 0],
      [-hw * 0.72, hh * 0.92],
    ];
    stations.push({ z, centerY: yArch, points: pts });
  }

  return buildLoftedGeometry(stations, {
    subdivisionsPerSpan: 1,
    capFront: true,
    capBack: true,
    smoothSeamNormals: false,
  });
}

// ---------------------------------------------------------------------------
// 6. STATIC SUB-MESH BUFFER CONSOLIDATION (DRAW-CALL MERGING)
// ---------------------------------------------------------------------------

export interface MergeGeometryEntry {
  geometry: THREE.BufferGeometry;
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  rotationOrder?: THREE.EulerOrder;
  scale?: readonly [number, number, number];
  matrix?: THREE.Matrix4;
  /** Dispose the input geometry after cloning into the merged buffer. Default: false. */
  disposeSource?: boolean;
}

const _mergePos = new THREE.Vector3();
const _mergeScale = new THREE.Vector3();
const _mergeQuat = new THREE.Quaternion();
const _mergeEuler = new THREE.Euler();
const _mergeMat = new THREE.Matrix4();

/**
 * Bakes transforms into static sub-mesh geometries, normalises attribute sets
 * (position, normal, uv) and index representation, preserves outward triangle
 * winding, and merges them into a single GPU BufferGeometry.
 */
export function mergeSubGeometries(entries: readonly MergeGeometryEntry[]): THREE.BufferGeometry {
  if (entries.length === 0) {
    throw new Error('mergeSubGeometries requires at least 1 entry');
  }

  let anyIndexed = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].geometry.index !== null) {
      anyIndexed = true;
      break;
    }
  }

  const prepared: THREE.BufferGeometry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const clone = entry.geometry.clone();

    if (!clone.hasAttribute('normal')) {
      clone.computeVertexNormals();
    }

    const posAttr = clone.getAttribute('position');
    if (!clone.hasAttribute('uv')) {
      clone.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(posAttr.count * 2), 2));
    }

    // Keep identical attribute layout across all merged parts
    for (const attrName of Object.keys(clone.attributes)) {
      if (attrName !== 'position' && attrName !== 'normal' && attrName !== 'uv') {
        clone.deleteAttribute(attrName);
      }
    }

    let mat: THREE.Matrix4 | null = null;
    if (entry.matrix) {
      mat = entry.matrix;
    } else if (entry.position || entry.rotation || entry.scale) {
      if (entry.position) {
        _mergePos.set(entry.position[0], entry.position[1], entry.position[2]);
      } else {
        _mergePos.set(0, 0, 0);
      }

      if (entry.rotation) {
        _mergeEuler.set(
          entry.rotation[0],
          entry.rotation[1],
          entry.rotation[2],
          entry.rotationOrder ?? 'XYZ',
        );
        _mergeQuat.setFromEuler(_mergeEuler);
      } else {
        _mergeQuat.identity();
      }

      if (entry.scale) {
        _mergeScale.set(entry.scale[0], entry.scale[1], entry.scale[2]);
      } else {
        _mergeScale.set(1, 1, 1);
      }

      _mergeMat.compose(_mergePos, _mergeQuat, _mergeScale);
      mat = _mergeMat;
    }

    if (mat) {
      clone.applyMatrix4(mat);

      // Restore outward CCW triangle winding if transform included an odd reflection
      if (mat.determinant() < 0) {
        if (clone.index) {
          const idxArr = clone.index.array;
          for (let k = 0; k < idxArr.length; k += 3) {
            const tmp = idxArr[k + 1];
            idxArr[k + 1] = idxArr[k + 2];
            idxArr[k + 2] = tmp;
          }
          clone.index.needsUpdate = true;
        } else {
          const count = posAttr.count;
          const idx = new Uint32Array(count);
          for (let k = 0; k < count; k += 3) {
            idx[k] = k;
            idx[k + 1] = k + 2;
            idx[k + 2] = k + 1;
          }
          clone.setIndex(new THREE.BufferAttribute(idx, 1));
          anyIndexed = true;
        }
      }
    }

    if (anyIndexed && !clone.index) {
      const count = posAttr.count;
      const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let k = 0; k < count; k++) idx[k] = k;
      clone.setIndex(new THREE.BufferAttribute(idx, 1));
    }

    prepared.push(clone);
    if (entry.disposeSource) {
      entry.geometry.dispose();
    }
  }

  // Ensure every entry has an index buffer if a reflection added one late
  if (anyIndexed) {
    for (let i = 0; i < prepared.length; i++) {
      const g = prepared[i];
      if (!g.index) {
        const count = g.getAttribute('position').count;
        const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
        for (let k = 0; k < count; k++) idx[k] = k;
        g.setIndex(new THREE.BufferAttribute(idx, 1));
      }
    }
  }

  const merged = mergeGeometries(prepared, false);
  for (let i = 0; i < prepared.length; i++) {
    prepared[i].dispose();
  }

  if (!merged) {
    throw new Error('mergeSubGeometries failed to merge prepared geometries');
  }

  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}
