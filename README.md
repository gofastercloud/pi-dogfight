# SOLAR MACH: CHROMATIC VIPER

An 88-second, five-act 3D Three.js WebGL2 HDR aerial dogfight showcase built for smooth 120 fps playback on Apple Silicon and modern desktop/tablet browsers.

## Highlights

- **Five-Act Choreographed Dogfight (0:00 – 1:28):** Golden-hour sea-skimming break, 20mm Vulcan gun pass, chromatic supercell storm with floating obsidian monolith rings, Pugachev's Cobra bullet-time Macross missile salvo, and a vertical sunrise climb-out.
- **Real-Time Web Audio FFT Sync:** 14 bespoke `fal.ai` audio stems (80s rock anthem, spatialised SFX, and UHF pilot radio comms with music ducking) tapped through a zero-allocation `AnalyserNode` (`bassEnergy`, `midEnergy`, `beatPulse`) driving subtle bloom, monolith energy conduits, and LSD prism modulation.
- **Diegetic Cockpit HUD:** Pitch ladder, heading compass tape, airspeed/Mach/G telemetry, 3D-projected bandit target diamonds, lead-computing gun pipper (LCOS), edge-of-screen off-boresight directional chevrons, corner RWR threat radar scope, and subtle 9G+ peripheral tunnel-vision darkening.
- **Cinema HDR Post-Processing:** Half-float 2× MSAA `EffectComposer` with NaN/Inf HDR sanitisation, 4-level Dual-Kawase bloom, separable horizontal cyan/amber anamorphic lens streaks, expanding shockwave refraction, analytic camera-velocity motion blur, luma-guided edge AA, hybrid AgX + ACES filmic tone mapping, and tunable LSD Chromatic Overdrive (`0%–150%`) fused into a single full-resolution uber pass.
- **Adaptive 120 fps WebGL2 Engine:** Hysteresis-guarded Dynamic Resolution Scaler (`DRS: AUTO` across `1.15×–2.0×` DPR or `DRS: NATIVE` lock via `Q`), upfront `renderer.compileAsync` shader pre-warming with constant point-light padding for zero mid-flight compile stutter, merged fighter airframes with GPU aeroelasticity, half-resolution temporal volumetric clouds, GPU-kinematic particles, and concentric radial ocean LOD.

## Prerequisites

- **Node.js 20+** and **npm**
- **Google Chrome** or **Chromium** (required only for headless WebGL2 visual verification via `make verify`)

## Building

Install dependencies and produce the optimised production bundle in `dist/`:

```nu
npm install
make build
```

`make build` runs `tsc --noEmit` followed by `vite build` (equivalent to `npm run build`).

For live hot-reload development bound to `0.0.0.0:8080`:

```nu
npm run dev
```

## Verification (`make verify`)

Run the full type-check, production build, static GLSL safety audit, and headless Chrome WebGL2 multi-act verification suite:

```nu
make verify
```

`make verify` checks:
1. TypeScript strict type-checking (`tsc --noEmit`) and production bundle build (`vite build`).
2. Static GLSL audit confirming every `pow()` call clamps its base with `max(..., 1e-4)` and `PostPipeline.ts` sanitises non-finite (`isnan`/`isinf`) HDR radiance before bloom.
3. Headless Chrome WebGL2 rendering across all five acts (`t = 2s, 24.5s, 45s, 59s, 70s`), all five camera modes, cockpit roll alignment, Free Orbit mouse drag persistence, keyboard shortcuts `1`–`5`, HUD toggle, LSD Overdrive slider, Play/Pause timeline advancement, and zero console/page/shader errors.

To point `make verify` at a custom Chrome/Chromium binary:

```nu
# Nushell
with-env { CHROME_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } { make verify }
```

```sh
# POSIX / zsh / bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" make verify
```

## Performance Architecture & Benchmarking (`make bench`)

Run the deterministic 5-act headless Chrome WebGL2 performance benchmark (builds `dist/`, samples 20 steady-state frames across each of the five acts at `1280×720 @ DPR 1`, and prints both a formatted table and structured JSON telemetry):

```nu
make bench
```

Customise viewport dimensions or device pixel ratio via environment variables:

```nu
# Nushell (Retina 2x DRS test)
with-env { BENCH_WIDTH: "1280", BENCH_HEIGHT: "720", BENCH_DPR: "2" } { make bench }
```

```sh
# POSIX / zsh / bash
BENCH_WIDTH=1280 BENCH_HEIGHT=720 BENCH_DPR=2 make bench
```

### WebGL2 Performance Architecture

1. **Zero-Stutter Launch Pre-Warming:** `renderer.compileAsync(scene, camera)` compiles all scene materials against the HalfFloat `EffectComposer` target via `KHR_parallel_shader_compile`, paired with constant `PointLight` count padding so bandit kills and detonations never trigger mid-flight shader recompiles.
2. **Adaptive Dynamic Resolution Scaler (DRS):** Hysteresis-guarded rolling-window scaler (`8.75 ms` scale-up / `10.2 ms` scale-down deadband, asymmetric step sizes and cooldowns) smoothly scales DPR within `[1.15, min(devicePixelRatio, 2)]` targeting 120 fps without oscillating or reallocating FBO textures unnecessarily. Toggle between `DRS: AUTO` and `DRS: NATIVE` in the dock or with `Q`.
3. **Single-Pass Fused Post-Processing:** Replaces multi-pass Unreal Bloom with a 4-level Dual-Kawase pyramid (`1/2 → 1/16`), low-resolution separable anamorphic streaks, and a single full-resolution uber pass combining luma edge AA, analytic camera-velocity motion blur, bloom/streak compositing, AgX + ACES tone mapping, and LSD prism optics.
4. **Merged Airframes & GPU Aeroelasticity:** Eliminates the double-pass canopy transmission render, merges static jet sub-meshes per airframe, and drives wing flex and shock shimmer in vertex shaders.
5. **Half-Resolution Temporal Clouds & Concentric Ocean LOD:** Uses a `64³` 3D Worley-Perlin `Data3DTexture` ray-marched at half resolution with temporal reprojection and early-Z sky culling, a concentric radial ocean mesh with distance-culled shading, and single-draw instanced basalt sea-stacks.
6. **GPU-Kinematic Particles & Zero-Allocation Loops:** Evaluates smoke, sparks, and debris ballistics on the GPU with dirty-range buffer uploads, instanced flare/core billboards, hoisted HUD dash/degree tables, and cached HUD telemetry strings.

### Verified Benchmark Results (`1280×720 @ DPR 1`, Headless Chrome WebGL2)

Headless Chrome runs at 60 Hz VSync (`16.67 ms` floor); structural draw-call, triangle, programme, geometry, texture, and frame-time p99 reductions reflect the full integrated WebGL2 pipeline:

| Metric (`1280×720 @ DPR 1`) | Baseline (`#22`) | Optimised (Integrated) | Delta |
| --- | ---: | ---: | ---: |
| Avg Draw Calls (all 5 acts) | 445 | **116** | **−73.9%** |
| Peak Draw Calls (Act 3) | 1,067 | **211** | **−80.2%** |
| Avg Triangles | 265,518 | **69,002** | **−74.0%** |
| WebGL Programmes | 82 | **41** *(constant I–V)* | **−50.0%** |
| Geometries | 348 | **147** | **−57.8%** |
| Textures | 37 | **32** | **−13.5%** |
| Ring-Buffer p99 Frame Time | 66.7 ms *(lazy compiles)* | **16.8 ms** *(zero stutter)* | **−74.8%** |

Live verified 5-act breakdown (`make bench`, `1280×720 @ DPR 1`, `DRS=auto`, 20 steady-state frames/act):

| Act | t (s) | Draws | Triangles | Progs | Geoms | Tex | p50 (ms) | p95 (ms) | p99 (ms) | FPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Act 1 | 2.0 | 82 | 59,955 | 41 | 61 | 19 | 16.70 | 16.70 | 16.80 | 60.0 |
| Act 2 | 24.5 | 71 | 58,474 | 41 | 68 | 20 | 16.70 | 16.70 | 16.80 | 60.0 |
| Act 3 | 45.0 | 211 | 88,537 | 41 | 137 | 32 | 16.60 | 16.80 | 16.80 | 60.0 |
| Act 4 | 59.0 | 125 | 71,064 | 41 | 140 | 32 | 16.70 | 16.80 | 16.80 | 60.0 |
| Act 5 | 70.0 | 90 | 66,982 | 41 | 147 | 32 | 16.70 | 16.70 | 16.70 | 60.0 |
| **ALL ACTS** | — | **116** | **69,002** | **41** | **147** | **32** | **16.70** | **16.80** | **16.80** | **60.0** |

## Hosting on `0.0.0.0:8080` (Localhost, LAN, and Tailnet)

`server.mjs` is a zero-dependency Node.js static server for `dist/` with HTTP `Range` support (for streaming audio stems). By default it binds to `0.0.0.0:8080` and prints every reachable Localhost, LAN, and Tailscale Tailnet (`100.64.0.0/10`) URL on startup.

Build once and serve:

```nu
make build
npm run serve
```

Or run `server.mjs` directly:

```nu
node server.mjs
```

### Customising `PORT` or `HOST`

```nu
# Nushell
with-env { PORT: "8080", HOST: "0.0.0.0" } { node server.mjs }
```

```sh
# POSIX / zsh / bash
PORT=8080 HOST=0.0.0.0 node server.mjs
```

### Connecting Over Localhost, LAN, or Tailnet

- **Localhost (this machine):** `http://localhost:8080`
- **LAN (same Wi-Fi / Ethernet network):** use the `LAN (<interface>)` IPv4 address printed by `server.mjs` (for example `http://192.168.1.42:8080`). Ensure macOS Firewall allows incoming connections for `node` if enabled.
- **Tailnet (Tailscale devices anywhere):** use the `Tailnet` IPv4 address printed by `server.mjs` (for example `http://100.x.y.z:8080`) or your machine's MagicDNS hostname (`http://<machine-name>:8080`). To inspect your Tailscale IPv4 address in Nushell:

```nu
let ts_ip = (^tailscale ip -4 | str trim)
print $"http://($ts_ip):8080"
```

## Interactive Controls

| Input | Action |
| --- | --- |
| `Space` | Play / Pause |
| `1` – `5` | Switch camera (`1 Auto`, `2 Cockpit`, `3 Chase`, `4 Free Orbit`, `5 Bayhem`) |
| `H` | Toggle cockpit HUD overlay |
| `L` | Toggle LSD Chromatic Overdrive (`145%` / `AUTO`) |
| `Q` | Toggle Dynamic Resolution Scaler (`DRS: AUTO` / `DRS: NATIVE`) |
| `M` | Mute / Unmute audio |
| `R` | Restart 88-second sequence from `0:00` |
| Timeline Scrubber | Jump cleanly to any timestamp across all five acts |
| LSD Slider | Manually tune psychedelic overdrive (`0%` – `150%`; double-click to return to `AUTO`) |
| Mouse Drag / Scroll (`4 Orbit`) | Freely orbit and zoom around Viper-1 while flying |

## Project Layout

- `src/main.ts` — Renderer bootstrap, `compileAsync` shader pre-warm, hysteresis-guarded 120 fps DRS, zero-allocation animation loop, FFT reactive wiring, UI controls, and `window.__DOGFIGHT_DEBUG__` telemetry.
- `src/audio/AudioEngine.ts` — Web Audio mixer, 14-stem preloader, Sidewinder seeker lock synth, and real-time `AnalyserNode` FFT bass/mid/beat extractor.
- `src/ui/FighterHUD.ts` — 2D high-DPI canvas cockpit HUD with cached telemetry formatting (pitch ladder, heading tape, target diamonds, LCOS gun pipper, off-boresight chevrons, RWR scope, 9G+ vignette).
- `src/aircraft/` — Merged lofted twin-tail hero & stealth bandit airframes, 2K PBR hull textures, GPU aeroelastic wings, and animated nozzles/afterburners.
- `src/environment/` — Early-Z twin-eclipse sky dome, `64³` 3D-noise half-res temporal clouds, concentric radial Gerstner ocean with rooster-tail wake, single-draw instanced basalt sea-stacks, and floating obsidian monolith rings.
- `src/vfx/` — GPU-kinematic particle system with dirty-range uploads, instanced explosions/billboards, missile smoke ribbons, Vulcan tracers, and flares.
- `src/post/` — Half-float 2× MSAA `EffectComposer`, 4-level Dual-Kawase bloom, separable anamorphic streaks, and fused cinema uber pass (luma edge AA, analytic motion blur, AgX/ACES, and LSD prism).
- `server.mjs` — Production static HTTP server (`0.0.0.0:8080`) with byte-range audio streaming and LAN/Tailnet address discovery.
- `tests/visual.spec.mjs` — Static GLSL safety audit and headless Chrome WebGL2 visual/UI verification suite (`make verify`).
- `tests/bench.spec.mjs` — Deterministic 5-act headless Chrome WebGL2 performance benchmark (`make bench`).
