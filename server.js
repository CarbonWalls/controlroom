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
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 8800;
const ROOT = __dirname;
const WWW = path.join(ROOT, 'www');
const HOME = os.homedir();

/* ---- service registry (paths, no secrets) ---- */
// vendored mercury (script + template config); runtime data lives beside it in the same dir
const HUM_DIR = process.env.HUM_DIR || path.join(ROOT, 'mercury');
const HUM_SCRIPT = 'mercury3.py';
const HUM_LOG = path.join(HUM_DIR, 'run.log');
const HUM_LOCK = path.join(HUM_DIR, '.mercury3.lock');
const HUM_OUTBOX = path.join(HUM_DIR, 'outbox');
const HUM_CONFIG = path.join(HUM_DIR, 'config.json');
const HUM_PROVIDERS = path.join(HUM_DIR, 'providers.json');
const HUM_MEMORY = path.join(HUM_DIR, 'memory.md');

const BRIDGE_CANDIDATES = (process.env.BRIDGE_PORTS || '8789,8793').split(',').map(n => parseInt(n, 10));
// where a bridge.js lives + how to run it (a cloner of THIS repo usually hasn't
// set up bot-mn-1 separately — controlroom can own the whole stack)
// vendored bridge lives INSIDE this repo — the clone is self-sufficient
const BRIDGE_DIR = process.env.BRIDGE_DIR || path.join(ROOT, 'bridge');
const BRIDGE_SCRIPT = path.join(BRIDGE_DIR, 'bridge.js');
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT, 10) || 8789;
const BRIDGE_START = process.env.BRIDGE_START || `node bridge.js`;

const START_TS = Date.now();

/* ---------- helpers ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '', len = 0, overflow = null;
    // drain-then-throw: a mid-stream req.destroy() resets the socket before the
    // 413 can be delivered, so the client sees ECONNRESET instead of an error
    req.on('data', c => {
      len += c.length;
      if (len > limit) { if (!overflow) overflow = new Error('too large'); return; }
      buf += c;
    });
    req.on('end', () => overflow ? reject(overflow) : resolve(buf));
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

let whoamiCache = null;
// bot token: bridge/.env inside the repo (chmod 600, gitignored), then legacy paths
const BRIDGE_ENVS = [
  process.env.BRIDGE_ENV,
  path.join(ROOT, 'bridge/.env'),
  path.join(HOME, 'projects/bot-mn-1-debug/.env'),
  path.join(HOME, 'projects/bot-mn-1/.env'),
].filter(Boolean);
const BOT_TOKEN = (() => {
  for (const envPath of BRIDGE_ENVS) {
    try {
      const env = fs.readFileSync(envPath, 'utf8');
      const m = /^TOKEN_BOT=(.+)$/m.exec(env);
      if (m) return m[1].trim();
    } catch {}
  }
  return '';
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
  // gateway routes that demand the bot token in the JSON body: inject it
  if (body && typeof body === 'object' && !body.token &&
      (/^\/gateway\/[^/]+\/(connect|members\/[^/]+)$/.test(urlPath) || /^\/gateway\/backup\/channel\//.test(urlPath))) {
    body = { ...body, token: BOT_TOKEN };
  }
  const hb = body ? JSON.stringify(body) : null;
  let r = await bridgeRaw(method, urlPath, headers, hb);
  if (r.status === 403 && nonce) { // stale nonce: refetch once
    bridgeNonce = ''; const n2 = await getBridgeNonce();
    r = await bridgeRaw(method, urlPath, { ...headers, 'x-client-nonce': n2 }, hb);
  }
  return r;
}

/* ---------- bridge lifecycle ---------- */
let bridgeProc = null;
function bridgePortUp() { return bridgePort === BRIDGE_PORT; }
function bridgePid() { return bridgeProc && !bridgeProc.killed ? bridgeProc.pid : 0; }
function bridgeStart() {
  if (!fs.existsSync(BRIDGE_SCRIPT)) return { ok: false, error: `bridge.js not found at ${BRIDGE_DIR} (set BRIDGE_DIR)` };
  if (!BOT_TOKEN) return { ok: false, error: 'no bot token: copy bridge/.env.example to bridge/.env and set TOKEN_BOT' };
  if (bridgePortUp()) return { ok: true, msg: 'bridge already up' };
  if (bridgePid()) return { ok: true, msg: 'bridge starting…' };
  const out = fs.openSync(path.join(ROOT, '.tmp', 'bridge.log'), 'a');
  bridgeProc = spawn('bash', ['-c', BRIDGE_START], { cwd: BRIDGE_DIR, detached: true, stdio: ['ignore', out, out] });
  bridgeProc.on('error', e => { console.error('[bridge] spawn failed:', e.message); bridgeProc = null; });
  bridgeProc.unref(); fs.closeSync(out);
  bridgeProc.on('exit', () => { bridgeProc = null; });
  return { ok: true, msg: 'bridge starting on port ' + BRIDGE_PORT };
}
function bridgeStopProc() {
  if (!bridgeProc) return { ok: true, msg: 'bridge not managed by panel (external?)' };
  try { process.kill(bridgeProc.pid, 'SIGTERM'); return { ok: true, msg: 'bridge stopped' }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/* ---------- mercury (hum-testing) control ---------- */
// argv must look like [python*, -u?, .../mercury3.py] — never match editors
// or grep lines that merely CONTAIN the script path (wrong-kill hazard)
function isMercuryArgv(argv) {
  const isPython = /python(?:\d+(?:\.\d+)?)?$/.test(argv[0] || '');
  const runsScript = argv.some(a => a === HUM_SCRIPT || a.endsWith('/' + HUM_SCRIPT));
  return isPython && runsScript;
}
function mercuryPid() {
  try {
    const raw = fs.readFileSync(HUM_LOCK, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (pidAlive(pid)) {
      try {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (isMercuryArgv(argv)) return pid;
      } catch { if (process.platform !== 'linux') return pid; }
    }
  } catch {}
  // lock empty/garbage: a rival mercury start truncates the file BEFORE it
  // fails flock and exits, destroying the live pid — scan /proc instead
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (isMercuryArgv(argv)) return parseInt(d, 10);
      } catch {}
    }
  } catch {}
  return 0;
}

function mercuryStart() {
  if (mercuryPid()) return { ok: true, msg: 'already running' };
  if (!fs.existsSync(path.join(HUM_DIR, HUM_SCRIPT))) return { ok: false, error: 'mercury3.py not found' };
  if (!fs.existsSync(path.join(HUM_DIR, '.env'))) return { ok: false, error: 'mercury/.env missing — create it with DISCORD_TOKEN=<user token> (gitignored)' };
  if (!fs.existsSync(path.join(HUM_DIR, 'config.json'))) {
    try { fs.copyFileSync(path.join(HUM_DIR, 'config.json.template'), path.join(HUM_DIR, 'config.json')); } catch {}
  }
  const out = fs.openSync(HUM_LOG, 'a');
  const child = spawn('python3', ['-u', HUM_SCRIPT], {
    cwd: HUM_DIR, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);
  // 'error' (ENOENT etc.) fires async and is an uncaughtException without a
  // listener — record it so the next status poll shows the truth
  child._spawnError = null;
  child.on('error', e => { child._spawnError = e.message; });
  setTimeout(() => { if (child._spawnError) mercuryStart.lastError = child._spawnError; }, 300);
  return { ok: !child._spawnError, pid: child.pid };
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
    // an uncaught throw inside setInterval kills the whole panel: this tick
    // touches the fs in a TOCTOU window (log rotation), so guard everything
    try {
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
    } catch { /* vanished between stat and open — next tick re-syncs */ }
  }, 1000).unref?.();
}
try { lastLogSize = fs.statSync(HUM_LOG).size; } catch {}

/* ---------- status snapshot ---------- */
async function statusSnapshot() {
  const bridgeUp = await refreshBridge();
  let bridge = { up: false, managed: !!bridgeProc, script: fs.existsSync(BRIDGE_SCRIPT) };
  if (bridgeUp) {
    const h = await bridgeRaw('GET', '/bridge/health');
    bridge = { up: true, port: bridgePort, managed: !!bridgeProc, ...(h.json || {}) };
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

  // drive-by defense: state-changing calls must be same-origin. sec-fetch-site
  // is set by every modern browser and is unforgeable in cross-site contexts;
  // the Host check closes DNS-rebind (attacker domain resolving to 127.0.0.1).
  const wantWrite = req.method !== 'GET' && req.method !== 'HEAD';
  const sfs = req.headers['sec-fetch-site'];
  const host = String(req.headers.host || '');
  const badHost = !/^127\.0\.0\.1(:\d+)?$/i.test(host) && !/^localhost(:\d+)?$/i.test(host);
  // non-browsers (curl/cli) omit sec-fetch-site entirely → allowed.
  // any browser send that isn't from this exact origin → 403.
  if (wantWrite && sfs && sfs !== 'same-origin') {
    return json(res, 403, { ok: false, error: 'cross-site request blocked' });
  }
  if (badHost) return json(res, 403, { ok: false, error: 'invalid host' });

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
      const name = `panel-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.txt`;
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
      const body = JSON.parse(await readBody(req) || 'null');
      if (!isObj(body)) return json(res, 400, { ok: false, error: 'json object required' });
      fs.writeFileSync(HUM_MEMORY, String(body.text || '').slice(0, 40000));
      return json(res, 200, { ok: true });
    }
    function redactProviders(prov) {
      // structural strip: api_key (and lookalikes) NEVER leave the server,
      // placeholder or raw — the UI only needs name/url/model routing info
      const SAFE = (o) => Array.isArray(o)
        ? o.map(SAFE)
        : (o && typeof o === 'object')
          ? Object.fromEntries(Object.entries(o)
              .filter(([k]) => !/key|secret|token|password/i.test(k))
              .map(([k, v]) => [k, SAFE(v)]))
          : o;
      return SAFE(prov);
    }

    /* --- bridge proxy (nonce handled server-side) --- */
    if (p === '/api/bridge/lifecycle' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = body.action === 'stop' ? bridgeStopProc() : bridgeStart();
      return json(res, 200, { ...r });
    }

    if (p === '/api/bridge/open' && req.method === 'GET') {
      await refreshBridge();
      return json(res, 200, { ok: !!bridgePort, url: `http://127.0.0.1:${bridgePort}/` });
    }
    if (p === '/api/whoami' && req.method === 'GET') {
      if (!whoamiCache && BOT_TOKEN) {
        await refreshBridge();
        if (bridgePort) {
          const nonce = await getBridgeNonce();
          const r = await bridgeRaw('GET', '/discord/users/@me', { 'x-client-nonce': nonce, 'x-bot-token': BOT_TOKEN });
          if (r.json && r.json.id) whoamiCache = { id: r.json.id, username: r.json.username, discriminator: r.json.discriminator, avatar: r.json.avatar };
        }
      }
      return json(res, 200, { ok: !!whoamiCache, token_present: !!BOT_TOKEN, user: whoamiCache });
    }
    if (p.startsWith('/api/bridge/')) {
      const sub = p.slice('/api/bridge'.length);
      if (!sub.startsWith('/')) return json(res, 400, { ok: false });
      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/')) {
        // file uploads: stream the raw multipart body through untouched
        await refreshBridge();
        if (!bridgePort) return json(res, 502, { ok: false, error: 'bridge offline' });
        const nonce = await getBridgeNonce();
        const chunks = [];
        let len = 0;
        for await (const c of req) { len += c.length; if (len > 25 * 1024 * 1024) return json(res, 413, { ok: false, error: 'too large' }); chunks.push(c); }
        const up = http.request({ host: '127.0.0.1', port: bridgePort, path: sub + url.search, method: req.method,
          headers: { 'content-type': ct, 'content-length': len, 'x-client-nonce': nonce, 'x-bot-token': BOT_TOKEN } }, pres => {
          if (res.headersSent) return pres.resume();
          res.writeHead(pres.statusCode, { 'content-type': pres.headers['content-type'] || 'application/json' });
          pres.on('error', () => res.destroy()); // upstream died mid-body: kill the socket, no throw
          pres.pipe(res);
        });
        up.on('error', e => { if (!res.headersSent) json(res, 502, { ok: false, error: e.message }); else res.destroy(); });
        up.end(Buffer.concat(chunks));
        return;
      }
      let bodyObj = null;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const raw = await readBody(req, 25 * 1024 * 1024);
        try { bodyObj = raw ? JSON.parse(raw) : null; } catch { bodyObj = null; }
        // gateway routes demanding the bot token in the JSON body: inject server-side
        if (bodyObj && typeof bodyObj === 'object' && !bodyObj.token &&
            (/^\/gateway\/[^/]+\/(connect|members\/[^/]+)$/.test(sub) || /^\/gateway\/backup\/channel\//.test(sub))) {
          bodyObj.token = BOT_TOKEN;
        }
        // scheduler send_message jobs carry payload.token — same treatment
        if (bodyObj && bodyObj.payload && typeof bodyObj.payload === 'object' && !bodyObj.payload.token && bodyObj.type === 'send_message') {
          bodyObj.payload = { ...bodyObj.payload, token: BOT_TOKEN };
        }
      }
      const r = await bridgeApi(req.method, sub + url.search, bodyObj);
      return json(res, r.status || 502, r.json || { ok: false, error: r.error || 'bridge unreachable', status: r.status });
    }

    if (p.startsWith('/api/backups/file/') && req.method === 'GET') {
      const name = decodeURIComponent(p.slice('/api/backups/file/'.length));
      if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) return json(res, 400, { ok: false, error: 'bad name' });
      const dirs = [
        path.join(BRIDGE_DIR, 'data/messages/backups'),
        path.join(HOME, 'projects/bot-mn-1-debug/data/messages/backups'),
        path.join(HOME, 'projects/bot-mn-1/data/messages/backups'),
      ];
      for (const d of dirs) {
        const f = path.join(d, name);
        if (fs.existsSync(f)) {
          res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename=\"${name}\"` });
          const rs = fs.createReadStream(f);
          rs.on('error', () => { try { res.end(); } catch {} }); // file vanished mid-download
          return rs.pipe(res);
        }
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }

    if (p === '/api/backups' && req.method === 'GET') {
      // list channel backups from both clones' data dirs (running process decides which fills)
      const dirs = [
        path.join(BRIDGE_DIR, 'data/messages/backups'),
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
    const msg = String(e.message || e);
    return json(res, msg === 'too large' ? 413 : 500, { ok: false, error: msg });
  }
});

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
startLogFollow();
server.listen(PORT, '127.0.0.1', () => console.log(`controlroom on http://127.0.0.1:${PORT}`));
