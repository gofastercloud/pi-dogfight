import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

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

const BAY_SCOTT_LSD_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uTrip: { value: 0 },
    uShock: { value: 0 },
    uSpeed: { value: 0 },
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
    uniform vec2 uResolution;
    varying vec2 vUv;

    vec3 acesFilm(vec3 x) {
      vec3 v = max(x, vec3(0.0));
      float a = 2.51;
      float b = 0.03;
      float c = 2.43;
      float d = 0.59;
      float e = 0.14;
      return clamp((v * (a * v + b)) / max(v * (c * v + d) + e, vec3(1e-4)), 0.0, 1.0);
    }

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    vec3 hueShift(vec3 col, float angle) {
      const vec3 k = vec3(0.57735, 0.57735, 0.57735);
      float cosA = cos(angle);
      return col * cosA + cross(k, col) * sin(angle) + k * dot(k, col) * (1.0 - cosA);
    }

    float sanitise(float v) {
      return (isnan(v) || isinf(v)) ? 0.0 : clamp(v, 0.0, 64.0);
    }

    vec3 sanitiseVec3(vec3 c) {
      return vec3(sanitise(c.r), sanitise(c.g), sanitise(c.b));
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float dist = length(centered);

      // Subtle peripheral psychedelic wave distortion (keeps centre crisp for action)
      if (uTrip > 0.15) {
        float edgeMask = smoothstep(0.24, 0.72, dist);
        float safeX = (abs(centered.x) < 1e-5 && abs(centered.y) < 1e-5) ? 1e-5 : centered.x;
        float angle = atan(centered.y, safeX);
        float ripple = sin(dist * 24.0 - uTime * 3.8 + angle * 4.0) * 0.0045 * uTrip * edgeMask;
        vec2 radialDir = dist > 1e-4 ? centered / dist : vec2(1.0, 0.0);
        uv += radialDir * ripple;
      }

      // Dynamic radial chromatic aberration (spikes on sonic booms, impacts, and LSD peaks)
      float caAmt = 0.0014 + uShock * 0.014 + uSpeed * 0.003 + uTrip * 0.0065;
      vec2 caVec = centered * caAmt;
      float r = sanitise(texture2D(tDiffuse, uv + caVec).r);
      float g = sanitise(texture2D(tDiffuse, uv).g);
      float b = sanitise(texture2D(tDiffuse, uv - caVec).b);
      vec3 col = vec3(r, g, b);

      // Anamorphic horizontal lens flare streak synthesis (Michael Bay / Ridley Scott glass)
      vec3 streak = vec3(0.0);
      float texelX = 1.0 / max(uResolution.x, 1.0);
      for (int i = -6; i <= 6; i++) {
        float fi = float(i);
        float w = exp(-abs(fi) * 0.28);
        vec3 s = sanitiseVec3(texture2D(tDiffuse, vec2(uv.x + fi * texelX * 14.0, uv.y)).rgb);
        float lum = dot(s, vec3(0.299, 0.587, 0.114));
        streak += max(s - 0.92, 0.0) * smoothstep(0.85, 1.65, lum) * w;
      }
      vec3 flareTint = mix(vec3(0.32, 0.78, 1.35), vec3(1.45, 0.38, 1.25), clamp(uTrip * 0.8, 0.0, 1.0));
      col += streak * flareTint * (0.048 + uShock * 0.06);

      // Psychedelic peripheral prism saturation & gentle hue swirl
      if (uTrip > 0.05) {
        float edgePrism = smoothstep(0.18, 0.78, dist);
        vec3 shifted = hueShift(col, sin(uTime * 0.9 + dist * 6.0) * 0.65 * uTrip);
        col = mix(col, shifted, clamp(uTrip * (0.22 + edgePrism * 0.42), 0.0, 0.7));
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(lum), col, 1.0 + uTrip * 0.42);
      }

      // Michael Bay teal-and-orange filmic colour grade
      vec3 shadows = vec3(0.92, 1.02, 1.12);
      vec3 highlights = vec3(1.10, 1.01, 0.90);
      float luma = clamp(dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
      col *= mix(shadows, highlights, smoothstep(0.18, 0.82, luma));

      // ACES Filmic Tone Mapping
      col = acesFilm(col * 1.08);

      // Subtle 35mm cinematic grain
      float grain = (rand(uv * uResolution * 0.35 + fract(uTime * 37.0)) - 0.5) * 0.032;
      col += grain;

      // Anamorphic vignette
      float vig = smoothstep(0.95, 0.28, dist * (1.05 + uSpeed * 0.25));
      col *= mix(0.45, 1.0, vig);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export class PostPipeline {
  public readonly composer: EffectComposer;
  public readonly sanitisePass: ShaderPass;
  public readonly bloomPass: UnrealBloomPass;
  public readonly finalPass: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: Math.min(4, renderer.capabilities.maxSamples),
    });

    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));

    // Sanitise any NaN/Inf HDR radiance values before bloom so Apple Metal/ANGLE cannot black out the frame
    this.sanitisePass = new ShaderPass(SANITISE_HDR_SHADER);
    this.composer.addPass(this.sanitisePass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.68, 0.52, 0.84);
    this.composer.addPass(this.bloomPass);

    this.finalPass = new ShaderPass(BAY_SCOTT_LSD_SHADER);
    this.finalPass.uniforms.uResolution.value.set(w, h);
    this.composer.addPass(this.finalPass);
  }

  public setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(w, h);
    this.finalPass.uniforms.uResolution.value.set(w, h);
  }

  public update(time: number, tripIntensity: number, shockIntensity: number, speedIntensity: number): void {
    this.bloomPass.strength = 0.62 + tripIntensity * 0.42 + shockIntensity * 0.55;
    this.bloomPass.threshold = THREE.MathUtils.lerp(0.84, 0.66, Math.min(1, tripIntensity * 0.6 + shockIntensity * 0.5));
    this.finalPass.uniforms.uTime.value = time;
    this.finalPass.uniforms.uTrip.value = tripIntensity;
    this.finalPass.uniforms.uShock.value = shockIntensity;
    this.finalPass.uniforms.uSpeed.value = speedIntensity;
  }

  public render(): void {
    this.composer.render();
  }
}
