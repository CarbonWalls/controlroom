/* controlroom frontend */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let STATUS = null;
let logFollow = true;

/* ---- api ---- */
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/* ---- toast ---- */
let toastT;
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.className = 'toast', 2600);
}

/* ---- helpers ---- */
function fmtUp(s) {
  if (!s && s !== 0) return '—';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h < 48 ? `${h}h ${m}m` : Math.floor(h / 24) + 'd';
}

/* ---- topbar chips + overview cards ---- */
function renderStatus(st) {
  STATUS = st;
  $('#topChips').innerHTML = `
    <span class="chip ${st.hum.up ? 'on' : 'off'}"><i></i>mercury</span>
    <span class="chip ${st.bridge.up ? 'on' : 'off'}"><i></i>bridge</span>
    <span class="chip neutral">panel <span class="port">${fmtUp(st.panel.uptime_s)}</span></span>`;

  $('#svcGrid').innerHTML = `
    ${svcCard('mercury', 'hum-testing · discord ambient selfbot', st.hum.up, [
      ['uptime', fmtUp(st.hum.uptime_s)], ['last beat', fmtUp(st.hum.last_beat_s)], ['outbox', String(st.hum.outbox)], ['mem', st.hum.mem_mb ? st.hum.mem_mb + 'MB' : '—'],
    ])}
    ${svcCard('bridge', 'bot-mn-1 · discord bot manager', st.bridge.up, [
      ['uptime', fmtUp(st.bridge.uptime_s)], ['port', st.bridge.port || '—'], ['sessions', String(st.bridge.sessions ?? '—')], ['mem', st.bridge.memory_mb ? st.bridge.memory_mb + 'MB' : '—'],
    ])}`;

  // mercury controls
  $('#humKv').innerHTML = kvs([
    ['state', st.hum.up ? 'running' : 'stopped'],
    ['pid', st.hum.pid || '—'],
    ['uptime', fmtUp(st.hum.uptime_s)],
    ['last log activity', fmtUp(st.hum.last_beat_s)],
    ['outbox queued', st.hum.outbox],
    ['log', 'run.log'],
  ]);
  $('#humBtns').innerHTML = st.hum.up
    ? `<button class="btn danger" id="humStopBtn">stop</button><button class="btn" id="humRestartBtn">restart</button>`
    : `<button class="btn primary" id="humStartBtn">start</button>`;
  bindIf('humStartBtn', () => act('/api/hum/start'));
  bindIf('humStopBtn', () => act('/api/hum/stop'));
  bindIf('humRestartBtn', async () => { await act('/api/hum/stop'); await new Promise(r => setTimeout(r, 1200)); await act('/api/hum/start'); });

  // bridge status strip above the workspace
  const ws = $('#wsStatus');
  if (ws) ws.innerHTML = st.bridge.up
    ? `<span class="chip on"><i></i>bridge :${st.bridge.port} · ${st.bridge.sessions} session(s) · ${fmtUp(st.bridge.uptime_s)} up · ${st.bridge.memory_mb}MB</span>`
    : '<span class="chip off"><i></i>bridge offline</span>';
}
function svcCard(name, role, on, stats) {
  return `<div class="svc ${on ? 'is-on' : ''}">
    <div class="svc-top"><span class="svc-name">${esc(name)}</span><span class="badge ${on ? 'on' : 'off'}">${on ? 'online' : 'offline'}</span></div>
    <div class="svc-role">${esc(role)}</div>
    <div class="svc-stats">${stats.map(([k, v]) => `<div class="stat"><b class="${v === '0' ? 'dim' : ''}">${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>
  </div>`;
}
function kvs(pairs) {
  return pairs.map(([k, v]) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}
function bindIf(id, fn) { const el = $('#' + id); if (el) el.onclick = fn; }
async function act(path) {
  try { const r = await api(path, { method: 'POST' }); toast(r.msg || (r.ok ? 'ok' : 'done')); }
  catch (e) { toast(e.message, true); }
  refresh();
}

/* ---- tabs ---- */
let wsMounted = false;
const _origToast = toast; window.crToast = toast;
$('#tabs').onclick = e => {
  const b = e.target.closest('.tab'); if (!b) return;
  $$('.tab').forEach(t => t.classList.toggle('active', t === b));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + b.dataset.tab));
  if (b.dataset.tab === 'mercury') loadCfg();
  if (b.dataset.tab === 'bridge') mountWs();
};

/* ---- log view ---- */
const logView = $('#logView');
function appendLog(text, scroll = true) {
  const atBottom = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 40;
  const span = document.createElement('span');
  span.textContent = text;
  logView.appendChild(span);
  while (logView.childNodes.length > 2500) logView.removeChild(logView.firstChild);
  if (scroll && (atBottom || logFollow)) logView.scrollTop = logView.scrollHeight;
}
async function bootLog() {
  try {
    const r = await api('/api/logs?tail=300');
    logView.textContent = r.lines.join('\n') + '\n';
    logView.scrollTop = logView.scrollHeight;
    if (!STILL) {
      const es = new EventSource('/api/logs/follow');
      es.onmessage = e => { if (logFollow) appendLog(JSON.parse(e.data)); };
      es.onerror = () => { /* server restart drops stream; fine */ };
    }
  } catch {}
}
$('#logFollowBtn').onclick = e => {
  logFollow = !logFollow;
  e.target.classList.toggle('active', logFollow);
  e.target.textContent = logFollow ? 'follow' : 'paused';
};
$('#logClearBtn').onclick = () => { logView.textContent = ''; };

/* ---- outbox ---- */
$('#outboxSend').onclick = async () => {
  const t = $('#outboxText').value;
  if (!t.trim()) return toast('nothing to queue', true);
  try { await api('/api/hum/outbox', { method: 'POST', body: JSON.stringify({ text: t }) }); $('#outboxText').value = ''; toast('queued → mercury will post it'); }
  catch (e) { toast(e.message, true); }
  refresh();
};

/* ---- mercury config form ---- */
let CFG = null;
async function loadCfg() {
  try {
    const r = await api('/api/hum/config');
    CFG = r.config;
    renderCfgForm(CFG);
    loadMemory();
  } catch (e) { toast('config: ' + e.message, true); }
}
function renderCfgForm(cfg) {
  if (!cfg) return $('#cfgForm').innerHTML = '<div class="empty">config.json unreadable</div>';
  const F = (label, key, path, type) => {
    const v = getPath(cfg, path);
    const num = type === 'n';
    return `<div class="field"><label>${label}</label>
      <input data-path="${path}" ${num ? 'type="number" step="any"' : 'type="text"'} value="${esc(v)}"></div>`;
  };
  $('#cfgForm').innerHTML = `
    ${F('channel id', '', 'channel_id')}
    ${F('ambient · target msgs/day', '', 'ambient.target_messages_per_day', 'n')}
    ${F('ambient · ok weight', '', 'ambient.ok_weight', 'n')}
    ${F('ambient · min gap (s)', '', 'ambient.min_gap_seconds', 'n')}
    ${F('attachments · mean gap (s)', '', 'attachments.mean_gap_seconds', 'n')}
    ${F('reply · debounce (s)', '', 'reply.debounce_seconds', 'n')}
    ${F('reply · max batch', '', 'reply.max_batch', 'n')}
    ${toggleField('ambient enabled', 'ambient.enabled')}
    ${toggleField('attachments enabled', 'attachments.enabled')}
    <div class="btn-row"><button class="btn primary" id="cfgSave">apply config</button><span class="count">merged & written back to config.json</span></div>`;
  $('#cfgSave').onclick = async () => {
    const patch = {};
    $$('#cfgForm input[data-path]').forEach(inp => {
      let v = inp.value;
      if (inp.type === 'number') v = parseFloat(v);
      else if (inp.dataset.bool) v = inp.checked;
      setPath(patch, inp.dataset.path, v);
    });
    try { await api('/api/hum/config', { method: 'POST', body: JSON.stringify(patch) }); toast('config saved · watchdog reloads in ~3s'); }
    catch (e) { toast(e.message, true); }
  };
}
function toggleField(label, path) {
  const v = !!getPath(CFG, path);
  return `<div class="field"><label>${label}</label>
    <div class="row"><input type="checkbox" id="tg_${path.replace(/\W/g, '_')}" data-bool="1" data-path="${path}" ${v ? 'checked' : ''} style="width:auto">
    <span class="count">${v ? 'on' : 'off'}</span></div></div>`;
}
function getPath(o, p) { return p.split('.').reduce((a, k) => (a || {})[k], o); }
function setPath(o, p, v) {
  const ks = p.split('.'); const last = ks.pop();
  let t = o; ks.forEach(k => { t[k] = t[k] || {}; t = t[k]; }); t[last] = v;
}
async function loadMemory() {
  try { const r = await api('/api/hum/memory'); $('#memText').value = r.text; } catch {}
}
$('#memSave').onclick = async () => {
  try { await api('/api/hum/memory', { method: 'POST', body: JSON.stringify({ text: $('#memText').value }) }); toast('notes saved'); }
  catch (e) { toast(e.message, true); }
};

/* ---- workspace mount ---- */
function mountWs() {
  if (wsMounted) { window.crWorkspace.reload && window.crWorkspace.reload(); return; }
  if (!STATUS || !STATUS.bridge.up) { $('#wsHost').innerHTML = '<div class="empty">bridge offline — start bot-mn-1 (node bridge.js), then reopen this tab.</div>'; return; }
  wsMounted = true;
  window.crWorkspace.mount($('#wsHost'));
}

/* ---- poll ---- */
let firstPaint = true;
async function refresh() {
  try { renderStatus(await api('/api/status')); } catch {}
  if (firstPaint) {
    firstPaint = false;
    if (STILLTAB === 'mercury') loadCfg();
    if (STILLTAB === 'bridge') mountWs();
  }
}
const STILL = new URLSearchParams(location.search).has('still'); // ?still=1 → no SSE/polling (headless screenshot mode)
const STILLTAB = new URLSearchParams(location.search).get('tab'); // force-show a tab in still mode
if (STILL && STILLTAB) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === STILLTAB));
  $$('.page').forEach(pg => pg.classList.toggle('active', pg.id === 'page-' + STILLTAB));
}
if (!STILL) setInterval(refresh, 5000);
bootLog();
refresh();
