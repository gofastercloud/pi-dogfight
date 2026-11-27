import * as THREE from 'three';

export type RibbonStyle = 'contrail' | 'missile' | 'flare';

const DEFAULT_SUN_DIR = new THREE.Vector3(-0.35, 0.18, -0.92).normalize();

const STYLE_CODE: Record<RibbonStyle, number> = {
  contrail: 0,
  missile: 1,
  flare: 2,
};

const RIBBON_VERT = /* glsl */ `
  attribute float aEdge;
  attribute float aProgress;

  varying float vEdge;
  varying float vProgress;
  varying vec3 vWorldPos;

  void main() {
    vEdge = aEdge;
    vProgress = aProgress;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const RIBBON_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uTrip;
  uniform vec3 uSunDir;
  uniform vec3 uBaseColor;
  uniform float uOpacity;
  uniform float uStyle;
  uniform float uPrism;
  uniform float uHueOffset;
  uniform float uFade;

  varying float vEdge;
  varying float vProgress;
  varying vec3 vWorldPos;

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.5);
    return fract(p.x * p.y);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.55;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = rot * p * 2.04;
      a *= 0.48;
    }
    return v;
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    float r = abs(vEdge);
    if (r >= 0.995 || uFade <= 0.005) discard;

    float prog = clamp(vProgress, 0.0, 1.0);
    float cylZ = sqrt(max(1.0 - r * r, 1e-4));

    // Animated smoke turbulence expanding along the wake from tight nozzle to billowing tail
    float scrollSpeed = uStyle > 0.5 && uStyle < 1.5 ? 4.2 : 2.6;
    float freq = uStyle < 0.5 ? 10.0 : 16.0;
    vec2 nUv = vec2(prog * freq - uTime * scrollSpeed + uHueOffset * 13.0, vEdge * 1.9 + sin(prog * 9.0 + uHueOffset * 6.28) * 0.35);
    float turb = fbm2(nUv);

    // Cylindrical volumetric density: crisp core near emitter, wispy billowing smoke near tail
    float edgeSoft = mix(0.28, 0.72, prog);
    float radialDensity = smoothstep(1.0, 1.0 - edgeSoft, r + (0.5 - turb) * (0.22 + prog * 0.42));
    float coreThickness = pow(max(cylZ, 1e-4), 1.15);

    // Sunlit volumetric cross-section shading
    vec3 sunDir = normalize(uSunDir + vec3(1e-5, 0.0, 0.0));
    float sunBias = clamp(0.55 + 0.45 * (cylZ * 0.62 + (vEdge * 0.32 + 0.25) * (0.5 + 0.5 * sunDir.y)), 0.25, 1.25);
    vec3 sunTint = mix(vec3(1.18, 0.92, 0.72), vec3(1.05, 0.78, 1.22), clamp(uTrip * 0.5, 0.0, 0.7));

    vec3 col = uBaseColor;
    float alpha = 0.0;

    if (uStyle < 0.5) {
      // WINGTIP VORTEX CONTRAIL
      float headMask = smoothstep(0.0, 0.04, prog);
      float tailMask = pow(max(1.0 - prog, 1e-4), 1.35);
      float coreHot = pow(max(cylZ, 1e-4), 2.4);
      vec3 baseLit = uBaseColor * sunTint * (0.72 + 0.48 * coreThickness + 0.35 * turb);

      if (uTrip > 0.10 || uPrism > 0.5) {
        float prismAmt = clamp(max(uPrism, (uTrip - 0.10) * 1.1), 0.0, 1.0);
        vec3 rainbow = hsv2rgb(vec3(fract(uHueOffset + prog * 1.6 - uTime * 0.32 + turb * 0.25), 0.92, 1.0)) * 1.85;
        baseLit = mix(baseLit, rainbow, prismAmt * (0.45 + 0.45 * coreHot));
      }

      col = baseLit + vec3(0.45, 0.65, 0.85) * coreHot * 0.45;
      alpha = radialDensity * (0.42 + 0.58 * coreThickness) * headMask * tailMask * uOpacity;
    } else if (uStyle < 1.5) {
      // CURVING SIDEWINDER / MACROSS VOLUMETRIC SMOKE & PRISM RIBBON
      float headMask = smoothstep(0.0, 0.015, prog);
      float tailMask = pow(max(1.0 - prog, 1e-4), 1.05);

      // Blazing rocket motor exhaust ignition right behind the nozzle
      float motorGlow = smoothstep(0.13, 0.0, prog) * pow(max(cylZ, 1e-4), 1.5);
      vec3 ignitionCol = mix(vec3(2.2, 0.78, 0.18), vec3(3.6, 2.8, 1.75), smoothstep(0.07, 0.0, prog));

      // Thick billowing backlit exhaust smoke
      vec3 smokeLit = mix(vec3(0.26, 0.24, 0.30), vec3(0.92, 0.84, 0.78), sunBias * (0.62 + 0.42 * turb)) * sunTint;
      col = mix(smokeLit, ignitionCol, clamp(motorGlow * 0.92, 0.0, 1.0));

      if (uPrism > 0.5 || uTrip > 0.22) {
        float pStrength = uPrism > 0.5 ? 1.0 : clamp((uTrip - 0.22) * 1.15, 0.0, 0.85);
        vec3 prismCol = hsv2rgb(vec3(fract(uHueOffset + prog * 1.85 - uTime * 0.48 + vEdge * 0.18), 0.94, 1.0));
        float streak = pow(max(cylZ, 1e-4), 2.1) * (0.72 + 0.45 * turb);
        col = mix(col, prismCol * 1.48 + smokeLit * 0.35, pStrength * (0.46 + 0.38 * streak));
        col += prismCol * streak * pStrength * 0.55 * (1.0 - prog * 0.58);
      }

      alpha = radialDensity * (0.58 + 0.42 * coreThickness) * headMask * tailMask * uOpacity;
    } else {
      // DECOY COUNTERMEASURE FLARE RIBBON
      float headMask = smoothstep(0.0, 0.02, prog);
      float tailMask = pow(max(1.0 - prog, 1e-4), 1.25);
      float flareCore = smoothstep(0.24, 0.0, prog) * pow(max(cylZ, 1e-4), 1.6);

      vec3 smokeCol = vec3(0.92, 0.85, 0.76) * sunTint * (0.55 + 0.55 * turb) * sunBias;
      vec3 magCore = vec3(4.2, 2.75, 1.1);
      col = mix(smokeCol, magCore, clamp(flareCore * 0.92, 0.0, 1.0));
      alpha = radialDensity * (0.5 + 0.5 * coreThickness) * headMask * tailMask * uOpacity;
    }

    alpha = clamp(alpha * uFade, 0.0, 0.95);
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(clamp(col, 0.0, 12.0), alpha);
  }
`;

export class VolumetricRibbon {
  public readonly mesh: THREE.Mesh;
  public readonly material: THREE.ShaderMaterial;
  public readonly maxPoints: number;

  public active = false;
  public detached = false;
  public fadeAge = 0;
  public fadeDuration = 1.0;
  public style: RibbonStyle = 'missile';
  public prism = false;
  public baseWidth = 1.2;
  public opacity = 0.75;
  public hueOffset = 0;
  public count = 0;

  private readonly spine: Float32Array;
  private readonly posArray: Float32Array;
  private readonly progArray: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly progAttr: THREE.BufferAttribute;
  private readonly baseColor = new THREE.Color(0xf6f0e8);

  constructor(maxPoints: number, style: RibbonStyle, sunDir: THREE.Vector3) {
    this.maxPoints = maxPoints;
    this.style = style;
    this.spine = new Float32Array(maxPoints * 3);

    const vertCount = maxPoints * 2;
    this.posArray = new Float32Array(vertCount * 3);
    this.progArray = new Float32Array(vertCount);
    const edgeArray = new Float32Array(vertCount);
    const indices = new Uint16Array((maxPoints - 1) * 6);

    for (let i = 0; i < maxPoints; i++) {
      edgeArray[i * 2] = 1.0;
      edgeArray[i * 2 + 1] = -1.0;
    }
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      const idx = i * 6;
      indices[idx] = a;
      indices[idx + 1] = a + 1;
      indices[idx + 2] = a + 2;
      indices[idx + 3] = a + 1;
      indices[idx + 4] = a + 3;
      indices[idx + 5] = a + 2;
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.posArray, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.progAttr = new THREE.BufferAttribute(this.progArray, 1);
    this.progAttr.setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aEdge', new THREE.BufferAttribute(edgeArray, 1));
    geo.setAttribute('aProgress', this.progAttr);
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: style === 'contrail' ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uTrip: { value: 0 },
        uSunDir: { value: sunDir },
        uBaseColor: { value: this.baseColor },
        uOpacity: { value: 0.75 },
        uStyle: { value: STYLE_CODE[style] },
        uPrism: { value: 0 },
        uHueOffset: { value: 0 },
        uFade: { value: 1 },
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = style === 'contrail' ? 18 : 22;
  }

  public configure(
    style: RibbonStyle,
    colorHex: number,
    prism: boolean,
    baseWidth: number,
    opacity: number,
    hueOffset = 0,
  ): void {
    this.style = style;
    this.prism = prism;
    this.baseWidth = baseWidth;
    this.opacity = opacity;
    this.hueOffset = hueOffset;
    this.active = true;
    this.detached = false;
    this.fadeAge = 0;
    this.fadeDuration = 1.0;
    this.count = 0;
    this.mesh.visible = false;

    this.baseColor.setHex(colorHex);
    this.material.blending =
      style === 'contrail' ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.uniforms.uStyle.value = STYLE_CODE[style];
    this.material.uniforms.uPrism.value = prism ? 1.0 : 0.0;
    this.material.uniforms.uOpacity.value = opacity;
    this.material.uniforms.uHueOffset.value = hueOffset;
    this.material.uniforms.uFade.value = 1.0;
  }

  public setDynamicAppearance(
    colorHex: number,
    opacity: number,
    baseWidth: number,
    prism: boolean,
    hueOffset?: number,
  ): void {
    this.baseColor.setHex(colorHex);
    this.opacity = opacity;
    this.baseWidth = baseWidth;
    this.prism = prism;
    this.material.uniforms.uOpacity.value = opacity;
    this.material.uniforms.uPrism.value = prism ? 1.0 : 0.0;
    if (hueOffset !== undefined) {
      this.hueOffset = hueOffset;
      this.material.uniforms.uHueOffset.value = hueOffset;
    }
  }

  public reset(): void {
    this.count = 0;
    this.active = false;
    this.detached = false;
    this.fadeAge = 0;
    this.mesh.visible = false;
    this.material.uniforms.uFade.value = 1.0;
  }

  public clearPoints(): void {
    this.count = 0;
    this.mesh.visible = false;
  }

  public detach(fadeDuration = 1.25): void {
    if (!this.active) return;
    this.detached = true;
    this.fadeAge = 0;
    this.fadeDuration = Math.max(0.1, fadeDuration);
  }

  /**
   * Pushes a live emitter position into the ribbon spine without allocating objects.
   * Slot 0 always tracks the exact emitter position; older samples shift back only once
   * the emitter moves beyond minStep so slow-mo never creates degenerate zero-length tangents.
   */
  public pushPoint(x: number, y: number, z: number, minStep = 0.85): void {
    const s = this.spine;
    if (this.count === 0) {
      s[0] = x;
      s[1] = y;
      s[2] = z;
      this.count = 1;
      return;
    }

    if (this.count === 1) {
      const dx = x - s[0];
      const dy = y - s[1];
      const dz = z - s[2];
      if (dx * dx + dy * dy + dz * dz < 1e-4) return;
      s[3] = s[0];
      s[4] = s[1];
      s[5] = s[2];
      s[0] = x;
      s[1] = y;
      s[2] = z;
      this.count = 2;
      return;
    }

    // Distance from previous committed anchor (index 1)
    const dx = x - s[3];
    const dy = y - s[4];
    const dz = z - s[5];
    if (dx * dx + dy * dy + dz * dz >= minStep * minStep) {
      const limit = Math.min(this.count, this.maxPoints - 1);
      for (let i = limit; i >= 1; i--) {
        const dst = i * 3;
        const src = (i - 1) * 3;
        s[dst] = s[src];
        s[dst + 1] = s[src + 1];
        s[dst + 2] = s[src + 2];
      }
      if (this.count < this.maxPoints) {
        this.count++;
      }
    }

    s[0] = x;
    s[1] = y;
    s[2] = z;
  }

  /**
   * Rebuilds smooth, twist-free camera-facing quad strip vertices using
   * parallel-transported side continuity across grazing/head-on view rays.
   */
  public rebuildGeometry(camPos: THREE.Vector3): void {
    if (this.count < 2) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    const s = this.spine;
    const pos = this.posArray;
    const prog = this.progArray;
    const count = this.count;
    const maxPts = this.maxPoints;
    const invSpan = 1 / Math.max(1, count - 1);
    const camX = camPos.x;
    const camY = camPos.y;
    const camZ = camPos.z;

    let prevSideX = 1;
    let prevSideY = 0;
    let prevSideZ = 0;
    let hasPrev = false;

    let lastDirX = 0;
    let lastDirY = 0;
    let lastDirZ = 1;

    for (let i = 0; i < maxPts; i++) {
      const clampedIdx = i < count ? i : count - 1;
      const pOff = clampedIdx * 3;
      const px = s[pOff];
      const py = s[pOff + 1];
      const pz = s[pOff + 2];

      if (i >= count) {
        const vOff = i * 6;
        pos[vOff] = px;
        pos[vOff + 1] = py;
        pos[vOff + 2] = pz;
        pos[vOff + 3] = px;
        pos[vOff + 4] = py;
        pos[vOff + 5] = pz;
        prog[i * 2] = 1;
        prog[i * 2 + 1] = 1;
        continue;
      }

      // Central-difference tangent along ribbon spine
      const prevIdx = clampedIdx > 0 ? clampedIdx - 1 : 0;
      const nextIdx = clampedIdx < count - 1 ? clampedIdx + 1 : count - 1;
      let dx = s[nextIdx * 3] - s[prevIdx * 3];
      let dy = s[nextIdx * 3 + 1] - s[prevIdx * 3 + 1];
      let dz = s[nextIdx * 3 + 2] - s[prevIdx * 3 + 2];
      let dLen = Math.hypot(dx, dy, dz);
      if (dLen < 1e-4) {
        dx = lastDirX;
        dy = lastDirY;
        dz = lastDirZ;
        dLen = 1;
      } else {
        dx /= dLen;
        dy /= dLen;
        dz /= dLen;
        lastDirX = dx;
        lastDirY = dy;
        lastDirZ = dz;
      }

      // View vector from spine point toward camera
      let vx = camX - px;
      let vy = camY - py;
      let vz = camZ - pz;
      const vLen = Math.hypot(vx, vy, vz);
      if (vLen < 1e-4) {
        vx = 0;
        vy = 1;
        vz = 0;
      } else {
        vx /= vLen;
        vy /= vLen;
        vz /= vLen;
      }

      // Camera-facing cross product dir x toCam
      let cx = dy * vz - dz * vy;
      let cy = dz * vx - dx * vz;
      let cz = dx * vy - dy * vx;
      const crossLen = Math.hypot(cx, cy, cz);

      let sideX: number;
      let sideY: number;
      let sideZ: number;

      if (!hasPrev) {
        if (crossLen > 1e-4) {
          sideX = cx / crossLen;
          sideY = cy / crossLen;
          sideZ = cz / crossLen;
        } else {
          // Orthonormal fallback perpendicular to dir
          const refY = Math.abs(dy) < 0.9 ? 1 : 0;
          const refX = refY === 0 ? 1 : 0;
          let fx = dy * 0 - dz * refY;
          let fy = dz * refX - dx * 0;
          let fz = dx * refY - dy * refX;
          const fLen = Math.hypot(fx, fy, fz) || 1;
          sideX = fx / fLen;
          sideY = fy / fLen;
          sideZ = fz / fLen;
        }
        hasPrev = true;
      } else {
        // Parallel-transport previous side onto the plane perpendicular to current tangent
        const dotPD = prevSideX * dx + prevSideY * dy + prevSideZ * dz;
        let tx = prevSideX - dx * dotPD;
        let ty = prevSideY - dy * dotPD;
        let tz = prevSideZ - dz * dotPD;
        let tLen = Math.hypot(tx, ty, tz);
        if (tLen > 1e-5) {
          tx /= tLen;
          ty /= tLen;
          tz /= tLen;
        } else {
          const refY = Math.abs(dy) < 0.9 ? 1 : 0;
          const refX = refY === 0 ? 1 : 0;
          tx = -dz * refY;
          ty = dz * refX;
          tz = dx * refY - dy * refX;
          tLen = Math.hypot(tx, ty, tz) || 1;
          tx /= tLen;
          ty /= tLen;
          tz /= tLen;
        }

        if (crossLen > 1e-4) {
          cx /= crossLen;
          cy /= crossLen;
          cz /= crossLen;

          // Enforce sign continuity with transported frame so ribbon never twists into a bowtie
          if (cx * tx + cy * ty + cz * tz < 0) {
            cx = -cx;
            cy = -cy;
            cz = -cz;
          }

          if (crossLen < 0.25) {
            // Smoothly blend through grazing head-on view rays
            const u = Math.max(0, Math.min(1, (crossLen - 0.03) / 0.22));
            const w = u * u * (3 - 2 * u);
            let bx = tx + (cx - tx) * w;
            let by = ty + (cy - ty) * w;
            let bz = tz + (cz - tz) * w;
            const bLen = Math.hypot(bx, by, bz) || 1;
            sideX = bx / bLen;
            sideY = by / bLen;
            sideZ = bz / bLen;
          } else {
            sideX = cx;
            sideY = cy;
            sideZ = cz;
          }
        } else {
          sideX = tx;
          sideY = ty;
          sideZ = tz;
        }
      }

      prevSideX = sideX;
      prevSideY = sideY;
      prevSideZ = sideZ;

      const t = clampedIdx * invSpan;
      let widthMult: number;
      if (this.style === 'missile') {
        // Tight bright rocket core expanding smoothly into thick billowing wake
        const billow = 0.42 + 1.48 * Math.sqrt(t);
        const tailPinch = 1 - Math.max(0, (t - 0.78) / 0.22) * 0.45;
        widthMult = billow * tailPinch;
      } else if (this.style === 'flare') {
        widthMult = (0.48 + 1.25 * Math.sqrt(t)) * (1 - t * 0.25);
      } else {
        // Contrail vortex: crisp at wingtip, diffusing organically down-wake
        widthMult = (0.52 + 0.92 * t) * (1 - Math.max(0, (t - 0.75) / 0.25) * 0.5);
      }

      const halfW = this.baseWidth * widthMult;
      const vOff = i * 6;
      pos[vOff] = px + sideX * halfW;
      pos[vOff + 1] = py + sideY * halfW;
      pos[vOff + 2] = pz + sideZ * halfW;
      pos[vOff + 3] = px - sideX * halfW;
      pos[vOff + 4] = py - sideY * halfW;
      pos[vOff + 5] = pz - sideZ * halfW;

      prog[i * 2] = t;
      prog[i * 2 + 1] = t;
    }

    this.posAttr.needsUpdate = true;
    this.progAttr.needsUpdate = true;
  }

  public getSpinePointCount(): number {
    return this.count;
  }
}

const MISSILE_RIBBON_POOL_SIZE = 24;
const FLARE_RIBBON_POOL_SIZE = 48;

/**
 * Zero-GC manager for pre-allocated volumetric smoke & prism ribbons:
 *  - Wingtip vortex contrails
 *  - Curving Sidewinder & Macross prism missile wakes (with smooth detached fade-out)
 *  - Decoy countermeasure flare plumes
 */
export class MissileTrailSystem {
  public readonly group = new THREE.Group();

  private readonly sunDir = DEFAULT_SUN_DIR.clone();
  private readonly missilePool: VolumetricRibbon[] = [];
  private readonly flarePool: VolumetricRibbon[] = [];
  private readonly contrailRibbons: VolumetricRibbon[] = [];
  private missileCursor = 0;
  private flareCursor = 0;

  constructor(parent: THREE.Object3D) {
    this.group.name = 'MissileTrailSystem';
    parent.add(this.group);

    for (let i = 0; i < MISSILE_RIBBON_POOL_SIZE; i++) {
      const r = new VolumetricRibbon(72, 'missile', this.sunDir);
      this.group.add(r.mesh);
      this.missilePool.push(r);
    }

    for (let i = 0; i < FLARE_RIBBON_POOL_SIZE; i++) {
      const r = new VolumetricRibbon(32, 'flare', this.sunDir);
      this.group.add(r.mesh);
      this.flarePool.push(r);
    }
  }

  public createContrailRibbon(colorHex: number, hueOffset = 0): VolumetricRibbon {
    const r = new VolumetricRibbon(56, 'contrail', this.sunDir);
    r.configure('contrail', colorHex, false, 0.52, 0.42, hueOffset);
    this.group.add(r.mesh);
    this.contrailRibbons.push(r);
    return r;
  }

  public acquireMissileRibbon(prism: boolean, hueOffset: number): VolumetricRibbon {
    // Prefer an inactive slot first, otherwise recycle oldest detached or ring slot
    let chosen: VolumetricRibbon | null = null;
    for (let i = 0; i < this.missilePool.length; i++) {
      const idx = (this.missileCursor + i) % this.missilePool.length;
      if (!this.missilePool[idx].active) {
        chosen = this.missilePool[idx];
        this.missileCursor = (idx + 1) % this.missilePool.length;
        break;
      }
    }
    if (!chosen) {
      chosen = this.missilePool[this.missileCursor];
      this.missileCursor = (this.missileCursor + 1) % this.missilePool.length;
    }

    const baseColorHex = prism ? 0xffffff : 0xf4eee6;
    chosen.configure('missile', baseColorHex, prism, prism ? 1.95 : 1.35, prism ? 0.90 : 0.78, hueOffset);
    return chosen;
  }

  public acquireFlareRibbon(hueOffset = 0): VolumetricRibbon {
    let chosen: VolumetricRibbon | null = null;
    for (let i = 0; i < this.flarePool.length; i++) {
      const idx = (this.flareCursor + i) % this.flarePool.length;
      if (!this.flarePool[idx].active) {
        chosen = this.flarePool[idx];
        this.flareCursor = (idx + 1) % this.flarePool.length;
        break;
      }
    }
    if (!chosen) {
      chosen = this.flarePool[this.flareCursor];
      this.flareCursor = (this.flareCursor + 1) % this.flarePool.length;
    }

    chosen.configure('flare', 0xffdfa8, false, 0.95, 0.72, hueOffset);
    return chosen;
  }

  public clearDynamic(): void {
    for (let i = 0; i < this.missilePool.length; i++) {
      this.missilePool[i].reset();
    }
    for (let i = 0; i < this.flarePool.length; i++) {
      this.flarePool[i].reset();
    }
    for (let i = 0; i < this.contrailRibbons.length; i++) {
      this.contrailRibbons[i].clearPoints();
    }
    this.missileCursor = 0;
    this.flareCursor = 0;
  }

  public update(
    dt: number,
    time: number,
    camPos: THREE.Vector3,
    tripIntensity: number,
  ): void {
    const safeDt = Math.max(0, Math.min(dt, 0.05));

    // Update contrail shader uniforms
    for (let i = 0; i < this.contrailRibbons.length; i++) {
      const r = this.contrailRibbons[i];
      r.material.uniforms.uTime.value = time;
      r.material.uniforms.uTrip.value = tripIntensity;
    }

    // Update active & lingering missile ribbons
    for (let i = 0; i < this.missilePool.length; i++) {
      const r = this.missilePool[i];
      if (!r.active) continue;
      r.material.uniforms.uTime.value = time;
      r.material.uniforms.uTrip.value = tripIntensity;
      if (r.detached) {
        r.fadeAge += safeDt;
        const fade = Math.max(0, 1 - r.fadeAge / r.fadeDuration);
        r.material.uniforms.uFade.value = fade;
        if (fade <= 0.005) {
          r.reset();
        } else {
          r.rebuildGeometry(camPos);
        }
      }
    }

    // Update active & lingering flare ribbons
    for (let i = 0; i < this.flarePool.length; i++) {
      const r = this.flarePool[i];
      if (!r.active) continue;
      r.material.uniforms.uTime.value = time;
      r.material.uniforms.uTrip.value = tripIntensity;
      if (r.detached) {
        r.fadeAge += safeDt;
        const fade = Math.max(0, 1 - r.fadeAge / r.fadeDuration);
        r.material.uniforms.uFade.value = fade;
        if (fade <= 0.005) {
          r.reset();
        } else {
          r.rebuildGeometry(camPos);
        }
      }
    }
  }
}
