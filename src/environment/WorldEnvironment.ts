import * as THREE from 'three';
import { SkyAndClouds } from './SkyAndClouds';
import { Monoliths } from './Monoliths';

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
    col += vec3(0.55, 0.42, 1.15) * uLightning * fresnel * 0.85;

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

export class WorldEnvironment {
  public readonly group = new THREE.Group();
  public readonly sunDirection = new THREE.Vector3(-0.35, 0.18, -0.92).normalize();
  public readonly sunLight: THREE.DirectionalLight;
  public readonly rimLight: THREE.DirectionalLight;
  public readonly hemiLight: THREE.HemisphereLight;
  public readonly lightningLight: THREE.DirectionalLight;

  private readonly skyAndClouds: SkyAndClouds;
  private readonly monoliths: Monoliths;
  private readonly oceanMesh: THREE.Mesh;
  private readonly oceanMat: THREE.ShaderMaterial;

  private shockOrigin = new THREE.Vector3();
  private shockRadius = 9999;
  private shockStrength = 0;

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
    // 3. TWIN-ECLIPSE SKY, VOLUMETRIC CLOUDS, GOD-RAYS & 3D LIGHTNING
    // ------------------------------------------------------------------
    this.skyAndClouds = new SkyAndClouds(this.sunDirection);
    this.group.add(this.skyAndClouds.group);

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
    // 6. FLOATING IRIDESCENT OBSIDIAN MONOLITH RINGS (ACTS III-IV)
    // ------------------------------------------------------------------
    this.monoliths = new Monoliths();
    this.group.add(this.monoliths.group);
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
    // Keep ocean grid snapped around camera
    const snap = 14000 / 150;
    this.oceanMesh.position.x = Math.round(cameraPos.x / snap) * snap;
    this.oceanMesh.position.z = Math.round(cameraPos.z / snap) * snap;

    // Expand ocean shockwave ring
    if (this.shockStrength > 0.005) {
      this.shockRadius += dt * 420;
      this.shockStrength = Math.max(0, this.shockStrength - dt * 0.42);
    }

    // Update sky dome, volumetric cloud cathedrals, god-rays, and 3D branching lightning
    this.skyAndClouds.update(time, dt, cameraPos, stormIntensity, tripIntensity, explosionFlash);
    const lightningFlash = this.skyAndClouds.lightningFlash;

    // Update ocean uniforms
    this.oceanMat.uniforms.uTime.value = time;
    this.oceanMat.uniforms.uStorm.value = stormIntensity;
    this.oceanMat.uniforms.uTrip.value = tripIntensity;
    this.oceanMat.uniforms.uLightning.value = lightningFlash;
    this.oceanMat.uniforms.uShockOrigin.value.copy(this.shockOrigin);
    this.oceanMat.uniforms.uShockRadius.value = this.shockRadius;
    this.oceanMat.uniforms.uShockStrength.value = this.shockStrength;

    // Dynamic lights synced with eclipse sky, psychedelic trip, and supercell lightning
    this.sunLight.color.setRGB(
      1.0,
      THREE.MathUtils.lerp(0.68, 0.48, tripIntensity * 0.6),
      THREE.MathUtils.lerp(0.36, 0.85, tripIntensity * 0.5),
    );
    this.sunLight.intensity = 3.6 - stormIntensity * 1.1 + explosionFlash * 2.2;
    this.rimLight.color.setHSL(
      (0.54 + tripIntensity * 0.32 * Math.sin(time * 0.45) + 1.0) % 1.0,
      0.88,
      0.62,
    );
    this.rimLight.intensity = 1.65 + tripIntensity * 1.85;
    this.lightningLight.intensity = lightningFlash * 7.8;
    if (lightningFlash > 0.01) {
      this.lightningLight.position.copy(this.skyAndClouds.lightningWorldPos);
      this.lightningLight.color.setHSL(tripIntensity > 0.3 ? 0.54 : 0.74, 0.9, 0.78);
    }

    // Update floating obsidian monolith megastructure rings (Acts III-IV)
    this.monoliths.update(time, dt, tripIntensity, stormIntensity, lightningFlash);
  }
}
