import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { AnamorphicPass } from './AnamorphicPass';
import { DualKawaseBloom } from './DualKawaseBloom';

const CINEMA_LSD_FINAL_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    tAnamorphicCore: { value: null },
    tAnamorphicWide: { value: null },
    uBloomStrength: { value: 0.56 },
    uAnamorphicIntensity: { value: 0.54 },
    uAnamorphicCoreWeight: { value: 0.68 },
    uAnamorphicWideWeight: { value: 0.96 },
    uPrevViewProjInvViewProj: { value: new THREE.Matrix4() },
    uMotionBlurScale: { value: 0 },
    uTime: { value: 0 },
    uTrip: { value: 0 },
    uShock: { value: 0 },
    uSpeed: { value: 0 },
    uShockRadius: { value: 0.35 },
    uShockAmp: { value: 0 },
    uAspect: { value: 16 / 9 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform sampler2D tAnamorphicCore;
    uniform sampler2D tAnamorphicWide;
    uniform float uBloomStrength;
    uniform float uAnamorphicIntensity;
    uniform float uAnamorphicCoreWeight;
    uniform float uAnamorphicWideWeight;
    uniform mat4 uPrevViewProjInvViewProj;
    uniform float uMotionBlurScale;
    uniform float uTime;
    uniform float uTrip;
    uniform float uShock;
    uniform float uSpeed;
    uniform float uShockRadius;
    uniform float uShockAmp;
    uniform float uAspect;
    uniform vec2 uResolution;
    varying vec2 vUv;

    const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
      vec3(0.6274, 0.0691, 0.0164),
      vec3(0.3293, 0.9195, 0.0880),
      vec3(0.0433, 0.0113, 0.8956)
    );

    const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
      vec3(1.6605, -0.1246, -0.0182),
      vec3(-0.5876, 1.1329, -0.1006),
      vec3(-0.0728, -0.0083, 1.1187)
    );

    const mat3 AGX_INSET_MAT = mat3(
      vec3(0.85662715, 0.13731897, 0.11189821),
      vec3(0.09512124, 0.76124199, 0.07679942),
      vec3(0.04825161, 0.10143904, 0.81130237)
    );

    const mat3 AGX_OUTSET_MAT = mat3(
      vec3(1.12710058, -0.14132976, -0.14132976),
      vec3(-0.11060664, 1.15782370, -0.11060664),
      vec3(-0.01649394, -0.01649394, 1.25193641)
    );

    float sanitise(float v) {
      return (isnan(v) || isinf(v)) ? 0.0 : clamp(v, 0.0, 64.0);
    }

    vec3 sanitiseVec3(vec3 c) {
      return vec3(sanitise(c.r), sanitise(c.g), sanitise(c.b));
    }

    vec3 sampleScene(vec2 uv) {
      vec2 safeUv = clamp(uv, vec2(0.001), vec2(0.999));
      return sanitiseVec3(texture2D(tDiffuse, safeUv).rgb);
    }

    // Tone-compressed perceptual luma keeps HDR emissives from over-triggering edge smoothing
    float perceptualLuma(vec3 c) {
      float l = max(dot(c, vec3(0.299, 0.587, 0.114)), 0.0);
      return l / (1.0 + l);
    }

    // Lightweight luma-guided edge smoothing (complements 2x MSAA without blurring jet details)
    vec3 applyLumaEdgeAA(vec2 uv, vec3 centerCol, vec2 invRes) {
      vec3 cNW = sampleScene(uv + vec2(-0.5,  0.5) * invRes);
      vec3 cNE = sampleScene(uv + vec2( 0.5,  0.5) * invRes);
      vec3 cSW = sampleScene(uv + vec2(-0.5, -0.5) * invRes);
      vec3 cSE = sampleScene(uv + vec2( 0.5, -0.5) * invRes);

      float lM  = perceptualLuma(centerCol);
      float lNW = perceptualLuma(cNW);
      float lNE = perceptualLuma(cNE);
      float lSW = perceptualLuma(cSW);
      float lSE = perceptualLuma(cSE);

      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      float lRange = lMax - lMin;

      float edgeThresh = max(0.055, lMax * 0.14);
      if (lRange <= edgeThresh) {
        return centerCol;
      }

      vec2 dir;
      dir.x = -((lNW + lNE) - (lSW + lSE));
      dir.y =  ((lNW + lSW) - (lNE + lSE));
      float dirReduce = max((lNW + lNE + lSW + lSE) * 0.0625, 0.0078125);
      float rcpDirMin = 1.0 / max(min(abs(dir.x), abs(dir.y)) + dirReduce, 1e-4);
      dir = clamp(dir * rcpDirMin, vec2(-2.5), vec2(2.5)) * invRes;

      vec3 aaA = 0.5 * (
        sampleScene(uv + dir * -0.1666667) +
        sampleScene(uv + dir *  0.1666667)
      );
      vec3 aaB = aaA * 0.5 + 0.25 * (
        sampleScene(uv + dir * -0.5) +
        sampleScene(uv + dir *  0.5)
      );
      float lB = perceptualLuma(aaB);
      vec3 aaCol = (lB < lMin || lB > lMax) ? aaA : aaB;
      float aaMix = clamp(smoothstep(edgeThresh, edgeThresh * 3.0, lRange) * 0.56, 0.0, 0.56);
      return mix(centerCol, aaCol, aaMix);
    }

    vec3 acesFilm(vec3 x) {
      vec3 v = max(x, vec3(0.0));
      float a = 2.51;
      float b = 0.03;
      float c = 2.43;
      float d = 0.59;
      float e = 0.14;
      return clamp((v * (a * v + b)) / max(v * (c * v + d) + e, vec3(1e-4)), 0.0, 1.0);
    }

    vec3 agxContrastApprox(vec3 x) {
      vec3 x2 = x * x;
      vec3 x4 = x2 * x2;
      return 15.5 * x4 * x2
        - 40.14 * x4 * x
        + 31.96 * x4
        - 6.868 * x2 * x
        + 0.4298 * x2
        + 0.1191 * x
        - 0.00232;
    }

    vec3 agxFilm(vec3 x) {
      vec3 col = max(x, vec3(0.0)) * 1.28;
      col = LINEAR_SRGB_TO_LINEAR_REC2020 * col;
      col = AGX_INSET_MAT * col;
      col = max(col, vec3(1e-4));
      col = (log2(col) - (-12.47393)) / (4.026069 - (-12.47393));
      col = clamp(col, 0.0, 1.0);
      col = agxContrastApprox(col);
      col = AGX_OUTSET_MAT * col;
      col = pow(max(col, 1e-4), vec3(2.05));
      col = LINEAR_REC2020_TO_LINEAR_SRGB * col;
      return clamp(col, 0.0, 1.0);
    }

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    // Interleaved gradient noise dithers directional shutter taps to avoid banding
    float interleavedGradientNoise(vec2 pixelPos) {
      return fract(52.9829189 * fract(dot(pixelPos, vec2(0.06711056, 0.00583715))));
    }

    vec3 hueShift(vec3 col, float angle) {
      const vec3 k = vec3(0.57735, 0.57735, 0.57735);
      float cosA = cos(angle);
      return col * cosA + cross(k, col) * sin(angle) + k * dot(k, col) * (1.0 - cosA);
    }

    void main() {
      float trip = clamp(uTrip, 0.0, 1.5);
      float shock = clamp(uShock, 0.0, 1.5);
      float speed = clamp(uSpeed, 0.0, 1.5);
      float aspect = max(uAspect, 0.5);
      vec2 safeRes = max(uResolution, vec2(1.0));
      vec2 invRes = 1.0 / safeRes;

      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float dist = length(centered);
      vec2 aspectCentered = vec2(centered.x * aspect, centered.y);
      float aspectDist = length(aspectCentered);
      vec2 radialAspect = aspectDist > 1e-4 ? aspectCentered / aspectDist : vec2(1.0, 0.0);
      vec2 radialUv = vec2(radialAspect.x / aspect, radialAspect.y);

      float safeX = (abs(aspectCentered.x) < 1e-5 && abs(aspectCentered.y) < 1e-5) ? 1e-5 : aspectCentered.x;
      float angle = atan(aspectCentered.y, safeX);

      // 1. Expanding screen-space shockwave refraction ripple on detonations & sonic booms
      float ringEnv = 0.0;
      float ringDelta = aspectDist - clamp(uShockRadius, 0.05, 1.25);
      if (uShockAmp > 0.004) {
        float ringBand = exp(-(ringDelta * ringDelta) / max(0.0048, 1e-4));
        float ringInner = smoothstep(0.03, 0.14, aspectDist);
        float ringOuter = 1.0 - smoothstep(0.68, 1.15, aspectDist);
        ringEnv = ringBand * ringInner * ringOuter * clamp(uShockAmp, 0.0, 1.5);
        float wave = sin(ringDelta * 44.0) * ringEnv;
        uv = clamp(uv + radialUv * wave * 0.022, vec2(0.001), vec2(0.999));
      }

      // 2. Peripheral psychedelic wave warp (central dogfight stays razor crisp)
      float edgeMask = smoothstep(0.26, 0.80, aspectDist);
      if (trip > 0.06) {
        float tripWarp = smoothstep(0.06, 1.50, trip);
        float ripple = sin(aspectDist * 14.0 - uTime * 3.2 + angle * 3.0) * 0.0038 * tripWarp * edgeMask;
        uv = clamp(uv + radialUv * ripple, vec2(0.001), vec2(0.999));
      }

      // 3. Sanitised scene sample + luma-guided post-AA + optical chromatic dispersion
      vec3 baseCol = sampleScene(uv);
      vec3 aaCol = applyLumaEdgeAA(uv, baseCol, invRes);

      float cornerGain = 0.42 + smoothstep(0.08, 0.78, dist) * 1.12;
      float caAmt = (0.0011 + shock * 0.0105 + ringEnv * 0.015 + speed * 0.0026 + trip * 0.0054) * cornerGain;
      vec2 caVec = centered * caAmt;

      // Subtle tangential prism shear on outer periphery during LSD overdrive
      vec2 tangentUv = vec2(-radialUv.y, radialUv.x);
      vec2 prismShear = tangentUv * (trip * edgeMask * 0.0032);

      vec3 caCol = vec3(
        sampleScene(uv + caVec + prismShear).r,
        baseCol.g,
        sampleScene(uv - caVec - prismShear).b
      );
      vec3 col = max(aaCol + (caCol - baseCol), vec3(0.0));

      // 4. Analytic camera-velocity shutter motion blur (uPrevViewProj * invViewProj)
      //    fused with peripheral high-Mach radial streaks; screen centre stays razor-sharp
      float centerGuard = smoothstep(0.08, 0.42, aspectDist);
      vec2 camVelUv = vec2(0.0);
      if (uMotionBlurScale > 0.001) {
        // Reproject screen UV at mid-ground depth (~106 world units at near=0.8, far=16000)
        // so angular whip-pans are exact and forward flight produces natural peripheral parallax
        vec4 currClip = vec4(uv * 2.0 - 1.0, 0.985, 1.0);
        vec4 prevClip = uPrevViewProjInvViewProj * currClip;
        vec2 prevUv = (abs(prevClip.w) > 1e-4) ? (prevClip.xy / prevClip.w) * 0.5 + 0.5 : uv;
        camVelUv = (uv - prevUv) * clamp(uMotionBlurScale, 0.0, 1.0) * centerGuard;
      }

      float speedMask = smoothstep(0.18, 0.74, dist) * clamp(speed + shock * 0.22, 0.0, 1.5);
      vec2 radialVelUv = centered * (speedMask * 0.014);
      vec2 totalVelUv = camVelUv + radialVelUv;

      float velLen = length(totalVelUv);
      float maxVel = 0.032;
      if (velLen > maxVel) {
        totalVelUv *= maxVel / max(velLen, 1e-4);
        velLen = maxVel;
      }

      if (velLen > 0.0008) {
        // 5 directional shutter taps (6 total with centre) + IGN dither for smooth cinema streak
        float jitter = (interleavedGradientNoise(uv * safeRes + fract(uTime * 17.0) * 64.0) - 0.5) * 0.18;
        vec3 accum = col * 0.28;
        float wSum = 0.28;

        // Asymmetric cinema shutter biased along trailing motion vector
        float tapOffsets[5];
        tapOffsets[0] = -0.92;
        tapOffsets[1] = -0.58;
        tapOffsets[2] = -0.26;
        tapOffsets[3] =  0.22;
        tapOffsets[4] =  0.52;

        float tapWeights[5];
        tapWeights[0] = 0.10;
        tapWeights[1] = 0.16;
        tapWeights[2] = 0.22;
        tapWeights[3] = 0.15;
        tapWeights[4] = 0.09;

        for (int i = 0; i < 5; i++) {
          vec2 tapUv = uv + totalVelUv * (tapOffsets[i] + jitter);
          accum += sampleScene(tapUv) * tapWeights[i];
          wSum += tapWeights[i];
        }
        vec3 blurred = accum / max(wSum, 1e-4);
        float blurMix = clamp(smoothstep(0.0008, 0.012, velLen) * 0.78, 0.0, 0.78);
        col = mix(col, blurred, blurMix);
      }

      // 5. Fused HDR Dual-Kawase bloom + horizontal anamorphic streak compositing
      vec3 bloomCol = sanitiseVec3(texture2D(tBloom, uv).rgb) * max(uBloomStrength, 0.0);
      vec3 coreStreak = sanitiseVec3(texture2D(tAnamorphicCore, uv).rgb);
      vec3 wideStreak = sanitiseVec3(texture2D(tAnamorphicWide, uv).rgb);

      float borderDist = abs(uv.x - 0.5) * 2.0;
      float edgeTaper = 1.0 - smoothstep(0.86, 1.0, borderDist) * 0.28;
      vec3 streak = (coreStreak * uAnamorphicCoreWeight + wideStreak * uAnamorphicWideWeight)
        * max(uAnamorphicIntensity, 0.0)
        * edgeTaper;
      // Soft highlight compression on the streak layer alone so intense detonations stay sculpted
      streak = streak / max(vec3(1.0) + streak * 0.32, vec3(1e-4));

      col = clamp(col + bloomCol + streak, 0.0, 64.0);

      // Subtle refractive pressure-wave caustic along expanding detonation shockwave crest
      if (ringEnv > 0.004) {
        float crest = 0.5 + 0.5 * cos(ringDelta * 44.0);
        vec3 shockTint = mix(vec3(0.55, 0.88, 1.25), vec3(1.30, 0.55, 1.15), clamp(trip * 0.65, 0.0, 1.0));
        col += shockTint * ringEnv * crest * 0.14;
      }

      // 6. LSD Chromatic Prism Aura & Peripheral Edge-Kaleidoscope Overdrive (0% - 150%)
      if (trip > 0.03) {
        float edgePrism = smoothstep(0.22, 0.82, aspectDist);

        // Peripheral 6-fold kaleidoscope reflection engages smoothly past 40% overdrive
        if (trip > 0.40) {
          float kaleidWeight = smoothstep(0.40, 1.50, trip) * smoothstep(0.46, 0.96, aspectDist);
          if (kaleidWeight > 0.002) {
            float sector = 1.04719755; // 2*PI / 6
            float shiftedAngle = angle + 3.14159265 + uTime * 0.14;
            float folded = abs(mod(shiftedAngle, sector) - sector * 0.5);
            vec2 kOffset = vec2(cos(folded) / aspect, sin(folded)) * aspectDist * 0.86;
            vec3 kSample = sampleScene(vec2(0.5) + kOffset);
            kSample = hueShift(kSample, uTime * 0.55 + aspectDist * 4.2);
            col = mix(col, kSample, clamp(kaleidWeight * 0.34, 0.0, 0.36));
          }
        }

        // Iridescent peripheral hue swirl + bright-edge prism aura
        vec3 shifted = hueShift(col, sin(uTime * 0.88 + aspectDist * 5.4) * 0.62 * trip);
        float hueMix = clamp(trip * (0.14 + edgePrism * 0.44), 0.0, 0.68);
        col = mix(col, shifted, hueMix);

        float colLum = dot(col, vec3(0.299, 0.587, 0.114));
        float auraMask = smoothstep(0.55, 1.75, colLum) * edgePrism;
        vec3 prismAura = hueShift(vec3(0.95, 0.35, 1.10), angle * 2.0 + uTime * 1.4);
        col += max(prismAura, vec3(0.0)) * auraMask * trip * 0.16;

        // Controlled saturation boost while preventing channel blow-out
        float satBoost = clamp(1.0 + trip * 0.34, 1.0, 1.52);
        col = max(vec3(0.0), mix(vec3(colLum), col, satBoost));
      }

      // 7. Michael Bay / Ridley Scott teal-and-orange filmic colour grade
      float gradeStrength = 1.0 - clamp(trip * 0.28, 0.0, 0.38);
      vec3 shadows = mix(vec3(1.0), vec3(0.91, 1.02, 1.13), gradeStrength);
      vec3 highlights = mix(vec3(1.0), vec3(1.11, 1.01, 0.89), gradeStrength);
      float luma = clamp(dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
      col *= mix(shadows, highlights, smoothstep(0.16, 0.84, luma));

      // 8. Hybrid AgX + ACES Filmic Tone Mapping
      vec3 acesCol = acesFilm(col * 1.08);
      vec3 agxCol = agxFilm(col);
      col = mix(acesCol, agxCol, 0.52);

      // 9. Luminance-weighted 35mm film grain
      float finalLum = dot(col, vec3(0.299, 0.587, 0.114));
      float grainMask = 1.0 - smoothstep(0.68, 1.0, finalLum) * 0.45;
      float grain = (rand(uv * safeRes * 0.35 + fract(uTime * 37.0)) - 0.5) * 0.028 * grainMask;
      col += grain;

      // 10. Anamorphic vignette (non-inverted smoothstep)
      float vigMask = smoothstep(0.28, 0.96, dist * (1.03 + speed * 0.22));
      col *= mix(1.0, 0.46, clamp(vigMask, 0.0, 1.0));

      // 11. Final finite-output sanitisation
      vec3 safeOut = vec3(
        (isnan(col.r) || isinf(col.r)) ? 0.0 : clamp(col.r, 0.0, 1.0),
        (isnan(col.g) || isinf(col.g)) ? 0.0 : clamp(col.g, 0.0, 1.0),
        (isnan(col.b) || isinf(col.b)) ? 0.0 : clamp(col.b, 0.0, 1.0)
      );
      gl_FragColor = vec4(safeOut, 1.0);
    }
  `,
};

export class PostPipeline {
  public readonly composer: EffectComposer;
  public readonly bloomPass: DualKawaseBloom;
  public readonly anamorphicPass: AnamorphicPass;
  public readonly finalPass: ShaderPass;

  private readonly _renderer: THREE.WebGLRenderer;
  private readonly _camera: THREE.PerspectiveCamera;

  private _lastTime = -1;
  private _prevShock = 0;
  private _shockWaveRadius = 0.35;
  private _shockWaveAmp = 0;

  // Pre-allocated camera reprojection scratch state (zero per-frame heap allocations)
  private readonly _currViewProj = new THREE.Matrix4();
  private readonly _invViewProj = new THREE.Matrix4();
  private readonly _prevViewProj = new THREE.Matrix4();
  private readonly _reprojMatrix = new THREE.Matrix4();
  private readonly _prevCamPos = new THREE.Vector3();
  private readonly _prevCamQuat = new THREE.Quaternion();
  private readonly _camDeltaPos = new THREE.Vector3();
  private _prevCamFov = 64;
  private _hasPrevCamera = false;
  private _motionBlurScale = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this._renderer = renderer;
    this._camera = camera;

    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = renderer.getPixelRatio();

    // 2x MSAA on HalfFloat FBO cuts Apple Silicon tile-memory bandwidth in half;
    // paired with luma-guided edge smoothing inside the fused final pass
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: Math.min(2, renderer.capabilities.maxSamples),
    });

    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));

    // 1. 4-level Dual-Kawase HDR bloom pyramid (sanitises NaN/Inf pre-downsample; no full-res write)
    this.bloomPass = new DualKawaseBloom(w, h, {
      strength: 0.56,
      radius: 0.48,
      threshold: 0.90,
      knee: 0.36,
    });
    this.composer.addPass(this.bloomPass);

    // 2. Separable low-res horizontal cyan/amber anamorphic streaks (fused in final pass)
    this.anamorphicPass = new AnamorphicPass(w, h, {
      intensity: 0.54,
      threshold: 0.94,
      knee: 0.32,
      stretch: 1.15,
      composite: false,
    });
    this.composer.addPass(this.anamorphicPass);

    // 3. Single fused full-res cinema uber pass (AA, camera-velocity blur, bloom, streaks, AgX/ACES, LSD)
    this.finalPass = new ShaderPass(CINEMA_LSD_FINAL_SHADER);
    const uniforms = this.finalPass.uniforms;
    uniforms.tBloom.value = this.bloomPass.bloomTexture;
    uniforms.uBloomStrength.value = this.bloomPass.getCompositeStrength();
    uniforms.tAnamorphicCore.value = this.anamorphicPass.coreStreakTexture;
    uniforms.tAnamorphicWide.value = this.anamorphicPass.wideStreakTexture;
    uniforms.uAnamorphicIntensity.value = this.anamorphicPass.intensity;
    uniforms.uAnamorphicCoreWeight.value = this.anamorphicPass.coreWeight;
    uniforms.uAnamorphicWideWeight.value = this.anamorphicPass.wideWeight;
    (uniforms.uResolution.value as THREE.Vector2).set(w * dpr, h * dpr);
    uniforms.uAspect.value = w / h;
    this.composer.addPass(this.finalPass);
  }

  public setSize(w: number, h: number): void {
    const safeW = Math.max(1, w);
    const safeH = Math.max(1, h);
    const dpr = this._renderer.getPixelRatio();
    this.composer.setSize(safeW, safeH);
    (this.finalPass.uniforms.uResolution.value as THREE.Vector2).set(safeW * dpr, safeH * dpr);
    this.finalPass.uniforms.uAspect.value = safeW / safeH;
  }

  /**
   * Manually trigger an expanding screen-space detonation shockwave ring.
   */
  public triggerShockwave(strength = 1.0): void {
    this._shockWaveRadius = 0.06;
    this._shockWaveAmp = Math.max(this._shockWaveAmp, THREE.MathUtils.clamp(strength, 0, 1.5));
  }

  public update(time: number, tripIntensity: number, shockIntensity: number, speedIntensity: number): void {
    const safeTrip = Number.isFinite(tripIntensity) ? THREE.MathUtils.clamp(tripIntensity, 0, 1.5) : 0;
    const safeShock = Number.isFinite(shockIntensity) ? THREE.MathUtils.clamp(shockIntensity, 0, 1.5) : 0;
    const safeSpeed = Number.isFinite(speedIntensity) ? THREE.MathUtils.clamp(speedIntensity, 0, 1.5) : 0;
    const safeTime = Number.isFinite(time) ? time : 0;

    // Advance expanding screen-space shockwave ring cleanly (also deterministic on seek)
    const dt = this._lastTime < 0 ? 0.016 : safeTime - this._lastTime;
    const isTimelineJump = this._lastTime < 0 || dt <= 1e-5 || dt > 0.25;

    if (dt < 0 || dt > 0.5) {
      // Timeline seek or restart: compute deterministic ring phase directly from shock level
      this._shockWaveRadius = 0.18 + (1.0 - Math.min(1, safeShock)) * 0.54;
      this._shockWaveAmp = safeShock;
    } else {
      const clampedDt = Math.min(Math.max(dt, 0), 0.08);
      if (safeShock > this._prevShock + 0.12 && safeShock > 0.18) {
        this._shockWaveRadius = 0.06;
        this._shockWaveAmp = Math.max(this._shockWaveAmp, safeShock);
      } else if (safeShock > this._shockWaveAmp) {
        this._shockWaveAmp = safeShock;
      }
      this._shockWaveRadius = Math.min(1.25, this._shockWaveRadius + clampedDt * 1.38);
      this._shockWaveAmp *= Math.exp(-clampedDt * 2.5);
      if (this._shockWaveRadius >= 1.2 && safeShock < 0.04) {
        this._shockWaveAmp = 0;
      }
    }
    this._lastTime = safeTime;
    this._prevShock = safeShock;

    // Analytic camera-velocity reprojection (uPrevViewProj * invViewProj) with hard-cut suppression
    this._camera.updateMatrixWorld();
    this._currViewProj.multiplyMatrices(
      this._camera.projectionMatrix,
      this._camera.matrixWorldInverse,
    );

    let suppressMotionBlur = isTimelineJump || !this._hasPrevCamera;
    let posDelta = 0;
    let angDelta = 0;

    if (!suppressMotionBlur) {
      posDelta = this._camDeltaPos.subVectors(this._camera.position, this._prevCamPos).length();
      const cosHalf = Math.min(1, Math.abs(this._prevCamQuat.dot(this._camera.quaternion)));
      angDelta = 2 * Math.acos(cosHalf);
      const fovDelta = Math.abs(this._camera.fov - this._prevCamFov);

      // Suppress shutter smear on abrupt director cuts, camera switches, or degenerate matrices
      if (posDelta > 35.0 || angDelta > 0.42 || fovDelta > 6.0) {
        suppressMotionBlur = true;
      } else if (Math.abs(this._currViewProj.determinant()) < 1e-10) {
        suppressMotionBlur = true;
      }
    }

    if (suppressMotionBlur) {
      this._reprojMatrix.identity();
      this._motionBlurScale = 0;
    } else {
      this._invViewProj.copy(this._currViewProj).invert();
      this._reprojMatrix.multiplyMatrices(this._prevViewProj, this._invViewProj);

      const clampedDt = THREE.MathUtils.clamp(dt, 0.004, 0.05);
      const angVel = angDelta / clampedDt;
      const linVel = posDelta / clampedDt;
      const velDrive = THREE.MathUtils.clamp(angVel * 0.65 + linVel * 0.0025 + safeSpeed * 0.22, 0, 1.35);
      const shutterNorm = Math.min(0.62, 0.48 * (0.01667 / clampedDt));
      this._motionBlurScale = shutterNorm * THREE.MathUtils.smoothstep(velDrive, 0.04, 0.85);
    }

    this._prevViewProj.copy(this._currViewProj);
    this._prevCamPos.copy(this._camera.position);
    this._prevCamQuat.copy(this._camera.quaternion);
    this._prevCamFov = this._camera.fov;
    this._hasPrevCamera = true;

    // Selective Dual-Kawase bloom tuning (keeps midtones crisp while boosting fireballs & LSD peaks)
    const bloomDrive = Math.min(1, safeTrip * 0.5 + safeShock * 0.55);
    this.bloomPass.strength = 0.54 + safeTrip * 0.34 + safeShock * 0.48;
    this.bloomPass.threshold = THREE.MathUtils.lerp(0.90, 0.72, bloomDrive);

    // Separable anamorphic streak pass tuning
    this.anamorphicPass.intensity = 0.54 + safeShock * 0.38 + safeTrip * 0.16;
    this.anamorphicPass.threshold = THREE.MathUtils.lerp(0.94, 0.80, Math.min(1, safeShock * 0.55 + safeTrip * 0.35));
    this.anamorphicPass.stretch = 1.15 + safeSpeed * 0.25 + safeShock * 0.32;
    this.anamorphicPass.tripIntensity = safeTrip;
    this.anamorphicPass.shockIntensity = safeShock;

    // Final cinema optics, analytic motion blur & LSD prism pass uniforms
    const uniforms = this.finalPass.uniforms;
    (uniforms.uPrevViewProjInvViewProj.value as THREE.Matrix4).copy(this._reprojMatrix);
    uniforms.uMotionBlurScale.value = this._motionBlurScale;
    uniforms.uTime.value = safeTime;
    uniforms.uTrip.value = safeTrip;
    uniforms.uShock.value = safeShock;
    uniforms.uSpeed.value = safeSpeed;
    uniforms.uShockRadius.value = this._shockWaveRadius;
    uniforms.uShockAmp.value = Math.max(this._shockWaveAmp, safeShock * 0.55);
  }

  public render(): void {
    // Sync bloom and anamorphic uniforms right before composing so external
    // audio-reactive modulations applied after update() are reflected immediately.
    const uniforms = this.finalPass.uniforms;
    uniforms.tBloom.value = this.bloomPass.bloomTexture;
    uniforms.uBloomStrength.value = this.bloomPass.getCompositeStrength();
    uniforms.tAnamorphicCore.value = this.anamorphicPass.coreStreakTexture;
    uniforms.tAnamorphicWide.value = this.anamorphicPass.wideStreakTexture;
    uniforms.uAnamorphicIntensity.value = this.anamorphicPass.intensity;
    uniforms.uAnamorphicCoreWeight.value = this.anamorphicPass.coreWeight;
    uniforms.uAnamorphicWideWeight.value = this.anamorphicPass.wideWeight;

    this.composer.render();
  }

  public dispose(): void {
    this.bloomPass.dispose();
    this.anamorphicPass.dispose();
    this.finalPass.dispose();
    this.composer.dispose();
  }
}
