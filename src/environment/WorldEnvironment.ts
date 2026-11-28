import * as THREE from 'three';
import { SkyAndClouds } from './SkyAndClouds';
import { OceanSurface } from './OceanSurface';
import { SeaStacks } from './SeaStacks';
import { Monoliths } from './Monoliths';

export class WorldEnvironment {
  public readonly group = new THREE.Group();
  public readonly sunDirection = new THREE.Vector3(-0.35, 0.18, -0.92).normalize();
  public readonly sunLight: THREE.DirectionalLight;
  public readonly rimLight: THREE.DirectionalLight;
  public readonly hemiLight: THREE.HemisphereLight;
  public readonly lightningLight: THREE.DirectionalLight;

  private readonly sceneRef: THREE.Scene;
  private readonly skyAndClouds: SkyAndClouds;
  private readonly oceanSurface: OceanSurface;
  private readonly seaStacks: SeaStacks;
  private readonly monoliths: Monoliths;

  // Pre-allocated hero tracking scratch state (zero per-frame heap allocations)
  private cachedHeroObject: THREE.Object3D | null = null;
  private heroLookupAttempts = 0;
  private readonly explicitHeroPos = new THREE.Vector3(0, 9999, 0);
  private readonly explicitHeroFwd = new THREE.Vector3(0, 0, -1);
  private hasExplicitHeroPos = false;
  private hasExplicitHeroFwd = false;
  private readonly resolvedHeroPos = new THREE.Vector3(0, 9999, 0);
  private readonly resolvedHeroFwd = new THREE.Vector3(0, 0, -1);
  private readonly prevHeroPos = new THREE.Vector3(0, 9999, 0);
  private hasPrevHeroPos = false;
  private readonly _deltaHero = new THREE.Vector3();

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.sceneRef = scene;
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
    // 4. 8-WAVE GERSTNER OCEAN, SHOCKWAVE RINGS & LOW-ALTITUDE SEA-SPRAY
    // ------------------------------------------------------------------
    this.oceanSurface = new OceanSurface(this.sunDirection);
    this.group.add(this.oceanSurface.group);

    // ------------------------------------------------------------------
    // 5. CLUSTERED HEXAGONAL COLUMNAR BASALT SEA-STACKS & SEA-MIST COLLARS
    // ------------------------------------------------------------------
    this.seaStacks = new SeaStacks(this.sunDirection);
    this.group.add(this.seaStacks.group);

    // ------------------------------------------------------------------
    // 6. FLOATING IRIDESCENT OBSIDIAN MONOLITH RINGS (ACTS III-IV)
    // ------------------------------------------------------------------
    this.monoliths = new Monoliths();
    this.group.add(this.monoliths.group);
  }

  public triggerOceanShockwave(origin: THREE.Vector3, strength = 1.0): void {
    this.oceanSurface.triggerShockwave(origin, strength);
  }

  public setHeroPosition(pos: THREE.Vector3, forward?: THREE.Vector3): void {
    this.explicitHeroPos.copy(pos);
    this.hasExplicitHeroPos = true;
    if (forward && forward.lengthSq() > 1e-6) {
      this.explicitHeroFwd.copy(forward).normalize();
      this.hasExplicitHeroFwd = true;
    } else {
      this.hasExplicitHeroFwd = false;
    }
  }

  private resolveHeroMotion(heroPos?: THREE.Vector3, heroForward?: THREE.Vector3): void {
    if (heroPos) {
      this.resolvedHeroPos.copy(heroPos);
      if (heroForward && heroForward.lengthSq() > 1e-6) {
        this.resolvedHeroFwd.copy(heroForward).normalize();
      } else if (this.hasPrevHeroPos) {
        this._deltaHero.subVectors(this.resolvedHeroPos, this.prevHeroPos);
        if (this._deltaHero.lengthSq() > 1e-4) {
          this.resolvedHeroFwd.copy(this._deltaHero).normalize();
        }
      }
      this.prevHeroPos.copy(this.resolvedHeroPos);
      this.hasPrevHeroPos = true;
      return;
    }

    if (this.hasExplicitHeroPos) {
      this.resolvedHeroPos.copy(this.explicitHeroPos);
      if (this.hasExplicitHeroFwd) {
        this.resolvedHeroFwd.copy(this.explicitHeroFwd);
      } else if (this.hasPrevHeroPos) {
        this._deltaHero.subVectors(this.resolvedHeroPos, this.prevHeroPos);
        if (this._deltaHero.lengthSq() > 1e-4) {
          this.resolvedHeroFwd.copy(this._deltaHero).normalize();
        }
      }
      this.prevHeroPos.copy(this.resolvedHeroPos);
      this.hasPrevHeroPos = true;
      return;
    }

    // Lazily bind to VIPER-1 in the scene graph if caller did not explicitly pass heroPos
    if (!this.cachedHeroObject && this.heroLookupAttempts < 4) {
      this.heroLookupAttempts++;
      this.cachedHeroObject = this.sceneRef.getObjectByName('Fighter_viper1') ?? null;
    }

    if (this.cachedHeroObject) {
      this.resolvedHeroPos.copy(this.cachedHeroObject.position);
      this.resolvedHeroFwd.set(0, 0, -1).applyQuaternion(this.cachedHeroObject.quaternion);
      this.prevHeroPos.copy(this.resolvedHeroPos);
      this.hasPrevHeroPos = true;
    } else {
      this.resolvedHeroPos.set(0, 9999, 0);
    }
  }

  public update(
    time: number,
    dt: number,
    cameraPos: THREE.Vector3,
    stormIntensity: number,
    tripIntensity: number,
    explosionFlash: number,
    heroPos?: THREE.Vector3,
    heroForward?: THREE.Vector3,
  ): void {
    // Update sky dome, volumetric cloud cathedrals, god-rays, and 3D branching lightning
    this.skyAndClouds.update(time, dt, cameraPos, stormIntensity, tripIntensity, explosionFlash);
    const lightningFlash = this.skyAndClouds.lightningFlash;

    // Resolve hero jet kinematics for low-altitude rooster-tail sea-spray wake (< 95 altitude)
    this.resolveHeroMotion(heroPos, heroForward);

    // Update 8-wave Gerstner ocean, expanding shockwave rings & rooster-tail spray
    this.oceanSurface.update(
      time,
      dt,
      cameraPos,
      stormIntensity,
      tripIntensity,
      lightningFlash,
      explosionFlash,
      this.resolvedHeroPos,
      this.resolvedHeroFwd,
    );

    // Update tri-planar columnar basalt sea-stacks & drifting sea-mist collars
    this.seaStacks.update(time, stormIntensity, tripIntensity, lightningFlash, explosionFlash);

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
