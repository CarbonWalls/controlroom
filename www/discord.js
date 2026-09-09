/* controlroom — discord workspace: full bridge feature set, native UI.
   all calls go through /api/bridge/* ; nonce + bot token handled server-side. */
(() => {
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tt = (msg, err) => window.crToast ? window.crToast(msg, err) : alert(msg);
const API = '/api/bridge';
const DISCORD_MSG_MAX = 2000;

/* ---- icon set (feather-style, bold stroke) ---- */
const IC = {
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  speaker: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9.5 9.5 0 0 1 0 13"/>',
  megaphone: '<path d="M3 11v3a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M14 8.5a4.5 4.5 0 0 1 0 7"/><path d="M17 5.5a8.5 8.5 0 0 1 0 13"/><line x1="6" y1="15" x2="7.5" y2="21"/>',
  stage: '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4"/><path d="M16.2 16.2a6 6 0 0 0 0-8.4"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2"/><path d="M19.1 19.1a10 10 0 0 0 0-14.2"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  caret: '<polyline points="6 9 12 15 18 9"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  clip: '<path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  play: '<polygon points="6 4 21 12 6 20 6 4"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  edit: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8 8.38 8.38 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  arrowup: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
};
const ic = (n, s = 15) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n] || ''}</svg>`;
const chanIc = c => ({ 0: 'hash', 2: 'speaker', 4: 'grid', 5: 'megaphone', 13: 'stage', 15: 'speaker', 16: 'hash' }[c.type] || 'hash');

async function bapi(path, opts = {}) {
  const r = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false && r.status >= 400) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/* ---- state ---- */
const W = {
  me: null, guilds: [], guild: null, channels: [], channel: null,
  messages: [], members: new Map(), roles: [], view: 'chat', loadingOlder: false,
};

/* ---- permission bits (official table) ---- */
const PERM_BITS = [
  [1n,'create_invite','TVS'],[2n,'kick_members','G'],[4n,'ban_members','G'],[8n,'administrator','G'],
  [16n,'manage_channels','TVS'],[32n,'manage_guild','G'],[64n,'add_reactions','TVS'],[128n,'view_audit_log','G'],
  [256n,'priority_speaker','V'],[512n,'stream','VS'],[1024n,'view_channel','TVS'],[2048n,'send_messages','TVS'],
  [4096n,'send_tts','TVS'],[8192n,'manage_messages','TVS'],[16384n,'embed_links','TVS'],[32768n,'attach_files','TVS'],
  [65536n,'read_history','TVS'],[131072n,'mention_everyone','TVS'],[262144n,'external_emojis','TVS'],
  [524288n,'view_guild_insights','G'],[1048576n,'connect','VS'],[2097152n,'speak','V'],[4194304n,'mute_members','VS'],
  [8388608n,'deafen_members','V'],[16777216n,'move_members','VS'],[33554432n,'use_vad','V'],
  [67108864n,'change_nickname','G'],[134217728n,'manage_nicknames','G'],[268435456n,'manage_roles','TVS'],
  [536870912n,'manage_webhooks','TVS'],[1073741824n,'manage_expressions','G'],[2147483648n,'use_commands','TVS'],
  [4294967296n,'request_to_speak','S'],[8589934592n,'manage_events','VS'],[17179869184n,'manage_threads','T'],
  [34359738368n,'create_public_threads','T'],[68719476736n,'create_private_threads','T'],
  [137438953472n,'external_stickers','TVS'],[274877906944n,'send_in_threads','T'],
  [549755813888n,'embedded_activities','TV'],[1099511627776n,'moderate_members','G'],
  [2199023255552n,'view_monetization_analytics','G'],[4398046511104n,'use_soundboard','V'],
  [8796093022208n,'create_guild_expressions','G'],[17592186044416n,'create_events','VS'],
  [35184372088832n,'use_external_sounds','V'],[1n<<46n,'send_voice_messages','TVS'],
  [1n<<49n,'send_polls','TVS'],[1n<<50n,'use_external_apps','TVS'],
  [1n<<51n,'pin_messages','T'],[1n<<52n,'bypass_slowmode','TVS']
];
const hasBit = (bits, bit) => (BigInt(bits || 0) & bit) === bit;
const AV_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='32' fill='%23232c40'/><circle cx='32' cy='25' r='10' fill='%2357647f'/><path d='M12 56c2-12 10-16 20-16s18 4 20 16' fill='%2357647f'/></svg>`);
const avatarUrl = u => u?.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : AV_FALLBACK;

/* ---- generic char counter: any textarea[data-max] gets a live counter ---- */
function bindCounter(ta) {
  const max = parseInt(ta.dataset.max, 10) || DISCORD_MSG_MAX;
  const wrap = ta.closest('.cwrap');
  const cnt = wrap?.querySelector('.ccount');
  const paint = () => {
    if (!cnt) return;
    const n = ta.value.length;
    cnt.textContent = `${n}/${max}`;
    cnt.className = 'ccount' + (n > max ? ' over' : n > max * .9 ? ' warn' : '');
    const sendBtn = wrap?.parentElement?.querySelector('[data-sendbtn]');
    if (sendBtn) sendBtn.disabled = n === 0 || n > max;
  };
  ta.addEventListener('input', paint);
  paint();
  return paint;
}

/* ---- modal helpers ---- */
function modal(title, bodyHTML, footHTML = '') {
  const bg = document.createElement('div');
  bg.className = 'cr-modal-bg';
  bg.innerHTML = `<div class="cr-modal"><div class="cr-modal-head"><h3>${esc(title)}</h3><button class="ibtn cr-x">${ic('x', 16)}</button></div><div class="cr-modal-body">${bodyHTML}</div>${footHTML ? `<div class="cr-modal-foot">${footHTML}</div>` : ''}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('.cr-x').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  return { el: bg, close };
}
function confirmModal(title, desc, onyes) {
  const m = modal(title, `<p class="hint" style="font-size:13px">${esc(desc)}</p>`,
    `<button class="btn danger" data-yes>confirm</button><button class="btn" data-no>cancel</button>`);
  m.el.querySelector('[data-yes]').onclick = async () => { m.close(); await onyes(); };
  m.el.querySelector('[data-no]').onclick = m.close;
}
function promptInput(title, label, val = '') {
  return new Promise(res => {
    const m = modal(title, `<div class="field"><label>${esc(label)}</label><input id="_pi" value="${esc(val)}"></div>`,
      `<button class="btn primary" data-ok>ok</button><button class="btn" data-no>cancel</button>`);
    m.el.querySelector('[data-ok]').onclick = () => { const v = m.el.querySelector('#_pi').value; m.close(); res(v); };
    m.el.querySelector('[data-no]').onclick = () => { m.close(); res(null); };
    setTimeout(() => m.el.querySelector('#_pi').focus(), 30);
  });
}
const searchBox = (id, ph) => `<div class="search-wrap">${ic('search', 14)}<input id="${id}" placeholder="${esc(ph)}"></div>`;
const btn = (cls, label, icon) => `<button class="${cls}">${icon ? ic(icon, 13) : ''}${label ? `<span>${esc(label)}</span>` : ''}</button>`;

/* ==== boot: whoami + guilds ==== */
async function ensureMe() {
  if (W.me) return W.me;
  const r = await fetch('/api/whoami').then(x => x.json());
  if (!r.ok) throw new Error(r.token_present ? 'bridge offline — start it to use the workspace' : 'no bot token on panel (.env TOKEN_BOT)');
  W.me = r.user;
  return W.me;
}
async function loadGuilds() {
  await ensureMe();
  if (!W.guilds.length) W.guilds = await bapi('/discord/users/@me/guilds?limit=200');
  return W.guilds;
}

/* ==== workspace shell ==== */
const SUBVIEWS = [
  ['chat', 'chat'], ['members', 'members'], ['roles', 'roles'], ['channels', 'channels'],
  ['scheduler', 'scheduler'], ['voice', 'voice'], ['backups', 'backups'],
];
function wsShell() {
  return `
  <div class="ws-topbar">
    <div class="ws-subtabs" id="wsSubtabs">${SUBVIEWS.map(([v, l]) =>
      `<button class="st ${v === W.view ? 'active' : ''}" data-v="${v}">${ic(v === 'chat' ? 'chat' : v === 'members' ? 'users' : v === 'roles' ? 'shield' : v === 'channels' ? 'grid' : v === 'scheduler' ? 'clock' : v === 'voice' ? 'speaker' : 'file', 13)}<span>${l}</span></button>`).join('')}</div>
  </div>
  <div class="ws">
    <aside class="ws-side" id="wsSide">
      <div class="ws-side-top">
        <select id="wsGuild" class="ws-guildsel"></select>
        <button class="ibtn ws-toggle" id="wsChanToggle" title="channels">${ic('menu', 16)}</button>
      </div>
      <div id="wsChans" class="ws-chans"></div>
    </aside>
    <section class="ws-main">
      <div class="ws-view" id="wsView"></div>
    </section>
  </div>`;
}

async function mountWorkspace(host) {
  const sv = new URLSearchParams(location.search).get('view'); // still-mode subview forcing
  if (sv) W.view = sv;
  host.innerHTML = wsShell();
  $('#wsSubtabs').onclick = e => {
    const b = e.target.closest('.st'); if (!b) return;
    $$('#wsSubtabs .st').forEach(x => x.classList.toggle('active', x === b));
    W.view = b.dataset.v; renderView();
  };
  $('#wsGuild').onchange = e => selectGuild(e.target.value);
  const side = $('#wsSide');
  const scrim = document.createElement('div');
  scrim.className = 'ws-scrim'; scrim.hidden = true;
  host.appendChild(scrim);
  const toggleSide = () => {
    if (innerWidth <= 800) {
      side.classList.toggle('open');
      scrim.hidden = !side.classList.contains('open');
    } else side.classList.toggle('collapsed');
  };
  $('#wsChanToggle').onclick = toggleSide;
  scrim.onclick = toggleSide;
  window.addEventListener('resize', () => { side.classList.remove('open'); scrim.hidden = true; });
  let guilds;
  try { guilds = await loadGuilds(); }
  catch (err) { host.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty">${ic('alert', 14)} ${esc(err.message)}</div></div></div>`; return; }
  $('#wsGuild').innerHTML = guilds.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  if (!W.guild) await selectGuild(guilds[0]?.id);
  else $('#wsGuild').value = W.guild.id;
}

async function selectGuild(id) {
  if (!id) return;
  W.guild = W.guilds.find(g => g.id === id);
  W.members = new Map();
  await loadChannels();
  renderView();
}

async function loadChannels() {
  W.channels = await bapi(`/discord/guilds/${W.guild.id}/channels`);
  W.channels.sort((a, b) => (a.type - b.type) || a.position - b.position);
  if (!W.channel || !W.channels.find(c => c.id === W.channel.id)) W.channel = W.channels.find(c => c.type === 0 || c.type === 5) || null;
  paintChans();
}
function paintChans() {
  const el = $('#wsChans'); if (!el) return;
  const byParent = new Map();
  const cats = W.channels.filter(c => c.type === 4);
  const orphans = [];
  for (const c of W.channels) {
    if (c.type === 4) continue;
    if (c.parent_id && byParent.has(c.parent_id)) byParent.get(c.parent_id).push(c);
    else if (c.parent_id && cats.some(k => k.id === c.parent_id)) byParent.set(c.parent_id, [c]);
    else orphans.push(c);
  }
  const rows = [];
  const row = c => `<div class="chan ${W.channel?.id === c.id ? 'sel' : ''}" data-id="${c.id}"><span class="ci">${ic(chanIc(c), 14)}</span><span class="cn">${esc(c.name)}</span></div>`;
  for (const c of orphans) rows.push(row(c));
  for (const cat of cats) {
    const kids = byParent.get(cat.id) || [];
    if (!kids.length) continue;
    rows.push(`<div class="cat-row" data-cat="${cat.id}"><span class="cat-caret">${ic('caret', 12)}</span><span class="cat-name">${esc(cat.name)}</span></div>`);
    rows.push(`<div class="cat-group" data-catg="${cat.id}">` + kids.map(row).join('') + `</div>`);
  }
  el.innerHTML = rows.join('') || '<div class="empty">no channels visible</div>';
  el.querySelectorAll('.cat-row').forEach(cr => {
    cr.onclick = () => {
      const g = el.querySelector(`[data-catg="${cr.dataset.cat}"]`);
      if (g) g.style.display = g.style.display === 'none' ? '' : 'none';
      cr.classList.toggle('shut');
    };
  });
  el.onclick = e => {
    const d = e.target.closest('.chan'); if (!d) return;
    W.channel = W.channels.find(c => c.id === d.dataset.id);
    $$('#wsChans .chan').forEach(x => x.classList.toggle('sel', x === d));
    if (innerWidth <= 800) { $('#wsSide').classList.remove('open'); const sc = $('.ws-scrim'); if (sc) sc.hidden = true; }
    else $('#wsSide').classList.add('collapsed');
    renderView();
  };
}

/* ==== views ==== */
async function renderView() {
  const v = $('#wsView'); if (!v) return;
  v.innerHTML = '<div class="empty">loading…</div>';
  try {
    await ({ chat: viewChat, members: viewMembers, roles: viewRoles, channels: viewChannels,
       scheduler: viewScheduler, voice: viewVoice, backups: viewBackups }[W.view])(v);
  } catch (e) { v.innerHTML = `<div class="empty">${ic('alert', 14)} ${esc(e.message)}</div>`; }
}

/* ---- chat: optimistic send, counter, load-older ---- */
async function viewChat(v) {
  if (!W.channel) return v.innerHTML = '<div class="empty">select a text channel</div>';
  v.innerHTML = `<div class="chat">
    <div class="chat-head">
      <button class="ibtn ch-chanbtn" id="chDrawerBtn" title="channels">${ic('grid', 15)}</button>
      <span class="cicon">${ic(chanIc(W.channel), 16)}</span><b>${esc(W.channel.name)}</b>
      <span class="count hidemobile" id="chIdChip" title="click to copy">${esc(W.channel.id)}</span>
      <span class="spacer"></span>
      <button class="ibtn" id="chReload" title="reload">${ic('refresh', 15)}</button>
      <button class="ibtn" id="chPurge" title="purge bot messages">${ic('trash', 15)}</button>
    </div>
    <div class="msgs" id="msgs"><div class="empty">loading…</div></div>
    <div class="reply-chip" id="replyChip" hidden></div>
    <div class="composer">
      <div class="cwrap">
        <textarea id="cmsg" rows="2" data-max="${DISCORD_MSG_MAX}" placeholder="message to #${esc(W.channel.name)}…"></textarea>
        <span class="ccount"></span>
      </div>
      <label class="ibtn file-btn" title="attach file">${ic('clip', 15)}<input type="file" id="cfile" hidden></label>
      <button class="ibtn primary-send" id="csend" data-sendbtn title="send">${ic('send', 15)}</button>
    </div>
  </div>`;
  const longTxt = t => (t && t.length > 400) ? 'data-clamp="1"' : '';
  const ta = $('#cmsg');
  const paintCount = bindCounter(ta);
  // @mention autocomplete: fires on '@' + typing, keyboard navigable
  let acBox = null, acItems = [], acIdx = -1, acStart = -1;
  const ensureAcBox = () => {
    if (!acBox) {
      acBox = document.createElement('div');
      acBox.className = 'ac-box'; acBox.hidden = true;
      ta.closest('.composer').appendChild(acBox);
    }
    return acBox;
  };
  const closeAc = () => { if (acBox) { acBox.hidden = true; acBox.innerHTML = ''; } acItems = []; acIdx = -1; acStart = -1; };
  const openAc = q => {
    const members = [...W.members.values()];
    if (!members.length) return closeAc();
    const ql = q.toLowerCase();
    acItems = members.filter(mb => !ql || mb.user?.username?.toLowerCase().includes(ql) || (mb.nick || '').toLowerCase().includes(ql)).slice(0, 6);
    if (!acItems.length) return closeAc();
    const box = ensureAcBox();
    acIdx = 0;
    box.innerHTML = acItems.map((mb, i) => `<div class="ac-item ${i === 0 ? 'sel' : ''}" data-i="${i}"><img class="m-av sm" src="${esc(avatarUrl(mb.user))}"> <b>${esc(mb.nick || mb.user.username)}</b> <span class="count">${esc(mb.user.username)}</span></div>`).join('');
    box.hidden = false;
    box.onclick = e => { const it = e.target.closest('.ac-item'); if (it) applyAc(+it.dataset.i); };
  };
  const applyAc = i => {
    const mb = acItems[i]; if (!mb) return closeAc();
    const name = mb.nick || mb.user.username;
    const before = ta.value.slice(0, acStart), after = ta.value.slice(ta.selectionStart);
    ta.value = before + '@' + name + ' ' + after.replace(/^\S*\s?/, '');
    closeAc(); paintCount(); ta.focus();
  };
  ta.addEventListener('input', () => {
    const pos = ta.selectionStart;
    const txt = ta.value.slice(0, pos);
    const m = /@([a-zA-Z0-9_.]*)$/.exec(txt);
    if (m) { acStart = pos - m[0].length; openAc(m[1]); } else closeAc();
  });
  ta.addEventListener('keydown', e => {
    if (acBox && !acBox.hidden && acItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = (acIdx + 1) % acItems.length; paintAcSel(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); acIdx = (acIdx - 1 + acItems.length) % acItems.length; paintAcSel(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); applyAc(acIdx); return; }
      if (e.key === 'Escape') { closeAc(); return; }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); sendCurrent();
    }
  });
  ta.addEventListener('blur', () => setTimeout(closeAc, 150));
  function paintAcSel() {
    acBox.querySelectorAll('.ac-item').forEach((el2, i) => el2.classList.toggle('sel', i === acIdx));
  }
  const doLoad = async () => {
    const msgs = await bapi(`/discord/channels/${W.channel.id}/messages?limit=100`);
    W.messages = Array.isArray(msgs) ? msgs.reverse() : [];
    paintMsgs();
  };
  $('#chReload').onclick = doLoad;
  $('#chIdChip').onclick = () => { navigator.clipboard?.writeText(W.channel.id); tt('id copied'); };
  $('#chDrawerBtn').onclick = () => $('#wsChanToggle').click();
  $('#chPurge').onclick = () => confirmModal('purge bot messages', `delete every message authored by ${W.me.username} in #${W.channel.name}?`, bulkDeleteBot);
  await doLoad();
  $('#csend').onclick = sendCurrent;
  $('#cfile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 8 * 1024 * 1024) { tt('file too large (>8MB)', true); e.target.value = ''; return; }
    const tmp = { id: 'tmpf' + Date.now(), content: ta.value || '', author: { id: W.me.id, username: W.me.username, avatar: W.me.avatar }, timestamp: new Date().toISOString(), attachments: [{ filename: f.name }], _pending: true };
    if (ta.value) { ta.value = ''; paintCount(); }
    W.messages.push(tmp); paintMsgs();
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      const sent = await bapi(`/discord/channels/${W.channel.id}/messages`, { method: 'POST', body: {
        content: tmp.content || undefined, attachments: [{ id: '0', filename: f.name, description: null, content_bytes: btoa(bin) }] } });
      const idx = W.messages.findIndex(m => m.id === tmp.id); if (idx >= 0) W.messages[idx] = sent;
    } catch (err) { tmp._failed = true; tmp._error = err.message; tt(err.message, true); }
    paintMsgs();
    e.target.value = '';
  };

  function renderReplyChip() {
    const chip = $('#replyChip');
    if (ta.dataset.reply) {
      const orig = W.messages.find(m => m.id === ta.dataset.reply);
      chip.hidden = false;
      chip.innerHTML = `${ic('reply', 13)} replying to <b>${esc(orig?.author?.username || ta.dataset.reply)}</b>${orig ? `: ${esc((orig.content || '').slice(0, 60))}` : ''}<button class="ibtn" id="replyX">${ic('x', 13)}</button>`;
      $('#replyX').onclick = () => { delete ta.dataset.reply; renderReplyChip(); ta.focus(); };
    } else chip.hidden = true;
  }

  function paintMsgs() {
    const el = $('#msgs');
    let prev = null;
    el.innerHTML = `<div class="load-older" id="loadOlder">${ic('arrowup', 13)} load older</div>` + W.messages.map(m0 => {
      const m = m0;
      const grouped = prev && prev.author?.id === m.author?.id && !m._pending && !m._failed &&
        (new Date(m.timestamp) - new Date(prev.timestamp)) < 4 * 60000 && prev.id && m.id;
      prev = m;
      const bot = m.author?.id === W.me.id;
      const atts = (m.attachments || []).map(a => a.image ? `<a href="${esc(a.url)}" target="_blank"><img class="att-img" src="${esc(a.url)}?width=320" loading="lazy"></a>` : `<span class="att-chip">${ic('file', 12)} ${esc(a.filename || 'file')}</span>`).join(' ');
      const acts = `${m._failed ? `<button class="mic" data-a="retry">${ic('refresh', 12)} retry</button>` : ''}<button class="mic" data-a="reply" title="reply">${ic('reply', 13)}</button>${bot && !m._pending && !m._failed ? `<button class="mic" data-a="del" title="delete">${ic('trash', 13)}</button>` : ''}`;
      let ref = m._reply;
      if (!ref && m.message_reference && m.message_reference.message_id) {
        const orig = W.messages.find(x => x.id === m.message_reference.message_id);
        ref = { username: orig?.author?.username || '?', content: orig?.content || '' };
      }
      const refHtml = ref ? `<div class="m-ref">${ic('reply', 12)} <b>${esc(ref.username)}</b> ${esc(ref.content.slice(0, 80) || '(media)')}</div>` : '';
      return `<div class="msg ${bot ? 'own' : ''} ${m._pending ? 'pending' : ''} ${m._failed ? 'failed' : ''} ${grouped ? 'grouped' : ''}" data-id="${m.id}">
        ${grouped ? '<span class="m-av ghost"></span>' : `<img class="m-av" src="${esc(avatarUrl(m.author))}" loading="lazy">`}
        <div class="m-body">
          <div class="m-top" ${grouped ? 'hidden' : ''}><b>${esc(m.author?.username || '?')}</b><span class="m-t">${m._pending ? 'sending…' : m._failed ? 'failed — ' + esc(m._error || '') : new Date(m.timestamp).toLocaleTimeString()}</span>
            <span class="m-acts">${acts}</span></div>
          ${refHtml}
          <div class="m-txt" ${longTxt(m.content)}>${esc(m.content || '')} ${atts}</div>
        </div></div>`;
    }).join('');
    $('#loadOlder').onclick = loadOlder;
    el.querySelectorAll('.m-txt[data-clamp]').forEach(el2 => {
      el2.onclick = ev => { ev.stopPropagation(); el2.removeAttribute('data-clamp'); };
    });
    el.onclick = async e => {
      const b = e.target.closest('.mic'); if (!b) return;
      const msgEl = b.closest('.msg'); const mid = msgEl.dataset.id;
      if (b.dataset.a === 'del') confirmModal('delete message', 'delete this message?', async () => { await bapi(`/discord/channels/${W.channel.id}/messages/${mid}`, { method: 'DELETE' }); W.messages = W.messages.filter(m => m.id !== mid); paintMsgs(); tt('deleted'); });
      if (b.dataset.a === 'reply') { ta.dataset.reply = mid; renderReplyChip(); ta.focus(); }
      if (b.dataset.a === 'retry') {
        const tmp = W.messages.find(m => m.id === mid); if (!tmp) return;
        tmp._pending = true; tmp._failed = false; paintMsgs();
        try {
          const sent = await bapi(`/discord/channels/${W.channel.id}/messages`, { method: 'POST', body: { content: tmp.content } });
          const idx = W.messages.findIndex(m => m.id === mid); if (idx >= 0) W.messages[idx] = sent;
        } catch (err) { tmp._failed = true; tmp._error = err.message; }
        paintMsgs();
      }
    };
    el.scrollTop = el.scrollHeight;
  }

  async function loadOlder() {
    const oldest = W.messages.find(m => !String(m.id).startsWith('tmp'));
    if (!oldest || W.loadingOlder) return;
    W.loadingOlder = true;
    $('#loadOlder').textContent = 'loading…';
    try {
      const older = await bapi(`/discord/channels/${W.channel.id}/messages?limit=100&before=${oldest.id}`);
      const atTop = $('#msgs').scrollTop;
      W.messages = (Array.isArray(older) ? older.reverse() : []).concat(W.messages);
      paintMsgs();
      $('#msgs').scrollTop = $('#msgs').scrollHeight - atTop; // keep position
    } finally { W.loadingOlder = false; }
  }

  async function sendCurrent() {
    const content = ta.value.trim();
    if (!content || content.length > DISCORD_MSG_MAX) return;
    const body = { content };
    let replyMeta = null;
    if (ta.dataset.reply) {
      const orig = W.messages.find(m => m.id === ta.dataset.reply);
      replyMeta = orig ? { id: orig.id, username: orig.author?.username || '?', content: orig.content || '' } : null;
      body.message_reference = { message_id: ta.dataset.reply };
    }
    // optimistic: clear input, paint a pending bubble, then settle
    ta.value = ''; paintCount(); delete ta.dataset.reply; renderReplyChip();
    const tmp = { id: 'tmp' + Date.now(), content, author: { id: W.me.id, username: W.me.username, avatar: W.me.avatar }, timestamp: new Date().toISOString(), attachments: [], _pending: true, _reply: replyMeta };
    W.messages.push(tmp); paintMsgs();
    try {
      const sent = await bapi(`/discord/channels/${W.channel.id}/messages`, { method: 'POST', body });
      const idx = W.messages.findIndex(m => m.id === tmp.id); if (idx >= 0) W.messages[idx] = sent;
    } catch (err) {
      tmp._failed = true; tmp._error = err.message; tt(err.message, true);
    }
    paintMsgs();
  }
  async function bulkDeleteBot() {
    const ids = W.messages.filter(m => m.author?.id === W.me.id && !String(m.id).startsWith('tmp')).map(m => m.id);
    if (!ids.length) return tt('no bot messages to purge');
    for (let i = 0; i < ids.length; i += 100) {
      await bapi(`/discord/channels/${W.channel.id}/messages/bulk-delete`, { method: 'POST', body: { messages: ids.slice(i, i + 100) } });
      await new Promise(r => setTimeout(r, 600));
    }
    tt(`purged ${ids.length}`); doLoad();
  }
}

/* ---- members ---- */
async function viewMembers(v) {
  v.innerHTML = `<div class="toolbar">${searchBox('memFilter', 'search members…')}<span class="count" id="memCount"></span></div><div id="memList" class="mem-list"><div class="empty">loading…</div></div>`;
  const render = () => {
    const f = $('#memFilter').value.toLowerCase();
    const arr = [...W.members.values()].filter(mb => !f || mb.user?.username?.toLowerCase().includes(f) || (mb.nick || '').toLowerCase().includes(f));
    $('#memCount').textContent = arr.length + ' / ' + W.members.size;
    $('#memList').innerHTML = arr.slice(0, 300).map(mb => {
      const roles = (mb.roles || []).map(r => W.roles.find(x => x.id === r)?.name).filter(Boolean);
      return `<div class="list-item" data-uid="${mb.user.id}">
        <span class="t"><img class="m-av sm" src="${esc(avatarUrl(mb.user))}" loading="lazy"> <b>${esc(mb.nick || mb.user.username)}</b> <span class="count">${esc(roles.slice(0, 3).join(', ') || 'no roles')}</span></span>
        <span class="meta"><button class="ibtn" data-a="edit" title="edit member">${ic('edit', 14)}</button></span></div>`;
    }).join('') || '<div class="empty">no matches</div>';
  };
  $('#memFilter').oninput = render;
  $('#memList').onclick = e => {
    const b = e.target.closest('[data-a="edit"]'); if (!b) return;
    openMemberEditor(b.closest('.list-item').dataset.uid);
  };
  if (!W.members.size) {
    W.roles = W.roles.length ? W.roles : await bapi(`/discord/guilds/${W.guild.id}/roles`);
    const r = await bapi(`/gateway/${W.me.id}/members/${W.guild.id}`, { method: 'POST', body: {} });
    (r.members || []).forEach(mb => W.members.set(mb.user.id, mb));
  }
  render();

  async function openMemberEditor(uid) {
    const mb = W.members.get(uid);
    const m = modal(`@${mb.user.username}`, `<div class="kv">
        <div class="kv-row"><dt>id</dt><dd>${uid}</dd></div>
        <div class="kv-row"><dt>nickname</dt><dd><input id="_nick" value="${esc(mb.nick || '')}" placeholder="${esc(mb.user.username)}"></dd></div>
        <div class="kv-row"><dt>joined</dt><dd>${new Date(mb.joined_at).toLocaleDateString()}</dd></div>
      </div>
      <div class="field"><label>roles</label><div class="role-checks">${
        W.roles.filter(r => r.id !== W.guild.id && r.name !== '@everyone').map(r =>
          `<label class="rc"><input type="checkbox" data-r="${r.id}" ${mb.roles.includes(r.id) ? 'checked' : ''}> <span style="color:${r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'var(--fg2)'}">${esc(r.name)}</span></label>`).join('')
      }</div></div>`,
      `<button class="btn primary" data-save>${ic('save', 13)}<span>save</span></button>
       <button class="btn" data-nick-only>nick only</button>
       <button class="btn danger" data-kick>kick</button>
       <button class="btn danger" data-ban>ban</button>`);
    m.el.querySelector('[data-save]').onclick = async () => {
      const roles = [...m.el.querySelectorAll('.rc input:checked')].map(x => x.dataset.r);
      const nick = m.el.querySelector('#_nick').value || null;
      await bapi(`/discord/guilds/${W.guild.id}/members/${uid}`, { method: 'PATCH', body: { nick, roles } });
      tt('member updated'); m.close();
      W.members.delete(uid);
      const fresh = await bapi(`/discord/guilds/${W.guild.id}/members/${uid}`); W.members.set(uid, fresh);
      render();
    };
    m.el.querySelector('[data-nick-only]').onclick = async () => {
      const nick = m.el.querySelector('#_nick').value || null;
      await bapi(`/discord/guilds/${W.guild.id}/members/${uid}`, { method: 'PATCH', body: { nick } });
      tt('nick set'); m.close(); W.members.delete(uid); W.members.set(uid, await bapi(`/discord/guilds/${W.guild.id}/members/${uid}`)); render();
    };
    m.el.querySelector('[data-kick]').onclick = () => confirmModal('kick', `kick @${mb.user.username}?`, async () => { await bapi(`/discord/guilds/${W.guild.id}/members/${uid}`, { method: 'DELETE' }); tt('kicked'); m.close(); W.members.delete(uid); render(); });
    m.el.querySelector('[data-ban]').onclick = () => confirmModal('ban', `ban @${mb.user.username}?`, async () => { await bapi(`/discord/guilds/${W.guild.id}/bans/${uid}`, { method: 'PUT' }); tt('banned'); m.close(); W.members.delete(uid); render(); });
  }
}

/* ---- roles ---- */
async function viewRoles(v) {
  const roles = await bapi(`/discord/guilds/${W.guild.id}/roles`);
  W.roles = roles;
  roles.sort((a, b) => b.position - a.position);
  v.innerHTML = `<div class="toolbar"><button class="btn primary" id="roleNew">${ic('plus', 13)}<span>new role</span></button></div><div class="mem-list">${
    roles.map(r => `<div class="list-item" data-rid="${r.id}">
      <span class="t"><i class="dot" style="background:${r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'var(--fg3)'}"></i> <b style="color:${r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'inherit'}">${esc(r.name)}</b> <span class="count">${hasBit(r.permissions, 8n) ? 'admin · ' : ''}${r.hoist ? 'separate · ' : ''}pos ${r.position}${r.managed ? ' · managed' : ''}</span></span>
      <span class="meta">${r.id === W.guild.id ? '' : `<button class="ibtn" data-a="perms" title="permissions">${ic('shield', 14)}</button><button class="ibtn" data-a="edit" title="edit">${ic('edit', 14)}</button>`}</span></div>`).join('')
  }</div>`;
  $('#roleNew').onclick = async () => {
    const name = await promptInput('new role', 'name'); if (!name) return;
    await bapi(`/discord/guilds/${W.guild.id}/roles`, { method: 'POST', body: { name } });
    tt('role created'); renderView();
  };
  v.onclick = e => {
    const b = e.target.closest('.ibtn'); if (!b) return;
    const rid = b.closest('[data-rid]').dataset.rid;
    const role = roles.find(r => r.id === rid);
    if (b.dataset.a === 'perms') openRolePerms(role, v);
    if (b.dataset.a === 'edit') openRoleEdit(role, v);
  };
}
function openRoleEdit(role, v) {
  const m = modal('role · ' + role.name, `<div class="field"><label>name</label><input id="_rn" value="${esc(role.name)}"></div>
    <div class="field"><label>color (hex)</label><input id="_rc" value="${role.color ? '#' + role.color.toString(16).padStart(6, '0') : ''}" placeholder="#rrggbb"></div>
    <label class="rc"><input type="checkbox" id="_rh" ${role.hoist ? 'checked' : ''}> show separately in member list</label>`,
    `<button class="btn primary" data-ok>${ic('save', 13)}<span>save</span></button><button class="btn danger" data-del>delete</button>`);
  m.el.querySelector('[data-ok]').onclick = async () => {
    const hex = m.el.querySelector('#_rc').value.trim();
    const color = hex ? parseInt(hex.replace('#', ''), 16) : 0;
    await bapi(`/discord/guilds/${W.guild.id}/roles/${role.id}`, { method: 'PATCH', body: {
      name: m.el.querySelector('#_rn').value || role.name, color, hoist: m.el.querySelector('#_rh').checked } });
    tt('saved'); m.close(); renderView();
  };
  m.el.querySelector('[data-del]').onclick = () => confirmModal('delete role', `delete "${role.name}"?`, async () => {
    await bapi(`/discord/guilds/${W.guild.id}/roles/${role.id}`, { method: 'DELETE' }); tt('deleted'); m.close(); renderView();
  });
}
function permTristateHTML(state, bits) {
  return bits.map(([bit, key]) => {
    const st = hasBit(state.allow, bit) ? 'allow' : hasBit(state.deny, bit) ? 'deny' : 'none';
    return `<div class="pg-row"><span>${key}</span><button class="pg-state ${st}" data-bit="${bit}">${st}</button></div>`;
  }).join('');
}
function wireTristate(grid, state, paint) {
  grid.onclick = e => {
    const b = e.target.closest('.pg-state'); if (!b) return;
    const bit = BigInt(b.dataset.bit);
    const cur = hasBit(state.allow, bit) ? 'allow' : hasBit(state.deny, bit) ? 'deny' : 'none';
    const next = cur === 'none' ? 'allow' : cur === 'allow' ? 'deny' : 'none';
    if (next === 'allow') { state.allow |= bit; state.deny &= ~bit; }
    else if (next === 'deny') { state.deny |= bit; state.allow &= ~bit; }
    else { state.allow &= ~bit; state.deny &= ~bit; }
    paint();
  };
}
function openRolePerms(role, v) {
  const state = { allow: BigInt(role.permissions || 0), deny: 0n };
  const m = modal('permissions · ' + role.name, `${searchBox('permFilter', 'filter perms…')}<div id="permGrid" class="perm-grid"></div>`,
    `<button class="btn primary" data-ok>${ic('save', 13)}<span>apply</span></button>`);
  const grid = m.el.querySelector('#permGrid');
  const paint = () => {
    const f = m.el.querySelector('#permFilter').value.toLowerCase();
    const groups = { general: [], text: [], voice: [] };
    for (const [bit, key, scope] of PERM_BITS) {
      if (f && !key.includes(f)) continue;
      const cat = scope === 'G' ? 'general' : scope.includes('T') ? 'text' : 'voice';
      groups[cat].push([bit, key]);
    }
    grid.innerHTML = Object.entries(groups).map(([g, bits]) => `<div class="pg-cat">${g}</div>${permTristateHTML(state, bits)}`).join('');
  };
  wireTristate(grid, state, paint);
  m.el.querySelector('#permFilter').oninput = paint;
  m.el.querySelector('[data-ok]').onclick = async () => {
    await bapi(`/discord/guilds/${W.guild.id}/roles/${role.id}`, { method: 'PATCH', body: { permissions: state.allow.toString() } });
    tt('permissions saved'); m.close();
  };
  paint();
}

/* ---- channels view ---- */
async function viewChannels(v) {
  const chans = await bapi(`/discord/guilds/${W.guild.id}/channels`);
  chans.sort((a, b) => (a.type - b.type) || a.position - b.position);
  const cats = chans.filter(c => c.type === 4);
  const groupRow = cat => {
    const kids = chans.filter(c => c.parent_id === cat.id);
    return `<div class="cat-row" data-cat="${cat.id}"><span class="cat-caret">${ic('caret', 12)}</span><span class="cat-name">${esc(cat.name)}</span><span class="count">${kids.length} ${kids.length === 1 ? 'channel' : 'channels'}</span></div>` +
      `<div class="cat-group" data-catg="${cat.id}">${kids.map(chanRow).join('') || '<div class="empty">empty category</div>'}</div>`;
  };
  const chanRow = c => `<div class="list-item">
    <span class="t">${ic(chanIc(c), 14)} <b>${esc(c.name)}</b>${c.nsfw ? ' <span class="badge off">nsfw</span>' : ''}</span>
    <span class="meta">${c.type === 4 ? '' : `<button class="ibtn" data-a="edit" data-id="${c.id}" title="edit">${ic('edit', 14)}</button><button class="ibtn" data-a="perms" data-id="${c.id}" title="permissions">${ic('shield', 14)}</button><button class="ibtn danger" data-a="del" data-id="${c.id}" title="delete">${ic('trash', 14)}</button>`}</span></div>`;
  v.innerHTML = `<div class="toolbar"><button class="btn primary" id="chNew">${ic('plus', 13)}<span>text</span></button><button class="btn" id="chNewV">${ic('plus', 13)}<span>voice</span></button></div>
  <div class="mem-list">
    ${chans.filter(c => !c.parent_id && c.type !== 4).map(chanRow).join('')}
    ${cats.map(groupRow).join('')}
  </div>`;
  v.querySelectorAll('.cat-row').forEach(cr => {
    cr.onclick = () => {
      const g = v.querySelector(`[data-catg="${cr.dataset.cat}"]`);
      if (g) g.style.display = g.style.display === 'none' ? '' : 'none';
      cr.classList.toggle('shut');
    };
  });
  $('#chNew').onclick = async () => { const n = await promptInput('new text channel', 'name'); if (n) { await bapi(`/discord/guilds/${W.guild.id}/channels`, { method: 'POST', body: { name: n, type: 0 } }); tt('created'); loadChannels().then(renderView); } };
  $('#chNewV').onclick = async () => { const n = await promptInput('new voice channel', 'name'); if (n) { await bapi(`/discord/guilds/${W.guild.id}/channels`, { method: 'POST', body: { name: n, type: 2 } }); tt('created'); loadChannels().then(renderView); } };
  v.onclick = e => {
    const b = e.target.closest('.ibtn'); if (!b) return;
    const c = chans.find(x => x.id === b.dataset.id);
    if (b.dataset.a === 'edit') {
      const m = modal('channel · ' + c.name, `<div class="field"><label>name</label><input id="_cn" value="${esc(c.name)}"></div><div class="field"><label>topic</label><input id="_ct" value="${esc(c.topic || '')}"></div><label class="rc"><input type="checkbox" id="_cnf" ${c.nsfw ? 'checked' : ''}> nsfw</label>`, `<button class="btn primary" data-ok>${ic('save', 13)}<span>save</span></button>`);
      m.el.querySelector('[data-ok]').onclick = async () => {
        await bapi(`/discord/channels/${c.id}`, { method: 'PATCH', body: { name: m.el.querySelector('#_cn').value, topic: m.el.querySelector('#_ct').value || null, nsfw: m.el.querySelector('#_cnf').checked } });
        tt('saved'); m.close(); loadChannels().then(renderView);
      };
    }
    if (b.dataset.a === 'perms') openChanPerms(c);
    if (b.dataset.a === 'del') confirmModal('delete channel', `delete ${c.name}?`, async () => { await bapi(`/discord/channels/${c.id}`, { method: 'DELETE' }); tt('deleted'); loadChannels().then(renderView); });
  };
  async function openChanPerms(c) {
    const fresh = await bapi(`/discord/channels/${c.id}`);
    const ow = Array.isArray(fresh.permission_overwrites) ? fresh.permission_overwrites.map(x => ({ ...x, allow: BigInt(x.allow), deny: BigInt(x.deny) })) : [];
    const m = modal(`perms · ${c.name}`, `
      <div class="field"><label>overwrite for</label><select id="_owtarget">${(W.roles.length ? W.roles : await bapi(`/discord/guilds/${W.guild.id}/roles`)).slice().sort((a, b) => b.position - a.position).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
      ${searchBox('permFilter2', 'filter perms…')}<div id="permGrid2" class="perm-grid"></div>
      <button class="btn" id="_owadd">${ic('plus', 13)}<span>queue overwrite</span></button>
      <div id="_owlist" class="ow-list"></div>`, `<button class="btn primary" data-ok>${ic('save', 13)}<span>save all</span></button>`);
    const grid = m.el.querySelector('#permGrid2');
    let state = { allow: 0n, deny: 0n };
    const paint = () => {
      const f = m.el.querySelector('#permFilter2').value.toLowerCase();
      const scope = { 0: 'T', 5: 'T', 15: 'T', 16: 'T', 2: 'V', 13: 'S' }[c.type] || 'TVS';
      const rows = PERM_BITS.filter(([, , sc]) => sc.includes(scope) || sc.length > 3)
        .filter(([, key]) => !f || key.includes(f));
      grid.innerHTML = permTristateHTML(state, rows);
    };
    wireTristate(grid, state, paint);
    const paintList = () => m.el.querySelector('#_owlist').innerHTML = ow.map((o, i) =>
      `<div class="list-item"><span class="t">${esc((W.roles.find(r => r.id === o.id) || {}).name || o.id)}</span><span class="meta"><button class="ibtn danger" data-rm="${i}">${ic('trash', 13)}</button></span></div>`).join('');
    m.el.querySelector('#permFilter2').oninput = paint;
    m.el.querySelector('#_owadd').onclick = () => {
      const id = m.el.querySelector('#_owtarget').value;
      const ex = ow.find(o => o.id === id);
      if (ex) { ex.allow = state.allow; ex.deny = state.deny; }
      else ow.push({ id, type: 0, allow: state.allow, deny: state.deny });
      state = { allow: 0n, deny: 0n }; paint(); paintList(); tt('overwrite queued');
    };
    m.el.querySelector('#_owlist').onclick = e => {
      const b = e.target.closest('[data-rm]'); if (!b) return;
      ow.splice(+b.dataset.rm, 1); paintList();
    };
    m.el.querySelector('[data-ok]').onclick = async () => {
      await bapi(`/discord/channels/${c.id}`, { method: 'PATCH', body: { permission_overwrites: ow.map(o => ({ id: o.id, type: o.type, allow: o.allow.toString(), deny: o.deny.toString() })) } });
      tt('overwrites saved'); m.close();
    };
    paint(); paintList();
  }
}

/* ---- scheduler ---- */
async function viewScheduler(v) {
  const r = await bapi('/gateway/scheduler/jobs');
  const jobs = r.jobs || [];
  v.innerHTML = `<div class="toolbar"><button class="btn primary" id="jobNew">${ic('plus', 13)}<span>new job</span></button></div>
  <div class="mem-list">${jobs.map(j => `<div class="list-item">
    <span class="t"><b>${esc(j.name)}</b> <span class="count">${esc(j.type === 'send_message' ? 'send' : 'presence')} · every ${everyLabel(j.intervalMs)} · ran ${j.runCount}× · ${esc(j.lastStatus || '—')}</span></span>
    <span class="meta"><button class="ibtn" data-a="toggle" data-id="${j.id}" title="${j.active ? 'pause' : 'resume'}">${ic(j.active ? 'stop' : 'play', 14)}</button><button class="ibtn danger" data-a="del" data-id="${j.id}" title="delete">${ic('trash', 14)}</button></span></div>`).join('') || `<div class="empty">${ic('clock', 14)} no jobs scheduled</div>`}</div>`;
  $('#jobNew').onclick = () => {
    const m = modal('new scheduler job', `
      <div class="field"><label>name</label><input id="_jn" placeholder="daily ping"></div>
      <div class="field"><label>type</label><select id="_jt"><option value="send_message">send message</option><option value="change_presence">change presence</option></select></div>
      <div class="field"><label>channel (send message)</label><select id="_jc">${W.channels.filter(c => c.type === 0 || c.type === 5).map(c => `<option value="${c.id}" ${W.channel?.id === c.id ? 'selected' : ''}>#${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>content</label><div class="cwrap"><textarea id="_jx" rows="2" data-max="${DISCORD_MSG_MAX}" placeholder="repeating message…"></textarea><span class="ccount"></span></div></div>
      <div class="field"><label>status (change presence)</label><select id="_js"><option value="online">online</option><option value="idle">idle</option><option value="dnd">dnd</option><option value="invisible">invisible</option></select></div>
      <div class="field"><label>every</label><select id="_ji"><option value="60000">minute</option><option value="3600000">hour</option><option value="86400000" selected>day</option><option value="604800000">week</option></select></div>`,
      `<button class="btn primary" data-ok>${ic('plus', 13)}<span>create</span></button>`);
    bindCounter(m.el.querySelector('#_jx'));
    m.el.querySelector('[data-ok]').onclick = async () => {
      const type = m.el.querySelector('#_jt').value;
      const id = 'job' + Date.now().toString(36);
      const content = m.el.querySelector('#_jx').value.trim();
      if (type === 'send_message' && content.length > DISCORD_MSG_MAX) return tt('content over 2000 chars', true);
      const body = { name: m.el.querySelector('#_jn').value, type, intervalMs: parseInt(m.el.querySelector('#_ji').value, 10),
        payload: type === 'send_message' ? { channelId: m.el.querySelector('#_jc').value, content } : { botId: W.me.id, status: m.el.querySelector('#_js').value } };
      try {
        await bapi(`/gateway/scheduler/job/${id}`, { method: 'POST', body });
        tt('job created'); m.close(); renderView();
      } catch (e) { tt(e.message, true); }
    };
  };
  v.onclick = e => {
    const b = e.target.closest('.ibtn'); if (!b) return;
    if (b.dataset.a === 'toggle') bapi(`/gateway/scheduler/job/${b.dataset.id}/toggle`, { method: 'POST', body: {} }).then(renderView);
    if (b.dataset.a === 'del') confirmModal('delete job', 'delete this job?', async () => { await bapi(`/gateway/scheduler/job/${b.dataset.id}`, { method: 'DELETE' }); renderView(); });
  };
}
function everyLabel(ms) { return ms >= 604800000 ? Math.round(ms / 604800000) + 'w' : ms >= 86400000 ? Math.round(ms / 86400000) + 'd' : ms >= 3600000 ? Math.round(ms / 3600000) + 'h' : Math.round(ms / 60000) + 'm'; }

/* ---- voice: player card for the connected channel + channel list ---- */
async function viewVoice(v) {
  let st = { connected: false };
  try { st = await bapi(`/gateway/${W.me.id}/voice/status`); } catch {}
  const voiceChans = W.channels.filter(c => c.type === 2 || c.type === 13);
  const cur = st.voice ? voiceChans.find(c => String(c.id) === String(st.voice.channel_id)) : null;
  v.innerHTML = `
  <div class="panel vplayer ${st.voice ? '' : 'idle'}">
    <div class="panel-head"><h2>${ic('speaker', 13)} voice player${st.voice ? ' — #' + esc(cur?.name || st.voice.channel_name || st.voice.channel_id) : ''}</h2>
      <span class="badge ${st.playing ? 'on' : 'off'}">${st.playing ? 'playing' : 'idle'}</span></div>
    <div class="panel-body">
      <div class="vp-meta">${st.playing ? ic('play', 26) : ic('speaker', 26)}<div><b>${st.playing ? esc(st.track || 'audio stream') : st.voice ? 'connected — nothing queued' : 'idle — join a channel to stream'}</b><span class="count">${st.playing ? 'streaming to voice' : st.voice ? 'pick a file below or join another channel' : ''}</span></div></div>
      <div class="btn-row">
        <button class="btn primary" id="vPlay2" ${st.voice ? '' : 'disabled'}>${ic('play', 13)}<span>play file</span></button>
        <button class="btn danger" id="vStop2" ${st.playing ? '' : 'disabled'}>${ic('stop', 13)}<span>stop</span></button>
        <button class="btn danger" id="vLeave2" ${st.voice ? '' : 'disabled'}>${ic('x', 13)}<span>disconnect</span></button>
      </div>
      <div class="hint">audio is transcoded to ogg/opus by the bridge (ffmpeg) and streamed over UDP</div>
    </div>
  </div>
  <div class="toolbar"><span class="count">voice channels</span><span class="spacer"></span><button class="ibtn" id="vsRefresh" title="refresh">${ic('refresh', 15)}</button></div>
  <div class="mem-list">${voiceChans.map(c => {
    const here = st.voice && String(c.id) === String(st.voice.channel_id);
    return `<div class="list-item ${here ? 'sel-row' : ''}">
    <span class="t">${ic('speaker', 14)} <b>${esc(c.name)}</b></span>
    <span class="meta">${here ? '' : `<button class="mic" data-a="join" data-id="${c.id}" title="join ${esc(c.name)}"><span>join</span></button>`}<button class="ibtn" data-a="play" data-id="${c.id}" title="play a file here">${ic('play', 14)}</button></span></div>`;
  }).join('') || `<div class="empty">${ic('speaker', 14)} no voice channels visible</div>`}</div>
  <input type="file" id="vFile" accept="audio/*,video/*" hidden>`;
  $('#vsRefresh').onclick = renderView;
  const doLeave = () => bapi(`/gateway/${W.me.id}/voice/leave`, { method: 'POST', body: {} }).then(() => { tt('disconnected'); renderView(); }).catch(e => tt(e.message, true));
  const doStop = () => bapi(`/gateway/${W.me.id}/voice/stop`, { method: 'POST', body: {} }).then(() => { tt('stopped'); renderView(); }).catch(e => tt(e.message, true));
  bindIf2(v, 'vLeave2', doLeave); bindIf2(v, 'vStop2', doStop);
  const pickFile = cid => {
    $('#vFile').onchange = async ev => {
      const f = ev.target.files[0]; if (!f) return;
      if (f.size > 18 * 1024 * 1024) { tt('file too large (>18MB)', true); ev.target.value = ''; return; }
      const rd = new FileReader();
      rd.onload = async () => {
        tt('uploading + transcoding…');
        try {
          const u8 = new Uint8Array(rd.result);
          let bin = '';
          for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
          await bapi(`/gateway/${W.me.id}/connect`, { method: 'POST', body: {} }).catch(() => {});
          await bapi(`/gateway/${W.me.id}/voice/play`, { method: 'POST', body: { guild_id: W.guild.id, channel_id: cid, audio_base64: btoa(bin), filename: f.name } });
          tt('playing ' + f.name); renderView();
        } catch (err) { tt(err.message, true); }
      };
      rd.readAsArrayBuffer(f);
      ev.target.value = '';
    };
    $('#vFile').click();
  };
  v.onclick = async e => {
    const b = e.target.closest('.ibtn[data-join],.ibtn[data-play]'); if (!b) return;
    const cid = b.dataset.id;
    if (b.dataset.a === 'join') {
      tt('connecting…');
      await bapi(`/gateway/${W.me.id}/connect`, { method: 'POST', body: {} }).catch(() => {});
      try { await bapi(`/gateway/${W.me.id}/voice/join`, { method: 'POST', body: { guild_id: W.guild.id, channel_id: cid } }); tt('joined'); renderView(); }
      catch (err) { tt(err.message, true); }
    }
    if (b.dataset.a === 'play') pickFile(cid);
  };
  if ($('#vPlay2')) $('#vPlay2').onclick = () => { if (!st.voice) return tt('join a channel first', true); pickFile(cur?.id || st.voice.channel_id); };
}
function bindIf2(scope, id, fn) { const el = scope.querySelector('#' + id); if (el) el.onclick = fn; }

/* ---- backups ---- */
async function viewBackups(v) {
  const r = await fetch('/api/backups').then(x => x.json());
  const chans = W.channels.filter(c => c.type === 0 || c.type === 5);
  v.innerHTML = `<div class="toolbar"><select id="bkChan">${chans.map(c => `<option value="${c.id}">#${esc(c.name)}</option>`).join('')}</select>
    <button class="btn primary" id="bkOne">${ic('download', 13)}<span>backup channel</span></button>
    <button class="btn" id="bkAll">${ic('download', 13)}<span>backup ALL</span></button><span class="count" id="bkProg"></span></div>
  <div class="mem-list">${(r.items || []).map(b => `<div class="list-item">
    <span class="t">${ic('file', 13)} ${esc(b.name)}</span>
    <span class="meta"><span class="sz">${(b.size / 1024).toFixed(0)}KB</span><span class="src">${esc(b.src)}</span><span class="tm">${new Date(b.mtime).toLocaleString()}</span><a class="ibtn" href="/api/backups/file/${encodeURIComponent(b.name)}" download title="download">${ic('download', 14)}</a></span></div>`).join('') || `<div class="empty">${ic('file', 14)} no backups on disk</div>`}</div>`;
  $('#bkOne').onclick = async () => {
    const id = $('#bkChan').value; if (!id) return;
    $('#bkProg').textContent = 'backing up…';
    try {
      const res = await bapi(`/gateway/backup/channel/${id}`, { method: 'POST', body: {} });
      tt(`backup: ${res.messageCount} messages → ${res.filename}`);
    } catch (e) { tt(e.message, true); }
    $('#bkProg').textContent = ''; renderView();
  };
  $('#bkAll').onclick = () => confirmModal('backup all channels', `archive every text channel of "${W.guild.name}" (slow, rate-limit safe)?`, async () => {
    let done = 0;
    for (const c of chans) {
      $('#bkProg').textContent = `${++done}/${chans.length} · #${c.name}`;
      try { await bapi(`/gateway/backup/channel/${c.id}`, { method: 'POST', body: {} }); } catch (e) { /* keep going */ }
      await new Promise(r => setTimeout(r, 700));
    }
    tt('guild backup done'); $('#bkProg').textContent = ''; renderView();
  });
}

/* ---- wire into panel tabs ---- */
window.crWorkspace = {
  mount: mountWorkspace,
  reload: () => { if (W.me) { renderView(); loadChannels(); } },
  get me() { return W.me; },
};
})();
