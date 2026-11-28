import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const BENCH_WIDTH = Math.max(320, Number.parseInt(process.env.BENCH_WIDTH || '1280', 10) || 1280);
const BENCH_HEIGHT = Math.max(240, Number.parseInt(process.env.BENCH_HEIGHT || '720', 10) || 720);
const BENCH_DPR = Math.max(1, Number.parseFloat(process.env.BENCH_DPR || '1') || 1);
const WARMUP_FRAMES = 5;
const SAMPLE_FRAMES = 20;

const ACT_SAMPLES = [
  { label: 'Act 1', t: 2 },
  { label: 'Act 2', t: 24.5 },
  { label: 'Act 3', t: 45 },
  { label: 'Act 4', t: 59 },
  { label: 'Act 5', t: 70 },
];

const REQUIRED_PERF_KEYS = [
  'drawCalls',
  'triangles',
  'programs',
  'geometries',
  'textures',
  'pixelRatio',
  'drsMode',
  'frameMsP50',
  'frameMsP95',
  'frameMsP99',
  'fps',
];

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
// 1. ENSURE dist/ EXISTS & SERVE OVER LOCAL HTTP
// ---------------------------------------------------------------------------
function ensureDistBuilt() {
  if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) return;
  const viteBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'vite');
  const res = spawnSync(viteBin, ['build'], { cwd: ROOT_DIR, stdio: 'inherit' });
  assert.equal(res.status, 0, 'vite build failed while preparing dist/ for benchmark');
  assert.ok(fs.existsSync(path.join(DIST_DIR, 'index.html')), 'dist/index.html missing after vite build');
}

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
// 2. LOCATE CHROMIUM / CHROME BINARY (same discovery pattern as visual.spec.mjs)
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

  throw new Error('Could not find Chrome or Chromium binary. Set CHROME_PATH to run WebGL benchmarks.');
}

// ---------------------------------------------------------------------------
// 3. ZERO-DEPENDENCY CDP CLIENT OVER NATIVE WEBSOCKET
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
      }, 30000);
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

async function launchChrome(chromePath, userDataDir) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--window-size=${BENCH_WIDTH},${BENCH_HEIGHT}`,
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

// ---------------------------------------------------------------------------
// 4. PERCENTILE & FORMATTING HELPERS
// ---------------------------------------------------------------------------
function round2(n) {
  return Math.round(n * 100) / 100;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function computeFrameSummary(deltas) {
  const valid = deltas.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  assert.ok(valid.length > 0, 'Expected at least one positive frame delta');
  const meanMs = valid.reduce((acc, v) => acc + v, 0) / valid.length;
  return {
    frameMsP50: round2(percentile(valid, 0.5)),
    frameMsP95: round2(percentile(valid, 0.95)),
    frameMsP99: round2(percentile(valid, 0.99)),
    fps: round1(1000 / meanMs),
  };
}

function assertPerfStatsShape(stats, contextLabel) {
  assert.ok(stats && typeof stats === 'object', `${contextLabel}: getPerfStats() must return an object`);
  for (const key of REQUIRED_PERF_KEYS) {
    assert.ok(key in stats, `${contextLabel}: getPerfStats() missing required key "${key}"`);
  }
  assert.ok(
    Number.isFinite(stats.drawCalls) && stats.drawCalls > 1,
    `${contextLabel}: drawCalls must reflect full multi-pass frame (got ${stats.drawCalls})`,
  );
  assert.ok(
    Number.isFinite(stats.triangles) && stats.triangles > 100,
    `${contextLabel}: triangles must reflect rendered 3D scene (got ${stats.triangles})`,
  );
  assert.ok(
    Number.isFinite(stats.programs) && stats.programs > 0,
    `${contextLabel}: programs must be > 0 (got ${stats.programs})`,
  );
  assert.ok(
    Number.isFinite(stats.geometries) && stats.geometries > 0,
    `${contextLabel}: geometries must be > 0 (got ${stats.geometries})`,
  );
  assert.ok(
    Number.isFinite(stats.textures) && stats.textures > 0,
    `${contextLabel}: textures must be > 0 (got ${stats.textures})`,
  );
  assert.ok(
    Number.isFinite(stats.pixelRatio) && stats.pixelRatio > 0,
    `${contextLabel}: pixelRatio must be > 0 (got ${stats.pixelRatio})`,
  );
  assert.ok(
    stats.drsMode === 'native' || stats.drsMode === 'auto',
    `${contextLabel}: drsMode must be "native" or "auto" (got ${JSON.stringify(stats.drsMode)})`,
  );
  assert.ok(
    Number.isFinite(stats.frameMsP50) && stats.frameMsP50 > 0,
    `${contextLabel}: frameMsP50 must be > 0 (got ${stats.frameMsP50})`,
  );
  assert.ok(
    Number.isFinite(stats.frameMsP95) && stats.frameMsP95 >= stats.frameMsP50,
    `${contextLabel}: frameMsP95 (${stats.frameMsP95}) must be >= frameMsP50 (${stats.frameMsP50})`,
  );
  assert.ok(
    Number.isFinite(stats.frameMsP99) && stats.frameMsP99 >= stats.frameMsP95,
    `${contextLabel}: frameMsP99 (${stats.frameMsP99}) must be >= frameMsP95 (${stats.frameMsP95})`,
  );
  assert.ok(
    Number.isFinite(stats.fps) && stats.fps > 0,
    `${contextLabel}: fps must be > 0 (got ${stats.fps})`,
  );
}

function formatTable(rows, summary) {
  const headers = [
    'Act',
    't(s)',
    'Draws',
    'Triangles',
    'Progs',
    'Geoms',
    'Tex',
    'p50(ms)',
    'p95(ms)',
    'p99(ms)',
    'FPS',
  ];
  const data = rows.map((r) => [
    r.label,
    r.t.toFixed(1),
    String(r.drawCalls),
    String(r.triangles),
    String(r.programs),
    String(r.geometries),
    String(r.textures),
    r.frameMsP50.toFixed(2),
    r.frameMsP95.toFixed(2),
    r.frameMsP99.toFixed(2),
    r.fps.toFixed(1),
  ]);
  const summaryRow = [
    'ALL ACTS',
    '-',
    String(summary.drawCalls),
    String(summary.triangles),
    String(summary.programs),
    String(summary.geometries),
    String(summary.textures),
    summary.frameMsP50.toFixed(2),
    summary.frameMsP95.toFixed(2),
    summary.frameMsP99.toFixed(2),
    summary.fps.toFixed(1),
  ];

  const all = [headers, ...data, summaryRow];
  const widths = headers.map((_, col) => Math.max(...all.map((row) => row[col].length)));
  const fmtRow = (row) =>
    row
      .map((cell, idx) => (idx === 0 ? cell.padEnd(widths[idx]) : cell.padStart(widths[idx])))
      .join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');

  return [
    fmtRow(headers),
    sep,
    ...data.map(fmtRow),
    sep,
    fmtRow(summaryRow),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 5. RUN 5-ACT HEADLESS WEBGL BENCHMARK
// ---------------------------------------------------------------------------
async function run() {
  ensureDistBuilt();

  const { server, url } = await startDistServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dogfight-bench-'));
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
      width: BENCH_WIDTH,
      height: BENCH_HEIGHT,
      deviceScaleFactor: BENCH_DPR,
      mobile: false,
    });

    // Trap any WebGL2 shader compilation or programme link failures
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

    // Wait for __DOGFIGHT_DEBUG__ and launch button
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.evaluate(`Boolean(window.__DOGFIGHT_DEBUG__ && document.getElementById('btn-launch'))`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const hasPerfHook = await cdp.evaluate(`typeof window.__DOGFIGHT_DEBUG__?.getPerfStats === 'function'`);
    assert.equal(hasPerfHook, true, 'window.__DOGFIGHT_DEBUG__.getPerfStats() must be exposed as a function');

    // Engage playback via #btn-launch
    await clickSelector(cdp, '#btn-launch');
    const launchDeadline = Date.now() + 5000;
    while (Date.now() < launchDeadline) {
      const playing = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.isPlaying === true`);
      if (playing) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.isPlaying`), true, 'Playback must be engaged before benchmarking');

    const actResults = [];
    const allDeltas = [];

    for (const act of ACT_SAMPLES) {
      await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.seek(${act.t})`);

      // Collect WARMUP_FRAMES + SAMPLE_FRAMES inside page rAF loop with zero per-frame CDP overhead
      const sample = await cdp.evaluate(`new Promise((resolve) => {
        const warmup = ${WARMUP_FRAMES};
        const target = ${SAMPLE_FRAMES};
        const deltas = [];
        let drawSum = 0;
        let triSum = 0;
        let lastStats = null;
        let count = 0;
        let prevTs = 0;

        const tick = (ts) => {
          count++;
          if (count === warmup) {
            prevTs = ts;
          } else if (count > warmup) {
            deltas.push(ts - prevTs);
            prevTs = ts;
            const s = window.__DOGFIGHT_DEBUG__.getPerfStats();
            drawSum += s.drawCalls;
            triSum += s.triangles;
            lastStats = s;
            if (deltas.length >= target) {
              resolve({
                deltas,
                drawCalls: Math.round(drawSum / deltas.length),
                triangles: Math.round(triSum / deltas.length),
                lastStats,
              });
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })`);

      assert.equal(sample.deltas.length, SAMPLE_FRAMES, `${act.label}: expected ${SAMPLE_FRAMES} steady-state frames`);
      assertPerfStatsShape(sample.lastStats, `${act.label} (t=${act.t}s)`);

      const timing = computeFrameSummary(sample.deltas);
      allDeltas.push(...sample.deltas);

      actResults.push({
        label: act.label,
        t: act.t,
        drawCalls: sample.drawCalls,
        triangles: sample.triangles,
        programs: sample.lastStats.programs,
        geometries: sample.lastStats.geometries,
        textures: sample.lastStats.textures,
        pixelRatio: sample.lastStats.pixelRatio,
        drsMode: sample.lastStats.drsMode,
        frameMsP50: timing.frameMsP50,
        frameMsP95: timing.frameMsP95,
        frameMsP99: timing.frameMsP99,
        fps: timing.fps,
      });
    }

    const ringBufferStats = await cdp.evaluate(`window.__DOGFIGHT_DEBUG__.getPerfStats()`);
    assertPerfStatsShape(ringBufferStats, 'Final 120-frame ring buffer');

    // Assert zero shader, page, or console errors
    const shaderErrors = await cdp.evaluate(`window.__WEBGL_SHADER_ERRORS__ || []`);
    assert.deepEqual(shaderErrors, [], `WebGL shader compilation/link errors:\n${shaderErrors.join('\n')}`);
    assert.deepEqual(pageErrors, [], `Unhandled page errors:\n${pageErrors.join('\n')}`);
    assert.deepEqual(consoleErrors, [], `Console errors:\n${consoleErrors.join('\n')}`);

    const overallTiming = computeFrameSummary(allDeltas);
    const summary = {
      drawCalls: Math.round(actResults.reduce((acc, r) => acc + r.drawCalls, 0) / actResults.length),
      triangles: Math.round(actResults.reduce((acc, r) => acc + r.triangles, 0) / actResults.length),
      programs: ringBufferStats.programs,
      geometries: ringBufferStats.geometries,
      textures: ringBufferStats.textures,
      pixelRatio: ringBufferStats.pixelRatio,
      drsMode: ringBufferStats.drsMode,
      frameMsP50: overallTiming.frameMsP50,
      frameMsP95: overallTiming.frameMsP95,
      frameMsP99: overallTiming.frameMsP99,
      fps: overallTiming.fps,
    };

    const report = {
      viewport: {
        width: BENCH_WIDTH,
        height: BENCH_HEIGHT,
        pixelRatio: ringBufferStats.pixelRatio,
      },
      drsMode: ringBufferStats.drsMode,
      framesPerAct: SAMPLE_FRAMES,
      summary,
      ringBufferStats: {
        ...ringBufferStats,
        frameMsP50: round2(ringBufferStats.frameMsP50),
        frameMsP95: round2(ringBufferStats.frameMsP95),
        frameMsP99: round2(ringBufferStats.frameMsP99),
        fps: round1(ringBufferStats.fps),
      },
      acts: actResults,
    };

    console.log(`\nSOLAR MACH: CHROMATIC VIPER — 5-Act WebGL Benchmark (${BENCH_WIDTH}x${BENCH_HEIGHT} @ DPR ${ringBufferStats.pixelRatio}, DRS=${ringBufferStats.drsMode}, ${SAMPLE_FRAMES} frames/act)`);
    console.log(formatTable(actResults, summary));
    console.log('\nBENCH_JSON_START');
    console.log(JSON.stringify(report, null, 2));
    console.log('BENCH_JSON_END');
    console.log('[PASS] 5-act WebGL benchmark completed with zero console or WebGL errors');
  } finally {
    if (cdp) cdp.close();
    if (chromeProc && chromeProc.exitCode === null && chromeProc.signalCode === null) {
      const exited = new Promise((resolve) => chromeProc.once('exit', resolve));
      chromeProc.kill('SIGTERM');
      const result = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);
      if (result === 'timeout' && chromeProc.exitCode === null) {
        chromeProc.kill('SIGKILL');
        await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000))]);
      }
    }
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

run().catch((err) => {
  console.error('\n[FAIL]', err && err.stack ? err.stack : err);
  process.exit(1);
});
