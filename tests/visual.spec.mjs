import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

// ---------------------------------------------------------------------------
// 1. STATIC GLSL SAFETY AUDIT
// ---------------------------------------------------------------------------
function auditGlslShaders() {
  const shaderFiles = [
    'src/environment/WorldEnvironment.ts',
    'src/aircraft/FighterJet.ts',
    'src/vfx/BayhemVFX.ts',
    'src/post/PostPipeline.ts',
  ];

  const glslBlockRe = /\/\*\s*glsl\s*\*\/\s*`([\s\S]*?)`/g;

  for (const relPath of shaderFiles) {
    const absPath = path.join(ROOT_DIR, relPath);
    const content = fs.readFileSync(absPath, 'utf8');
    let match;
    let blockIdx = 0;

    while ((match = glslBlockRe.exec(content)) !== null) {
      blockIdx++;
      const glsl = match[1];
      let pos = 0;
      while ((pos = glsl.indexOf('pow(', pos)) !== -1) {
        if (pos > 0 && /[A-Za-z0-9_.]/.test(glsl[pos - 1])) {
          pos += 4;
          continue;
        }
        let depth = 0;
        let commaIdx = -1;
        for (let i = pos + 4; i < glsl.length; i++) {
          const ch = glsl[i];
          if (ch === '(') depth++;
          else if (ch === ')') {
            if (depth === 0) break;
            depth--;
          } else if (ch === ',' && depth === 0) {
            commaIdx = i;
            break;
          }
        }
        assert.notEqual(commaIdx, -1, `Malformed pow() call in ${relPath} block #${blockIdx}`);
        const baseArg = glsl.slice(pos + 4, commaIdx).trim();
        const isClamped =
          /^max\s*\([\s\S]*,\s*(1e-4|0\.0001)\s*\)$/.test(baseArg) ||
          /^max\s*\(\s*(1e-4|0\.0001)\s*,[\s\S]*\)$/.test(baseArg);
        assert.ok(
          isClamped,
          `Unguarded GLSL pow() base in ${relPath} block #${blockIdx}: pow(${baseArg}, ...) — must clamp with max(..., 1e-4)`,
        );
        pos = commaIdx + 1;
      }
    }
  }

  const postSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/post/PostPipeline.ts'), 'utf8');
  assert.ok(
    postSrc.includes('isnan(') && postSrc.includes('isinf('),
    'src/post/PostPipeline.ts must sanitise non-finite (isnan/isinf) HDR values before bloom',
  );
  console.log('[PASS] Static GLSL pow() clamp & HDR sanitiser audit');
}

// ---------------------------------------------------------------------------
// 2. STATIC HTTP SERVER FOR dist/
// ---------------------------------------------------------------------------
function startDistServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(405);
        res.end();
        return;
      }
      const cleanPath = decodeURIComponent(req.url.split('?')[0]);
      const relative = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
      let filePath = path.resolve(DIST_DIR, relative);
      if (!filePath.startsWith(DIST_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(DIST_DIR, 'index.html');
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size);
      res.writeHead(200);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(filePath).pipe(res);
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// 3. LOCATE CHROMIUM / CHROME BINARY
// ---------------------------------------------------------------------------
function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Fallback: Playwright cached headless shell
  const pwCache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (fs.existsSync(pwCache)) {
    for (const entry of fs.readdirSync(pwCache).sort().reverse()) {
      const macArm = path.join(pwCache, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
      if (fs.existsSync(macArm)) return macArm;
      const macX64 = path.join(pwCache, entry, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell');
      if (fs.existsSync(macX64)) return macX64;
    }
  }

  throw new Error('Could not find Chrome or Chromium binary. Set CHROME_PATH to run visual verification.');
}

// ---------------------------------------------------------------------------
// 4. MINIMAL CDP CLIENT OVER NATIVE WEBSOCKET
// ---------------------------------------------------------------------------
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString('utf8'));
      if (msg.id) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(`CDP ${entry.method} failed: ${msg.error.message}`));
          } else {
            entry.resolve(msg.result || {});
          }
        }
      } else if (msg.method) {
        const cbs = this.listeners.get(msg.method);
        if (cbs) {
          for (const cb of cbs) cb(msg.params || {});
        }
      }
    });
  }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${wsUrl}`)), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to ${wsUrl}: ${err.message || err}`));
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout waiting for ${method}`));
      }, 20000);
      this.pending.set(id, {
        method,
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Page evaluation failed: ${text}`);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// 5. PURE-NODE PNG DECODER & PIXEL LUMINANCE / COLOUR VARIANCE SAMPLER
// ---------------------------------------------------------------------------
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgb(buffer) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(buffer.subarray(0, 8).equals(sig), 'Invalid PNG signature');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  assert.equal(bitDepth, 8, `Unsupported PNG bitDepth ${bitDepth}`);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(bpp === 3 || bpp === 4, `Unsupported PNG colorType ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const pixels = new Uint8Array(height * stride);

  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[inPos++];
      const a = x >= bpp ? pixels[rowStart + x - bpp] : 0;
      const b = y > 0 ? pixels[rowStart - stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[rowStart - stride + x - bpp] : 0;
      let recon = v;
      if (filter === 1) recon = (v + a) & 0xff;
      else if (filter === 2) recon = (v + b) & 0xff;
      else if (filter === 3) recon = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon = (v + paethPredictor(a, b, c)) & 0xff;
      pixels[rowStart + x] = recon;
    }
  }

  return { width, height, bpp, pixels };
}

function analysePngRegion(pngBuffer) {
  const { width, height, bpp, pixels } = decodePngRgb(pngBuffer);
  // Sample central 3D viewport excluding letterbox bars (5.5vh top/bottom) and bottom control dock
  const x0 = Math.floor(width * 0.08);
  const x1 = Math.floor(width * 0.92);
  const y0 = Math.floor(height * 0.12);
  const y1 = Math.floor(height * 0.76);
  const step = 4;

  let count = 0;
  let sumLum = 0;
  let sumLumSq = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumRSq = 0;
  let sumGSq = 0;
  let sumBSq = 0;
  let nonBlack = 0;

  for (let y = y0; y < y1; y += step) {
    const rowOffset = y * width * bpp;
    for (let x = x0; x < x1; x += step) {
      const idx = rowOffset + x * bpp;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sumLum += lum;
      sumLumSq += lum * lum;
      sumR += r;
      sumG += g;
      sumB += b;
      sumRSq += r * r;
      sumGSq += g * g;
      sumBSq += b * b;
      if (lum > 4) nonBlack++;
      count++;
    }
  }

  const meanLuminance = sumLum / count;
  const lumVariance = Math.max(0, sumLumSq / count - meanLuminance * meanLuminance);
  const varR = Math.max(0, sumRSq / count - (sumR / count) ** 2);
  const varG = Math.max(0, sumGSq / count - (sumG / count) ** 2);
  const varB = Math.max(0, sumBSq / count - (sumB / count) ** 2);
  const colourVariance = varR + varG + varB;

  return {
    meanLuminance,
    lumVariance,
    colourVariance,
    nonBlackRatio: nonBlack / count,
    sampleCount: count,
  };
}

// ---------------------------------------------------------------------------
// 6. LAUNCH HEADLESS CHROME & RUN VERIFICATION SUITE
// ---------------------------------------------------------------------------
async function launchChrome(chromePath, userDataDir) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--window-size=960,540',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];

  const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let stderrBuf = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out launching Chrome. stderr:\n${stderrBuf}`));
    }, 15000);

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrBuf += text;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrBuf);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited prematurely with code ${code}. stderr:\n${stderrBuf}`));
    });
  });

  const port = new URL(wsUrl).port;
  const targetsRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await targetsRes.json();
  const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  assert.ok(pageTarget, 'No inspectable page target found in headless Chrome');

  const cdp = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  return { proc, cdp };
}

async function clickSelector(cdp, selector) {
  const rect = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  })()`);
  assert.ok(rect && rect.width > 0 && rect.height > 0, `Element not clickable/visible: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

async function pressKey(cdp, key, code) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key.length === 1 ? key : '' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
}

async function waitFrames(cdp, count = 3) {
  await cdp.evaluate(`new Promise((resolve) => {
    let left = ${count};
    const step = () => {
      if (--left <= 0) resolve(true);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`);
}

function vec3Dist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.hypot(dx, dy, dz);
}

async function run() {
  auditGlslShaders();

  assert.ok(fs.existsSync(path.join(DIST_DIR, 'index.html')), 'dist/index.html missing — run vite build first');

  const { server, url } = await startDistServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dogfight-chrome-'));
  let chromeProc = null;
  let cdp = null;

  const consoleErrors = [];
  const pageErrors = [];

  try {
    const chromePath = findChromeBinary();
    const launched = await launchChrome(chromePath, userDataDir);
    chromeProc = launched.proc;
    cdp = launched.cdp;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 960,
      height: 540,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Hook WebGL2 shader compilation & program linking to trap any GLSL errors
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__WEBGL_SHADER_ERRORS__ = [];
        const origCompile = WebGL2RenderingContext.prototype.compileShader;
        WebGL2RenderingContext.prototype.compileShader = function(shader) {
          origCompile.call(this, shader);
          if (!this.getShaderParameter(shader, this.COMPILE_STATUS)) {
            window.__WEBGL_SHADER_ERRORS__.push('ShaderCompileError: ' + (this.getShaderInfoLog(shader) || 'unknown'));
          }
        };
        const origLink = WebGL2RenderingContext.prototype.linkProgram;
        WebGL2RenderingContext.prototype.linkProgram = function(program) {
          origLink.call(this, program);
          if (!this.getProgramParameter(program, this.LINK_STATUS)) {
            window.__WEBGL_SHADER_ERRORS__.push('ProgramLinkError: ' + (this.getProgramInfoLog(program) || 'unknown'));
          }
        };
      })();`,
    });

    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      const text = (args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (type === 'error' || /THREE\.WebGLProgram:\s*Shader Error|GL_INVALID/i.test(text)) {
        consoleErrors.push(`[console.${type}] ${text}`);
      }
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const text = exceptionDetails.exception?.description || exceptionDetails.text || 'Unknown exception';
      pageErrors.push(text);
    });
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') {
        consoleErrors.push(`[log.${entry.level}] ${entry.text}`);
      }
    });

    await cdp.send('Page.navigate', { url });

    // Wait for __DOGFIGHT_DEBUG__ and #btn-launch
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.evaluate(`Boolean(window.__DOGFIGHT_DEBUG__ && document.getElementById('btn-launch'))`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const debugCheck = await cdp.evaluate(`(() => {
      const d = window.__DOGFIGHT_DEBUG__;
      if (!d) return null;
      const requiredKeys = ['currentTime', 'camMode', 'cameraTag', 'cameraPosition', 'hudEnabled', 'tripIntensity', 'isPlaying', 'fps'];
      const missing = requiredKeys.filter((k) => !(k in d));
      return {
        missing,
        hasSeek: typeof d.seek === 'function',
        isFrozen: Object.isFrozen(d),
      };
    })()`);
    assert.ok(debugCheck, 'window.__DOGFIGHT_DEBUG__ is not exposed');
    assert.deepEqual(debugCheck.missing, [], `Missing debug keys: ${debugCheck.missing.join(', ')}`);
    assert.equal(debugCheck.hasSeek, true, 'window.__DOGFIGHT_DEBUG__.seek(t) must be a function');
    assert.equal(debugCheck.isFrozen, true, 'window.__DOGFIGHT_DEBUG__ must be read-only (frozen)');
    console.log('[PASS] window.__DOGFIGHT_DEBUG__ telemetry interface verified');

    // Click #btn-launch
    await clickSelector(cdp, '#btn-launch');
    await waitFrames(cdp, 4);

    const launchState = await cdp.evaluate(`(() => ({
      overlayHidden: document.getElementById('launch-overlay').classList.contains('hidden'),
      dockVisible: !document.getElementById('control-dock').classList.contains('hidden'),
      isPlaying: window.__DOGFIGHT_DEBUG__.isPlaying,
      fps: window.__DOGFIGHT_DEBUG__.fps,
    }))()`);
    assert.equal(launchState.overlayHidden, true, 'Launch overlay should hide after clicking #btn-launch');
    assert.equal(launchState.dockVisible, true, 'Control dock should become visible after launch');
    assert.equal(launchState.isPlaying, true, 'Playback should be active after clicking #btn-launch');
    console.log(`[PASS] Launch sequence active (fps=${launchState.fps})`);

    // Pause during deterministic multi-act pixel sampling so timestamps are exact
    await clickSelector(cdp, '#btn-play');
    await waitFrames(cdp, 2);
    assert.equal(await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.isPlaying`), false, 'Play/Pause button should pause playback');

    // Sample rendered canvas pixels across all 5 acts (t = 2, 24.5, 45, 59, 70)
    const actTimestamps = [2, 24.5, 45, 59, 70];
    for (const t of actTimestamps) {
      await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.seek(${t})`);
      await waitFrames(cdp, 2);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const pngStats = analysePngRegion(Buffer.from(shot.data, 'base64'));
      const glStats = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.sampleCanvasStats()`);

      assert.ok(
        pngStats.meanLuminance > 12,
        `Act timestamp t=${t}s screenshot too dark (meanLuminance=${pngStats.meanLuminance.toFixed(2)}, expected > 12)`,
      );
      assert.ok(
        pngStats.colourVariance > 25,
        `Act timestamp t=${t}s screenshot lacks colour variance (${pngStats.colourVariance.toFixed(2)})`,
      );
      assert.ok(
        glStats.meanLuminance > 12 && glStats.colourVariance > 25,
        `Act timestamp t=${t}s WebGL framebuffer too dark/flat (mean=${glStats.meanLuminance.toFixed(2)}, var=${glStats.colourVariance.toFixed(2)})`,
      );
      console.log(
        `[PASS] Act sample t=${t}s: pngLum=${pngStats.meanLuminance.toFixed(1)}, pngVar=${pngStats.colourVariance.toFixed(0)}, glLum=${glStats.meanLuminance.toFixed(1)}`,
      );
    }

    // Verify all 5 camera buttons click cleanly, highlight active button, update HUD tag, and move to distinct positions
    await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.seek(2.0)`);
    await waitFrames(cdp, 2);

    const expectedModes = [
      { mode: 'cockpit', expectedTag: 'COCKPIT HUD' },
      { mode: 'chase', expectedTag: 'TAIL CHASE' },
      { mode: 'orbit', expectedTag: 'FREE ORBIT' },
      { mode: 'cinematic', expectedTag: 'BAYHEM ORBIT' },
      { mode: 'auto', expectedTag: 'LOW SEA SKIM' },
    ];
    const camPositions = new Map();

    for (const { mode, expectedTag } of expectedModes) {
      await clickSelector(cdp, `.cam-btn[data-cam="${mode}"]`);
      await waitFrames(cdp, 2);
      const state = await cdp.evaluate(`(() => {
        const activeBtns = Array.from(document.querySelectorAll('.cam-btn.active')).map((b) => b.dataset.cam);
        const d = window.__DOGFIGHT_DEBUG__;
        return {
          activeBtns,
          camMode: d.camMode,
          cameraTag: d.cameraTag,
          cameraPosition: d.cameraPosition,
          cameraUp: d.cameraUp,
        };
      })()`);

      assert.deepEqual(state.activeBtns, [mode], `Expected active button [${mode}], got [${state.activeBtns.join(', ')}]`);
      assert.equal(state.camMode, mode, `Expected camMode=${mode}, got ${state.camMode}`);
      assert.equal(state.cameraTag, expectedTag, `Expected cameraTag=${expectedTag}, got ${state.cameraTag}`);
      camPositions.set(mode, state.cameraPosition);

      // Verify each camera view renders an unobstructed non-black frame
      const glStats = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.sampleCanvasStats()`);
      assert.ok(
        glStats.meanLuminance > 12 && glStats.colourVariance > 20,
        `Camera mode ${mode} appears obstructed or black (lum=${glStats.meanLuminance.toFixed(1)}, var=${glStats.colourVariance.toFixed(1)})`,
      );
      console.log(
        `[PASS] Camera button ${mode} -> tag="${state.cameraTag}", pos=[${state.cameraPosition.map((v) => v.toFixed(1)).join(', ')}], lum=${glStats.meanLuminance.toFixed(1)}`,
      );
    }

    // Confirm all 5 camera positions are mutually distinct (> 3 world units apart)
    const modeList = Array.from(camPositions.keys());
    for (let i = 0; i < modeList.length; i++) {
      for (let j = i + 1; j < modeList.length; j++) {
        const a = modeList[i];
        const b = modeList[j];
        const d = vec3Dist(camPositions.get(a), camPositions.get(b));
        assert.ok(d > 3.0, `Camera modes ${a} and ${b} are not distinct (distance=${d.toFixed(2)})`);
      }
    }
    console.log('[PASS] All 5 camera modes have mutually distinct unobstructed viewpoints');

    // Verify cockpit camera tilts camera.up with the jet during banking/Cobra and resets on exit
    await clickSelector(cdp, '.cam-btn[data-cam="cockpit"]');
    await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.seek(59.0)`); // Inverted Cobra!
    await waitFrames(cdp, 2);
    const cobraUp = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.cameraUp`);
    assert.ok(
      cobraUp[1] < 0.85 || Math.abs(cobraUp[0]) > 0.15,
      `Cockpit camera.up should align with banked/inverted jet (got [${cobraUp.map((v) => v.toFixed(2)).join(', ')}])`,
    );
    await clickSelector(cdp, '.cam-btn[data-cam="chase"]');
    await waitFrames(cdp, 2);
    const chaseUp = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.cameraUp`);
    assert.ok(
      Math.abs(chaseUp[0]) < 0.01 && Math.abs(chaseUp[1] - 1) < 0.01 && Math.abs(chaseUp[2]) < 0.01,
      `Switching away from cockpit should reset camera.up to (0,1,0) (got [${chaseUp.join(', ')}])`,
    );
    console.log('[PASS] Cockpit jet-aligned camera.up and clean mode reset verified');

    // Verify Orbit mode allows free mouse drag without being overwritten
    await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.seek(2.0)`);
    await clickSelector(cdp, '.cam-btn[data-cam="orbit"]');
    await waitFrames(cdp, 2);
    const beforeDrag = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.cameraPosition`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 480, y: 240 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 480, y: 240, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 480 + step * 28,
        y: 240 - step * 10,
        buttons: 1,
      });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 704, y: 160, button: 'left', clickCount: 1 });
    await waitFrames(cdp, 5);
    const afterDrag = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.cameraPosition`);
    const dragDist = vec3Dist(beforeDrag, afterDrag);
    assert.ok(dragDist > 5.0, `Orbit drag should move camera freely (delta=${dragDist.toFixed(2)})`);
    await waitFrames(cdp, 10);
    const settledPos = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.cameraPosition`);
    assert.ok(
      vec3Dist(beforeDrag, settledPos) > 5.0,
      'Orbit camera position was overwritten back to initial view after drag',
    );
    console.log(`[PASS] Orbit mode free drag persists (moved ${dragDist.toFixed(1)} units)`);

    // Verify keyboard shortcuts 1-5
    const keyMap = [
      ['1', 'Digit1', 'auto'],
      ['2', 'Digit2', 'cockpit'],
      ['3', 'Digit3', 'chase'],
      ['4', 'Digit4', 'orbit'],
      ['5', 'Digit5', 'cinematic'],
      ['1', 'Digit1', 'auto'],
    ];
    for (const [key, code, mode] of keyMap) {
      await pressKey(cdp, key, code);
      await waitFrames(cdp, 1);
      const actualMode = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.camMode`);
      assert.equal(actualMode, mode, `Key '${key}' should switch camMode to ${mode}, got ${actualMode}`);
    }
    console.log('[PASS] Keyboard shortcuts 1-5 verified');

    // Verify HUD toggle button
    const hudBefore = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.hudEnabled`);
    assert.equal(hudBefore, true, 'HUD should start enabled');
    await clickSelector(cdp, '#btn-hud');
    await waitFrames(cdp, 1);
    const hudOff = await cdp.evaluate(`({
      enabled: window.__DOGFIGHT_DEBUG__.hudEnabled,
      active: document.getElementById('btn-hud').classList.contains('active'),
    })`);
    assert.equal(hudOff.enabled, false, 'Clicking #btn-hud should disable HUD');
    assert.equal(hudOff.active, false, '#btn-hud should lose .active when HUD disabled');
    await clickSelector(cdp, '#btn-hud');
    await waitFrames(cdp, 1);
    assert.equal(await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.hudEnabled`), true, 'Second click should re-enable HUD');
    console.log('[PASS] HUD toggle button verified');

    // Verify LSD slider updates live state
    const tripState = await cdp.evaluate(`(() => {
      const slider = document.getElementById('trip-slider');
      slider.value = '1.35';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        label: document.getElementById('trip-value').textContent,
        tripIntensity: window.__DOGFIGHT_DEBUG__.tripIntensity,
      };
    })()`);
    assert.equal(tripState.label, '135%', `Expected trip label 135%, got ${tripState.label}`);
    assert.ok(
      Math.abs(tripState.tripIntensity - 1.35) < 0.02,
      `Expected tripIntensity ~1.35, got ${tripState.tripIntensity}`,
    );
    console.log(`[PASS] LSD overdrive slider updates live state (${tripState.label}, trip=${tripState.tripIntensity.toFixed(2)})`);

    // Verify Play/Pause resume advances timeline
    const tBeforePlay = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.currentTime`);
    await clickSelector(cdp, '#btn-play');
    await new Promise((r) => setTimeout(r, 300));
    await waitFrames(cdp, 2);
    const playState = await cdp.evaluate(`({
      isPlaying: window.__DOGFIGHT_DEBUG__.isPlaying,
      currentTime: window.__DOGFIGHT_DEBUG__.currentTime,
      btnText: document.getElementById('btn-play').textContent,
    })`);
    assert.equal(playState.isPlaying, true, 'Play/Pause should resume playback');
    assert.equal(playState.btnText, '❚❚', 'Play button should display pause icon while playing');
    assert.ok(playState.currentTime > tBeforePlay + 0.05, 'Timeline should advance while playing');
    console.log(`[PASS] Play/Pause toggle advances timeline (${tBeforePlay.toFixed(2)}s -> ${playState.currentTime.toFixed(2)}s)`);

    // Assert zero shader errors, console errors, or page errors
    const shaderErrors = await cdp.evaluate(`window.__WEBGL_SHADER_ERRORS__ || []`);
    assert.deepEqual(shaderErrors, [], `WebGL shader compilation/link errors:\n${shaderErrors.join('\n')}`);
    assert.deepEqual(pageErrors, [], `Unhandled page errors:\n${pageErrors.join('\n')}`);
    assert.deepEqual(consoleErrors, [], `Console errors:\n${consoleErrors.join('\n')}`);

    console.log('[PASS] Zero console.error, pageerror, or WebGL shader errors');
    console.log('ALL VISUAL & UI VERIFICATION CHECKS PASSED');
  } finally {
    if (cdp) cdp.close();
    if (chromeProc) {
      chromeProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 200));
      if (chromeProc.exitCode === null) chromeProc.kill('SIGKILL');
    }
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('\n[FAIL]', err && err.stack ? err.stack : err);
  process.exit(1);
});
