import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { AnamorphicPass } from './AnamorphicPass';

const SANITISE_HDR_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
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
    varying vec2 vUv;

    float sanitiseChannel(float v) {
      if (isnan(v) || isinf(v)) return 0.0;
      return clamp(v, 0.0, 64.0);
    }

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 col = vec3(
        sanitiseChannel(tex.r),
        sanitiseChannel(tex.g),
        sanitiseChannel(tex.b)
      );
      float a = (isnan(tex.a) || isinf(tex.a)) ? 1.0 : clamp(tex.a, 0.0, 1.0);
      gl_FragColor = vec4(col, a);
    }
  `,
};

const CINEMA_LSD_FINAL_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
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

      // 3. Optical chromatic dispersion (spikes on detonations, shockwaves, high Mach, and LSD)
      float cornerGain = 0.42 + smoothstep(0.08, 0.78, dist) * 1.12;
      float caAmt = (0.0011 + shock * 0.0105 + ringEnv * 0.015 + speed * 0.0026 + trip * 0.0054) * cornerGain;
      vec2 caVec = centered * caAmt;

      // Subtle tangential prism shear on outer periphery during LSD overdrive
      vec2 tangentUv = vec2(-radialUv.y, radialUv.x);
      vec2 prismShear = tangentUv * (trip * edgeMask * 0.0032);

      float r = sampleScene(uv + caVec + prismShear).r;
      float g = sampleScene(uv).g;
      float b = sampleScene(uv - caVec - prismShear).b;
      vec3 col = vec3(r, g, b);

      // 4. Radial velocity / G-load motion streaks (keeps central target reticle sharp)
      float speedMask = smoothstep(0.18, 0.74, dist) * clamp(speed + shock * 0.22, 0.0, 1.5);
      if (speedMask > 0.01) {
        vec3 streakAccum = col * 0.34;
        float weightSum = 0.34;
        vec2 stepVec = centered * (0.011 + speedMask * 0.022);
        for (int i = 1; i <= 5; i++) {
          float fi = float(i);
          float w = exp(-fi * 0.36);
          vec3 s = sampleScene(uv - stepVec * (fi * 0.28));
          streakAccum += s * w;
          weightSum += w;
        }
        vec3 blurred = streakAccum / max(weightSum, 1e-4);
        float streakMix = clamp(speedMask * 0.40, 0.0, 0.46);
        col = mix(col, blurred, streakMix);
      }

      // Subtle refractive pressure-wave caustic along expanding detonation shockwave crest
      if (ringEnv > 0.004) {
        float crest = 0.5 + 0.5 * cos(ringDelta * 44.0);
        vec3 shockTint = mix(vec3(0.55, 0.88, 1.25), vec3(1.30, 0.55, 1.15), clamp(trip * 0.65, 0.0, 1.0));
        col += shockTint * ringEnv * crest * 0.14;
      }

      // 5. LSD Chromatic Prism Aura & Peripheral Edge-Kaleidoscope Overdrive (0% - 150%)
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

      // 6. Michael Bay / Ridley Scott teal-and-orange filmic colour grade
      float gradeStrength = 1.0 - clamp(trip * 0.28, 0.0, 0.38);
      vec3 shadows = mix(vec3(1.0), vec3(0.91, 1.02, 1.13), gradeStrength);
      vec3 highlights = mix(vec3(1.0), vec3(1.11, 1.01, 0.89), gradeStrength);
      float luma = clamp(dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
      col *= mix(shadows, highlights, smoothstep(0.16, 0.84, luma));

      // 7. Hybrid AgX + ACES Filmic Tone Mapping
      vec3 acesCol = acesFilm(col * 1.08);
      vec3 agxCol = agxFilm(col);
      col = mix(acesCol, agxCol, 0.52);

      // 8. Luminance-weighted 35mm film grain
      float finalLum = dot(col, vec3(0.299, 0.587, 0.114));
      float grainMask = 1.0 - smoothstep(0.68, 1.0, finalLum) * 0.45;
      float grain = (rand(uv * uResolution * 0.35 + fract(uTime * 37.0)) - 0.5) * 0.028 * grainMask;
      col += grain;

      // 9. Anamorphic vignette (non-inverted smoothstep)
      float vigMask = smoothstep(0.28, 0.96, dist * (1.03 + speed * 0.22));
      col *= mix(1.0, 0.46, clamp(vigMask, 0.0, 1.0));

      // Final finite-output sanitisation
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
  public readonly sanitisePass: ShaderPass;
  public readonly bloomPass: UnrealBloomPass;
  public readonly anamorphicPass: AnamorphicPass;
  public readonly finalPass: ShaderPass;

  private _lastTime = -1;
  private _prevShock = 0;
  private _shockWaveRadius = 0.35;
  private _shockWaveAmp = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);

    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: Math.min(4, renderer.capabilities.maxSamples),
    });

    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));

    // 1. Sanitise any NaN/Inf HDR radiance values before bloom & anamorphic extraction
    this.sanitisePass = new ShaderPass(SANITISE_HDR_SHADER);
    this.composer.addPass(this.sanitisePass);

    // 2. Selective thresholded bloom (preserves crisp midtones & dark shadows)
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.56, 0.48, 0.90);
    this.composer.addPass(this.bloomPass);

    // 3. Dedicated separable horizontal cyan/amber anamorphic lens flare pass
    this.anamorphicPass = new AnamorphicPass(w, h, {
      intensity: 0.54,
      threshold: 0.94,
      knee: 0.32,
      stretch: 1.15,
    });
    this.composer.addPass(this.anamorphicPass);

    // 4. Final filmic AgX/ACES, shockwave refraction, motion streaks & LSD prism pass
    this.finalPass = new ShaderPass(CINEMA_LSD_FINAL_SHADER);
    (this.finalPass.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    this.finalPass.uniforms.uAspect.value = w / h;
    this.composer.addPass(this.finalPass);
  }

  public setSize(w: number, h: number): void {
    const safeW = Math.max(1, w);
    const safeH = Math.max(1, h);
    this.composer.setSize(safeW, safeH);
    this.bloomPass.resolution.set(safeW, safeH);
    (this.finalPass.uniforms.uResolution.value as THREE.Vector2).set(safeW, safeH);
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
    if (dt < 0 || dt > 0.5) {
      // Timeline seek or restart: compute deterministic ring phase directly from shock level
      this._shockWaveRadius = 0.18 + (1.0 - Math.min(1, safeShock)) * 0.54;
      this._shockWaveAmp = safeShock;
    } else {
      const clampedDt = Math.min(dt, 0.08);
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

    // Selective bloom tuning (keeps midtones crisp while boosting fireballs & LSD peaks)
    const bloomDrive = Math.min(1, safeTrip * 0.5 + safeShock * 0.55);
    this.bloomPass.strength = 0.54 + safeTrip * 0.34 + safeShock * 0.48;
    this.bloomPass.threshold = THREE.MathUtils.lerp(0.90, 0.72, bloomDrive);

    // Separable anamorphic streak pass tuning
    this.anamorphicPass.intensity = 0.54 + safeShock * 0.38 + safeTrip * 0.16;
    this.anamorphicPass.threshold = THREE.MathUtils.lerp(0.94, 0.80, Math.min(1, safeShock * 0.55 + safeTrip * 0.35));
    this.anamorphicPass.stretch = 1.15 + safeSpeed * 0.25 + safeShock * 0.32;
    this.anamorphicPass.tripIntensity = safeTrip;
    this.anamorphicPass.shockIntensity = safeShock;

    // Final cinema optics & LSD prism pass uniforms
    const uniforms = this.finalPass.uniforms;
    uniforms.uTime.value = safeTime;
    uniforms.uTrip.value = safeTrip;
    uniforms.uShock.value = safeShock;
    uniforms.uSpeed.value = safeSpeed;
    uniforms.uShockRadius.value = this._shockWaveRadius;
    uniforms.uShockAmp.value = Math.max(this._shockWaveAmp, safeShock * 0.55);
  }

  public render(): void {
    this.composer.render();
  }

  public dispose(): void {
    this.sanitisePass.dispose();
    this.bloomPass.dispose();
    this.anamorphicPass.dispose();
    this.finalPass.dispose();
    this.composer.dispose();
  }
}
