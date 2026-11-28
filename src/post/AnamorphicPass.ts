import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const ANAMORPHIC_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Stage 1: Selective HDR highlight extraction with vertical anti-shimmer prefilter
// and Bay/Scott dual-tone cyan/amber optical glass tinting.
const ANAMORPHIC_EXTRACT_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uInvSrcSize;
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uTrip;
  varying vec2 vUv;

  float sanitiseVal(float v) {
    return (isnan(v) || isinf(v)) ? 0.0 : clamp(v, 0.0, 64.0);
  }

  vec3 sampleSanitised(vec2 uv) {
    vec3 c = texture2D(tDiffuse, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb;
    return vec3(sanitiseVal(c.r), sanitiseVal(c.g), sanitiseVal(c.b));
  }

  void main() {
    // 3-tap vertical tent prefilter stops thin specular highlights flickering during pitch/roll
    vec2 dy = vec2(0.0, uInvSrcSize.y * 1.25);
    vec3 c0 = sampleSanitised(vUv);
    vec3 cUp = sampleSanitised(vUv + dy);
    vec3 cDn = sampleSanitised(vUv - dy);
    vec3 col = c0 * 0.5 + (cUp + cDn) * 0.25;

    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float peak = max(col.r, max(col.g, col.b));
    float brightness = max(lum, peak * 0.74);

    // Soft-knee selective threshold: midtones below (threshold - knee) contribute strictly 0.0
    float safeKnee = max(uKnee, 1e-4);
    float rq = clamp(brightness - uThreshold + safeKnee, 0.0, 2.0 * safeKnee);
    float soft = (rq * rq) / max(4.0 * safeKnee, 1e-4);
    float contrib = max(brightness - uThreshold, soft) / max(brightness, 1e-4);
    vec3 extracted = min(col * contrib, vec3(10.0));

    // Classify source warmth so sun/afterburners emit icy cyan streaks while
    // fireballs, decoy flares, and golden sunset rim emit rich amber-gold streaks
    float energy = max(col.r + col.g + col.b, 1e-4);
    float warmth = smoothstep(0.04, 0.42, (col.r - col.b) / energy);
    vec3 cyanGlass = vec3(0.26, 0.80, 1.42);
    vec3 amberGlass = vec3(1.42, 0.82, 0.30);
    vec3 glassTint = mix(cyanGlass, amberGlass, clamp(warmth, 0.0, 1.0));

    // LSD overdrive smoothly infuses iridescent magenta-violet into optical streaks
    vec3 prismTint = mix(vec3(1.38, 0.36, 1.32), vec3(0.32, 1.38, 1.26), clamp(warmth, 0.0, 1.0));
    float tripMix = clamp(uTrip * 0.48, 0.0, 0.68);
    vec3 finalTint = mix(glassTint, prismTint, tripMix);

    vec3 outCol = clamp(extracted * finalTint, 0.0, 14.0);
    gl_FragColor = vec4(outCol, 1.0);
  }
`;

// Stage 2: Separable 9-tap horizontal anamorphic streak blur with slight spectral
// edge dispersion (cylindrical lens chromatic spread along the streak axis).
const ANAMORPHIC_BLUR_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uTexelSize;
  uniform float uStride;
  uniform float uChromaSpread;
  varying vec2 vUv;

  float sanitiseVal(float v) {
    return (isnan(v) || isinf(v)) ? 0.0 : clamp(v, 0.0, 32.0);
  }

  vec3 sampleSafe(vec2 uv) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      return vec3(0.0);
    }
    vec3 c = texture2D(tDiffuse, uv).rgb;
    return vec3(sanitiseVal(c.r), sanitiseVal(c.g), sanitiseVal(c.b));
  }

  void main() {
    float stepX = uTexelSize.x * uStride;
    float chromaOffset = stepX * uChromaSpread;

    // Symmetric exponential-Gaussian weights normalised to preserve peak energy without washout
    vec3 acc = sampleSafe(vUv) * 0.220;

    float w1 = 0.168;
    float w2 = 0.114;
    float w3 = 0.068;
    float w4 = 0.040;

    // Inner taps (1, 2)
    acc += (sampleSafe(vec2(vUv.x - stepX * 1.0, vUv.y)) + sampleSafe(vec2(vUv.x + stepX * 1.0, vUv.y))) * w1;
    acc += (sampleSafe(vec2(vUv.x - stepX * 2.0, vUv.y)) + sampleSafe(vec2(vUv.x + stepX * 2.0, vUv.y))) * w2;

    // Outer taps (3, 4) with subtle optical blue-outward / red-inward cylindrical glass fringe
    vec3 l3 = sampleSafe(vec2(vUv.x - stepX * 3.0, vUv.y));
    vec3 r3 = sampleSafe(vec2(vUv.x + stepX * 3.0, vUv.y));
    float l3b = sampleSafe(vec2(vUv.x - stepX * 3.0 - chromaOffset, vUv.y)).b;
    float r3b = sampleSafe(vec2(vUv.x + stepX * 3.0 + chromaOffset, vUv.y)).b;
    acc += vec3(l3.r + r3.r, l3.g + r3.g, (l3.b + r3.b) * 0.5 + (l3b + r3b) * 0.5) * w3;

    vec3 l4 = sampleSafe(vec2(vUv.x - stepX * 4.0, vUv.y));
    vec3 r4 = sampleSafe(vec2(vUv.x + stepX * 4.0, vUv.y));
    float l4r = sampleSafe(vec2(vUv.x - stepX * 4.0 + chromaOffset, vUv.y)).r;
    float r4r = sampleSafe(vec2(vUv.x + stepX * 4.0 - chromaOffset, vUv.y)).r;
    acc += vec3((l4.r + r4.r) * 0.5 + (l4r + r4r) * 0.5, l4.g + r4.g, l4.b + r4.b) * w4;

    gl_FragColor = vec4(clamp(acc, 0.0, 24.0), 1.0);
  }
`;

// Stage 3: Composite crisp core streak + wide screen-spanning streak additively onto HDR scene.
const ANAMORPHIC_COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tCoreStreak;
  uniform sampler2D tWideStreak;
  uniform float uIntensity;
  uniform float uCoreWeight;
  uniform float uWideWeight;
  varying vec2 vUv;

  float sanitiseVal(float v) {
    return (isnan(v) || isinf(v)) ? 0.0 : clamp(v, 0.0, 64.0);
  }

  vec3 sanitiseVec3(vec3 c) {
    return vec3(sanitiseVal(c.r), sanitiseVal(c.g), sanitiseVal(c.b));
  }

  void main() {
    vec4 baseTex = texture2D(tDiffuse, vUv);
    vec3 baseCol = sanitiseVec3(baseTex.rgb);
    vec3 coreStreak = sanitiseVec3(texture2D(tCoreStreak, vUv).rgb);
    vec3 wideStreak = sanitiseVec3(texture2D(tWideStreak, vUv).rgb);

    // Subtle soft horizontal taper right at the extreme viewport borders so streaks breathe naturally
    float borderDist = abs(vUv.x - 0.5) * 2.0;
    float edgeTaper = 1.0 - smoothstep(0.86, 1.0, borderDist) * 0.28;

    vec3 streak = (coreStreak * uCoreWeight + wideStreak * uWideWeight) * uIntensity * edgeTaper;
    // Soft highlight compression on the streak layer alone so intense detonations remain sculpted
    streak = streak / max(vec3(1.0) + streak * 0.32, vec3(1e-4));

    vec3 outCol = clamp(baseCol + streak, 0.0, 64.0);
    float alpha = (isnan(baseTex.a) || isinf(baseTex.a)) ? 1.0 : clamp(baseTex.a, 0.0, 1.0);
    gl_FragColor = vec4(outCol, alpha);
  }
`;

export interface AnamorphicPassOptions {
  intensity?: number;
  threshold?: number;
  knee?: number;
  stretch?: number;
  coreWeight?: number;
  wideWeight?: number;
}

/**
 * Dedicated separable horizontal anamorphic lens flare pass.
 * Extracts selective HDR highlights (sun, afterburners, decoy flares, fireballs)
 * with a soft-knee threshold so midtones stay clean, then performs progressive
 * multi-stride 1D horizontal blur passes to synthesise crisp cyan/amber cinema streaks.
 */
export class AnamorphicPass extends Pass {
  public intensity: number;
  public threshold: number;
  public knee: number;
  public stretch: number;
  public coreWeight: number;
  public wideWeight: number;
  public tripIntensity = 0;
  public shockIntensity = 0;

  private readonly rtCore: THREE.WebGLRenderTarget;
  private readonly rtPing: THREE.WebGLRenderTarget;
  private readonly rtPong: THREE.WebGLRenderTarget;

  private readonly extractMaterial: THREE.ShaderMaterial;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;

  private readonly _clearColor = new THREE.Color(0, 0, 0);
  private readonly _oldClearColor = new THREE.Color();

  constructor(width: number, height: number, options: AnamorphicPassOptions = {}) {
    super();

    this.intensity = options.intensity ?? 0.54;
    this.threshold = options.threshold ?? 0.94;
    this.knee = options.knee ?? 0.32;
    this.stretch = options.stretch ?? 1.15;
    this.coreWeight = options.coreWeight ?? 0.68;
    this.wideWeight = options.wideWeight ?? 0.96;

    this.needsSwap = true;

    const safeW = Math.max(1, Math.round(width));
    const safeH = Math.max(1, Math.round(height));
    const streakW = Math.max(1, Math.round(safeW * 0.5));
    const streakH = Math.max(1, Math.round(safeH * 0.25));

    const rtOptions: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };

    this.rtCore = new THREE.WebGLRenderTarget(streakW, streakH, rtOptions);
    this.rtCore.texture.name = 'AnamorphicPass.core';

    this.rtPing = new THREE.WebGLRenderTarget(streakW, streakH, rtOptions);
    this.rtPing.texture.name = 'AnamorphicPass.ping';

    this.rtPong = new THREE.WebGLRenderTarget(streakW, streakH, rtOptions);
    this.rtPong.texture.name = 'AnamorphicPass.pong';

    this.extractMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uInvSrcSize: { value: new THREE.Vector2(1 / safeW, 1 / safeH) },
        uThreshold: { value: this.threshold },
        uKnee: { value: this.knee },
        uTrip: { value: 0 },
      },
      vertexShader: ANAMORPHIC_VERT,
      fragmentShader: ANAMORPHIC_EXTRACT_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / streakW, 1 / streakH) },
        uStride: { value: 1.0 },
        uChromaSpread: { value: 0.35 },
      },
      vertexShader: ANAMORPHIC_VERT,
      fragmentShader: ANAMORPHIC_BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tCoreStreak: { value: this.rtCore.texture },
        tWideStreak: { value: this.rtPing.texture },
        uIntensity: { value: this.intensity },
        uCoreWeight: { value: this.coreWeight },
        uWideWeight: { value: this.wideWeight },
      },
      vertexShader: ANAMORPHIC_VERT,
      fragmentShader: ANAMORPHIC_COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.extractMaterial);
  }

  public override setSize(width: number, height: number): void {
    const safeW = Math.max(1, Math.round(width));
    const safeH = Math.max(1, Math.round(height));
    const streakW = Math.max(1, Math.round(safeW * 0.5));
    const streakH = Math.max(1, Math.round(safeH * 0.25));

    this.rtCore.setSize(streakW, streakH);
    this.rtPing.setSize(streakW, streakH);
    this.rtPong.setSize(streakW, streakH);

    (this.extractMaterial.uniforms.uInvSrcSize.value as THREE.Vector2).set(1 / safeW, 1 / safeH);
    (this.blurMaterial.uniforms.uTexelSize.value as THREE.Vector2).set(1 / streakW, 1 / streakH);
  }

  public override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    renderer.getClearColor(this._oldClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this._clearColor, 0);

    // 1. Extract bright highlights into rtPong (anamorphic quarter-pixel buffer)
    this.extractMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.extractMaterial.uniforms.uThreshold.value = this.threshold;
    this.extractMaterial.uniforms.uKnee.value = this.knee;
    this.extractMaterial.uniforms.uTrip.value = this.tripIntensity;
    this.fsQuad.material = this.extractMaterial;
    renderer.setRenderTarget(this.rtPong);
    renderer.clear();
    this.fsQuad.render(renderer);

    // 2. Separable progressive horizontal streak blur passes
    //    Pass A (tight core streak) -> rtCore
    const s = Math.max(0.25, this.stretch);
    const chroma = 0.28 + Math.min(1.5, this.tripIntensity) * 0.45 + Math.min(1.5, this.shockIntensity) * 0.25;
    this.blurMaterial.uniforms.uChromaSpread.value = chroma;
    this.fsQuad.material = this.blurMaterial;

    this.blurMaterial.uniforms.tDiffuse.value = this.rtPong.texture;
    this.blurMaterial.uniforms.uStride.value = 1.25 * s;
    renderer.setRenderTarget(this.rtCore);
    renderer.clear();
    this.fsQuad.render(renderer);

    //    Pass B (medium reach) rtCore -> rtPing
    this.blurMaterial.uniforms.tDiffuse.value = this.rtCore.texture;
    this.blurMaterial.uniforms.uStride.value = 3.2 * s;
    renderer.setRenderTarget(this.rtPing);
    renderer.clear();
    this.fsQuad.render(renderer);

    //    Pass C (wide reach) rtPing -> rtPong
    this.blurMaterial.uniforms.tDiffuse.value = this.rtPing.texture;
    this.blurMaterial.uniforms.uStride.value = 7.4 * s;
    renderer.setRenderTarget(this.rtPong);
    renderer.clear();
    this.fsQuad.render(renderer);

    //    Pass D (cinema screen-spanning reach) rtPong -> rtPing
    this.blurMaterial.uniforms.tDiffuse.value = this.rtPong.texture;
    this.blurMaterial.uniforms.uStride.value = 14.5 * s;
    renderer.setRenderTarget(this.rtPing);
    renderer.clear();
    this.fsQuad.render(renderer);

    // 3. Composite tight core + sweeping wide streaks onto HDR scene
    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tCoreStreak.value = this.rtCore.texture;
    this.compositeMaterial.uniforms.tWideStreak.value = this.rtPing.texture;
    this.compositeMaterial.uniforms.uIntensity.value = this.intensity;
    this.compositeMaterial.uniforms.uCoreWeight.value = this.coreWeight;
    this.compositeMaterial.uniforms.uWideWeight.value = this.wideWeight;
    this.fsQuad.material = this.compositeMaterial;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
    }
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);

    renderer.setClearColor(this._oldClearColor, oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }

  public override dispose(): void {
    this.rtCore.dispose();
    this.rtPing.dispose();
    this.rtPong.dispose();
    this.extractMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.fsQuad.dispose();
  }
}
