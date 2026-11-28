/**
 * SOLAR MACH: CHROMATIC VIPER — Static Production Server
 *
 * Serves the built production bundle from `dist/` with HTTP byte-range support
 * (for streaming audio stems) on `0.0.0.0:8080` by default so the showcase is
 * reachable over Localhost, LAN, and Tailscale Tailnet.
 *
 * Usage:
 *   make build          # Type-check and build dist/
 *   make verify         # Build + GLSL safety audit + headless Chrome WebGL2 checks
 *   npm run serve       # Host on http://0.0.0.0:8080 (or set PORT / HOST env vars)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

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
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function isTailnetIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 100 && second >= 64 && second <= 127;
}

function resolveFilePath(urlPath) {
  let cleanPath;
  try {
    cleanPath = decodeURIComponent((urlPath || '/').split('?')[0]);
  } catch {
    return null;
  }
  const relative = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
  const fullPath = path.resolve(DIST_DIR, relative);
  if (fullPath !== DIST_DIR && !fullPath.startsWith(DIST_DIR + path.sep)) {
    return null;
  }
  return fullPath;
}

const server = http.createServer((req, res) => {
  if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  let filePath = resolveFilePath(req.url);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found — run "make build" or "npm run build" first.');
      return;
    }
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600');

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(filePath, { start, end }).pipe(res);
        }
        return;
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
  });

  if (req.method === 'HEAD') {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n[server] Port ${PORT} on ${HOST} is already in use. Set PORT=<number> to choose another port.\n`);
  } else {
    console.error('\n[server] Failed to start:', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\nSOLAR MACH: CHROMATIC VIPER — Static Server Running (${HOST}:${PORT})`);
  console.log(`  Localhost: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const tag = isTailnetIpv4(addr.address) ? 'Tailnet  ' : `LAN (${name})`;
        console.log(`  ${tag}: http://${addr.address}:${PORT}`);
      }
    }
  }
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.warn('\n  [warn] dist/index.html not found — run "make build" or "npm run build" first.');
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
