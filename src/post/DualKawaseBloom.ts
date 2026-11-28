import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const KAWASE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 5-tap Dual-Kawase downsample shader with pre-downsample NaN/Inf HDR sanitisation,
// soft-knee luminance threshold, and Karis firefly suppression on mip level 0.
const KAWASE_DOWNSAMPLE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uHalfPixel;
  uniform float uPrefilter;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;

  float sanitiseVal(float v) {
    return (isnan(v) || isinf(v)) ? 0.0 : clamp(v, 0.0, 64.0);
  }

  vec3 sampleSanitised(vec2 uv) {
    vec3 c = texture2D(tDiffuse, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb;
    return vec3(sanitiseVal(c.r), sanitiseVal(c.g), sanitiseVal(c.b));
  }

  vec3 softKneeThreshold(vec3 col) {
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float peak = max(col.r, max(col.g, col.b));
    float brightness = max(lum, peak * 0.78);
    float safeKnee = max(uKnee, 1e-4);
    float rq = clamp(brightness - uThreshold + safeKnee, 0.0, 2.0 * safeKnee);
    float soft = (rq * rq) / max(4.0 * safeKnee, 1e-4);
    float contrib = max(brightness - uThreshold, soft) / max(brightness, 1e-4);
    return min(col * contrib, vec3(16.0));
  }

  void main() {
    // 5-tap Dual-Kawase downsample kernel (centre + 4 bilinear half-pixel corners)
    vec3 c0 = sampleSanitised(vUv);
    vec3 c1 = sampleSanitised(vUv + vec2(-uHalfPixel.x, -uHalfPixel.y));
    vec3 c2 = sampleSanitised(vUv + vec2( uHalfPixel.x, -uHalfPixel.y));
    vec3 c3 = sampleSanitised(vUv + vec2(-uHalfPixel.x,  uHalfPixel.y));
    vec3 c4 = sampleSanitised(vUv + vec2( uHalfPixel.x,  uHalfPixel.y));

    vec3 outCol;
    if (uPrefilter > 0.5) {
      c0 = softKneeThreshold(c0);
      c1 = softKneeThreshold(c1);
      c2 = softKneeThreshold(c2);
      c3 = softKneeThreshold(c3);
      c4 = softKneeThreshold(c4);

      // Karis luma average prevents single-pixel HDR firefly shimmer during jet rolls
      float w0 = 4.0 / (1.0 + dot(c0, vec3(0.2126, 0.7152, 0.0722)));
      float w1 = 1.0 / (1.0 + dot(c1, vec3(0.2126, 0.7152, 0.0722)));
      float w2 = 1.0 / (1.0 + dot(c2, vec3(0.2126, 0.7152, 0.0722)));
      float w3 = 1.0 / (1.0 + dot(c3, vec3(0.2126, 0.7152, 0.0722)));
      float w4 = 1.0 / (1.0 + dot(c4, vec3(0.2126, 0.7152, 0.0722)));
      float wSum = max(w0 + w1 + w2 + w3 + w4, 1e-4);
      outCol = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3 + c4 * w4) / wSum;
    } else {
      outCol = c0 * 0.5 + (c1 + c2 + c3 + c4) * 0.125;
    }

    gl_FragColor = vec4(clamp(outCol, 0.0, 24.0), 1.0);
  }
`;

// 8-tap Dual-Kawase tent upsample shader blended additively into the next finer mip level.
const KAWASE_UPSAMPLE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uHalfPixel;
  uniform float uScatter;
  varying vec2 vUv;

  float sanitiseVal(float v) {
    return (isnan(v) || isinf(v)) ? 0.0 : clamp(v, 0.0, 24.0);
  }

  vec3 sampleSanitised(vec2 uv) {
    vec3 c = texture2D(tDiffuse, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb;
    return vec3(sanitiseVal(c.r), sanitiseVal(c.g), sanitiseVal(c.b));
  }

  void main() {
    vec3 acc = vec3(0.0);
    acc += sampleSanitised(vUv + vec2(-uHalfPixel.x * 2.0, 0.0));
    acc += sampleSanitised(vUv + vec2(-uHalfPixel.x,  uHalfPixel.y)) * 2.0;
    acc += sampleSanitised(vUv + vec2(0.0,  uHalfPixel.y * 2.0));
    acc += sampleSanitised(vUv + vec2( uHalfPixel.x,  uHalfPixel.y)) * 2.0;
    acc += sampleSanitised(vUv + vec2( uHalfPixel.x * 2.0, 0.0));
    acc += sampleSanitised(vUv + vec2( uHalfPixel.x, -uHalfPixel.y)) * 2.0;
    acc += sampleSanitised(vUv + vec2(0.0, -uHalfPixel.y * 2.0));
    acc += sampleSanitised(vUv + vec2(-uHalfPixel.x, -uHalfPixel.y)) * 2.0;

    vec3 col = (acc / 12.0) * clamp(uScatter, 0.0, 1.5);
    gl_FragColor = vec4(clamp(col, 0.0, 24.0), 1.0);
  }
`;

export interface DualKawaseBloomOptions {
  strength?: number;
  radius?: number;
  threshold?: number;
  knee?: number;
}

const MIP_LEVELS = 4;

/**
 * Bandwidth-efficient 4-level Dual-Kawase HDR bloom pyramid (5-tap downsample,
 * 8-tap tent upsample with hardware additive blending across mips 1/2 -> 1/16).
 * Sanitises NaN/Inf radiance pre-downsample and exposes its half-resolution
 * bloom texture directly for single-pass compositing in PostPipeline.
 */
export class DualKawaseBloom extends Pass {
  public strength: number;
  public radius: number;
  public threshold: number;
  public knee: number;
  public readonly resolution: THREE.Vector2;

  private readonly mips: THREE.WebGLRenderTarget[] = [];
  private readonly downsampleMaterial: THREE.ShaderMaterial;
  private readonly upsampleMaterial: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;

  private readonly _clearColor = new THREE.Color(0, 0, 0);
  private readonly _oldClearColor = new THREE.Color();

  constructor(width: number, height: number, options: DualKawaseBloomOptions = {}) {
    super();

    const safeW = Math.max(1, Math.round(width));
    const safeH = Math.max(1, Math.round(height));

    this.strength = options.strength ?? 0.56;
    this.radius = options.radius ?? 0.48;
    this.threshold = options.threshold ?? 0.90;
    this.knee = options.knee ?? 0.36;
    this.resolution = new THREE.Vector2(safeW, safeH);

    // Exposes bloomTexture directly to the fused final pass — no full-res swap needed
    this.needsSwap = false;

    const rtOptions: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };

    let mipW = safeW;
    let mipH = safeH;
    for (let i = 0; i < MIP_LEVELS; i++) {
      mipW = Math.max(1, Math.round(mipW * 0.5));
      mipH = Math.max(1, Math.round(mipH * 0.5));
      const rt = new THREE.WebGLRenderTarget(mipW, mipH, rtOptions);
      rt.texture.name = `DualKawaseBloom.mip${i}`;
      this.mips.push(rt);
    }

    this.downsampleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uHalfPixel: { value: new THREE.Vector2(1 / safeW, 1 / safeH) },
        uPrefilter: { value: 1.0 },
        uThreshold: { value: this.threshold },
        uKnee: { value: this.knee },
      },
      vertexShader: KAWASE_VERT,
      fragmentShader: KAWASE_DOWNSAMPLE_FRAG,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.upsampleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uHalfPixel: { value: new THREE.Vector2(1 / safeW, 1 / safeH) },
        uScatter: { value: this.computeScatter() },
      },
      vertexShader: KAWASE_VERT,
      fragmentShader: KAWASE_UPSAMPLE_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.downsampleMaterial);
  }

  public get bloomTexture(): THREE.Texture {
    return this.mips[0].texture;
  }

  public get mipCount(): number {
    return this.mips.length;
  }

  private computeScatter(): number {
    return THREE.MathUtils.clamp(0.46 + this.radius * 0.58, 0.35, 0.92);
  }

  /**
   * Returns a pyramid-normalised composite strength so changing bloom radius
   * broadens the halo smoothly without shifting overall exposure.
   */
  public getCompositeStrength(): number {
    const safeStrength = Number.isFinite(this.strength) ? Math.max(0, this.strength) : 0;
    const s = this.computeScatter();
    const pyramidGain = 1 + s + s * s + s * s * s;
    return (safeStrength * 1.85) / Math.max(pyramidGain, 1e-4);
  }

  public override setSize(width: number, height: number): void {
    const safeW = Math.max(1, Math.round(width));
    const safeH = Math.max(1, Math.round(height));
    this.resolution.set(safeW, safeH);

    let mipW = safeW;
    let mipH = safeH;
    for (let i = 0; i < this.mips.length; i++) {
      mipW = Math.max(1, Math.round(mipW * 0.5));
      mipH = Math.max(1, Math.round(mipH * 0.5));
      this.mips[i].setSize(mipW, mipH);
    }
  }

  public override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    renderer.getClearColor(this._oldClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this._clearColor, 0);

    // 1. 4-level Dual-Kawase downsample chain (mip 0 applies NaN/Inf sanitisation + soft-knee)
    const downUniforms = this.downsampleMaterial.uniforms;
    const downHalfPixel = downUniforms.uHalfPixel.value as THREE.Vector2;
    downUniforms.uThreshold.value = this.threshold;
    downUniforms.uKnee.value = this.knee;
    this.fsQuad.material = this.downsampleMaterial;

    let srcTex = readBuffer.texture;
    let srcW = Math.max(1, readBuffer.width);
    let srcH = Math.max(1, readBuffer.height);

    for (let i = 0; i < this.mips.length; i++) {
      const dst = this.mips[i];
      downUniforms.tDiffuse.value = srcTex;
      downUniforms.uPrefilter.value = i === 0 ? 1.0 : 0.0;
      downHalfPixel.set(1 / srcW, 1 / srcH);

      renderer.setRenderTarget(dst);
      renderer.clear(true, false, false);
      this.fsQuad.render(renderer);

      srcTex = dst.texture;
      srcW = dst.width;
      srcH = dst.height;
    }

    // 2. 3-step Dual-Kawase 8-tap tent upsample with hardware additive blend into finer mips
    const upUniforms = this.upsampleMaterial.uniforms;
    const upHalfPixel = upUniforms.uHalfPixel.value as THREE.Vector2;
    const scatter = this.computeScatter();
    const radiusScale = THREE.MathUtils.clamp(0.88 + this.radius * 0.44, 0.80, 1.35);
    upUniforms.uScatter.value = scatter;
    this.fsQuad.material = this.upsampleMaterial;

    for (let i = this.mips.length - 1; i > 0; i--) {
      const src = this.mips[i];
      const dst = this.mips[i - 1];
      upUniforms.tDiffuse.value = src.texture;
      upHalfPixel.set((0.5 / Math.max(1, src.width)) * radiusScale, (0.5 / Math.max(1, src.height)) * radiusScale);

      // Do NOT clear dst: additive blend accumulates coarser halo onto finer mip in tile memory
      renderer.setRenderTarget(dst);
      this.fsQuad.render(renderer);
    }

    renderer.setClearColor(this._oldClearColor, oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }

  public override dispose(): void {
    for (let i = 0; i < this.mips.length; i++) {
      this.mips[i].dispose();
    }
    this.downsampleMaterial.dispose();
    this.upsampleMaterial.dispose();
    this.fsQuad.dispose();
  }
}
