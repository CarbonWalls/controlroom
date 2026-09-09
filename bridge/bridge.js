// VERSION: 2025-09-07-HARDENED-v2
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const { spawn } = require('child_process');

let ffmpegPath;
if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
  ffmpegPath = process.env.FFMPEG_PATH;
} else {
  try {
    // npm@10+ resolves main via exports; fall back to the direct file when
    // an exports map hides it (breaks module resolution on some setups)
    ffmpegPath = require('ffmpeg-static');
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      const direct = path.join('node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      const abs = path.join(__dirname, direct);
      ffmpegPath = fs.existsSync(abs) ? abs : null;
    }
  } catch (e) { ffmpegPath = null; }
  // ffmpeg-static can export null (no prebuilt binary for this platform) without
  // throwing; older releases also return paths that no longer exist after reinstalls
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) ffmpegPath = 'ffmpeg';
}

let WebSocket;
try { WebSocket = require('ws'); } catch (e) { WebSocket = null; }

let davey;
try { davey = require('@snazzah/davey'); } catch (e) { 
  console.warn('[voice] @snazzah/davey not available, DAVE protocol disabled:', e.message);
  davey = null;
}

const PORT = parseInt(process.env.PORT, 10) || 8789;
const WWW = process.env.WWW_DIR || path.join(__dirname, 'www');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data', 'messages');
const VOICE_DIR = process.env.VOICE_DIR || path.join(__dirname, 'data', 'voice');
const LOCALES_DIR = process.env.LOCALES_DIR || path.join(WWW, 'locales');
const API = process.env.API_BASE || 'https://discord.com/api/v10';
const GATEWAY_URL = process.env.GATEWAY_URL || 'wss://gateway.discord.gg/?v=10&encoding=json';
const BRIDGE_VERSION = '2025-09-07-HARDENED-v2';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15) | (1 << 7);
const INTENT_GUILD_MEMBERS = 1 << 1; // privileged: needs SERVER MEMBERS INTENT in the dev portal
// bots that got 4014 (disallowed intents) reconnect without the members intent,
// degrading member data instead of losing the connection entirely
const reducedIntentsBots = new Set();
// in-flight reconnects per bot: gateway events (op 7/9, abnormal close) and a
// terminating heartbeat timer must never stack multiple connect loops
const reconnectingBots = new Set();
const reconnectAttempts = new Map();
const reconnectTimers = new Map(); // botId -> pending backoff timer
const intentionalClose = new Set();
const intentionalCloseTimers = new Map(); // botId -> forget timer
function intentsFor(botId) {
  return reducedIntentsBots.has(botId) ? INTENTS : (INTENTS | INTENT_GUILD_MEMBERS);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

[DATA_DIR, VOICE_DIR, LOCALES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ===== ogg/opus ===== */
function parseOggOpusPackets(oggBuffer) {
  const packets = [];
  let current = Buffer.alloc(0);
  let offset = 0;
  while (offset + 27 <= oggBuffer.length) {
    if (oggBuffer.toString('ascii', offset, offset + 4) !== 'OggS') break;
    const numSegments = oggBuffer.readUInt8(offset + 26);
    const tableStart = offset + 27;
    let pos = tableStart + numSegments;
    for (let i = 0; i < numSegments; i++) {
      const len = oggBuffer.readUInt8(tableStart + i);
      current = Buffer.concat([current, oggBuffer.slice(pos, pos + len)]);
      pos += len;
      if (len < 255) { packets.push(current); current = Buffer.alloc(0); }
    }
    offset = pos;
  }
  if (current.length) packets.push(current);
  let start = 0;
  if (packets.length && packets[0].length >= 8 && packets[0].slice(0, 8).toString('ascii') === 'OpusHead') start++;
  if (packets.length > start && packets[start].length >= 8 && packets[start].slice(0, 8).toString('ascii') === 'OpusTags') start++;
  return packets.slice(start);
}

function runFfmpeg(inputPath, channels) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let stderr = '';
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-map', '0:a:0',
      '-c:a', 'libopus',
      '-ar', '48000',
      '-ac', String(channels),
      '-b:a', '64k',
      '-frame_duration', '20',
      '-f', 'ogg',
      'pipe:1'
    ]);
    ff.stdout.on('data', (chunk) => chunks.push(chunk));
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', () => reject(new Error('ffmpeg binary not found')));
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg error: ' + (stderr || code)));
      try { resolve(Buffer.concat(chunks)); } catch (e) { reject(e); }
    });
  });
}

async function extractOpusPackets(inputPath) {
  const buf = await runFfmpeg(inputPath, 2);
  return parseOggOpusPackets(buf);
}

async function transcodeToOggBuffer(inputPath) {
  return runFfmpeg(inputPath, 1);
}

/* ===== http helpers ===== */
const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Bot-Token,X-Client-Nonce');
};
const send = (res, status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
const json = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));

// per-boot secret required by every /gateway/* and /discord/* call; injected
// into the served index.html so the page has it but workers/user scripts cannot
const SESSION_NONCE = crypto.randomBytes(16).toString('hex');

// request body cap: audio uploads are the only legitimate large payloads;
// anything past the limit is rejected before it can exhaust memory
const BODY_LIMIT = Math.max(1, parseInt(process.env.BODY_LIMIT_MB, 10) || 64) * 1024 * 1024;
function bodyLimitError() { const e = new Error('request body too large (limit ' + Math.round(BODY_LIMIT / 1024 / 1024) + ' MB)'); e.status = 413; return e; }
async function readBody(req) {
  const chunks = [];
  let size = 0;
  let overflow = null;
  for await (const ch of req) {
    size += ch.length;
    if (!overflow && size > BODY_LIMIT) {
      chunks.length = 0;
      overflow = bodyLimitError();
    }
    // keep draining to EOF instead of throwing mid-stream: an early throw
    // destroys the request stream and the socket is reset before the 413
    // response can be delivered (verified: 200MB upload -> client got no
    // response at all). draining discards chunks so memory stays bounded.
    if (overflow) continue;
    chunks.push(ch);
  }
  if (overflow) throw overflow;
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString()); } catch { return {}; }
}

async function proxyDiscord(req, res, target) {
  const token = req.headers['x-bot-token'];
  if (!token) return json(res, 400, { error: 'missing x-bot-token' });
  const headers = { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (local-manager, 1.0)' };
  const body = await readBody(req);
  const ct = req.headers['content-type'];
  if (body.length && ct) headers['Content-Type'] = ct;
  try {
    const up = await fetch(API + target, {
      method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    // track the discord rate limit bucket this request consumed
    const bucket = up.headers.get('x-ratelimit-bucket') || target.split('?')[0];
    updateRateLimit(bucket, up.headers);
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, {
      'Content-Type': up.headers.get('content-type') || (buf.length ? 'application/octet-stream' : 'text/plain'),
      'X-RateLimit-Remaining': up.headers.get('x-ratelimit-remaining') ?? '',
      'X-RateLimit-Reset': up.headers.get('x-ratelimit-reset') ?? '',
      'X-RateLimit-Bucket': bucket,
    });
    res.end(buf);
  } catch (e) { json(res, 502, { error: 'upstream: ' + e.message }); }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(WWW, rel));
  if (!file.startsWith(WWW + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'text/plain', '404');
  }
  // the script-sandbox worker must have zero network reach from inside:
  // connect-src 'none' blocks fetch/xhr/ws/eventsource/cache.add at the
  // browser level, which user code cannot bypass even by restoring shims
  if (rel === 'runtime-worker.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; worker-src 'none'"
    });
    return res.end(fs.readFileSync(file));
  }
  if (rel === 'index.html') {
    const html = fs.readFileSync(file, 'utf8').replace(
      '<head>',
      `<head>\n  <meta name="x-bridge-nonce" content="${SESSION_NONCE}">`
    );
    return send(res, 200, 'text/html', html);
  }
  send(res, 200, MIME[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
}

/* ===== archive ===== */
const sessions = new Map();

/* ===== rate limit tracking ===== */
const rateLimits = new Map(); // bucket -> { remaining, reset, limit, updatedAt }
const RATE_LIMIT_TTL = 10 * 60 * 1000;

function updateRateLimit(bucket, headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const limit = headers.get('x-ratelimit-limit');
  if (remaining === null || reset === null) return;
  rateLimits.set(bucket, {
    remaining: parseInt(remaining, 10),
    reset: parseFloat(reset),
    limit: limit !== null ? parseInt(limit, 10) : null,
    updatedAt: Date.now()
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [bucket, data] of rateLimits) {
    if (now - data.updatedAt > RATE_LIMIT_TTL) rateLimits.delete(bucket);
  }
}, 60000).unref();

/* ===== scheduler ===== */
const JOBS_FILE = path.join(DATA_DIR, 'scheduled-jobs.json');
const MIN_INTERVAL_MS = 10000;
const scheduledJobs = new Map(); // id -> job
const jobTimers = new Map(); // id -> timer

function loadJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
      if (Array.isArray(data)) data.forEach(j => scheduledJobs.set(j.id, j));
    }
  } catch (e) {
    console.error('[scheduler] load error:', e.message);
  }
}

function saveJobs() {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify([...scheduledJobs.values()], null, 2));
  } catch (e) {
    console.error('[scheduler] save error:', e.message);
  }
}

async function runJob(job) {
  job.lastRun = Date.now();
  job.runCount = (job.runCount || 0) + 1;
  try {
    if (job.type === 'send_message') {
      const headers = {
        Authorization: `Bot ${job.payload.token}`,
        'User-Agent': 'DiscordBot (local-manager, 1.0)',
        'Content-Type': 'application/json'
      };
      const r = await fetch(`${API}/channels/${job.payload.channelId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: job.payload.content })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } else if (job.type === 'change_presence') {
      const s = sessions.get(job.payload.botId);
      if (!s || s.ws.readyState !== WebSocket.OPEN) throw new Error('bot not connected');
      s.ws.send(JSON.stringify({
        op: 3,
        d: { status: job.payload.status, afk: false, since: null, activities: [] }
      }));
    } else {
      throw new Error('unknown job type: ' + job.type);
    }
    job.lastStatus = 'success';
  } catch (e) {
    job.lastStatus = 'error: ' + e.message;
  }
  saveJobs();
}

function scheduleJob(job) {
  if (jobTimers.has(job.id)) {
    clearInterval(jobTimers.get(job.id));
    jobTimers.delete(job.id);
  }
  if (!job.active) return;
  const timer = setInterval(() => runJob(job), Math.max(job.intervalMs, MIN_INTERVAL_MS));
  jobTimers.set(job.id, timer);
}

function unscheduleJob(id) {
  if (jobTimers.has(id)) {
    clearInterval(jobTimers.get(id));
    jobTimers.delete(id);
  }
}

loadJobs();
for (const job of scheduledJobs.values()) {
  if (job.active) scheduleJob(job);
}


function archivePath(channelId) { return path.join(DATA_DIR, `${channelId}.json`); }
function loadArchive(channelId) {
  const p = archivePath(channelId);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}
function saveMessage(msg) {
  if (!msg || !msg.channel_id) return;
  const arr = loadArchive(msg.channel_id);
  const idx = arr.findIndex(m => m.id === msg.id);
  if (idx >= 0) arr[idx] = { ...msg, _deleted: false, _editedAt: Date.now() };
  else arr.push({ ...msg, _deleted: false });
  while (arr.length > 500) arr.shift();
  fs.writeFileSync(archivePath(msg.channel_id), JSON.stringify(arr));
}
function markDeleted(channelId, msgId) {
  const arr = loadArchive(channelId);
  const m = arr.find(x => x.id === msgId);
  if (m) {
    m._deleted = true; m._deletedAt = Date.now();
  } else {
    arr.push({ id: msgId, channel_id: channelId, _deleted: true, _deletedAt: Date.now(), content: '[deleted before capture]' });
  }
  fs.writeFileSync(archivePath(channelId), JSON.stringify(arr));
}

/* ===== i18n ===== */
function readJsonFile(file) {
  let txt = fs.readFileSync(file, 'utf8');
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  return JSON.parse(txt);
}
function listLocales() {
  if (!fs.existsSync(LOCALES_DIR)) return [];
  return fs.readdirSync(LOCALES_DIR)
    .filter(f => /^([a-zA-Z0-9_-]{2,35})\.json$/.test(f))
    .map(f => {
      const code = f.replace(/\.json$/i, '');
      let meta = {};
      try {
        const parsed = readJsonFile(path.join(LOCALES_DIR, f));
        if (parsed && typeof parsed === 'object') meta = parsed.meta || parsed._meta || {};
      } catch {}
      return { code, name: meta.name || code, native: meta.native || meta.name || code, flag: meta.flag || '' };
    })
    .sort((a, b) => a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.code.localeCompare(b.code));
}
function readLocale(code) {
  if (!/^[a-zA-Z0-9_-]{2,35}$/.test(code)) return null;
  const file = path.normalize(path.join(LOCALES_DIR, code + '.json'));
  if (!file.startsWith(LOCALES_DIR + path.sep) || !fs.existsSync(file)) return null;
  return readJsonFile(file);
}

/* ===== voice ===== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Standard Opus silence/DTX frame (as used by @discordjs/voice) sent while idle to keep the
// voice session alive — Discord closes the connection (~10s) if no RTP arrives.
const SILENCE_FRAME = Buffer.from([0xF8, 0xFF, 0xFE]);

function maybeResolveVoiceJoin(session, guildId, channelId) {
  const state = session.voice?.state;
  const server = session.voice?.server;

  if (
    state?.guild_id === guildId &&
    state?.channel_id === channelId &&
    state?.session_id &&
    server?.guild_id === guildId &&
    server?.endpoint &&
    server?.token
  ) {
    resolveVoiceWaiters(session, {
      guild_id: guildId,
      channel_id: channelId,
      session_id: state.session_id,
      voiceReady: true
    });
  }
}

function resolveVoiceWaiters(session, d) {
  if (!session.voiceWaiters || !session.voiceWaiters.length) return;
  session.voiceWaiters = session.voiceWaiters.filter(w => {
    let ok = false;
    try { ok = w.predicate(d); } catch { ok = false; }
    if (ok) { try { w.resolve(d); } catch {} return false; }
    return true;
  });
}

function waitForVoiceCredentials(session, guildId, channelId, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.voiceWaiters = (session.voiceWaiters || []).filter(w => w !== entry);
      reject(new Error('voice credentials timeout'));
    }, timeoutMs);

    const entry = {
      predicate: () => {
        const state = session.voice?.state;
        const server = session.voice?.server;

        return (
          state?.guild_id === guildId &&
          state?.channel_id === channelId &&
          state?.session_id &&
          server?.guild_id === guildId &&
          server?.endpoint &&
          server?.token
        );
      },
      resolve: () => {
        clearTimeout(timer);
        resolve({
          state: session.voice.state,
          server: session.voice.server
        });
      }
    };

    session.voiceWaiters = session.voiceWaiters || [];
    session.voiceWaiters.push(entry);

    // Check current state in case both events already arrived
    if (entry.predicate()) {
      clearTimeout(timer);
      session.voiceWaiters = session.voiceWaiters.filter(w => w !== entry);
      resolve({
        state: session.voice.state,
        server: session.voice.server
      });
    }
  });
}

function clearVoiceAutoLeave(session) {
  if (session?.voice?.autoLeaveTimer) { clearTimeout(session.voice.autoLeaveTimer); session.voice.autoLeaveTimer = null; }
}
function scheduleVoiceAutoLeave(session, seconds) {
  clearVoiceAutoLeave(session);
  const secs = parseInt(seconds, 10);
  if (!secs || secs <= 0) return;
  if (!session?.voice?.state?.guild_id) return;
  session.voice.autoLeaveTimer = setTimeout(() => { leaveVoice(session.botId).catch(() => {}); }, secs * 1000);
}
function stopPlayback(session, silent = false) {
  const vc = session?.voiceConnection;
  if (!vc) return;
  if (vc.playTimer) clearInterval(vc.playTimer);
  vc.playTimer = null;
  vc.playing = false;
  setSpeaking(session, false);
  if (!silent) console.log(`[voice] playback stopped bot ${session.botId}`);
}
function cleanupVoice(session) {
  stopPlayback(session, true);
  const vc = session?.voiceConnection;
  if (!vc) return;
  if (vc.heartbeatTimer) clearInterval(vc.heartbeatTimer);
  if (vc.keepAliveTimer) { clearInterval(vc.keepAliveTimer); vc.keepAliveTimer = null; }
  if (vc.daveSession) {
    try { vc.daveSession.reset(); } catch {}
    vc.daveSession = null;
  }
  if (vc.ws) { try { vc.ws.close(); } catch {} }
  if (vc.udp) { try { vc.udp.close(); } catch {} }
  session.voiceConnection = null;
  if (session.voice) session.voice.server = null;
}

function udpDiscovery(ip, port, ssrc) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const req = Buffer.alloc(74);
    req.writeUInt16BE(0x1, 0);
    req.writeUInt16BE(70, 2);
    req.writeUInt32BE(ssrc, 4);
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(new Error('udp discovery timeout')); }, 8000);
    socket.once('message', (msg) => {
      clearTimeout(timer);
      try {
        const ipStr = msg.slice(8, msg.length - 2).toString('utf8').replace(/\0/g, '');
        const discoveredPort = msg.readUInt16BE(msg.length - 2);
        try { socket.close(); } catch {}
        resolve({ ip: ipStr, port: discoveredPort });
      } catch (e) { try { socket.close(); } catch {} reject(e); }
    });
    socket.on('error', (err) => { clearTimeout(timer); try { socket.close(); } catch {} reject(err); });
    socket.send(req, port, ip);
  });
}

// UDP discovery performed on a PROVIDED socket (the same one used for RTP),
// so the declared source port in Select Protocol matches where RTP actually comes from.
function udpDiscoverOn(socket, ip, port, ssrc) {
  return new Promise((resolve, reject) => {
    const req = Buffer.alloc(74);
    req.writeUInt16BE(0x1, 0);
    req.writeUInt16BE(70, 2);
    req.writeUInt32BE(ssrc, 4);
    const timer = setTimeout(() => { cleanup(); reject(new Error('udp discovery timeout')); }, 8000);
    const onMsg = (msg) => {
      cleanup();
      try {
        const ipStr = msg.slice(8, msg.length - 2).toString('utf8').replace(/\0/g, '');
        const discoveredPort = msg.readUInt16BE(msg.length - 2);
        resolve({ ip: ipStr, port: discoveredPort });
      } catch (e) { reject(e); }
    };
    const onErr = (err) => { cleanup(); reject(err); };
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('message', onMsg);
      socket.removeListener('error', onErr);
    }
    socket.once('message', onMsg);
    socket.once('error', onErr);
    socket.send(req, port, ip);
  });
}

function connectVoiceTransport(session) {
  return new Promise((resolve, reject) => {
    if (!WebSocket) return reject(new Error('ws module not installed (npm i ws)'));
    if (!session?.voice?.server?.endpoint) return reject(new Error('voice server missing'));
    if (!davey) return reject(new Error('@snazzah/davey not installed - DAVE protocol required'));

    let settled = false;
    let heartbeatTimer = null;
    let udp = null;
    let ready = null;
    let daveSession = null;
    let daveReady = false;
    let secretKey = null;
    let encryptionMode = 'dave'; // track selected encryption mode
    let daveProtocolVersion = 0; // negotiated DAVE protocol version (0 = transport-only)
    const recognizedUserIds = new Set(); // user IDs seen via CLIENTS_CONNECT (op 11)
    const davePendingTransitions = new Map(); // transition_id -> protocol_version
    let lastSequence = -1; // last seq seen (binary or JSON) — sent as seq_ack in v8 heartbeat

    const endpoint = session.voice.server.endpoint.replace(/:(80|443)$/, '');
    const url = `wss://${endpoint}/?v=8&encoding=json`;
    console.log(`[voice] connecting to voice ws: ${url}`);
    console.log(`[voice] voice state: guild=${session.voice.state.guild_id} channel=${session.voice.state.channel_id} session_id=${session.voice.state.session_id}`);
    console.log(`[voice] voice server: endpoint=${session.voice.server.endpoint} token_len=${session.voice.server.token?.length}`);
    
    const vws = new WebSocket(url);
    const timeout = setTimeout(() => done(new Error('voice connect timeout (20s)')), 20000);

    function done(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) {
        // Failure path: tear down everything we started.
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (udp) { try { udp.close(); } catch {} }
        console.error(`[voice] connect failed: ${err.message}`);
        try { vws.close(); } catch {}
        reject(err);
      } else {
        // Success path: heartbeat + udp are handed off to session.voiceConnection.
        resolve(value);
      }
    }

    vws.on('open', () => {
      console.log('[voice] voice ws opened');
    });

    vws.on('error', (err) => done(new Error('voice ws error: ' + err.message)));
    vws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : 'no reason';
      console.log(`[voice] voice ws closed: code=${code} reason=${reasonStr}`);
      if (session.voiceConnection?.ws === vws) cleanupVoice(session);
      if (!settled) done(new Error(`voice ws closed: code=${code} reason=${reasonStr}`));
    });

    // Client→server DAVE binary frame: [uint8 opcode][payload]  (NO sequence!)
    function sendDaveBinary(opcode, payload) {
      const frame = Buffer.alloc(1 + payload.length);
      frame[0] = opcode;
      payload.copy(frame, 1);
      vws.send(frame);
      return frame;
    }

    // Create/reinit the DAVE session and send a fresh key package (op 26).
    function reinitDaveSession() {
      if (!davey) return;
      // NOTE: DAVESession's 3rd arg is the CHANNEL id (MLS group id), NOT the guild id.
      const channelId = session.voice.state.channel_id;
      if (daveSession) {
        daveSession.reinit(daveProtocolVersion, session.user.id, channelId, session.voice.daveKeyPair);
      } else {
        daveSession = new davey.DAVESession(daveProtocolVersion, session.user.id, channelId, session.voice.daveKeyPair);
      }
      const keyPackage = daveSession.getSerializedKeyPackage();
      const frame = sendDaveBinary(26, keyPackage);
      console.log('[voice] Sent key package (op 26), bytes:', frame.length);
    }

    function handleDaveBinary(buf) {
      if (!daveSession) return;
      // Server→client binary: [sequence: uint16BE][opcode: uint8][payload]
      if (buf.length < 3) return;
      const sequence = buf.readUInt16BE(0);
      const op = buf[2];
      const payload = buf.subarray(3);
      lastSequence = sequence;
      console.log(`[voice] dave binary recv op=${op} seq=${sequence} (${payload.length}b)`);

      try {
        if (op === 25) {
          // MLS_EXTERNAL_SENDER: install the external sender ONLY.
          // Do NOT send another key package here (that is done once after op=4).
          daveSession.setExternalSender(payload);
          console.log('[voice] Set external sender (op 25)');
        }
        else if (op === 27) {
          // MLS_PROPOSALS: [optype:uint8][proposals...]
          const operationType = payload.readUInt8(0);
          const proposals = payload.subarray(1);
          const result = daveSession.processProposals(operationType, proposals, [...recognizedUserIds]);
          console.log('[voice] Processed proposals (op 27)', { operationType, hasCommit: !!result.commit, hasWelcome: !!result.welcome });
          if (result.commit) {
            const payload28 = result.welcome ? Buffer.concat([result.commit, result.welcome]) : result.commit;
            const frame = sendDaveBinary(28, payload28);
            console.log('[voice] Sent commit/welcome (op 28), bytes:', frame.length);
          }
        }
        else if (op === 29) {
          // MLS_ANNOUNCE_COMMIT_TRANSITION: [transition_id:uint16BE][commit...]
          const transitionId = payload.readUInt16BE(0);
          const commit = payload.subarray(2);
          try {
            daveSession.processCommit(commit);
            if (transitionId !== 0) {
              davePendingTransitions.set(transitionId, daveProtocolVersion);
              vws.send(JSON.stringify({ op: 23, d: { transition_id: transitionId } }));
            }
            console.log('[voice] Processed commit (op 29), transition:', transitionId, 'ready:', daveSession.ready);
          } catch (e) {
            console.warn('[voice] MLS commit errored:', e.message);
            vws.send(JSON.stringify({ op: 31, d: { transition_id: transitionId } }));
            reinitDaveSession();
          }
        }
        else if (op === 30) {
          // MLS_WELCOME: [transition_id:uint16BE][welcome...]
          const transitionId = payload.readUInt16BE(0);
          const welcome = payload.subarray(2);
          try {
            daveSession.processWelcome(welcome);
            if (transitionId !== 0) {
              davePendingTransitions.set(transitionId, daveProtocolVersion);
              vws.send(JSON.stringify({ op: 23, d: { transition_id: transitionId } }));
            }
            console.log('[voice] Processed welcome (op 30), transition:', transitionId, 'ready:', daveSession.ready);
          } catch (e) {
            console.warn('[voice] MLS welcome errored:', e.message);
            vws.send(JSON.stringify({ op: 31, d: { transition_id: transitionId } }));
            reinitDaveSession();
          }
        }
        else {
          console.warn('[voice] Unexpected DAVE binary op:', op);
        }
      } catch (e) {
        console.error('[voice] Binary DAVE error:', e.message);
      }
    }

    vws.on('message', async (raw) => {
      let buf = raw instanceof Buffer ? raw : (raw instanceof Uint8Array ? Buffer.from(raw) : null);
      
      if (buf) {
        const str = buf.toString('utf8');
        if (str.startsWith('{')) {
          let data;
          try { data = JSON.parse(str); } catch { }
          if (data && typeof data.op === 'number') {
            if (typeof data.seq === 'number') lastSequence = data.seq;
            if (data.op !== 6) console.log(`[voice] ws recv op=${data.op}`);
            
            if (data.op === 8) {
              heartbeatTimer = setInterval(() => {
                try { if (vws.readyState === WebSocket.OPEN) vws.send(JSON.stringify({ op: 3, d: { t: Date.now(), seq_ack: lastSequence } })); } catch {}
              }, Math.max(5000, Math.floor((data.d?.heartbeat_interval || 13750) * 0.75)));

              if (!session.voice.daveKeyPair) {
                session.voice.daveKeyPair = davey.generateP256Keypair();
                console.log('[voice] Generated new DAVE key pair');
              }

              // Send identify (op 0) with DAVE mode and max_dave_protocol_version ONLY (no key_package)
              const protocolVersion = davey.DAVE_PROTOCOL_VERSION || 1;
              const identifyPayload = {
                op: 0,
                d: {
                  server_id: session.voice.state.guild_id,
                  user_id: session.user.id,
                  session_id: session.voice.state.session_id,
                  token: session.voice.server.token,
                  max_dave_protocol_version: protocolVersion
                }
              };
              console.log(`[voice] identify (op 0) guild=${session.voice.state.guild_id} session=${session.voice.state.session_id?.slice(0,8)}… dave=${protocolVersion}`);
              vws.send(JSON.stringify(identifyPayload));
            }
            else if (data.op === 2) {
              ready = data.d;
              console.log('[voice] ready received', { ip: ready.ip, port: ready.port, ssrc: ready.ssrc, modes: ready.modes });
              
              // Prefer AES-256-GCM (Node-native) over XChaCha20 (needs HChaCha20 impl)
              const supportedModes = ready.modes || [];
              if (supportedModes.includes('aead_aes256_gcm_rtpsize')) {
                encryptionMode = 'aead_aes256_gcm_rtpsize';
              } else if (supportedModes.includes('aead_xchacha20_poly1305_rtpsize')) {
                encryptionMode = 'aead_xchacha20_poly1305_rtpsize';
              } else if (!supportedModes.includes('dave')) {
                return done(new Error('DAVE mode not supported by server. available: ' + supportedModes.join(',')));
              }
              console.log('[voice] selected encryption mode:', encryptionMode);
              
              if (encryptionMode !== 'dave') {
                // For transport encryption modes, we still use DAVE for E2EE
                // but the transport layer uses the selected mode
              }
              
              // Create the RTP socket, run UDP discovery ON IT, then declare the
              // discovered (our public) ip/port in Select Protocol. The source port
              // must match where RTP will actually be sent from.
              udp = dgram.createSocket('udp4');
              udp.on('error', (err) => console.error('[voice] udp error:', err.message));
              try {
                const disc = await udpDiscoverOn(udp, ready.ip, ready.port, ready.ssrc);
                console.log('[voice] udp discovery:', disc);
                vws.send(JSON.stringify({
                  op: 1,
                  d: { protocol: 'udp', data: { address: disc.ip, port: disc.port, mode: encryptionMode } }
                }));
                console.log('[voice] sent protocol select (op 1) with discovered address', disc, 'mode:', encryptionMode);
              } catch (e) {
                console.warn('[voice] udp discovery failed, falling back to ready address:', e.message);
                vws.send(JSON.stringify({
                  op: 1,
                  d: { protocol: 'udp', data: { address: ready.ip, port: ready.port, mode: encryptionMode } }
                }));
              }
            }
            else if (data.op === 4) {
              if (!ready || !udp) return;
              secretKey = Buffer.from(data.d.secret_key);
              console.log('[voice] session description (op 4) received, mode:', data.d.mode, 'secret_key length:', secretKey.length);

              // Initialize DAVE session with protocol version from server
              daveProtocolVersion = data.d.dave_protocol_version || 1;
              console.log('[voice] DAVE protocol version from server:', daveProtocolVersion);

              // Create the DAVE session and send ONE key package (op 26) now.
              reinitDaveSession();
              console.log('[voice] DAVE session ready to init', { protocolVersion: daveProtocolVersion, userId: session.user.id, channelId: session.voice.state.channel_id });

              // Transport is up after op=4 + Select Protocol: mark the connection ready now.
              // DAVE E2EE readiness (daveSession.ready) is tracked separately and only gates
              // whether media is additionally E2EE-encrypted. This lets a lone bot play too.
              session.voiceConnection = {
                guildId: session.voice.state.guild_id,
                ws: vws, udp,
                ip: ready.ip, port: ready.port, ssrc: ready.ssrc,
                mode: encryptionMode,
                sequence: Math.floor(Math.random() * 0xffff),
                timestamp: Math.floor(Math.random() * 0xffffffff),
                nonceCounter: Math.floor(Math.random() * 0xffffffff),
                heartbeatTimer,
                daveSession,
                secretKey,
                ready: true, playing: false, playTimer: null
              };
              // Keep daveReady updated in the background for media encryption decisions.
              const watchDaveReady = () => {
                if (settled) return;
                if (daveSession && daveSession.ready) {
                  daveReady = true;
                  console.log('[voice] DAVE session became ready (E2EE active)');
                } else {
                  setTimeout(watchDaveReady, 200);
                }
              };
              watchDaveReady();
              done(null, session.voiceConnection);

              // RTP keepalive: send silence when idle so Discord doesn't drop the session.
              if (!process.env.VOICE_NO_KEEPALIVE) {
                session.voiceConnection.keepAliveTimer = setInterval(() => {
                  const c = session.voiceConnection;
                  if (!c || c !== session.voiceConnection) return;
                  if (!c.playing) {
                    try { sendOpusPacket(session, SILENCE_FRAME); } catch {}
                  }
                }, 20);
              }
            }
            else if (data.op === 11) {
              // CLIENTS_CONNECT (JSON): track recognized user IDs for processProposals
              const ids = Array.isArray(data.d?.user_ids) ? data.d.user_ids
                       : (Array.isArray(data.d) ? data.d : []);
              ids.forEach(id => recognizedUserIds.add(String(id)));
              console.log('[voice] clients connect (op 11):', { ids, recognized: [...recognizedUserIds] });
            }
            else if (data.op === 13) {
              // CLIENT_DISCONNECT (JSON)
              const uid = data.d?.user_id;
              if (uid) recognizedUserIds.delete(String(uid));
              console.log('[voice] client disconnect (op 13):', uid);
            }
            else if (data.op === 21) {
              // DAVE_PREPARE_TRANSITION (JSON)
              const transitionId = data.d.transition_id;
              const version = data.d.protocol_version;
              console.log('[voice] DAVE prepare transition', { transitionId, version });
              davePendingTransitions.set(transitionId, version);
              if (transitionId === 0) {
                // (re)initialization transition: execute immediately
                daveProtocolVersion = version;
                if (version === 0) { daveSession?.reset(); daveSession?.setPassthroughMode(true, 10); }
              } else {
                if (version === 0) daveSession?.setPassthroughMode(true, 120);
                vws.send(JSON.stringify({ op: 23, d: { transition_id: transitionId } }));
              }
            }
            else if (data.op === 22) {
              // DAVE_EXECUTE_TRANSITION (JSON)
              const transitionId = data.d.transition_id;
              console.log('[voice] DAVE execute transition', { transitionId });
              if (davePendingTransitions.has(transitionId)) {
                daveProtocolVersion = davePendingTransitions.get(transitionId);
                davePendingTransitions.delete(transitionId);
                if (daveProtocolVersion === 0) {
                  daveSession?.reset();
                  daveSession?.setPassthroughMode(true, 10);
                }
              }
            }
            else if (data.op === 24) {
              // DAVE_PREPARE_EPOCH (JSON): only epoch===1 needs a fresh group + key package
              console.log('[voice] DAVE prepare epoch', data.d);
              if (data.d.epoch === 1) {
                daveProtocolVersion = data.d.protocol_version || daveProtocolVersion;
                reinitDaveSession();
              }
            }
            else if (data.op === 7) { done(new Error('voice reconnect not implemented')); }
            else if (data.op === 5) { console.warn('[voice] received op 5 (resume?)', data.d); }
            else if (data.op === 15) {
              // CLIENT_DISCONNECT or keepalive
              console.log('[voice] received op 15 (client disconnect/keepalive):', data.d);
            }
            else if (data.op === 31) {
              console.error('[voice] DAVE invalid commit/welcome (op 31):', data.d);
            }
            return;
          }
        }
      }
      
      if (buf) {
        return handleDaveBinary(buf);
      }
    });
  });
}

async function ensureVoiceUdp(session) {
  if (!session?.voice?.state?.guild_id || !session?.voice?.state?.channel_id) throw new Error('bot not in voice channel');
  
  // If we already have a valid connection for this guild, reuse it
  const existing = session.voiceConnection;
  if (existing && existing.ready && existing.guildId === session.voice.state.guild_id) return existing;
  
  // Connection should have been established in joinVoice
  throw new Error('voice transport not connected - call joinVoice first');
}

function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
// HChaCha20: derive a 32-byte subkey from key + 16-byte input (needed for XChaCha20).
function hchacha20(key, in16) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = in16.readUInt32LE(i * 4);
  const qr = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = rotl32(s[d], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = rotl32(s[b], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = rotl32(s[d], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = rotl32(s[b], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(s[i], i * 4);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(s[12 + i], (i + 8) * 4);
  return out;
}
// XChaCha20-Poly1305 AEAD using Node's chacha20-poly1305 (16-byte IV) on top of HChaCha20.
function xchacha20poly1305Encrypt(key, nonce24, plaintext, aad) {
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const iv = Buffer.alloc(16); // [4-byte LE block counter=0][12-byte nonce = 0x00000000 || nonce24[16:24]]
  nonce24.copy(iv, 8, 16, 24);
  const cipher = crypto.createCipheriv('chacha20-poly1305', subkey, iv);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function sendOpusPacket(session, opusPacket) {
  const vc = session.voiceConnection;
  if (!vc || !vc.ready || !vc.udp) return;

  vc.sequence = (vc.sequence + 1) & 0xffff;
  vc.timestamp = (vc.timestamp + 960) >>> 0;
  vc.nonceCounter = (vc.nonceCounter + 1) >>> 0;

  let payload = opusPacket;

  // Step 1: DAVE E2EE encryption (if available). Silence/keepalive frames are NOT
  // DAVE-encrypted (matches @discordjs/voice): they must stay transport-only.
  const isSilence = payload.length === SILENCE_FRAME.length && payload.equals(SILENCE_FRAME);
  if (vc.daveSession && vc.daveSession.ready && !isSilence) {
    try {
      payload = vc.daveSession.encryptOpus(payload);
    } catch (e) {
      console.error('[voice] DAVE encrypt error:', e.message);
      return;
    }
  } else if (vc.mode === 'dave' && !isSilence) {
    console.warn('[voice] DAVE session not ready, skipping packet');
    return;
  }

  // Step 2: Transport encryption + RTP header (matches @discordjs/voice)
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 0x78; // RTP_OPUS_PAYLOAD_TYPE
  header.writeUInt16BE(vc.sequence, 2);
  header.writeUInt32BE(vc.timestamp, 4);
  header.writeUInt32BE(vc.ssrc, 8);

  let packet;
  if (vc.mode === 'aead_aes256_gcm_rtpsize') {
    // 12-byte nonce = [4-byte counter (BE)][8 zero bytes]; the 4-byte counter is appended as padding
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(vc.nonceCounter, 0);
    const cipher = crypto.createCipheriv('aes-256-gcm', vc.secretKey.subarray(0, 32), nonce);
    cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
    packet = Buffer.concat([header, encrypted, nonce.subarray(0, 4)]);
  } else if (vc.mode === 'aead_xchacha20_poly1305_rtpsize') {
    // 24-byte nonce = [4-byte counter (BE)][20 zero bytes]; the 4-byte counter is appended as padding
    const nonce = Buffer.alloc(24);
    nonce.writeUInt32BE(vc.nonceCounter, 0);
    const encrypted = xchacha20poly1305Encrypt(vc.secretKey.subarray(0, 32), nonce, payload, header);
    packet = Buffer.concat([header, encrypted, nonce.subarray(0, 4)]);
  } else if (vc.mode === 'dave') {
    // Pure DAVE mode without transport encryption (fallback)
    packet = Buffer.concat([header, payload]);
  } else {
    throw new Error('unsupported encryption mode: ' + vc.mode);
  }
  vc.udp.send(packet, vc.port, vc.ip);
}

// Send a Speaking update (op 5). Discord maps SSRC -> userId from this, which the receiver
// needs to pick the right DAVE key; without it, our audio is silently dropped by listeners.
function setSpeaking(session, speaking) {
  const vc = session.voiceConnection;
  if (!vc || !vc.ws || vc.ws.readyState !== WebSocket.OPEN) return;
  if (vc.speaking === speaking) return;
  vc.speaking = speaking;
  try {
    vc.ws.send(JSON.stringify({ op: 5, d: { speaking: speaking ? 1 : 0, delay: 0, ssrc: vc.ssrc } }));
    console.log(`[voice] setSpeaking(${speaking}) ssrc=${vc.ssrc}`);
  } catch {}
}

function startOpusPlayback(session, packets) {
  const vc = session.voiceConnection;
  if (!vc) return;
  stopPlayback(session, true);
  vc.playing = true;
  setSpeaking(session, true);
  let i = 0;
  console.log(`[voice] starting playback bot ${session.botId}: ${packets.length} packets`);
  vc.playTimer = setInterval(() => {
    if (!session.voiceConnection || session.voiceConnection !== vc) { stopPlayback(session, true); return; }
    if (i >= packets.length) { stopPlayback(session); return; }
    try { sendOpusPacket(session, packets[i]); i++; }
    catch (e) { console.error('[voice] packet send error:', e.message); stopPlayback(session); }
  }, 20);
}

async function joinVoice(botId, opts = {}) {
  const s = sessions.get(botId);
  if (!s || s.ws.readyState !== WebSocket.OPEN) throw new Error('gateway not connected');
  const guild_id = String(opts.guild_id || '');
  const channel_id = String(opts.channel_id || '');
  if (!guild_id || !channel_id) throw new Error('guild_id and channel_id required');
  const self_mute = !!opts.self_mute;
  const self_deaf = !!opts.self_deaf;

  clearVoiceAutoLeave(s);
  const current = s.voice?.state;
  if (current && current.guild_id === guild_id && current.channel_id === channel_id) {
    s.ws.send(JSON.stringify({ op: 4, d: { guild_id, channel_id, self_mute, self_deaf } }));
    scheduleVoiceAutoLeave(s, opts.auto_leave_seconds);
    // Ensure voice server is available for existing connection
    let waited = 0;
    while (!s.voice?.server?.endpoint && waited < 5000) { await sleep(100); waited += 100; }
    return current;
  }
  // New channel: clear stale voice server info so we wait for fresh VOICE_SERVER_UPDATE
  if (s.voice) {
    s.voice.server = null;
    s.voice.pendingServer = null;
  }

  console.log(`[voice] joinVoice: guild=${guild_id} channel=${channel_id} mute=${self_mute} deaf=${self_deaf}`);
  s.ws.send(JSON.stringify({ op: 4, d: { guild_id, channel_id, self_mute, self_deaf } }));

  const timeoutMs = Math.max(3000, parseInt(opts.timeout_ms || 12000, 10));
  const { state, server } = await waitForVoiceCredentials(s, guild_id, channel_id, timeoutMs);

  console.log('[voice] both voice packets received, connecting transport immediately', {
    session_id: state.session_id,
    endpoint: server.endpoint,
    token_len: server.token?.length
  });

  await connectVoiceTransport(s);
  console.log('[voice] joinVoice: voice transport connected successfully');

  scheduleVoiceAutoLeave(s, opts.auto_leave_seconds);
  return state;
}

async function leaveVoice(botId, timeoutMs = 10000) {
  const s = sessions.get(botId);
  if (!s || s.ws.readyState !== WebSocket.OPEN) throw new Error('gateway not connected');
  clearVoiceAutoLeave(s);
  const guild_id = s.voice?.state?.guild_id;
  if (!guild_id || !s.voice?.state?.channel_id) return null;

  const waiter = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.voiceWaiters = (s.voiceWaiters || []).filter(w => w !== entry);
      reject(new Error('voice leave timeout'));
    }, timeoutMs);
    const entry = {
      predicate: (d) => d.guild_id === guild_id && d.channel_id === null,
      resolve: (d) => { clearTimeout(timer); resolve(d); }
    };
    s.voiceWaiters = s.voiceWaiters || [];
    s.voiceWaiters.push(entry);
  });

  console.log(`[voice] leaveVoice: guild=${guild_id}`);
  s.ws.send(JSON.stringify({ op: 4, d: { guild_id, channel_id: null, self_mute: false, self_deaf: false } }));
  if (s.voice) s.voice.server = null;
  return waiter;
}

// decoded audio cap: voice clips are a few MB at most; a 25 MB ceiling stops
// base64 uploads from ballooning into disk + ffmpeg transcode work
const AUDIO_LIMIT = 25 * 1024 * 1024;

function decodeAudioB64(b64) {
  let s = String(b64 || '');
  if (s.includes(',')) s = s.split(',').pop();
  const buf = Buffer.from(s, 'base64');
  if (!buf.length) { const e = new Error('empty audio'); e.status = 400; throw e; }
  if (buf.length > AUDIO_LIMIT) {
    const e = new Error('audio too large (limit 25 MB decoded)');
    e.status = 413;
    throw e;
  }
  return buf;
}

async function playVoice(botId, opts = {}) {
  const s = sessions.get(botId);
  if (!s || s.ws.readyState !== WebSocket.OPEN) throw new Error('gateway not connected');

  if (opts.guild_id && opts.channel_id) {
    const currentChannel = s.voice?.state?.channel_id;
    if (!currentChannel || currentChannel !== String(opts.channel_id)) {
      await joinVoice(botId, {
        guild_id: opts.guild_id, channel_id: opts.channel_id,
        self_mute: !!opts.self_mute, self_deaf: !!opts.self_deaf,
        auto_leave_seconds: 0, timeout_ms: 12000
      });
    }
  }

  if (!s.voice?.state?.channel_id) throw new Error('bot not in voice channel');
  clearVoiceAutoLeave(s);
  console.log('[voice] playVoice: ensuring UDP connection...');
  await ensureVoiceUdp(s);
  const vc = s.voiceConnection;
  if (!vc) throw new Error('voice connection missing');
  if (vc.playing) throw new Error('playback already active');

  let b64 = String(opts.audio_base64 || '');
  const audioBuf = decodeAudioB64(b64);

  const ext = path.extname(String(opts.filename || '')) || '.audio';
  const tmp = path.join(VOICE_DIR, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  fs.writeFileSync(tmp, audioBuf);

  let packets;
  try { packets = await extractOpusPackets(tmp); }
  finally { try { fs.unlinkSync(tmp); } catch {} }

  if (!packets.length) throw new Error('no audio packets extracted');

  startOpusPlayback(s, packets);
  return { ok: true, packets: packets.length, duration_ms: packets.length * 20 };
}

/* ===== gateway ===== */

// central reconnect policy: one in-flight attempt per bot, capped exponential
// backoff reset on every successful connect, no-op when the user disconnected
// the bot on purpose or an attempt is already pending
function scheduleReconnect(botId, token, reason) {
  if (reconnectingBots.has(botId)) return;
  if (intentionalClose.has(botId)) return;
  reconnectingBots.add(botId);
  const attempt = reconnectAttempts.get(botId) || 0;
  reconnectAttempts.set(botId, attempt + 1);
  const delay = Math.min(60000, 2000 * Math.pow(2, Math.min(attempt, 5)));
  console.log(`[gateway] reconnect bot ${botId} in ${delay}ms (attempt ${attempt + 1}): ${reason}`);
  const t = setTimeout(() => {
    reconnectingBots.delete(botId);
    reconnectTimers.delete(botId);
    // a /disconnect during the backoff window must cancel this attempt
    if (intentionalClose.has(botId)) { reconnectAttempts.delete(botId); return; }
    connectGateway(botId, token)
      .then(() => { reconnectAttempts.delete(botId); console.log(`[gateway] auto-reconnect ok for bot ${botId}`); })
      .catch(() => { scheduleReconnect(botId, token, 'attempt failed'); });
  }, delay);
  if (t.unref) t.unref();
  reconnectTimers.set(botId, t);
}

function connectGateway(botId, token) {
  return new Promise((resolve, reject) => {
    const existing = sessions.get(botId);
    if (existing && existing.ws.readyState === WebSocket.OPEN) return resolve(existing);
    if (existing) { try { existing.ws.close(); } catch {} cleanupVoice(existing); sessions.delete(botId); }
    if (!WebSocket) return reject(new Error('ws module not installed (npm i ws)'));

    console.log(`[gateway] connecting bot ${botId}...`);
    const ws = new WebSocket(GATEWAY_URL);
    // settles once per connect attempt: READY resolves it, but a close/error
    // BEFORE ready must reject it too — otherwise the /connect HTTP response
    // hangs forever (the 30s timeout alone is cleared by the close handler)
    let settled = false;
    const settleReject = (err) => { if (!settled) { settled = true; clearTimeout(timeout); reject(err); } };
    const settleResolve = (v) => { if (!settled) { settled = true; clearTimeout(timeout); reconnectAttempts.delete(botId); resolve(v); } };
    const session = {
      botId, ws, token, user: null, heartbeatTimer: null, seq: null,
      presence: 'online', voice: {}, voiceWaiters: [], voiceConnection: null,
      guildVoiceStates: new Map()
    };
    sessions.set(botId, session);

    const timeout = setTimeout(() => {
      console.error(`[gateway] timeout connecting bot ${botId}`);
      try { ws.close(); } catch {}
      cleanupVoice(session); sessions.delete(botId);
      settleReject(new Error('gateway connect timeout (30s)'));
    }, 30000);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.s) session.seq = data.s;

        if (data.op === 10) {
          const interval = data.d.heartbeat_interval;
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token, intents: intentsFor(botId),
              properties: { os: 'linux', browser: 'local-manager', device: 'local-manager' },
              presence: { status: 'online', afk: false, activities: [], since: null }
            }
          }));
          session.lastHeartbeatAck = Date.now();
          session.lastBeatSent = 0;
          // a second HELLO (mock/rogue server) must not leak the first interval
          if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
          session.heartbeatTimer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            // zombie detection: when a heartbeat has been out for over two
            // full periods with no ack, the TCP link is silently dead —
            // terminate (not close) so the close handler reconnects us
            if (session.lastBeatSent && Date.now() - session.lastHeartbeatAck > interval * 2) {
              console.warn(`[gateway] heartbeat ack missing for bot ${botId}, terminating dead link`);
              try { ws.terminate(); } catch {}
              return;
            }
            try { ws.send(JSON.stringify({ op: 1, d: session.seq })); session.lastBeatSent = Date.now(); } catch {}
          }, interval * 0.9);
        }
        else if (data.op === 1) { ws.send(JSON.stringify({ op: 1, d: session.seq })); }
        else if (data.op === 11) { session.lastHeartbeatAck = Date.now(); }
        else if (data.op === 7 || data.op === 9) {
          // op 7 = server-initiated reconnect, op 9 = invalid session (d=false
          // demands a fresh IDENTIFY). previously only op 9 with d===false
          // reconnected, leaving bots silently offline after a rebalance
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          cleanupVoice(session);
          if (sessions.get(botId) === session) sessions.delete(botId);
          scheduleReconnect(botId, token, `op ${data.op} from gateway`);
        }
        else if (data.op === 0) {
          if (data.t === 'READY') {
            console.log(`[gateway] ready bot ${botId}: @${data.d.user.username}`);
            session.user = data.d.user;
            settleResolve(session);
          }
          else if (data.t === 'MESSAGE_CREATE' && data.d.channel_id) saveMessage(data.d);
          else if (data.t === 'MESSAGE_UPDATE' && data.d.channel_id) saveMessage(data.d);
          else if (data.t === 'MESSAGE_DELETE' && data.d.channel_id) markDeleted(data.d.channel_id, data.d.id);
          else if (data.t === 'MESSAGE_DELETE_BULK' && data.d.channel_id) data.d.ids.forEach(id => markDeleted(data.d.channel_id, id));
          else if (data.t === 'GUILD_CREATE') {
            // seed the voice state cache with the members already in voice
            // when the session opened (VOICE_STATE_UPDATE only carries deltas)
            if (Array.isArray(data.d.voice_states)) {
              for (const vs of data.d.voice_states) {
                if (vs && vs.user_id && vs.channel_id) session.guildVoiceStates.set(vs.user_id, vs);
              }
            }
          }
          else if (data.t === 'INTERACTION_CREATE') {
            // component interactions (type 3): buffered per bot so the panel
            // can poll them; raw row is kept for ack/edit responses
            if (data.d && data.d.type === 3) {
              const d = data.d;
              session.interactions = session.interactions || [];
              session.interactions.push({
                id: d.id,
                type: d.type,
                application_id: d.application_id,
                token: d.token,
                version: d.version || 1,
                guild_id: d.guild_id || null,
                channel_id: d.channel_id || null,
                user: d.member && d.member.user ? { id: d.member.user.id, username: d.member.user.username, global_name: d.member.user.global_name, avatar: d.member.user.avatar } : null,
                message: d.message ? { id: d.message.id, content: d.message.content || '', components: d.message.components || [] } : null,
                data: { component_type: d.data?.component_type, custom_id: d.data?.custom_id, values: d.data?.values },
                received_at: Date.now()
              });
              if (session.interactions.length > 100) session.interactions.splice(0, session.interactions.length - 100);
            }
          }
          else if (data.t === 'VOICE_STATE_UPDATE') {
            // track every member's voice state (used by the voice moderation list)
            if (data.d.guild_id) {
              if (!data.d.channel_id) session.guildVoiceStates.delete(data.d.user_id);
              else session.guildVoiceStates.set(data.d.user_id, data.d);
            }
            if (session.user && data.d.user_id === session.user.id) {
            session.voice = session.voice || {};
            session.voice.state = data.d;
            console.log('[gateway] VOICE_STATE_UPDATE:', {
              guild_id: data.d.guild_id,
              channel_id: data.d.channel_id,
              session_id: data.d.session_id,
              self_mute: data.d.self_mute,
              self_deaf: data.d.self_deaf
            });
            if (!data.d.channel_id) {
              session.voice.server = null;
              session.voice.pendingServer = null;
              cleanupVoice(session);
            } else if (session.voice.pendingServer && session.voice.pendingServer.guild_id === data.d.guild_id) {
              session.voice.server = session.voice.pendingServer;
              session.voice.pendingServer = null;
            }

            // Check if we now have both state and server for this guild/channel
            maybeResolveVoiceJoin(session, data.d.guild_id, data.d.channel_id);
            resolveVoiceWaiters(session, data.d);
            }
          }
          else if (data.t === 'VOICE_SERVER_UPDATE') {
            session.voice = session.voice || {};
            console.log('[gateway] VOICE_SERVER_UPDATE:', {
              guild_id: data.d.guild_id,
              endpoint: data.d.endpoint,
              token_len: data.d.token?.length
            });
            if (session.voice?.state?.guild_id === data.d.guild_id) {
              session.voice.server = data.d;
            } else {
              session.voice.pendingServer = data.d;
            }

            // Check if we now have both state and server for this guild/channel
            maybeResolveVoiceJoin(session, data.d.guild_id, session.voice?.state?.channel_id);
            resolveVoiceWaiters(session, session.voice?.state);
          }
        }
      } catch (e) { console.error('[gateway] parse error:', e.message); }
    });

    ws.on('close', (code) => {
      clearTimeout(timeout);
      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
      cleanupVoice(session);
      // only remove our own session: a manual reconnect may have installed a
      // newer one while this socket was dying
      const isCurrent = sessions.get(botId) === session;
      if (isCurrent) sessions.delete(botId);
      if (intentionalClose.has(botId)) {
        intentionalClose.delete(botId);
        console.log(`[gateway] closed bot ${botId} (code ${code}, intentional)`);
        settleReject(new Error('closed before ready (intentional)'));
        return;
      }
      // a stale socket dying must never touch reconnect policy for a newer
      // session, and a pre-ready close must still settle the pending /connect
      if (!isCurrent) {
        settleReject(new Error('superseded by a newer connection'));
        return;
      }
      settleReject(new Error(`gateway closed before ready (code ${code})`));
      if (code === 4014 && !reducedIntentsBots.has(botId)) {
        // disallowed intents: retry once without the privileged members intent
        console.warn(`[gateway] bot ${botId}: GUILD_MEMBERS intent not enabled in the portal, reconnecting without it`);
        reducedIntentsBots.add(botId);
        scheduleReconnect(botId, token, '4014 disallowed intents, dropping GUILD_MEMBERS');
        return;
      }
      if (code === 4014) {
        // still disallowed even without GUILD_MEMBERS (another privileged
        // intent like MESSAGE_CONTENT is missing): retrying would loop forever
        console.error(`[gateway] bot ${botId}: intents still not enabled (4014) after dropping GUILD_MEMBERS, giving up`);
        reconnectAttempts.delete(botId);
        return;
      }
      console.log(`[gateway] closed bot ${botId} (code ${code})`);
      // non-recoverable codes must NOT auto-reconnect: 4004 authentication
      // failed, 4010/4011/4013 invalid shard/version/intents. retrying would
      // only hammer the gateway (and risk per-token invalidation) forever.
      const nonRecoverable = [4004, 4010, 4011, 4013].includes(code);
      if (nonRecoverable) {
        console.error(`[gateway] bot ${botId}: non-recoverable close code ${code}, giving up (fix the cause and /connect again)`);
        reconnectAttempts.delete(botId);
        return;
      }
      // code 1000 = clean goodbye (we initiated it), everything else heals
      // itself: network drops, 4000-series errors and zombie kills reconnect
      // automatically with capped exponential backoff
      if (code !== 1000 && !reconnectingBots.has(botId)) {
        scheduleReconnect(botId, token, 'abnormal close');
      }
    });

    ws.on('error', (err) => {
      console.error(`[gateway] error bot ${botId}:`, err.message);
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      cleanupVoice(session);
      // only evict our own session: a stale socket's error must not remove a
      // newer session installed by a manual reconnect (same rule as the close handler)
      if (sessions.get(botId) === session) sessions.delete(botId);
      settleReject(new Error('gateway error: ' + err.message));
    });
  });
}

function setPresence(botId, status, activity) {
  const s = sessions.get(botId);
  if (!s || s.ws.readyState !== WebSocket.OPEN) throw new Error('gateway not connected');
  s.ws.send(JSON.stringify({
    op: 3,
    d: { status, afk: false, since: Date.now(), activities: activity ? [{ name: activity, type: 0 }] : [] }
  }));
  s.presence = status;
}

function disconnectGateway(botId) {
  const s = sessions.get(botId);
  if (!s && !reconnectTimers.has(botId) && !reconnectingBots.has(botId)) return false;
  // the flag tells the close handler this was a user-initiated goodbye, so
  // the auto-reconnect logic stays out of the way
  intentionalClose.add(botId);
  // cancel a pending auto-reconnect outright (including the mid-backoff case
  // where no live session exists anymore): the in-timer flag check alone
  // can't cover it (the old socket's close event may have already consumed
  // and cleared the flag before the timer fires)
  if (reconnectTimers.has(botId)) {
    clearTimeout(reconnectTimers.get(botId));
    reconnectTimers.delete(botId);
  }
  reconnectingBots.delete(botId);
  reconnectAttempts.delete(botId);
  // restart the grace window on every call: overlapping /disconnects must not
  // let the first (already-expired) forget timer cut a later one short
  if (intentionalCloseTimers.has(botId)) clearTimeout(intentionalCloseTimers.get(botId));
  const forget = setTimeout(() => {
    intentionalClose.delete(botId);
    intentionalCloseTimers.delete(botId);
  }, 10000);
  if (forget.unref) forget.unref();
  intentionalCloseTimers.set(botId, forget);
  if (!s) return true; // pending reconnect cancelled; no live session to close
  clearVoiceAutoLeave(s); cleanupVoice(s);
  try { s.ws.close(); } catch {}
  sessions.delete(botId);
  return true;
}

/* ===== server ===== */
async function handleRequest(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  let m;

  // public liveness probe: no secrets, no ids — just enough for the UI
  // health chip to distinguish "bridge down" from "stale page nonce"
  if (p === '/bridge/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      version: BRIDGE_VERSION,
      uptime_s: Math.floor(process.uptime()),
      sessions: sessions.size,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576)
    });
  }

  // every api route requires the per-boot nonce (injected into index.html);
  // static files stay open. this walls off bridge endpoints from user scripts
  // running inside sandboxed workers, which never receive the nonce
  if (p.startsWith('/gateway/') || p.startsWith('/discord/')) {
    if (req.headers['x-client-nonce'] !== SESSION_NONCE) {
      return json(res, 403, { error: 'invalid session nonce' });
    }
  }

  if (p === '/gateway/tools/transcode-voice' && req.method === 'POST') {
    const body = await readJson(req);
    const buf = decodeAudioB64(body.audio_base64);
    const ext = path.extname(String(body.filename || '')) || '.audio';
    const tmp = path.join(VOICE_DIR, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    fs.writeFileSync(tmp, buf);
    try {
      const out = await transcodeToOggBuffer(tmp);
      try { fs.unlinkSync(tmp); } catch {}
      return json(res, 200, { ok: true, audio_base64: out.toString('base64'), filename: 'voice-message.ogg', content_type: 'audio/ogg' });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      return json(res, 500, { error: e.message });
    }
  }

  if ((m = p.match(/^\/gateway\/([^/]+)\/connect$/)) && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.token) return json(res, 400, { error: 'missing token' });
    // a manual reconnect retracts a pending intentional-close grace window:
    // otherwise the stale flag would swallow the auto-heal if this new
    // session later drops abnormally (the old socket's close event is safe —
    // the close handler ignores sessions that are no longer current)
    if (intentionalCloseTimers.has(m[1])) { clearTimeout(intentionalCloseTimers.get(m[1])); intentionalCloseTimers.delete(m[1]); }
    intentionalClose.delete(m[1]);
    // and cancel any pending auto-reconnect so it can't race this manual one
    if (reconnectTimers.has(m[1])) {
      clearTimeout(reconnectTimers.get(m[1]));
      reconnectTimers.delete(m[1]);
      reconnectingBots.delete(m[1]);
      reconnectAttempts.delete(m[1]);
    }
    const existed = (() => { const s = sessions.get(m[1]); return !!s && s.ws.readyState === WebSocket.OPEN; })();
    connectGateway(m[1], body.token).then(() => json(res, 200, { ok: true, created: !existed })).catch(e => json(res, 500, { error: e.message }));
    return;
  }

  if ((m = p.match(/^\/gateway\/([^/]+)\/presence$/)) && req.method === 'POST') {
    const body = await readJson(req);
    if (!['online', 'idle', 'dnd', 'invisible'].includes(body.status)) return json(res, 400, { error: 'invalid status' });
    try { setPresence(m[1], body.status, body.activity || null); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if ((m = p.match(/^\/gateway\/([^/]+)\/disconnect$/)) && req.method === 'POST') {
    disconnectGateway(m[1]);
    return json(res, 200, { ok: true });
  }

  if (p === '/gateway/status' && req.method === 'GET') {
    const list = [...sessions.entries()].map(([id, s]) => ({
      id, user: s.user, presence: s.presence,
      connected: s.ws.readyState === WebSocket.OPEN,
      voicePlaying: !!s.voiceConnection?.playing
    }));
    return json(res, 200, { sessions: list });
  }

  // archive reads live behind the nonce wall only: the plain /archive/:id
  // alias was removed because it sat outside the nonce check and CORS '*' made
  // archived messages readable by any website the user browses (drive-by exfil)
  const archMatch = p.match(/^\/gateway\/archive\/(\d+)$/);
  if (archMatch && req.method === 'GET') return json(res, 200, { messages: loadArchive(archMatch[1]) });

  if (p === '/i18n/languages' && req.method === 'GET') {
    try { return json(res, 200, { languages: listLocales() }); } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if ((m = p.match(/^\/i18n\/locales\/([a-zA-Z0-9_-]+)$/)) && req.method === 'GET') {
    try {
      const data = readLocale(m[1]);
      if (!data) return json(res, 404, { error: 'locale not found' });
      return json(res, 200, data);
    } catch (e) { return json(res, 500, { error: 'invalid json: ' + e.message }); }
  }

  if ((m = p.match(/^\/gateway\/([^/]+)\/voice\/join$/)) && req.method === 'POST') {
    joinVoice(m[1], await readJson(req)).then(state => json(res, 200, { ok: true, state })).catch(e => json(res, 500, { error: e.message }));
    return;
  }

  if ((m = p.match(/^\/gateway\/([^/]+)\/voice\/leave$/)) && req.method === 'POST') {
    leaveVoice(m[1]).then(state => json(res, 200, { ok: true, state })).catch(e => json(res, 500, { error: e.message }));
    return;
  }

  if ((m = p.match(/^\/gateway\/([^/]+)\/voice\/status$/)) && req.method === 'GET') {
    const s = sessions.get(m[1]);
    return json(res, 200, {
      connected: !!s && s.ws.readyState === WebSocket.OPEN,
      voice: s?.voice?.state || null,
      hasVoiceServer: !!s?.voice?.server,
      voiceTransportReady: !!s?.voiceConnection?.ready,
      playing: !!s?.voiceConnection?.playing
    });
  }

  if ((m = p.match(/^\/gateway\/([^/]+)\/voice\/play$/)) && req.method === 'POST') {
    playVoice(m[1], await readJson(req)).then(info => json(res, 200, info)).catch(e => json(res, e.status || 500, { error: e.message }));
    return;
  }

  if ((m = p.match(/^\/gateway\/([^/]+)\/voice\/stop$/)) && req.method === 'POST') {
    const s = sessions.get(m[1]);
    if (s) stopPlayback(s);
    return json(res, 200, { ok: true });
  }

  // webhook proxy (bypasses CORS: webhook endpoints reject browser origins).
  // POST executes the webhook, GET fetches its profile, PATCH edits it
  // (name/avatar) — all token-authenticated via the url, no bot auth needed.
  if ((m = p.match(/^\/gateway\/webhook\/(\d+)\/([a-zA-Z0-9_-]+)$/)) && ['GET', 'PATCH', 'POST'].includes(req.method)) {
    const body = req.method === 'GET' ? null : await readBody(req);
    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
    try {
      const up = await fetch(`${API}/webhooks/${m[1]}/${m[2]}${url.search}`, { method: req.method, headers, body });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
      res.end(buf);
    } catch (e) { json(res, 502, { error: e.message }); }
    return;
  }

  // buffered component interactions (type 3) captured by the gateway session
  if ((m = p.match(/^\/gateway\/interactions\/([^/]+)$/)) && req.method === 'GET') {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { error: 'no gateway session for this bot' });
    const now = Date.now();
    s.interactions = (s.interactions || []).filter(i => now - i.received_at < 15 * 60 * 1000);
    return json(res, 200, { interactions: [...s.interactions].reverse() });
  }
  if ((m = p.match(/^\/gateway\/interactions\/([^/]+)$/)) && req.method === 'DELETE') {
    const s = sessions.get(m[1]);
    if (s) s.interactions = [];
    return json(res, 200, { ok: true });
  }
  // interaction response callbacks (POST /interactions/:id/:token/callback)
  if ((m = p.match(/^\/gateway\/interactions\/([^/]+)\/callback$/)) && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.id || !body.token || !body.type) return json(res, 400, { error: 'id, token and type required' });
    const payload = { type: body.type };
    if (body.data !== undefined && body.data !== null) payload.data = body.data;
    try {
      const up = await fetch(`${API}/interactions/${body.id}/${body.token}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (local-manager, 1.0)' },
        body: JSON.stringify(payload)
      });
      if (!up.ok) {
        const txt = await up.text();
        return json(res, up.status, { error: txt || ('discord ' + up.status) });
      }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 502, { error: e.message }); }
  }

  // tracked voice states of every member in the guild. the gateway cache
  // (VOICE_STATE_UPDATE + GUILD_CREATE seed) may be empty or stale for users
  // whose states were never observed, so it is re-verified per user against
  // the per-user REST endpoint before being reported.
  if ((m = p.match(/^\/gateway\/([^/]+)\/voice\/states(\?.*)?$/)) && req.method === 'GET') {
    const s = sessions.get(m[1]);
    const guildId = url.searchParams.get('guild_id');
    let states = s?.guildVoiceStates ? [...s.guildVoiceStates.values()] : [];
    if (states.some(st => !st || !st.channel_id)) {
      states = states.filter(st => st && st.channel_id);
    }
    if (guildId && s) {
      const candidateIds = [...new Set(states.map(st => st.user_id).filter(Boolean))];
      const verified = new Map(states.map(st => [st.user_id, st]));
      const token = s.token || null;
      const missing = [];
      for (const uid of candidateIds) {
        const cached = verified.get(uid);
        if (cached && (cached.guild_id || cached.join_time)) continue;
        missing.push(uid);
      }
      // without a token the per-user re-verification would send "Bot null":
      // serve the cached states and skip the rest round-trip entirely
      if (!token) missing.length = 0;
      await Promise.all(missing.map(async (uid) => {
        try {
          const r = await fetch(`${API}/guilds/${guildId}/voice-states/${uid}`, {
            headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (local-manager, 1.0)' }
          });
          if (r.ok) {
            const fresh = await r.json();
            if (fresh && fresh.channel_id) {
              verified.set(uid, fresh);
              s.guildVoiceStates.set(uid, fresh);
            } else {
              verified.delete(uid);
              s.guildVoiceStates.delete(uid);
            }
          } else if (r.status === 404) {
            verified.delete(uid);
            s.guildVoiceStates.delete(uid);
          }
        } catch {}
      }));
      states = [...verified.values()].filter(st => st && st.channel_id);
    }
    return json(res, 200, { states });
  }

  if (p === '/gateway/rate-limits' && req.method === 'GET') {
    const limits = [];
    for (const [bucket, data] of rateLimits.entries()) {
      limits.push({ bucket, ...data });
    }
    return json(res, 200, { limits });
  }

  // full channel backup: metadata + every message, paginated with rate-limit pauses
  if ((m = p.match(/^\/gateway\/backup\/channel\/(\d+)$/)) && req.method === 'POST') {
    const channelId = m[1];
    const body = await readJson(req);
    const token = body.token;
    if (!token) return json(res, 400, { error: 'missing token' });
    const authHeaders = { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (local-manager, 1.0)' };
    try {
      const channelRes = await fetch(`${API}/channels/${channelId}`, { headers: authHeaders });
      if (!channelRes.ok) throw new Error('failed to fetch channel (HTTP ' + channelRes.status + ')');
      const channel = await channelRes.json();

      const messages = [];
      let before = null;
      while (true) {
        const url = `${API}/channels/${channelId}/messages?limit=100${before ? '&before=' + before : ''}`;
        const msgRes = await fetch(url, { headers: authHeaders });
        if (!msgRes.ok) break;
        const msgs = await msgRes.json();
        if (!Array.isArray(msgs) || !msgs.length) break;
        messages.push(...msgs);
        before = msgs[msgs.length - 1].id;
        if (msgs.length < 100) break;
        await sleep(500);
      }

      const backupDir = path.join(DATA_DIR, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const filename = `channel-${channelId}-${Date.now()}.json`;
      fs.writeFileSync(path.join(backupDir, filename), JSON.stringify({ channel, messages }, null, 2));

      return json(res, 200, { ok: true, filename, messageCount: messages.length });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ===== scheduler =====
  if (p === '/gateway/scheduler/jobs' && req.method === 'GET') {
    // never round-trip stored tokens back to the client: mask them
    const jobs = [...scheduledJobs.values()].map(j => ({
      ...j,
      payload: j.payload && j.payload.token
        ? { ...j.payload, token: '••••' + String(j.payload.token).slice(-4) }
        : j.payload
    }));
    return json(res, 200, { jobs });
  }

  if ((m = p.match(/^\/gateway\/scheduler\/job\/([a-zA-Z0-9_-]{1,64})$/)) && req.method === 'POST') {
    const id = m[1];
    const body = await readJson(req);
    if (!['send_message', 'change_presence'].includes(body.type)) {
      return json(res, 400, { error: 'invalid job type' });
    }
    if (body.type === 'send_message' && (!body.payload?.token || !body.payload?.channelId)) {
      return json(res, 400, { error: 'send_message jobs need payload.token and payload.channelId' });
    }
    if (body.type === 'change_presence' && !body.payload?.botId) {
      return json(res, 400, { error: 'change_presence jobs need payload.botId' });
    }
    if (body.type === 'change_presence' && body.payload?.status && !['online', 'idle', 'dnd', 'invisible'].includes(body.payload.status)) {
      return json(res, 400, { error: 'change_presence jobs need payload.status in online|idle|dnd|invisible' });
    }
    if (body.type === 'send_message' && body.payload?.content != null && typeof body.payload.content !== 'string') {
      return json(res, 400, { error: 'send_message payload.content must be a string' });
    }
    const intervalMs = Math.max(parseInt(body.intervalMs, 10) || MIN_INTERVAL_MS, MIN_INTERVAL_MS);
    const job = {
      id,
      name: String(body.name || 'unnamed').slice(0, 80),
      type: body.type,
      intervalMs,
      active: body.active !== false,
      payload: body.payload || {},
      createdAt: Date.now(),
      lastRun: null,
      runCount: 0,
      lastStatus: null
    };
    scheduledJobs.set(id, job);
    saveJobs();
    if (job.active) scheduleJob(job);
    return json(res, 200, { ok: true, job: { ...job, payload: job.payload.token ? { ...job.payload, token: '••••' + String(job.payload.token).slice(-4) } : job.payload } });
  }

  if ((m = p.match(/^\/gateway\/scheduler\/job\/([a-zA-Z0-9_-]{1,64})\/toggle$/)) && req.method === 'POST') {
    const job = scheduledJobs.get(m[1]);
    if (!job) return json(res, 404, { error: 'job not found' });
    job.active = !job.active;
    saveJobs();
    if (job.active) scheduleJob(job);
    else unscheduleJob(job.id);
    return json(res, 200, { ok: true, active: job.active });
  }

  if ((m = p.match(/^\/gateway\/scheduler\/job\/([a-zA-Z0-9_-]{1,64})$/)) && req.method === 'DELETE') {
    unscheduleJob(m[1]);
    if (!scheduledJobs.delete(m[1])) return json(res, 404, { error: 'job not found' });
    saveJobs();
    return json(res, 200, { ok: true });
  }

  // ===== guild members (paginated REST; needs the GUILD_MEMBERS intent enabled) =====
  if ((m = p.match(/^\/gateway\/([^/]+)\/members\/([^/]+)$/)) && req.method === 'POST') {
    // the token travels in the body on purpose: a rest member list has no
    // dependency on a live gateway session (the 403 gate is purely the
    // privileged-intent portal toggle), so the tab works before connecting
    const body = await readJson(req);
    if (!body.token) return json(res, 400, { error: 'missing token' });
    const headers = { Authorization: `Bot ${body.token}`, 'User-Agent': 'DiscordBot (local-manager, 1.0)' };
    try {
      const probe = await fetch(`${API}/guilds/${m[2]}/members?limit=1`, { headers });
      if (probe.status === 403) {
        return json(res, 403, { error: 'missing GUILD_MEMBERS privileged intent (enable SERVER MEMBERS INTENT in the developer portal) or members permission', hasIntent: false });
      }
      if (!probe.ok) return json(res, probe.status, { error: 'HTTP ' + probe.status });

      const members = [];
      let after = null;
      while (true) {
        const pgRes = await fetch(`${API}/guilds/${m[2]}/members?limit=1000${after ? '&after=' + after : ''}`, { headers });
        if (!pgRes.ok) break;
        const batch = await pgRes.json();
        if (!Array.isArray(batch) || !batch.length) break;
        members.push(...batch);
        after = batch[batch.length - 1].user?.id;
        if (!after || batch.length < 1000) break;
        await sleep(500);
      }
      return json(res, 200, { members, hasIntent: !!(intentsFor(m[1]) & INTENT_GUILD_MEMBERS) });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (p.startsWith('/discord/')) return proxyDiscord(req, res, p.slice('/discord'.length) + url.search);

  serveStatic(res, p);
}

// single funnel for async handler errors: body-limit overflows, bad JSON
// uploads and similar now answer with a proper status instead of crashing
// as unhandled rejections (which would keep the socket hanging)
http.createServer((req, res) => {
  handleRequest(req, res).catch(e => {
    console.error('[http] handler error:', e.message);
    try { json(res, e.status || 500, { error: e.message }); } catch {}
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`bridge running on http://127.0.0.1:${PORT}`);
  console.error(`[boot] BRIDGE VERSION: ${BRIDGE_VERSION}`);
  if (!WebSocket) console.warn('ws module not installed: gateway disabled. run: npm i ws');
  console.log(`[boot] ffmpeg: ${ffmpegPath}` + (path.basename(ffmpegPath) === ffmpegPath ? ' (PATH lookup)' : (fs.existsSync(ffmpegPath) ? '' : ' (missing — voice transcode will fail)')));
  console.log(`[boot] dave (voice E2EE): ${davey ? 'available' : 'unavailable'}`);
});

/* ===== process resilience ===== */
// a long-lived local manager should not die from one stray async error:
// log loud, keep serving. genuinely fatal states (port busy, OOM) still crash.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaught exception:', err && err.stack ? err.stack : err);
});
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[process] ${signal} received: closing sessions and shutting down`);
  try { saveJobs(); } catch {}
  for (const [botId] of sessions) {
    try { disconnectGateway(botId); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));