# SOLAR MACH: CHROMATIC VIPER

An 88-second, five-act 3D Three.js WebGL2 HDR aerial dogfight showcase built for smooth 120 fps playback on Apple Silicon and modern desktop/tablet browsers.

## Highlights

- **Five-Act Choreographed Dogfight (0:00 – 1:28):** Golden-hour sea-skimming break, 20mm Vulcan gun pass, chromatic supercell storm with floating obsidian monolith rings, Pugachev's Cobra bullet-time Macross missile salvo, and a vertical sunrise climb-out.
- **Real-Time Web Audio FFT Sync:** 14 bespoke `fal.ai` audio stems (80s rock anthem, spatialised SFX, and UHF pilot radio comms with music ducking) tapped through a zero-allocation `AnalyserNode` (`bassEnergy`, `midEnergy`, `beatPulse`) driving subtle bloom, monolith energy conduits, and LSD prism modulation.
- **Diegetic Cockpit HUD:** Pitch ladder, heading compass tape, airspeed/Mach/G telemetry, 3D-projected bandit target diamonds, lead-computing gun pipper (LCOS), edge-of-screen off-boresight directional chevrons, corner RWR threat radar scope, and subtle 9G+ peripheral tunnel-vision darkening.
- **Cinema HDR Post-Processing:** Half-float MSAA `EffectComposer` with NaN/Inf HDR sanitisation, thresholded Unreal Bloom, separable horizontal cyan/amber anamorphic lens streaks, expanding shockwave refraction, hybrid AgX + ACES filmic tone mapping, and tunable LSD Chromatic Overdrive (`0%–150%`).

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
| `M` | Mute / Unmute audio |
| `R` | Restart 88-second sequence from `0:00` |
| Timeline Scrubber | Jump cleanly to any timestamp across all five acts |
| LSD Slider | Manually tune psychedelic overdrive (`0%` – `150%`; double-click to return to `AUTO`) |
| Mouse Drag / Scroll (`4 Orbit`) | Freely orbit and zoom around Viper-1 while flying |

## Project Layout

- `src/main.ts` — Renderer bootstrap, zero-allocation 120 fps animation loop, FFT reactive wiring, UI controls, and `window.__DOGFIGHT_DEBUG__` telemetry.
- `src/audio/AudioEngine.ts` — Web Audio mixer, 14-stem preloader, Sidewinder seeker lock synth, and real-time `AnalyserNode` FFT bass/mid/beat extractor.
- `src/ui/FighterHUD.ts` — 2D high-DPI canvas cockpit HUD (pitch ladder, heading tape, target diamonds, LCOS gun pipper, off-boresight chevrons, RWR scope, 9G+ vignette).
- `src/aircraft/` — Procedural lofted twin-tail hero & stealth bandit airframes, 2K PBR hull textures, animated wings/nozzles/afterburners.
- `src/environment/` — Twin-eclipse sky dome, volumetric clouds, 8-wave Gerstner ocean with rooster-tail wake, basalt sea-stacks, and floating obsidian monolith rings.
- `src/vfx/` — Instanced explosions, missile smoke ribbons, Vulcan tracers, flares, and GPU particle systems.
- `src/post/` — Half-float MSAA `EffectComposer`, HDR sanitiser, Unreal Bloom, separable anamorphic streaks, and AgX/ACES + LSD prism shader pass.
- `server.mjs` — Production static HTTP server (`0.0.0.0:8080`) with byte-range audio streaming and LAN/Tailnet address discovery.
- `tests/visual.spec.mjs` — Static GLSL safety audit and headless Chrome WebGL2 visual/UI verification suite.
