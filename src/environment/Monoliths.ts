import * as THREE from 'three';

const CONDUIT_VERT = /* glsl */ `
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

const CONDUIT_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  uniform float uTime;
  uniform float uTrip;
  uniform float uReveal;
  uniform float uLightning;
  uniform float uPhase;

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
    vec3 V = safeNormalize(cameraPosition - vWorldPos);
    vec3 N = safeNormalize(vWorldNormal);
    float ndotv = abs(dot(N, V));
    float fresnel = pow(max(1.0 - ndotv, 1e-4), 2.4);

    // Counter-propagating circumferential energy pulses & glyph-like cadence
    float waveA = sin(vUv.x * 37.6991 - uTime * 4.2 + uPhase) * 0.5 + 0.5;
    float waveB = sin(vUv.x * 75.3982 + uTime * 2.7 - uPhase * 1.6) * 0.5 + 0.5;
    float pulse = pow(max(waveA, 1e-4), 5.0) * 0.78 + pow(max(waveB, 1e-4), 7.0) * 0.45;

    // Rhythmic architectural conduit node segments around the ring
    float segmentGate = smoothstep(0.18, 0.36, abs(sin(vUv.x * 56.5486)));

    // Iridescent LSD prism hue shifting with view angle and orbital phase
    float hue = fract(0.78 + vUv.x * 1.5 + fresnel * 0.36 - uTime * 0.14 + uPhase * 0.19);
    vec3 prismCol = hsv2rgb(vec3(hue, 0.94, 0.92));
    vec3 hotCore = vec3(0.95, 0.88, 1.15);

    // Controlled HDR radiance: crisp glowing neon energy veins without blooming out dark obsidian facets
    float intensity = (0.48 + pulse * 1.18 + fresnel * 0.45 + uLightning * 0.85) * (0.45 + min(uTrip, 1.1) * 0.52);
    vec3 col = mix(prismCol, hotCore, clamp(pulse * 0.45 + uLightning * 0.35, 0.0, 0.72)) * intensity;
    col *= (0.28 + 0.72 * segmentGate) * smoothstep(0.0, 0.35, uReveal);

    gl_FragColor = vec4(clamp(col, 0.0, 4.2), clamp(uReveal, 0.0, 1.0));
  }
`;

interface ShardOrbit {
  group: THREE.Group;
  angleOffset: number;
  orbitRadius: number;
  orbitSpeed: number;
  verticalOffset: number;
  verticalAmp: number;
  verticalFreq: number;
  spinSpeed: number;
  tiltAngle: number;
}

interface MonolithAssembly {
  root: THREE.Group;
  outerRingGroup: THREE.Group;
  innerGimbalGroup: THREE.Group;
  conduitMat: THREE.ShaderMaterial;
  basePosition: THREE.Vector3;
  baseRotSpeedY: number;
  outerSpinZ: number;
  innerSpinX: number;
  shards: ShardOrbit[];
}

/**
 * Builds a faceted, bevelled megastructure ring by sweeping an 8-point chamfered
 * brutalist cross-section around a circle and computing crisp face normals.
 */
function createBevelledRingGeometry(
  majorRadius: number,
  radialHalfWidth: number,
  axialHalfDepth: number,
  radialSegments: number,
  bevelRatio = 0.28,
): THREE.BufferGeometry {
  const w = radialHalfWidth;
  const d = axialHalfDepth;
  const bw = w * (1 - bevelRatio);
  const bd = d * (1 - bevelRatio);

  // Octagonal chamfered profile (rOffset, yOffset)
  const profile: [number, number][] = [
    [-w, -bd],
    [-bw, -d],
    [bw, -d],
    [w, -bd],
    [w, bd],
    [bw, d],
    [-bw, d],
    [-w, bd],
  ];

  const pCount = profile.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let s = 0; s <= radialSegments; s++) {
    const u = s / radialSegments;
    const theta = u * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    for (let p = 0; p <= pCount; p++) {
      const [pr, py] = profile[p % pCount];
      const r = majorRadius + pr;
      positions.push(cosT * r, py, sinT * r);
      uvs.push(u, p / pCount);
    }
  }

  const ringStride = pCount + 1;
  for (let s = 0; s < radialSegments; s++) {
    for (let p = 0; p < pCount; p++) {
      const a = s * ringStride + p;
      const b = (s + 1) * ringStride + p;
      const c = (s + 1) * ringStride + (p + 1);
      const e = s * ringStride + (p + 1);

      indices.push(a, e, b);
      indices.push(b, e, c);
    }
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  indexed.setIndex(indices);

  // Convert to non-indexed so every bevelled architectural facet catches crisp highlights
  const faceted = indexed.toNonIndexed();
  indexed.dispose();
  faceted.computeVertexNormals();
  return faceted;
}

/**
 * Builds a bevelled brutalist geometric obelisk shard (elongated double-pyramid
 * with chamfered hexagonal waist) for orbiting around the monolith rings.
 */
function createBevelledShardGeometry(radius: number, halfHeight: number): THREE.BufferGeometry {
  const sides = 6;
  const waistY = halfHeight * 0.22;
  const shoulderY = halfHeight * 0.68;
  const shoulderR = radius * 0.52;

  const positions: number[] = [];
  const uvs: number[] = [];

  const pushTri = (
    ax: number, ay: number, az: number, au: number, av: number,
    bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number,
  ) => {
    positions.push(ax, ay, az, cx, cy, cz, bx, by, bz);
    uvs.push(au, av, cu, cv, bu, bv);
  };

  for (let i = 0; i < sides; i++) {
    const u0 = i / sides;
    const u1 = (i + 1) / sides;
    const a0 = u0 * Math.PI * 2;
    const a1 = u1 * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);

    // Top apex -> upper bevel shoulder
    pushTri(
      0, halfHeight, 0, 0.5, 1.0,
      c0 * shoulderR, shoulderY, s0 * shoulderR, u0, 0.78,
      c1 * shoulderR, shoulderY, s1 * shoulderR, u1, 0.78,
    );

    // Upper shoulder -> upper waist
    pushTri(
      c0 * shoulderR, shoulderY, s0 * shoulderR, u0, 0.78,
      c0 * radius, waistY, s0 * radius, u0, 0.58,
      c1 * radius, waistY, s1 * radius, u1, 0.58,
    );
    pushTri(
      c0 * shoulderR, shoulderY, s0 * shoulderR, u0, 0.78,
      c1 * radius, waistY, s1 * radius, u1, 0.58,
      c1 * shoulderR, shoulderY, s1 * shoulderR, u1, 0.78,
    );

    // Central bevelled waist band
    pushTri(
      c0 * radius, waistY, s0 * radius, u0, 0.58,
      c0 * radius, -waistY, s0 * radius, u0, 0.42,
      c1 * radius, -waistY, s1 * radius, u1, 0.42,
    );
    pushTri(
      c0 * radius, waistY, s0 * radius, u0, 0.58,
      c1 * radius, -waistY, s1 * radius, u1, 0.42,
      c1 * radius, waistY, s1 * radius, u1, 0.58,
    );

    // Lower waist -> lower bevel shoulder
    pushTri(
      c0 * radius, -waistY, s0 * radius, u0, 0.42,
      c0 * shoulderR, -shoulderY, s0 * shoulderR, u0, 0.22,
      c1 * shoulderR, -shoulderY, s1 * shoulderR, u1, 0.22,
    );
    pushTri(
      c0 * radius, -waistY, s0 * radius, u0, 0.42,
      c1 * shoulderR, -shoulderY, s1 * shoulderR, u1, 0.22,
      c1 * radius, -waistY, s1 * radius, u1, 0.42,
    );

    // Lower shoulder -> bottom apex
    pushTri(
      c0 * shoulderR, -shoulderY, s0 * shoulderR, u0, 0.22,
      0, -halfHeight, 0, 0.5, 0.0,
      c1 * shoulderR, -shoulderY, s1 * shoulderR, u1, 0.22,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

export class Monoliths {
  public readonly group = new THREE.Group();

  private readonly assemblies: MonolithAssembly[] = [];

  constructor() {
    this.group.visible = false;

    const obsidianMat = new THREE.MeshPhysicalMaterial({
      color: 0x060811,
      roughness: 0.16,
      metalness: 0.92,
      iridescence: 0.95,
      iridescenceIOR: 1.55,
      iridescenceThicknessRange: [180, 620],
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      flatShading: true,
    });

    const shardGeo = createBevelledShardGeometry(13.5, 48.0);
    const shardConduitGeo = createBevelledRingGeometry(14.0, 0.9, 1.2, 6, 0.22);
    const pylonGeo = new THREE.BoxGeometry(26, 28, 16);

    const configs = [
      // Central Act IV cathedral arena megastructure framing Cobra & Supernova
      { pos: new THREE.Vector3(0, 520, -1550), radius: 245, tiltX: 0.24, tiltZ: 0.15, shards: 10, phase: 0.0 },
      // Port supercell sentinel ring
      { pos: new THREE.Vector3(-425, 615, -1880), radius: 170, tiltX: -0.35, tiltZ: 0.42, shards: 8, phase: 2.1 },
      // Starboard supercell sentinel ring
      { pos: new THREE.Vector3(465, 575, -1350), radius: 188, tiltX: 0.42, tiltZ: -0.28, shards: 8, phase: 4.2 },
      // Distant monumental horizon halo ring (deep Ridley Scott cathedral depth)
      { pos: new THREE.Vector3(0, 745, -2450), radius: 315, tiltX: 0.18, tiltZ: -0.14, shards: 10, phase: 5.5 },
    ];

    for (let idx = 0; idx < configs.length; idx++) {
      const cfg = configs[idx];
      const root = new THREE.Group();
      root.position.copy(cfg.pos);

      const conduitMat = new THREE.ShaderMaterial({
        vertexShader: CONDUIT_VERT,
        fragmentShader: CONDUIT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uTrip: { value: 0 },
          uReveal: { value: 0 },
          uLightning: { value: 0 },
          uPhase: { value: cfg.phase },
        },
      });

      // 1. Monumental bevelled faceted outer obsidian ring
      const outerRingGroup = new THREE.Group();
      outerRingGroup.rotation.set(cfg.tiltX, 0, cfg.tiltZ);

      const outerBody = new THREE.Mesh(
        createBevelledRingGeometry(cfg.radius, 13.5, 11.0, 36, 0.30),
        obsidianMat,
      );
      // Orient ring into the vertical-tilted cathedral plane
      outerBody.rotation.x = Math.PI / 2;
      outerRingGroup.add(outerBody);

      // Dual recessed pulsing iridescent energy conduits along inner & outer faces
      const innerConduit = new THREE.Mesh(
        createBevelledRingGeometry(cfg.radius - 13.8, 1.6, 1.9, 48, 0.25),
        conduitMat,
      );
      innerConduit.rotation.x = Math.PI / 2;
      outerRingGroup.add(innerConduit);

      const outerConduit = new THREE.Mesh(
        createBevelledRingGeometry(cfg.radius + 13.6, 1.1, 1.4, 48, 0.25),
        conduitMat,
      );
      outerConduit.rotation.x = Math.PI / 2;
      outerRingGroup.add(outerConduit);

      // Brutalist radial monolith buttress clamps around the perimeter (12 per ring)
      const pylonCount = 12;
      const pylonInst = new THREE.InstancedMesh(pylonGeo, obsidianMat, pylonCount);
      const dummy = new THREE.Object3D();
      for (let p = 0; p < pylonCount; p++) {
        const a = (p / pylonCount) * Math.PI * 2;
        const r = cfg.radius + 4.0;
        dummy.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
        dummy.rotation.set(0, 0, a);
        const s = p % 3 === 0 ? 1.35 : 0.92;
        dummy.scale.set(s, 1.0, s);
        dummy.updateMatrix();
        pylonInst.setMatrixAt(p, dummy.matrix);
      }
      pylonInst.instanceMatrix.needsUpdate = true;
      outerRingGroup.add(pylonInst);

      root.add(outerRingGroup);

      // 2. Counter-rotating inner chamfered gimbal ring with glowing plasma channel
      const innerGimbalGroup = new THREE.Group();
      innerGimbalGroup.rotation.set(-cfg.tiltX * 0.7, 0.35, -cfg.tiltZ * 0.8);

      const gimbalRadius = cfg.radius * 0.76;
      const gimbalBody = new THREE.Mesh(
        createBevelledRingGeometry(gimbalRadius, 5.8, 5.2, 24, 0.32),
        obsidianMat,
      );
      gimbalBody.rotation.x = Math.PI / 2;
      innerGimbalGroup.add(gimbalBody);

      const gimbalConduit = new THREE.Mesh(
        createBevelledRingGeometry(gimbalRadius - 5.9, 1.1, 1.3, 36, 0.25),
        conduitMat,
      );
      gimbalConduit.rotation.x = Math.PI / 2;
      innerGimbalGroup.add(gimbalConduit);

      root.add(innerGimbalGroup);

      // 3. Orbiting bevelled obsidian geometric shards with luminous waist conduits
      const shards: ShardOrbit[] = [];
      for (let k = 0; k < cfg.shards; k++) {
        const sg = new THREE.Group();
        const shardBody = new THREE.Mesh(shardGeo, obsidianMat);
        const shardBand = new THREE.Mesh(shardConduitGeo, conduitMat);
        sg.add(shardBody);
        sg.add(shardBand);

        const scaleVar = 0.68 + ((k * 37 + idx * 13) % 10) * 0.075;
        sg.scale.set(scaleVar, scaleVar * (0.9 + (k % 3) * 0.22), scaleVar);
        root.add(sg);

        const angleOffset = (k / cfg.shards) * Math.PI * 2;
        shards.push({
          group: sg,
          angleOffset,
          orbitRadius: cfg.radius + 42 + (k % 3) * 26,
          orbitSpeed: (0.14 + (k % 4) * 0.035) * (idx % 2 === 0 ? 1 : -1),
          verticalOffset: ((k % 5) - 2) * 32,
          verticalAmp: 22 + (k % 3) * 14,
          verticalFreq: 0.45 + (k % 4) * 0.14,
          spinSpeed: (0.35 + (k % 3) * 0.18) * (k % 2 === 0 ? 1 : -1),
          tiltAngle: ((k % 3) - 1) * 0.22,
        });
      }

      this.group.add(root);
      this.assemblies.push({
        root,
        outerRingGroup,
        innerGimbalGroup,
        conduitMat,
        basePosition: cfg.pos.clone(),
        baseRotSpeedY: (0.065 + idx * 0.022) * (idx % 2 === 0 ? 1 : -1),
        outerSpinZ: (0.16 + idx * 0.03) * (idx % 2 === 0 ? 1 : -1),
        innerSpinX: (0.24 + idx * 0.04) * (idx % 2 === 0 ? -1 : 1),
        shards,
      });
    }
  }

  public update(
    time: number,
    _dt: number,
    tripIntensity: number,
    _stormIntensity: number,
    lightningFlash: number,
  ): void {
    // Cleanly reveal colossal monolith rings strictly during Acts III-IV
    const reveal = THREE.MathUtils.smoothstep(tripIntensity, 0.28, 0.62);
    const isVisible = reveal > 0.005;
    this.group.visible = isVisible;
    if (!isVisible) return;

    const emergenceScale = 0.42 + reveal * 0.58;
    const emergenceDrop = (1.0 - reveal) * 110.0;

    for (let i = 0; i < this.assemblies.length; i++) {
      const a = this.assemblies[i];
      a.root.scale.setScalar(emergenceScale);
      a.root.position.set(
        a.basePosition.x,
        a.basePosition.y - emergenceDrop + Math.sin(time * 0.45 + i * 1.4) * 12.0,
        a.basePosition.z,
      );
      a.root.rotation.y = time * a.baseRotSpeedY;

      a.outerRingGroup.rotation.z = time * a.outerSpinZ;
      a.innerGimbalGroup.rotation.x = time * a.innerSpinX;
      a.innerGimbalGroup.rotation.z = -time * a.outerSpinZ * 1.35;

      // Update pulsing iridescent energy conduit shader uniforms
      a.conduitMat.uniforms.uTime.value = time;
      a.conduitMat.uniforms.uTrip.value = tripIntensity;
      a.conduitMat.uniforms.uReveal.value = reveal;
      a.conduitMat.uniforms.uLightning.value = lightningFlash;

      // Update orbiting geometric obsidian shards (zero heap allocations)
      const shards = a.shards;
      for (let k = 0; k < shards.length; k++) {
        const s = shards[k];
        const theta = s.angleOffset + time * s.orbitSpeed;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const bob = Math.sin(time * s.verticalFreq + s.angleOffset * 2.0) * s.verticalAmp;

        s.group.position.set(
          cosT * s.orbitRadius,
          s.verticalOffset + bob + sinT * s.orbitRadius * Math.sin(s.tiltAngle),
          sinT * s.orbitRadius,
        );
        s.group.rotation.set(
          s.tiltAngle * 0.6,
          time * s.spinSpeed + s.angleOffset,
          Math.cos(theta) * 0.18,
        );
      }
    }
  }
}
