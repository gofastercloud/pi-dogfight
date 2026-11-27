import * as THREE from 'three';
import { createHullTextureSet } from './textures';

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

// Cached textures per role so 5 jets share GPU textures cleanly
const textureCache: Partial<Record<FighterRole, ReturnType<typeof createHullTextureSet>>> = {};

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
  private readonly leftWingPivot: THREE.Group;
  private readonly rightWingPivot: THREE.Group;
  private readonly afterburnerMats: THREE.ShaderMaterial[] = [];
  private readonly afterburnerMeshes: THREE.Mesh[] = [];
  private readonly afterburnerLight: THREE.PointLight;
  private readonly vaporMat: THREE.ShaderMaterial;
  private readonly vaporMesh: THREE.Mesh;
  private readonly strobeMeshes: THREE.Mesh[] = [];
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

    if (!textureCache[role]) {
      textureCache[role] = createHullTextureSet(role);
    }
    const texSet = textureCache[role]!;

    const scale = role === 'ace' ? 1.28 : 1.0;
    this.group.scale.setScalar(scale);

    // Primary weathered titanium / obsidian stealth hull
    this.hullMat = new THREE.MeshPhysicalMaterial({
      map: texSet.map,
      bumpMap: texSet.bumpMap,
      bumpScale: 0.045,
      roughnessMap: texSet.roughnessMap,
      roughness: role === 'hero' ? 0.34 : role === 'ace' ? 0.26 : 0.4,
      metalness: role === 'hero' ? 0.82 : 0.72,
      clearcoat: role === 'ace' ? 0.65 : 0.35,
      clearcoatRoughness: 0.22,
      iridescence: role === 'ace' ? 0.35 : 0.12,
      iridescenceIOR: 1.4,
      iridescenceThicknessRange: [160, 520],
    });

    this.darkMat = new THREE.MeshPhysicalMaterial({
      color: role === 'hero' ? 0x222834 : 0x0e0f15,
      roughness: 0.42,
      metalness: 0.88,
      clearcoat: 0.25,
    });

    this.canopyMat = new THREE.MeshPhysicalMaterial({
      color: role === 'hero' ? 0xffd17a : role === 'ace' ? 0xff2850 : 0xff5a36,
      roughness: 0.06,
      metalness: 0.25,
      transmission: 0.55,
      ior: 1.52,
      thickness: 0.35,
      iridescence: 1.0,
      iridescenceIOR: 1.48,
      iridescenceThicknessRange: [220, 680],
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      transparent: true,
      opacity: 0.88,
    });

    this.glowMat = new THREE.MeshStandardMaterial({
      color: role === 'hero' ? 0x62f4ff : 0xff2a48,
      emissive: role === 'hero' ? 0x3ce8ff : 0xff1c3a,
      emissiveIntensity: role === 'ace' ? 3.5 : 2.2,
      roughness: 0.2,
      metalness: 0.1,
    });

    const body = new THREE.Group();
    this.group.add(body);

    // ------------------------------------------------------------------
    // 1. SLEEK CHINED NOSE RADOME & FUSELAGE SPINE (-Z is forward!)
    // ------------------------------------------------------------------
    const nosePts: THREE.Vector2[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const r = Math.pow(t, 0.72) * 1.08;
      const y = (t - 0.5) * 6.8;
      nosePts.push(new THREE.Vector2(Math.max(0.015, r), y));
    }
    const noseGeo = new THREE.LatheGeometry(nosePts, 18);
    noseGeo.rotateX(Math.PI / 2);
    noseGeo.scale(1.18, 0.62, 1.0);
    const noseMesh = new THREE.Mesh(noseGeo, this.hullMat);
    noseMesh.position.set(0, 0.02, -5.8);
    body.add(noseMesh);

    // Pitot probe needle
    const pitot = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.045, 1.5, 8), this.darkMat);
    pitot.rotation.x = Math.PI / 2;
    pitot.position.set(0, 0.02, -9.95);
    body.add(pitot);

    // Central blended lifting-body fuselage
    const fuseGeo = new THREE.BoxGeometry(2.65, 1.15, 8.6);
    const fuseMesh = new THREE.Mesh(fuseGeo, this.hullMat);
    fuseMesh.position.set(0, 0.04, 1.5);
    body.add(fuseMesh);

    // Dorsal avionics spine fairing
    const spineShape = new THREE.Shape();
    spineShape.moveTo(-0.72, 0);
    spineShape.lineTo(-0.42, 0.62);
    spineShape.lineTo(0.42, 0.62);
    spineShape.lineTo(0.72, 0);
    spineShape.closePath();
    const spineGeo = new THREE.ExtrudeGeometry(spineShape, { depth: 7.4, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.12, bevelSegments: 2 });
    spineGeo.translate(0, 0.45, -2.1);
    const spineMesh = new THREE.Mesh(spineGeo, this.hullMat);
    body.add(spineMesh);

    // Twin stealth engine intakes + recessed glowing compressor grilles
    for (const side of [-1, 1]) {
      const intake = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.92, 6.6), this.hullMat);
      intake.position.set(side * 1.48, -0.06, 0.9);
      intake.rotation.z = side * -0.14;
      body.add(intake);

      // Angled intake lip shroud
      const lip = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.96, 1.2), this.darkMat);
      lip.position.set(side * 1.52, -0.06, -2.55);
      lip.rotation.z = side * -0.14;
      lip.rotation.y = side * 0.22;
      body.add(lip);

      // Glowing turbine accent strip inside intake
      const intakeGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.56), this.glowMat);
      intakeGlow.position.set(side * 1.5, -0.06, -3.16);
      intakeGlow.rotation.y = Math.PI;
      body.add(intakeGlow);

      // Leading-edge root extension (LERX) strake
      const lerxShape = new THREE.Shape();
      lerxShape.moveTo(0, 0);
      lerxShape.lineTo(side * 1.45, 3.6);
      lerxShape.lineTo(side * 0.25, 4.4);
      lerxShape.lineTo(0, 0);
      const lerxGeo = new THREE.ExtrudeGeometry(lerxShape, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.05 });
      lerxGeo.rotateX(Math.PI / 2);
      const lerxMesh = new THREE.Mesh(lerxGeo, this.hullMat);
      lerxMesh.position.set(side * 0.85, 0.16, -4.8);
      body.add(lerxMesh);
    }

    // ------------------------------------------------------------------
    // 2. COCKPIT TUB, PILOT HELMET, HOLO HUD & IRIDESCENT BUBBLE CANOPY
    // ------------------------------------------------------------------
    const cockpitTub = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.55, 3.1), this.darkMat);
    cockpitTub.position.set(0, 0.58, -3.45);
    body.add(cockpitTub);

    // Ejection seat & helmeted pilot silhouette
    const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.72, 0.24), this.darkMat);
    seatBack.position.set(0, 0.88, -2.65);
    seatBack.rotation.x = -0.22;
    body.add(seatBack);

    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 14, 12),
      new THREE.MeshPhysicalMaterial({ color: role === 'hero' ? 0xeef3fa : 0x18181f, roughness: 0.15, metalness: 0.7, clearcoat: 1.0 }),
    );
    helmet.position.set(0, 1.02, -3.15);
    body.add(helmet);

    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.245, 12, 10, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.28, Math.PI * 0.35),
      new THREE.MeshPhysicalMaterial({ color: 0xffb833, metalness: 0.95, roughness: 0.08, iridescence: 1.0 }),
    );
    visor.position.copy(helmet.position);
    visor.rotation.y = Math.PI;
    body.add(visor);

    // Interior holographic HUD combiner glass
    const hudGlass = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 0.34),
      new THREE.MeshBasicMaterial({ color: 0x44ffaa, transparent: true, opacity: 0.45, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    hudGlass.position.set(0, 1.04, -4.35);
    hudGlass.rotation.x = -0.45;
    body.add(hudGlass);

    // Sculpted bubble canopy
    const canopyGeo = new THREE.SphereGeometry(1.0, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
    canopyGeo.scale(0.68, 0.78, 2.35);
    const canopyMesh = new THREE.Mesh(canopyGeo, this.canopyMat);
    canopyMesh.position.set(0, 0.56, -3.35);
    body.add(canopyMesh);

    // ------------------------------------------------------------------
    // 3. SWEPT WINGS (VARIABLE SWEEP FOR HERO, FORWARD-SWEPT FOR BANDITS)
    // ------------------------------------------------------------------
    this.leftWingPivot = new THREE.Group();
    this.rightWingPivot = new THREE.Group();
    this.leftWingPivot.position.set(-1.7, 0.1, -0.35);
    this.rightWingPivot.position.set(1.7, 0.1, -0.35);
    body.add(this.leftWingPivot, this.rightWingPivot);

    const buildWing = (side: -1 | 1): THREE.Group => {
      const wg = new THREE.Group();
      const shape = new THREE.Shape();
      if (role === 'hero') {
        // Aggressive F-14/F-22 swept delta wing
        shape.moveTo(0, -1.6);
        shape.lineTo(side * 6.4, 2.45);
        shape.lineTo(side * 6.2, 3.65);
        shape.lineTo(side * 1.4, 3.1);
        shape.lineTo(0, 2.65);
      } else {
        // Menacing Su-47 forward-swept stealth wing!
        shape.moveTo(0, -0.8);
        shape.lineTo(side * 5.6, -2.85);
        shape.lineTo(side * 6.1, -1.75);
        shape.lineTo(side * 2.2, 2.55);
        shape.lineTo(0, 3.2);
      }
      shape.closePath();

      const extrude = new THREE.ExtrudeGeometry(shape, {
        depth: 0.18,
        bevelEnabled: true,
        bevelThickness: 0.055,
        bevelSize: 0.08,
        bevelSegments: 2,
      });
      extrude.rotateX(Math.PI / 2);
      const wingMesh = new THREE.Mesh(extrude, this.hullMat);
      wg.add(wingMesh);

      // Glowing wing-root accent strip (extra intense on Ace)
      if (role !== 'bandit' || Math.abs(side) === 1) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.12), this.glowMat);
        strip.position.set(side * 2.1, 0.09, role === 'hero' ? 1.15 : -0.65);
        strip.rotation.y = role === 'hero' ? side * -0.52 : side * 0.35;
        wg.add(strip);
      }

      // Wingtip missile rail + Sidewinder missile body
      const tipX = side * (role === 'hero' ? 6.25 : 5.75);
      const tipZ = role === 'hero' ? 2.85 : -2.1;
      const missileBody = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 10), this.darkMat);
      missileBody.rotation.x = Math.PI / 2;
      missileBody.position.set(tipX, -0.12, tipZ);
      wg.add(missileBody);

      // Wingtip navigation strobe light
      const strobeColor = side < 0 ? 0xff2244 : 0x22ff88;
      const strobe = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 8, 8),
        new THREE.MeshBasicMaterial({ color: strobeColor }),
      );
      strobe.position.set(tipX, 0.04, tipZ + 0.45);
      wg.add(strobe);
      this.strobeMeshes.push(strobe);

      return wg;
    };

    this.leftWingPivot.add(buildWing(-1));
    this.rightWingPivot.add(buildWing(1));

    // Forward stealth canards on Bandits / Ace
    if (role !== 'hero') {
      for (const side of [-1, 1]) {
        const canardShape = new THREE.Shape();
        canardShape.moveTo(0, -0.5);
        canardShape.lineTo(side * 2.0, 0.6);
        canardShape.lineTo(side * 1.8, 1.15);
        canardShape.lineTo(0, 0.8);
        canardShape.closePath();
        const cGeo = new THREE.ExtrudeGeometry(canardShape, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.03 });
        cGeo.rotateX(Math.PI / 2);
        const canard = new THREE.Mesh(cGeo, this.hullMat);
        canard.position.set(side * 1.15, 0.14, -4.4);
        body.add(canard);
      }
    }

    // ------------------------------------------------------------------
    // 4. TWIN CANTED VERTICAL STABILISERS & HORIZONTAL STABILATORS
    // ------------------------------------------------------------------
    for (const side of [-1, 1]) {
      const finShape = new THREE.Shape();
      finShape.moveTo(0, 0);
      finShape.lineTo(1.8, 2.65);
      finShape.lineTo(3.15, 2.55);
      finShape.lineTo(2.9, 0);
      finShape.closePath();
      const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.04 });
      finGeo.rotateY(-Math.PI / 2);
      const fin = new THREE.Mesh(finGeo, this.hullMat);
      fin.position.set(side * 1.48, 0.45, 2.75);
      fin.rotation.z = side * (role === 'hero' ? -0.34 : -0.52);
      body.add(fin);

      // Horizontal stabilator
      const stabShape = new THREE.Shape();
      stabShape.moveTo(0, -0.8);
      stabShape.lineTo(side * 3.1, 0.85);
      stabShape.lineTo(side * 2.85, 1.65);
      stabShape.lineTo(0, 1.3);
      stabShape.closePath();
      const stabGeo = new THREE.ExtrudeGeometry(stabShape, { depth: 0.11, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.04 });
      stabGeo.rotateX(Math.PI / 2);
      const stab = new THREE.Mesh(stabGeo, this.hullMat);
      stab.position.set(side * 1.38, 0.0, 4.9);
      body.add(stab);
    }

    // ------------------------------------------------------------------
    // 5. TWIN VECTORING NOZZLES & MACH-DIAMOND GLSL AFTERBURNERS
    // ------------------------------------------------------------------
    const coreColor = role === 'hero' ? new THREE.Color(0xc8f4ff) : role === 'ace' ? new THREE.Color(0xff9eff) : new THREE.Color(0xffd2a8);
    const outerColor = role === 'hero' ? new THREE.Color(0xff741c) : role === 'ace' ? new THREE.Color(0xff1058) : new THREE.Color(0xff3314);

    for (const side of [-1, 1]) {
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.74, 1.45, 16, 1, false), this.darkMat);
      nozzle.rotation.x = Math.PI / 2;
      nozzle.position.set(side * 0.92, -0.02, 6.25);
      body.add(nozzle);

      // Glowing inner burner ring
      const burnerCore = new THREE.Mesh(
        new THREE.CircleGeometry(0.56, 16),
        new THREE.MeshBasicMaterial({ color: role === 'hero' ? 0x99f2ff : 0xff5577 }),
      );
      burnerCore.position.set(side * 0.92, -0.02, 6.98);
      body.add(burnerCore);

      // Animated Mach-diamond plasma cone (wide base at nozzle, tapered tip aft)
      const plumeGeo = new THREE.ConeGeometry(0.68, 7.6, 20, 18, true);
      plumeGeo.translate(0, 3.8, 0);
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
      plumeMesh.position.set(side * 0.92, -0.02, 6.9);
      body.add(plumeMesh);
      this.afterburnerMats.push(abMat);
      this.afterburnerMeshes.push(plumeMesh);
    }

    // Dynamic afterburner illumination light on hero & ace (keeps lighting rich & performant)
    this.afterburnerLight = new THREE.PointLight(
      role === 'hero' ? 0xff9438 : 0xff2855,
      role === 'hero' ? 35 : role === 'ace' ? 30 : 12,
      48,
      1.6,
    );
    this.afterburnerLight.position.set(0, 0.2, 8.6);
    body.add(this.afterburnerLight);

    // ------------------------------------------------------------------
    // 6. SUPERSONIC PRANDTL-GLAUERT VAPOR CONE
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
    // 7. ANCHORS FOR CAMERAS, GUNS & WINGTIP CONTRAILS
    // ------------------------------------------------------------------
    // Positioned cleanly above & forward of the opaque canopy sill for an unobstructed cockpit view
    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.position.set(0, 1.85, -4.8);
    body.add(this.cockpitAnchor);

    this.chaseAnchor = new THREE.Object3D();
    this.chaseAnchor.position.set(0, 4.4, 18.5);
    body.add(this.chaseAnchor);

    this.gunMuzzle = new THREE.Object3D();
    this.gunMuzzle.position.set(0.85, -0.25, -6.2);
    body.add(this.gunMuzzle);

    this.wingtipLeft = new THREE.Object3D();
    this.wingtipLeft.position.set(-7.9, 0.15, role === 'hero' ? 2.55 : -2.45);
    body.add(this.wingtipLeft);

    this.wingtipRight = new THREE.Object3D();
    this.wingtipRight.position.set(7.9, 0.15, role === 'hero' ? 2.55 : -2.45);
    body.add(this.wingtipRight);
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
      this.gForce = THREE.MathUtils.lerp(this.gForce, 1.0 + Math.min(11.5, this._accel.length() / 22), 0.14);
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

    // Variable wing sweep on Hero jet based on speed/throttle
    if (this.role === 'hero') {
      const sweep = THREE.MathUtils.clamp((this.throttle - 0.6) * 0.42, 0.0, 0.34);
      this.leftWingPivot.rotation.y = sweep;
      this.rightWingPivot.rotation.y = -sweep;
    }

    // Dynamic afterburner plumes
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

    // Supersonic vapor cone
    this.vaporMat.uniforms.uTime.value = time;
    this.vaporMat.uniforms.uIntensity.value = this.vaporIntensity;
    this.vaporMat.uniforms.uTrip.value = tripIntensity;
    this.vaporMesh.visible = this.vaporIntensity > 0.02;
    const coneScale = 0.85 + this.vaporIntensity * 0.45;
    this.vaporMesh.scale.set(coneScale, coneScale, 0.9 + this.vaporIntensity * 0.35);

    // Oil-slick psychedelic hull iridescence ramp
    this.hullMat.iridescence = THREE.MathUtils.clamp(
      (this.role === 'ace' ? 0.35 : 0.14) + tripIntensity * 0.88,
      0,
      1,
    );
    this.hullMat.iridescenceThicknessRange = [
      160 + tripIntensity * 180,
      460 + tripIntensity * 420,
    ];

    // Strobe blink
    const strobeOn = Math.sin(time * 12 + (this.role === 'hero' ? 0 : 2.1)) > 0.65;
    for (const s of this.strobeMeshes) {
      s.visible = strobeOn;
    }
  }

  public getWorldWingtips(leftOut: THREE.Vector3, rightOut: THREE.Vector3): void {
    this.wingtipLeft.getWorldPosition(leftOut);
    this.wingtipRight.getWorldPosition(rightOut);
  }
}
