import * as THREE from 'three';
import { createGlowTexture } from '../aircraft/textures';
import { FighterJet } from '../aircraft/FighterJet';

const FIREBALL_VERT = /* glsl */ `
  varying vec3 vNormal;
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

  void main() {
    vec3 p = position;
    float n1 = noise(normalize(p) * 3.4 + vec3(0.0, -uTime * 1.4, uProgress * 2.5));
    float n2 = noise(normalize(p) * 7.2 - vec3(uTime * 2.2, uProgress * 4.0, 0.0));
    float disp = (n1 * 0.65 + n2 * 0.35);
    vDisp = disp;
    p += normal * (disp - 0.35) * (0.45 + uProgress * 0.75);
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    vViewPos = -mvPos.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const FIREBALL_FRAG = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying float vDisp;
  uniform float uProgress;
  uniform float uTrip;
  uniform float uSupernova;

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    float ndotv = clamp(abs(dot(normalize(vNormal), normalize(vViewPos))), 0.0, 1.0);
    // Cool down from blinding white plasma -> molten orange -> glowing soot
    float heat = clamp((1.0 - uProgress * 0.92) + (vDisp - 0.42) * 0.85, 0.0, 1.4);

    vec3 soot = vec3(0.06, 0.04, 0.05);
    vec3 red = vec3(1.15, 0.22, 0.04);
    vec3 orange = vec3(2.4, 0.88, 0.16);
    vec3 white = vec3(3.8, 3.2, 2.4);

    vec3 col = mix(soot, red, smoothstep(0.12, 0.42, heat));
    col = mix(col, orange, smoothstep(0.38, 0.76, heat));
    col = mix(col, white, smoothstep(0.74, 1.08, heat));

    if (uTrip > 0.15 || uSupernova > 0.5) {
      vec3 prism = hsv2rgb(vec3(fract(vDisp * 2.2 - uProgress * 1.4), 0.95, 1.0)) * 2.4;
      float rim = pow(1.0 - ndotv, 1.6);
      col += prism * rim * max(uTrip * 0.8, uSupernova * 1.1) * (1.0 - uProgress * 0.65);
    }

    float edgeAlpha = smoothstep(0.0, 0.35, ndotv) * (1.0 - smoothstep(0.58, 1.0, uProgress));
    float alpha = clamp(edgeAlpha * (0.65 + vDisp * 0.55), 0.0, 1.0);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

interface ExplosionInstance {
  group: THREE.Group;
  fireball: THREE.Mesh;
  fireballMat: THREE.ShaderMaterial;
  coreSprite: THREE.Sprite;
  shockRing: THREE.Mesh;
  shockRingMat: THREE.MeshBasicMaterial;
  light: THREE.PointLight;
  age: number;
  duration: number;
  maxScale: number;
  supernova: boolean;
}

interface SparkParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  age: number;
  life: number;
  size: number;
  isDebris: boolean;
  rot: THREE.Euler;
  rotSpeed: THREE.Vector3;
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
  trailMat: THREE.MeshBasicMaterial;
  onImpact?: (pos: THREE.Vector3) => void;
}

interface TracerBolt {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
  life: number;
}

interface DecoyFlare {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  sprite: THREE.Sprite;
  age: number;
  life: number;
  smokeTimer: number;
}

interface ContrailRibbon {
  jet: FighterJet;
  leftPts: THREE.Vector3[];
  rightPts: THREE.Vector3[];
  leftMesh: THREE.Mesh;
  rightMesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
}

const MAX_SPARKS = 1400;
const MAX_DEBRIS = 220;
const RIBBON_SEGMENTS = 52;

export class BayhemVFX {
  public readonly group = new THREE.Group();
  public explosionFlash = 0;
  public shockImpact = 0;
  public activeMissiles: GuidedMissile[] = [];

  private readonly glowTex: THREE.CanvasTexture;
  private readonly explosions: ExplosionInstance[] = [];
  private readonly sparks: SparkParticle[] = [];
  private readonly debris: SparkParticle[] = [];
  private readonly sparkInst: THREE.InstancedMesh;
  private readonly debrisInst: THREE.InstancedMesh;
  private readonly tracers: TracerBolt[] = [];
  private readonly flares: DecoyFlare[] = [];
  private readonly contrails: ContrailRibbon[] = [];
  private readonly speedLines: THREE.LineSegments;
  private readonly speedLinesMat: THREE.LineBasicMaterial;
  private readonly dummy = new THREE.Object3D();

  private readonly fireballGeo = new THREE.IcosahedronGeometry(1, 4);
  private readonly shockRingGeo = new THREE.TorusGeometry(1, 0.065, 12, 48);
  private readonly tracerGeo = new THREE.BoxGeometry(0.18, 0.18, 12.5);

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.glowTex = createGlowTexture();

    // Instanced glowing magnesium sparks
    const sparkGeo = new THREE.BoxGeometry(0.35, 0.35, 2.8);
    const sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.sparkInst = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
    this.sparkInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparkInst.frustumCulled = false;
    this.sparkInst.count = 0;
    this.group.add(this.sparkInst);

    // Instanced tumbling charred/flaming aircraft debris shards
    const debrisGeo = new THREE.OctahedronGeometry(0.85, 0);
    debrisGeo.scale(1.8, 0.32, 1.1);
    const debrisMat = new THREE.MeshStandardMaterial({
      color: 0x2a2428,
      emissive: 0xff4c12,
      emissiveIntensity: 1.5,
      roughness: 0.5,
      metalness: 0.8,
    });
    this.debrisInst = new THREE.InstancedMesh(debrisGeo, debrisMat, MAX_DEBRIS);
    this.debrisInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisInst.frustumCulled = false;
    this.debrisInst.count = 0;
    this.group.add(this.debrisInst);

    // High-speed Mach wind streaks around the camera
    const lineCount = 120;
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
      linePositions[i * 6 + 5] = z + 18 + Math.random() * 24;
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
    for (const jet of jets) {
      const makeRibbonGeo = () => {
        const geo = new THREE.BufferGeometry();
        const verts = new Float32Array(RIBBON_SEGMENTS * 2 * 3);
        const indices: number[] = [];
        for (let i = 0; i < RIBBON_SEGMENTS - 1; i++) {
          const a = i * 2;
          const b = a + 1;
          const c = a + 2;
          const d = a + 3;
          indices.push(a, b, c, b, d, c);
        }
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        geo.setIndex(indices);
        return geo;
      };

      const mat = new THREE.MeshBasicMaterial({
        color: jet.role === 'hero' ? 0xdff5ff : jet.role === 'ace' ? 0xff4477 : 0xffaa88,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      const leftMesh = new THREE.Mesh(makeRibbonGeo(), mat);
      const rightMesh = new THREE.Mesh(makeRibbonGeo(), mat);
      leftMesh.frustumCulled = false;
      rightMesh.frustumCulled = false;
      this.group.add(leftMesh, rightMesh);

      this.contrails.push({
        jet,
        leftPts: [],
        rightPts: [],
        leftMesh,
        rightMesh,
        mat,
      });
    }
  }

  public clearDynamic(): void {
    for (const e of this.explosions) {
      this.group.remove(e.group);
    }
    this.explosions.length = 0;

    for (const m of this.activeMissiles) {
      this.group.remove(m.mesh, m.trailMesh);
    }
    this.activeMissiles.length = 0;

    for (const t of this.tracers) {
      this.group.remove(t.mesh);
    }
    this.tracers.length = 0;

    for (const f of this.flares) {
      this.group.remove(f.sprite);
    }
    this.flares.length = 0;

    this.sparks.length = 0;
    this.debris.length = 0;
    this.sparkInst.count = 0;
    this.debrisInst.count = 0;

    for (const c of this.contrails) {
      c.leftPts.length = 0;
      c.rightPts.length = 0;
    }
    this.explosionFlash = 0;
    this.shockImpact = 0;
  }

  public spawnExplosion(
    origin: THREE.Vector3,
    scale = 42,
    supernova = false,
    tripIntensity = 0,
  ): void {
    const g = new THREE.Group();
    g.position.copy(origin);

    const fbMat = new THREE.ShaderMaterial({
      vertexShader: FIREBALL_VERT,
      fragmentShader: FIREBALL_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: Math.random() * 10 },
        uProgress: { value: 0 },
        uTrip: { value: tripIntensity },
        uSupernova: { value: supernova ? 1.0 : 0.0 },
      },
    });
    const fireball = new THREE.Mesh(this.fireballGeo, fbMat);
    fireball.scale.setScalar(scale * 0.12);
    g.add(fireball);

    // Blinding incandescent flash halo
    const coreSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTex,
        color: supernova ? 0xffaaff : 0xffe4aa,
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    coreSprite.scale.setScalar(scale * (supernova ? 5.2 : 3.2));
    g.add(coreSprite);

    // Expanding luminous shockwave ring
    const shockMat = new THREE.MeshBasicMaterial({
      color: supernova ? 0x80f4ff : 0xffb866,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const shockRing = new THREE.Mesh(this.shockRingGeo, shockMat);
    shockRing.rotation.set(Math.random() * 0.8, Math.random() * Math.PI, Math.random() * 0.8);
    shockRing.scale.setScalar(scale * 0.25);
    g.add(shockRing);

    // Blazing transient explosion light illuminating nearby jets & clouds
    const light = new THREE.PointLight(
      supernova ? 0xff77ee : 0xff8828,
      supernova ? 3800 : 1400,
      supernova ? 2400 : 900,
      1.3,
    );
    g.add(light);

    this.group.add(g);
    this.explosions.push({
      group: g,
      fireball,
      fireballMat: fbMat,
      coreSprite,
      shockRing,
      shockRingMat: shockMat,
      light,
      age: 0,
      duration: supernova ? 4.8 : 2.5,
      maxScale: scale,
      supernova,
    });

    // Shower of blazing magnesium sparks
    const sparkCount = supernova ? 420 : 170;
    for (let i = 0; i < sparkCount; i++) {
      if (this.sparks.length >= MAX_SPARKS) break;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const spd = (supernova ? 110 : 55) + Math.random() * (supernova ? 320 : 190);
      const col = new THREE.Color();
      if (supernova || tripIntensity > 0.45) {
        col.setHSL((0.06 + Math.random() * 0.92) % 1.0, 1.0, 0.65);
      } else {
        col.setHSL(0.05 + Math.random() * 0.09, 1.0, 0.58 + Math.random() * 0.32);
      }
      this.sparks.push({
        pos: origin.clone().addScaledVector(dir, Math.random() * scale * 0.15),
        vel: dir.multiplyScalar(spd),
        color: col,
        age: 0,
        life: (supernova ? 1.8 : 1.0) + Math.random() * 1.4,
        size: (supernova ? 1.5 : 0.9) + Math.random() * 1.2,
        isDebris: false,
        rot: new THREE.Euler(),
        rotSpeed: new THREE.Vector3(),
      });
    }

    // Tumbling flaming fuselage debris chunks
    const debrisCount = supernova ? 75 : 28;
    for (let i = 0; i < debrisCount; i++) {
      if (this.debris.length >= MAX_DEBRIS) break;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.2, Math.random() - 0.5).normalize();
      const spd = 45 + Math.random() * (supernova ? 210 : 120);
      this.debris.push({
        pos: origin.clone(),
        vel: dir.multiplyScalar(spd),
        color: new THREE.Color(0xff5522),
        age: 0,
        life: 2.2 + Math.random() * 1.8,
        size: 0.7 + Math.random() * 1.8,
        isDebris: true,
        rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        rotSpeed: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
      });
    }

    this.explosionFlash = Math.min(1.5, this.explosionFlash + (supernova ? 1.4 : 0.75));
    this.shockImpact = Math.min(1.4, this.shockImpact + (supernova ? 1.2 : 0.58));
  }

  public fireVulcanBurst(shooter: FighterJet, targetDir: THREE.Vector3, count = 4): void {
    const muzzleWorld = new THREE.Vector3();
    shooter.gunMuzzle.getWorldPosition(muzzleWorld);
    const baseDir = targetDir.clone().normalize();

    for (let i = 0; i < count; i++) {
      const spread = new THREE.Vector3(
        (Math.random() - 0.5) * 0.032,
        (Math.random() - 0.5) * 0.032,
        (Math.random() - 0.5) * 0.032,
      );
      const dir = baseDir.clone().add(spread).normalize();
      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xffe478 : 0xff7b29,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.tracerGeo, mat);
      mesh.position.copy(muzzleWorld).addScaledVector(dir, i * 16);
      mesh.lookAt(mesh.position.clone().add(dir));
      this.group.add(mesh);

      this.tracers.push({
        mesh,
        vel: dir.multiplyScalar(1150),
        age: 0,
        life: 0.85,
      });
    }

    // Muzzle flash sparks
    for (let i = 0; i < 6; i++) {
      if (this.sparks.length >= MAX_SPARKS) break;
      const jitter = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(45);
      this.sparks.push({
        pos: muzzleWorld.clone(),
        vel: baseDir.clone().multiplyScalar(220).add(jitter),
        color: new THREE.Color(0xffd066),
        age: 0,
        life: 0.14,
        size: 0.85,
        isDebris: false,
        rot: new THREE.Euler(),
        rotSpeed: new THREE.Vector3(),
      });
    }
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
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.16, 3.6, 8),
      new THREE.MeshStandardMaterial({ color: 0xeaf0f8, metalness: 0.65, roughness: 0.3 }),
    );
    body.rotation.x = Math.PI / 2;
    mesh.add(body);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTex,
        color: prism ? 0xff55ee : 0xffaa44,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glow.position.set(0, 0, -2.0);
    glow.scale.setScalar(5.5);
    mesh.add(glow);

    mesh.position.copy(origin);
    this.group.add(mesh);

    // Ribbon trail geometry
    const trailGeo = new THREE.BufferGeometry();
    const maxPts = 64;
    const verts = new Float32Array(maxPts * 2 * 3);
    const indices: number[] = [];
    for (let i = 0; i < maxPts - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    trailGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    trailGeo.setIndex(indices);

    const hue = Math.random();
    const trailMat = new THREE.MeshBasicMaterial({
      color: prism ? new THREE.Color().setHSL(hue, 1.0, 0.65) : new THREE.Color(0xf6f0e8),
      transparent: true,
      opacity: prism ? 0.82 : 0.65,
      side: THREE.DoubleSide,
      blending: prism ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
    });
    const trailMesh = new THREE.Mesh(trailGeo, trailMat);
    trailMesh.frustumCulled = false;
    this.group.add(trailMesh);

    const missile: GuidedMissile = {
      id,
      mesh,
      pos: origin.clone(),
      vel: initialVel.clone(),
      target,
      targetPoint: target ? target.group.position.clone() : origin.clone().addScaledVector(initialVel, 4),
      age: 0,
      maxAge: 6.2,
      speed,
      turnRate: 7.5,
      prism,
      alive: true,
      trailPositions: [origin.clone()],
      trailMesh,
      trailMat,
      onImpact,
    };

    this.activeMissiles.push(missile);
    return missile;
  }

  public popDecoyFlares(jet: FighterJet, count = 8): void {
    const base = jet.group.position.clone();
    const jetVel = jet.velocity.clone().multiplyScalar(0.35);

    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const eject = new THREE.Vector3(
        side * (26 + Math.random() * 28),
        -12 - Math.random() * 20,
        18 + Math.random() * 28,
      ).applyQuaternion(jet.group.quaternion);

      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color: 0xfff0b8,
          transparent: true,
          opacity: 1.0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sprite.scale.setScalar(11 + Math.random() * 5);
      sprite.position.copy(base);
      this.group.add(sprite);

      this.flares.push({
        pos: base.clone(),
        vel: jetVel.clone().add(eject),
        sprite,
        age: 0,
        life: 2.0 + Math.random() * 1.1,
        smokeTimer: 0,
      });
    }
  }

  private updateRibbonGeometry(
    mesh: THREE.Mesh,
    pts: THREE.Vector3[],
    width: number,
    camPos: THREE.Vector3,
  ): void {
    const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const maxPts = posAttr.count / 2;

    if (pts.length < 2) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    const dir = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    const side = new THREE.Vector3();

    for (let i = 0; i < maxPts; i++) {
      const idx = Math.min(i, pts.length - 1);
      const p = pts[idx];
      const next = pts[Math.min(idx + 1, pts.length - 1)];
      const prev = pts[Math.max(idx - 1, 0)];
      dir.subVectors(next, prev);
      if (dir.lengthSq() < 0.0001) dir.set(0, 0, -1);
      dir.normalize();

      toCam.subVectors(camPos, p).normalize();
      side.crossVectors(dir, toCam).normalize();

      const t = i / Math.max(1, pts.length - 1);
      const halfW = width * (0.25 + 0.75 * Math.sin(t * Math.PI));

      const base = i * 6;
      arr[base] = p.x + side.x * halfW;
      arr[base + 1] = p.y + side.y * halfW;
      arr[base + 2] = p.z + side.z * halfW;
      arr[base + 3] = p.x - side.x * halfW;
      arr[base + 4] = p.y - side.y * halfW;
      arr[base + 5] = p.z - side.z * halfW;
    }
    posAttr.needsUpdate = true;
  }

  public update(
    dt: number,
    time: number,
    camera: THREE.PerspectiveCamera,
    tripIntensity: number,
    speedIntensity: number,
  ): void {
    this.explosionFlash = Math.max(0, this.explosionFlash - dt * 2.4);
    this.shockImpact = Math.max(0, this.shockImpact - dt * 1.9);

    // 1. Update volumetric fireballs & shockwave rings
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.age += dt;
      const p = e.age / e.duration;
      if (p >= 1) {
        this.group.remove(e.group);
        this.explosions.splice(i, 1);
        continue;
      }

      const easeOut = 1 - Math.pow(1 - p, 3);
      e.fireball.scale.setScalar(e.maxScale * (0.18 + easeOut * 1.05));
      e.fireball.rotation.y += dt * 0.55;
      e.fireballMat.uniforms.uTime.value = time;
      e.fireballMat.uniforms.uProgress.value = p;
      e.fireballMat.uniforms.uTrip.value = tripIntensity;

      const flashFade = Math.max(0, 1 - p * 3.2);
      (e.coreSprite.material as THREE.SpriteMaterial).opacity = flashFade;
      e.coreSprite.scale.setScalar(e.maxScale * (e.supernova ? 4.8 : 2.8) * (0.6 + p * 1.4));

      e.shockRing.scale.setScalar(e.maxScale * (0.35 + p * (e.supernova ? 11.5 : 4.6)));
      e.shockRingMat.opacity = Math.max(0, 1 - p * 1.35);

      e.light.intensity = (e.supernova ? 3800 : 1400) * Math.pow(Math.max(0, 1 - p * 1.4), 2);
    }

    // 2. Update guided Sidewinder / Macross missiles
    const camPos = camera.position;
    for (let i = this.activeMissiles.length - 1; i >= 0; i--) {
      const m = this.activeMissiles[i];
      m.age += dt;
      if (!m.alive || m.age >= m.maxAge) {
        this.group.remove(m.mesh, m.trailMesh);
        this.activeMissiles.splice(i, 1);
        continue;
      }

      if (m.target && m.target.alive) {
        m.targetPoint.copy(m.target.group.position);
      }

      const toTarget = m.targetPoint.clone().sub(m.pos);
      const dist = toTarget.length();
      if (dist < 22) {
        m.alive = false;
        m.onImpact?.(m.pos.clone());
        this.group.remove(m.mesh, m.trailMesh);
        this.activeMissiles.splice(i, 1);
        continue;
      }

      const desiredDir = toTarget.normalize();
      // Add subtle Macross corkscrew weave early in flight
      if (m.age < 1.2) {
        const spiral = Math.sin(m.age * 16 + i * 1.7) * 0.35 * (1 - m.age / 1.2);
        desiredDir.x += spiral;
        desiredDir.y += Math.cos(m.age * 14 + i * 2.3) * 0.25 * (1 - m.age / 1.2);
        desiredDir.normalize();
      }

      const curDir = m.vel.clone().normalize();
      curDir.lerp(desiredDir, Math.min(1, dt * m.turnRate)).normalize();
      m.vel.copy(curDir).multiplyScalar(m.speed);
      m.pos.addScaledVector(m.vel, dt);

      m.mesh.position.copy(m.pos);
      m.mesh.lookAt(m.pos.clone().add(curDir));

      m.trailPositions.unshift(m.pos.clone());
      if (m.trailPositions.length > 64) m.trailPositions.pop();
      if (m.prism) {
        m.trailMat.color.setHSL((time * 0.35 + i * 0.18) % 1.0, 1.0, 0.62);
      }
      this.updateRibbonGeometry(m.trailMesh, m.trailPositions, m.prism ? 1.85 : 1.15, camPos);
    }

    // 3. Update Vulcan tracers
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.age += dt;
      if (t.age >= t.life) {
        this.group.remove(t.mesh);
        this.tracers.splice(i, 1);
        continue;
      }
      t.mesh.position.addScaledVector(t.vel, dt);
    }

    // 4. Update decoy countermeasure flares
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.age += dt;
      if (f.age >= f.life) {
        this.group.remove(f.sprite);
        this.flares.splice(i, 1);
        continue;
      }
      f.vel.y -= 28 * dt;
      f.vel.multiplyScalar(1 - 0.65 * dt);
      f.pos.addScaledVector(f.vel, dt);
      f.sprite.position.copy(f.pos);
      const fade = 1 - f.age / f.life;
      (f.sprite.material as THREE.SpriteMaterial).opacity = fade;
      f.sprite.scale.setScalar((10 + Math.sin(time * 42 + i) * 2.5) * (0.4 + fade * 0.8));

      // Emit glowing trail embers behind each flare
      f.smokeTimer += dt;
      if (f.smokeTimer > 0.045 && this.sparks.length < MAX_SPARKS) {
        f.smokeTimer = 0;
        this.sparks.push({
          pos: f.pos.clone(),
          vel: new THREE.Vector3((Math.random() - 0.5) * 8, 4, (Math.random() - 0.5) * 8),
          color: new THREE.Color(0xffcc77),
          age: 0,
          life: 0.45,
          size: 0.65,
          isDebris: false,
          rot: new THREE.Euler(),
          rotSpeed: new THREE.Vector3(),
        });
      }
    }

    // 5. Update instanced sparks
    let sparkCount = 0;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.sparks.splice(i, 1);
        continue;
      }
      s.vel.y -= 24 * dt;
      s.vel.multiplyScalar(1 - 0.55 * dt);
      s.pos.addScaledVector(s.vel, dt);

      const scale = s.size * (1 - s.age / s.life);
      this.dummy.position.copy(s.pos);
      this.dummy.lookAt(s.pos.clone().add(s.vel));
      this.dummy.scale.set(scale, scale, scale * (1.2 + s.vel.length() * 0.015));
      this.dummy.updateMatrix();
      this.sparkInst.setMatrixAt(sparkCount, this.dummy.matrix);
      this.sparkInst.setColorAt(sparkCount, s.color);
      sparkCount++;
    }
    this.sparkInst.count = sparkCount;
    this.sparkInst.instanceMatrix.needsUpdate = true;
    if (this.sparkInst.instanceColor) this.sparkInst.instanceColor.needsUpdate = true;

    // 6. Update instanced tumbling flaming debris
    let debrisCount = 0;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age >= d.life) {
        this.debris.splice(i, 1);
        continue;
      }
      d.vel.y -= 48 * dt;
      d.pos.addScaledVector(d.vel, dt);
      d.rot.x += d.rotSpeed.x * dt;
      d.rot.y += d.rotSpeed.y * dt;
      d.rot.z += d.rotSpeed.z * dt;

      const scale = d.size * (1 - (d.age / d.life) * 0.55);
      this.dummy.position.copy(d.pos);
      this.dummy.rotation.copy(d.rot);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      this.debrisInst.setMatrixAt(debrisCount, this.dummy.matrix);
      debrisCount++;
    }
    this.debrisInst.count = debrisCount;
    this.debrisInst.instanceMatrix.needsUpdate = true;

    // 7. Update wingtip contrail ribbons
    const lTip = new THREE.Vector3();
    const rTip = new THREE.Vector3();
    for (let i = 0; i < this.contrails.length; i++) {
      const c = this.contrails[i];
      if (c.jet.alive) {
        c.jet.getWorldWingtips(lTip, rTip);
        c.leftPts.unshift(lTip.clone());
        c.rightPts.unshift(rTip.clone());
      }
      if (c.leftPts.length > RIBBON_SEGMENTS) c.leftPts.pop();
      if (c.rightPts.length > RIBBON_SEGMENTS) c.rightPts.pop();

      if (tripIntensity > 0.12) {
        c.mat.color.setHSL((time * 0.25 + i * 0.19) % 1.0, 0.95, 0.65);
        c.mat.opacity = 0.38 + tripIntensity * 0.34;
      } else {
        c.mat.color.set(c.jet.role === 'hero' ? 0xdff5ff : c.jet.role === 'ace' ? 0xff4477 : 0xffaa88);
        c.mat.opacity = 0.28 + Math.min(0.3, (c.jet.gForce - 1) * 0.05);
      }

      const w = 0.42 + Math.min(0.75, (c.jet.gForce - 1) * 0.12);
      this.updateRibbonGeometry(c.leftMesh, c.leftPts, w, camPos);
      this.updateRibbonGeometry(c.rightMesh, c.rightPts, w, camPos);
    }

    // 8. Speed lines aligned to camera
    this.speedLines.position.copy(camera.position);
    this.speedLines.quaternion.copy(camera.quaternion);
    this.speedLinesMat.opacity = Math.max(0, (speedIntensity - 0.35) * 0.48 + tripIntensity * 0.18);
    if (tripIntensity > 0.2) {
      this.speedLinesMat.color.setHSL((time * 0.4) % 1.0, 0.95, 0.72);
    } else {
      this.speedLinesMat.color.setHex(0xd8f0ff);
    }
  }
}
