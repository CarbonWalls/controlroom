#!/usr/bin/env node
/*
 * controlroom — unified web panel for hum-testing + bot-mn-1
 * zero deps, node >= 18.  binds 127.0.0.1:8800
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execSync } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 8800;
const ROOT = __dirname;
const WWW = path.join(ROOT, 'www');
const HOME = os.homedir();

/* ---- service registry (paths, no secrets) ---- */
const HUM_DIR = process.env.HUM_DIR || path.join(HOME, 'projects/hum-testing');
const HUM_SCRIPT = 'mercury3.py';
const HUM_LOG = path.join(HUM_DIR, 'run.log');
const HUM_LOCK = path.join(HUM_DIR, '.mercury3.lock');
const HUM_OUTBOX = path.join(HUM_DIR, 'outbox');
const HUM_CONFIG = path.join(HUM_DIR, 'config.json');
const HUM_PROVIDERS = path.join(HUM_DIR, 'providers.json');
const HUM_MEMORY = path.join(HUM_DIR, 'memory.md');

const BRIDGE_CANDIDATES = (process.env.BRIDGE_PORTS || '8789,8793').split(',').map(n => parseInt(n, 10));

const START_TS = Date.now();

/* ---------- helpers ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '', len = 0;
    req.on('data', c => {
      len += c.length;
      if (len > limit) { reject(new Error('too large')); req.destroy(); return; }
      buf += c;
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
function tcpProbe(port, host = '127.0.0.1', timeout = 700) {
  return new Promise(resolve => {
    const s = net.connect({ port, host });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeout);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}
function pidAlive(pid) {
  if (!pid || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, patchObj) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patchObj)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}
function tailFile(file, lines) {
  try {
    const fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const size = Math.min(st.size, lines * 4096 + 4096);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(-lines);
  } catch { return []; }
}

/* ---------- bridge discovery + nonce ---------- */
let bridgePort = 0;
let bridgeNonce = '';
let bridgeNonceTs = 0;

// bot token for proxied /discord calls — loaded once, never exposed by any endpoint
const BRIDGE_ENV = process.env.BRIDGE_ENV || path.join(HOME, 'projects/bot-mn-1-debug/.env');
const BOT_TOKEN = (() => {
  try {
    const env = fs.readFileSync(BRIDGE_ENV, 'utf8');
    const m = /^TOKEN_BOT=(.+)$/m.exec(env);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

async function refreshBridge() {
  for (const p of BRIDGE_CANDIDATES) {
    if (await tcpProbe(p)) {
      bridgePort = p;
      return true;
    }
  }
  bridgePort = 0;
  return false;
}

async function getBridgeNonce() {
  if (bridgeNonce && Date.now() - bridgeNonceTs < 60_000) return bridgeNonce;
  const html = await bridgeRaw('GET', '/');
  const m = /x-bridge-nonce" content="([^"]+)/.exec(html.body || '');
  bridgeNonce = m ? m[1] : '';
  bridgeNonceTs = Date.now();
  return bridgeNonce;
}

function bridgeRaw(method, urlPath, headers = {}, body = null, portOverride = null) {
  return new Promise(resolve => {
    const port = portOverride || bridgePort;
    if (!port) return resolve({ status: 0, json: null, body: '' });
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { ...headers } }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, json: j, body: buf });
      });
    });
    req.on('error', e => resolve({ status: 0, json: null, body: '', error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function bridgeApi(method, urlPath, body = null) {
  await refreshBridge();
  if (!bridgePort) return { status: 0, json: { ok: false, error: 'bridge offline' } };
  const nonce = await getBridgeNonce();
  const headers = { 'content-type': 'application/json', 'x-client-nonce': nonce };
  if (urlPath.startsWith('/discord/')) headers['x-bot-token'] = BOT_TOKEN;
  const hb = body ? JSON.stringify(body) : null;
  let r = await bridgeRaw(method, urlPath, headers, hb);
  if (r.status === 403 && nonce) { // stale nonce: refetch once
    bridgeNonce = ''; const n2 = await getBridgeNonce();
    r = await bridgeRaw(method, urlPath, { ...headers, 'x-client-nonce': n2 }, hb);
  }
  return r;
}

/* ---------- mercury (hum-testing) control ---------- */
function mercuryPid() {
  try {
    const pid = parseInt(fs.readFileSync(HUM_LOCK, 'utf8').trim(), 10);
    // confirm it's actually mercury3, not a recycled pid
    if (pidAlive(pid)) {
      try {
        const cl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cl.includes(HUM_SCRIPT)) return pid;
      } catch { if (process.platform !== 'linux') return pid; }
    }
  } catch {}
  return 0;
}

function mercuryStart() {
  if (mercuryPid()) return { ok: true, msg: 'already running' };
  if (!fs.existsSync(path.join(HUM_DIR, HUM_SCRIPT))) return { ok: false, error: 'mercury3.py not found' };
  const out = fs.openSync(HUM_LOG, 'a');
  const child = spawn('python3', ['-u', HUM_SCRIPT], {
    cwd: HUM_DIR, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);
  return { ok: true, pid: child.pid };
}

function mercuryStop() {
  const pid = mercuryPid();
  if (!pid) return { ok: true, msg: 'not running' };
  try { process.kill(pid, 'SIGTERM'); return { ok: true, pid }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function mercuryStatusExtra() {
  const pid = mercuryPid();
  let uptime = 0, lastBeat = 0, mem = 0;
  // /proc/stat (btime) is blocked on this Android host — derive uptime from the
  // lock file's mtime (written at boot) and liveness from run.log's mtime
  if (pid) {
    try { uptime = Math.floor(Date.now() / 1000 - fs.statSync(HUM_LOCK).mtimeMs / 1000); } catch {}
    try { lastBeat = Math.floor(Date.now() / 1000 - fs.statSync(HUM_LOG).mtimeMs / 1000); } catch {}
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+) kB/.exec(st);
      if (m) mem = Math.round(parseInt(m[1], 10) / 1024);
    } catch {}
  }
  let outboxCount = 0;
  try { outboxCount = fs.readdirSync(HUM_OUTBOX).filter(f => f.endsWith('.txt')).length; } catch {}
  return { pid, uptime_s: uptime, last_beat_s: lastBeat, mem_mb: mem, outbox: outboxCount };
}

/* ---------- SSE log follow ---------- */
const followers = new Set();
let lastLogSize = 0;
function startLogFollow() {
  setInterval(() => {
    let st;
    try { st = fs.statSync(HUM_LOG); } catch { return; }
    if (st.size === lastLogSize) return;
    if (st.size < lastLogSize) lastLogSize = 0; // truncated
    const fd = fs.openSync(HUM_LOG, 'r');
    const len = st.size - lastLogSize;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, lastLogSize);
    fs.closeSync(fd);
    lastLogSize = st.size;
    const evt = `data: ${JSON.stringify(buf.toString('utf8'))}\n\n`;
    for (const res of followers) { try { res.write(evt); } catch { followers.delete(res); } }
  }, 1000).unref?.();
}
try { lastLogSize = fs.statSync(HUM_LOG).size; } catch {}

/* ---------- status snapshot ---------- */
async function statusSnapshot() {
  const bridgeUp = await refreshBridge();
  let bridge = { up: false };
  if (bridgeUp) {
    const h = await bridgeRaw('GET', '/bridge/health');
    bridge = { up: true, port: bridgePort, ...(h.json || {}) };
  }
  const humPid = mercuryPid();
  return {
    ts: Date.now(),
    panel: { uptime_s: Math.floor((Date.now() - START_TS) / 1000), version: PANEL_VERSION },
    bridge,
    hum: { up: !!humPid, ...mercuryStatusExtra() },
  };
}
const PANEL_VERSION = '1.0.0';

/* ---------- routing ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

function serveStatic(res, p) {
  if (p === '/') p = '/index.html';
  const file = path.join(WWW, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WWW)) { res.writeHead(404); return res.end('nf'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://controlroom');
  const p = url.pathname;
  try {
    /* --- api --- */
    if (p === '/api/status' && req.method === 'GET') return json(res, 200, await statusSnapshot());

    if (p === '/api/logs' && req.method === 'GET') {
      const n = Math.min(parseInt(url.searchParams.get('tail'), 10) || 200, 2000);
      const lines = tailFile(HUM_LOG, n);
      return json(res, 200, { ok: true, lines, size: (() => { try { return fs.statSync(HUM_LOG).size; } catch { return 0; } })() });
    }

    if (p === '/api/logs/follow' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      followers.add(res);
      const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ka); followers.delete(res); });
      return;
    }

    if (p === '/api/hum/start' && req.method === 'POST') {
      const r = mercuryStart();
      return json(res, 200, { ok: !!r.ok, msg: r.msg || 'started', error: r.error, status: { pid: mercuryPid() } });
    }
    if (p === '/api/hum/stop' && req.method === 'POST') {
      const r = mercuryStop();
      return json(res, 200, r);
    }
    if (p === '/api/hum/outbox' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const text = String(body.text || '').slice(0, 4000);
      if (!text.trim()) return json(res, 400, { ok: false, error: 'empty' });
      fs.mkdirSync(HUM_OUTBOX, { recursive: true });
      const name = `panel-${Date.now()}.txt`;
      fs.writeFileSync(path.join(HUM_OUTBOX, name), text);
      return json(res, 200, { ok: true, name });
    }

    if (p === '/api/hum/config' && req.method === 'GET') {
      // config.json + providers (redacted) — never .env
      let cfg = null, prov = null;
      try { cfg = JSON.parse(fs.readFileSync(HUM_CONFIG, 'utf8')); } catch {}
      try {
        prov = JSON.parse(fs.readFileSync(HUM_PROVIDERS, 'utf8'));
        prov = redactProviders(prov);
      } catch {}
      return json(res, 200, { ok: true, config: cfg, providers: prov });
    }
    if (p === '/api/hum/config' && req.method === 'POST') {
      const cfg = JSON.parse(await readBody(req) || 'null');
      if (!cfg || typeof cfg !== 'object') return json(res, 400, { ok: false, error: 'bad json' });
      // sanity: must keep required keys or mercury dies on reload
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(HUM_CONFIG, 'utf8')); } catch {}
      const merged = deepMerge(prev, cfg);
      if (!merged.channel_id) return json(res, 400, { ok: false, error: 'channel_id required' });
      fs.writeFileSync(HUM_CONFIG, JSON.stringify(merged, null, 2));
      return json(res, 200, { ok: true, note: 'hot-reloaded in ~3s by the watchdog' });
    }

    if (p === '/api/hum/memory' && req.method === 'GET') {
      let txt = ''; try { txt = fs.readFileSync(HUM_MEMORY, 'utf8').slice(0, 20000); } catch {}
      return json(res, 200, { ok: true, text: txt });
    }
    if (p === '/api/hum/memory' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      fs.writeFileSync(HUM_MEMORY, String(body.text || '').slice(0, 40000));
      return json(res, 200, { ok: true });
    }
    function redactProviders(prov) {
      // providers.json uses "${ENV_VAR}" placeholders — already safe; strip any literal key-looking values
      const s = JSON.stringify(prov);
      if (/[A-Za-z0-9_-]{32,}\.sk-|sk-[A-Za-z0-9_-]{20,}/.test(s)) return { redacted: true };
      return prov;
    }

    /* --- bridge proxy (nonce handled server-side) --- */
    if (p === '/api/bridge/open' && req.method === 'GET') {
      await refreshBridge();
      return json(res, 200, { ok: !!bridgePort, url: `http://127.0.0.1:${bridgePort}/` });
    }
    if (p.startsWith('/api/bridge/')) {
      const sub = p.slice('/api/bridge'.length);
      if (!sub.startsWith('/')) return json(res, 400, { ok: false });
      let bodyObj = null;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const raw = await readBody(req);
        try { bodyObj = raw ? JSON.parse(raw) : null; } catch { bodyObj = null; }
      }
      const r = await bridgeApi(req.method, sub, bodyObj);
      return json(res, r.status || 502, r.json || { ok: false, error: r.error || 'bridge unreachable', status: r.status });
    }

    if (p === '/api/backups' && req.method === 'GET') {
      // list channel backups from both clones' data dirs (running process decides which fills)
      const dirs = [
        path.join(HOME, 'projects/bot-mn-1-debug/data/messages/backups'),
        path.join(HOME, 'projects/bot-mn-1/data/messages/backups'),
      ];
      let items = [];
      for (const d of dirs) {
        let names = [];
        try { names = fs.readdirSync(d); } catch { continue; }
        for (const n of names) {
          if (!/\.(json)$/.test(n)) continue;
          try {
            const st = fs.statSync(path.join(d, n));
            items.push({ name: n, size: st.size, mtime: st.mtimeMs, src: d.includes('debug') ? 'debug' : 'live' });
          } catch {}
        }
      }
      items.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { ok: true, items: items.slice(0, 30) });
    }

    /* --- static --- */
    if (req.method === 'GET') return serveStatic(res, p);
    return json(res, 405, { ok: false, error: 'method' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

startLogFollow();
server.listen(PORT, '127.0.0.1', () => console.log(`controlroom on http://127.0.0.1:${PORT}`));
