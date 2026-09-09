/* controlroom — discord workspace: full bridge feature set, native UI.
   all calls go through /api/bridge/* ; nonce + bot token handled server-side. */
(() => {
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tt = (msg, err) => window.crToast ? window.crToast(msg, err) : alert(msg);
const API = '/api/bridge';

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
  me: null,             // whoami bot user
  guilds: [],           // guild list
  guild: null,          // selected guild object
  channels: [],
  channel: null,
  messages: [],
  members: new Map(),   // uid -> member
  roles: [],
  view: 'chat',         // chat | members | roles | channels | scheduler | voice | backups
  loading: false,
};

/* ---- permission bits (ported from bridge www/app.js — official table) ---- */
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
const avatarUrl = (u) => u?.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : 'data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2764%27 height=%2764%27><rect width=%2764%27 height=%2764%27 fill=%27%23232c40%27/><text x=%2732%27 y=%2740%27 font-size=%2726%27 text-anchor=%27middle%27 fill=%27%237d8aa5%27>?</text></svg>';

/* ---- dom helpers (panel-consistent) ---- */
function modal(title, bodyHTML, footHTML = '') {
  const bg = document.createElement('div');
  bg.className = 'cr-modal-bg';
  bg.innerHTML = `<div class="cr-modal"><div class="cr-modal-head"><h3>${esc(title)}</h3><button class="ghost-btn cr-x">✕</button></div><div class="cr-modal-body">${bodyHTML}</div>${footHTML ? `<div class="cr-modal-foot">${footHTML}</div>` : ''}</div>`;
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

/* ==== rendering: shell of the workspace tab ==== */
function wsShell() {
  return `
  <div class="ws-subtabs" id="wsSubtabs">
    <button class="st active" data-v="chat">chat</button>
    <button class="st" data-v="members">members</button>
    <button class="st" data-v="roles">roles</button>
    <button class="st" data-v="channels">channels</button>
    <button class="st" data-v="scheduler">scheduler</button>
    <button class="st" data-v="voice">voice</button>
    <button class="st" data-v="backups">backups</button>
  </div>
  <div class="ws">
    <aside class="ws-side" id="wsSide">
      <div class="ws-side-top">
        <select id="wsGuild" class="ws-guildsel"></select>
        <button class="mic ws-toggle" id="wsChanToggle" title="toggle channels">☰</button>
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
  if (sv) { W.view = sv; host.innerHTML = wsShell(); $$('#wsSubtabs .st').forEach(x => x.classList.toggle('active', x.dataset.v === sv)); }
  else host.innerHTML = wsShell();
  $('#wsSubtabs').onclick = e => {
    const b = e.target.closest('.st'); if (!b) return;
    $$('#wsSubtabs .st').forEach(x => x.classList.toggle('active', x === b));
    W.view = b.dataset.v; renderView();
  };
  $('#wsGuild').onchange = e => selectGuild(e.target.value);
  const side = $('#wsSide');
  if (innerWidth <= 800) side.classList.add('collapsed');
  $('#wsChanToggle').onclick = () => side.classList.toggle('collapsed');
  $('#wsChanToggle').title = 'toggle channels';
  let guilds;
  try { guilds = await loadGuilds(); }
  catch (err) { host.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty">${esc(err.message)}</div></div></div>`; return; }
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
  const el = $('#wsChans');
  if (!el) return;
  const cats = W.channels.filter(c => c.type === 4);
  const rows = [];
  for (const c of W.channels) {
    if (c.type === 4 || !c.parent_id) continue;
    const icon = { 0: '#', 2: '♪', 4: '', 5: '‼', 13: '◎', 15: '▶' }[c.type] || '·';
    rows.push(`<div class="chan ${W.channel?.id === c.id ? 'sel' : ''}" data-id="${c.id}"><span class="ci">${icon}</span><span class="cn">${esc(c.name)}</span></div>`);
  }
  el.innerHTML = rows.join('') || '<div class="empty">no channels visible</div>';
  el.onclick = e => {
    const d = e.target.closest('.chan'); if (!d) return;
    W.channel = W.channels.find(c => c.id === d.dataset.id);
    $$('#wsChans .chan').forEach(x => x.classList.toggle('sel', x === d));
    renderView();
  };
}

/* ==== views ==== */
async function renderView() {
  const v = $('#wsView'); if (!v) return;
  v.innerHTML = '<div class="empty">loading…</div>';
  try {
    ({ chat: viewChat, members: viewMembers, roles: viewRoles, channels: viewChannels,
       scheduler: viewScheduler, voice: viewVoice, backups: viewBackups }[W.view])(v);
  } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ---- chat ---- */
async function viewChat(v) {
  if (!W.channel) return v.innerHTML = '<div class="empty">select a text channel</div>';
  v.innerHTML = `<div class="chat">
    <div class="chat-head"><b>#${esc(W.channel.name)}</b>
      <span class="count">id ${esc(W.channel.id)}</span>
      <button class="ghost-btn" id="chReload">reload</button>
      <button class="ghost-btn" id="chPurge" title="bulk-delete bot messages">purge-bot</button>
    </div>
    <div class="msgs" id="msgs"><div class="empty">loading…</div></div>
    <div class="composer">
      <textarea id="cmsg" rows="2" placeholder="message to #${esc(W.channel.name)}…"></textarea>
      <label class="ghost-btn file-btn">📎<input type="file" id="cfile" hidden></label>
      <button class="btn primary" id="csend">send</button>
    </div>
  </div>`;
  const doLoad = async () => {
    const msgs = await bapi(`/discord/channels/${W.channel.id}/messages?limit=100`);
    W.messages = Array.isArray(msgs) ? msgs.reverse() : [];
    paintMsgs();
  };
  $('#chReload').onclick = doLoad;
  $('#chPurge').onclick = () => confirmModal('purge bot messages', `delete every message authored by ${W.me.username} in #${W.channel.name}?`, bulkDeleteBot);
  await doLoad();
  $('#csend').onclick = sendCurrent;
  $('#cmsg').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); } });
  $('#cfile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer())));
    try {
      await bapi(`/discord/channels/${W.channel.id}/messages`, { method: 'POST', body: {
        content: $('#cmsg').value || undefined,
        attachments: [{ id: '0', filename: f.name, description: null, content_bytes: b64 }] } });
      $('#cmsg').value = ''; tt('uploaded'); doLoad();
    } catch (err) { tt(err.message, true); }
    e.target.value = '';
  };
  function paintMsgs() {
    const el = $('#msgs');
    el.innerHTML = W.messages.map(m => {
      const bot = m.author?.id === W.me.id;
      const atts = (m.attachments || []).map(a => a.image ? `<a href="${esc(a.url)}" target="_blank"><img class="att-img" src="${esc(a.url)}?width=320" loading="lazy"></a>` : `<span class="att-chip">${esc(a.filename)}</span>`).join(' ');
      return `<div class="msg ${bot ? 'own' : ''}" data-id="${m.id}">
        <img class="m-av" src="${esc(avatarUrl(m.author))}" loading="lazy">
        <div class="m-body">
          <div class="m-top"><b>${esc(m.author?.username || '?')}</b><span class="m-t">${new Date(m.timestamp).toLocaleTimeString()}</span>
            <span class="m-acts"><button class="mic" data-a="reply">↩</button>${bot ? '<button class="mic" data-a="del">🗑</button>' : ''}</span></div>
          <div class="m-txt">${esc(m.content || '')} ${atts}</div>
        </div></div>`;
    }).join('') || '<div class="empty">no messages</div>';
    el.onclick = async e => {
      const b = e.target.closest('.mic'); if (!b) return;
      const mid = b.closest('.msg').dataset.id;
      if (b.dataset.a === 'del') confirmModal('delete message', 'delete this message?', async () => { await bapi(`/discord/channels/${W.channel.id}/messages/${mid}`, { method: 'DELETE' }); tt('deleted'); doLoad(); });
      if (b.dataset.a === 'reply') { $('#cmsg').dataset.reply = mid; $('#cmsg').placeholder = 'replying to ' + mid + '…'; $('#cmsg').focus(); }
    };
    el.scrollTop = el.scrollHeight;
  }
  async function sendCurrent() {
    const content = $('#cmsg').value.trim(); if (!content) return;
    const body = { content };
    if ($('#cmsg').dataset.reply) body.message_reference = { message_id: $('#cmsg').dataset.reply };
    await bapi(`/discord/channels/${W.channel.id}/messages`, { method: 'POST', body });
    $('#cmsg').value = ''; delete $('#cmsg').dataset.reply; $('#cmsg').placeholder = `message to #${W.channel.name}…`;
    doLoad();
  }
  async function bulkDeleteBot() {
    const ids = W.messages.filter(m => m.author?.id === W.me.id).map(m => m.id);
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
  v.innerHTML = `<div class="toolbar"><input id="memFilter" placeholder="filter by name…"><span class="count" id="memCount"></span></div><div id="memList" class="mem-list"><div class="empty">loading…</div></div>`;
  const render = () => {
    const f = $('#memFilter').value.toLowerCase();
    const arr = [...W.members.values()].filter(mb => !f || mb.user?.username?.toLowerCase().includes(f) || (mb.nick || '').toLowerCase().includes(f));
    $('#memCount').textContent = arr.length + ' / ' + W.members.size;
    $('#memList').innerHTML = arr.slice(0, 300).map(mb => {
      const roles = (mb.roles || []).map(r => W.roles.find(x => x.id === r)?.name).filter(Boolean);
      return `<div class="list-item" data-uid="${mb.user.id}">
        <span class="t"><img class="m-av sm" src="${esc(avatarUrl(mb.user))}" loading="lazy"> <b>${esc(mb.nick || mb.user.username)}</b> <span class="count">${esc(roles.slice(0, 3).join(', ') || 'no roles')}</span></span>
        <span class="meta"><button class="mic" data-a="edit">edit</button></span></div>`;
    }).join('') || '<div class="empty">no matches</div>';
  };
  $('#memFilter').oninput = render;
  $('#memList').onclick = e => {
    const b = e.target.closest('[data-a="edit"]'); if (!b) return;
    openMemberEditor(b.closest('.list-item').dataset.uid);
  };
  if (!W.members.size) {
    W.roles = await bapi(`/discord/guilds/${W.guild.id}/roles`);
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
      `<button class="btn primary" data-save>save</button>
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
  v.innerHTML = `<div class="toolbar"><button class="btn" id="roleNew">+ new role</button></div><div class="mem-list">${
    roles.map(r => `<div class="list-item" data-rid="${r.id}">
      <span class="t"><i class="dot" style="background:${r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'var(--fg3)'}"></i> <b style="color:${r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'inherit'}">${esc(r.name)}</b> <span class="count">${hasBit(r.permissions, 8n) ? '⚠ admin · ' : ''}${r.hoist ? 'separate · ' : ''}pos ${r.position}${r.managed ? ' · managed' : ''}</span></span>
      <span class="meta">${r.id === W.guild.id ? '' : '<button class="mic" data-a="perms">perms</button><button class="mic" data-a="edit">edit</button>'}</span></div>`).join('')
  }</div>`;
  $('#roleNew').onclick = async () => {
    const name = await promptInput('new role', 'name'); if (!name) return;
    await bapi(`/discord/guilds/${W.guild.id}/roles`, { method: 'POST', body: { name } });
    tt('role created'); renderView();
  };
  v.onclick = e => {
    const b = e.target.closest('.mic'); if (!b) return;
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
    `<button class="btn primary" data-ok>save</button><button class="btn danger" data-del>delete</button>`);
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
function openRolePerms(role, v) {
  const state = { allow: BigInt(role.permissions || 0), deny: 0n };
  const m = modal('permissions · ' + role.name, `
    <input id="permFilter" placeholder="filter perms…" style="margin-bottom:8px">
    <div id="permGrid" class="perm-grid"></div>`,
    `<button class="btn primary" data-ok>apply</button>`);
  const grid = m.el.querySelector('#permGrid');
  const paint = () => {
    const f = m.el.querySelector('#permFilter').value.toLowerCase();
    const groups = { general: [], text: [], voice: [] };
    for (const [bit, key, scope] of PERM_BITS) {
      if (f && !key.includes(f)) continue;
      const cat = scope === 'G' ? 'general' : scope.includes('T') ? 'text' : 'voice';
      groups[cat].push([bit, key]);
    }
    grid.innerHTML = Object.entries(groups).map(([g, bits]) => `
      <div class="pg-cat">${g}</div>${bits.map(([bit, key]) => {
        const st = hasBit(state.allow, bit) ? 'allow' : hasBit(state.deny, bit) ? 'deny' : 'none';
        return `<div class="pg-row"><span>${key}</span><button class="pg-state ${st}" data-bit="${bit}">${st}</button></div>`;
      }).join('')}`).join('');
  };
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
  m.el.querySelector('#permFilter').oninput = paint;
  m.el.querySelector('[data-ok]').onclick = async () => {
    await bapi(`/discord/guilds/${W.guild.id}/roles/${role.id}`, { method: 'PATCH', body: { permissions: state.allow.toString() } });
    tt('permissions saved'); m.close();
  };
  paint();
}

/* ---- channels view (create/edit/perms/delete) ---- */
async function viewChannels(v) {
  const chans = await bapi(`/discord/guilds/${W.guild.id}/channels`);
  chans.sort((a, b) => (a.type - b.type) || a.position - b.position);
  v.innerHTML = `<div class="toolbar"><button class="btn" id="chNew">+ text channel</button><button class="btn" id="chNewV">+ voice channel</button></div>
  <div class="mem-list">${chans.map(c => `<div class="list-item">
    <span class="t">${{0:'#',2:'♪',4:'▦',5:'‼',13:'◎'}[c.type] || '·'} <b>${esc(c.name)}</b> <span class="count">${c.type === 4 ? 'category' : 'type ' + c.type} ${c.parent_id ? '· in ' + esc(chans.find(x => x.id === c.parent_id)?.name || '') : ''} ${c.nsfw ? '· nsfw' : ''}</span></span>
    <span class="meta">${c.type === 4 ? '' : `<button class="mic" data-a="edit" data-id="${c.id}">edit</button><button class="mic" data-a="perms" data-id="${c.id}">perms</button><button class="mic" data-a="del" data-id="${c.id}">✕</button>`}</span></div>`).join('')}</div>`;
  $('#chNew').onclick = async () => { const n = await promptInput('new text channel', 'name'); if (n) { await bapi(`/discord/guilds/${W.guild.id}/channels`, { method: 'POST', body: { name: n, type: 0 } }); tt('created'); loadChannels().then(renderView); } };
  $('#chNewV').onclick = async () => { const n = await promptInput('new voice channel', 'name'); if (n) { await bapi(`/discord/guilds/${W.guild.id}/channels`, { method: 'POST', body: { name: n, type: 2 } }); tt('created'); loadChannels().then(renderView); } };
  v.onclick = e => {
    const b = e.target.closest('.mic'); if (!b) return;
    const c = chans.find(x => x.id === b.dataset.id);
    if (b.dataset.a === 'edit') {
      const m = modal('channel · #' + c.name, `<div class="field"><label>name</label><input id="_cn" value="${esc(c.name)}"></div><div class="field"><label>topic</label><input id="_ct" value="${esc(c.topic || '')}"></div><label class="rc"><input type="checkbox" id="_cnf" ${c.nsfw ? 'checked' : ''}> nsfw</label>`, `<button class="btn primary" data-ok>save</button>`);
      m.el.querySelector('[data-ok]').onclick = async () => {
        await bapi(`/discord/channels/${c.id}`, { method: 'PATCH', body: { name: m.el.querySelector('#_cn').value, topic: m.el.querySelector('#_ct').value || null, nsfw: m.el.querySelector('#_cnf').checked } });
        tt('saved'); m.close(); loadChannels().then(renderView);
      };
    }
    if (b.dataset.a === 'perms') openChanPerms(c, chans);
    if (b.dataset.a === 'del') confirmModal('delete channel', `delete #${c.name}?`, async () => { await bapi(`/discord/channels/${c.id}`, { method: 'DELETE' }); tt('deleted'); loadChannels().then(renderView); });
  };
  async function openChanPerms(c, allChans) {
    const fresh = await bapi(`/discord/channels/${c.id}`);
    const ow = Array.isArray(fresh.permission_overwrites) ? fresh.permission_overwrites.map(x => ({ ...x, allow: BigInt(x.allow), deny: BigInt(x.deny) })) : [];
    const m = modal('channel perms · #' + c.name, `
      <div class="field"><label>overwrite for</label><select id="_owtarget">${W.roles.slice().sort((a, b) => b.position - a.position).map(r => `<option value="${r.id}" data-t="role">${esc(r.name)}</option>`).join('')}</select></div>
      <input id="permFilter2" placeholder="filter perms…" style="margin:8px 0"><div id="permGrid2" class="perm-grid"></div>
      <button class="btn" id="_owadd">apply to selected</button>
      <div id="_owlist" class="ow-list"></div>`, `<button class="btn primary" data-ok>save all</button>`);
    const grid = m.el.querySelector('#permGrid2');
    let state = { allow: 0n, deny: 0n };
    const paint = () => {
      const f = m.el.querySelector('#permFilter2').value.toLowerCase();
      const scope = { 0: 'T', 5: 'T', 15: 'T', 16: 'T', 2: 'V', 13: 'S' }[c.type] || 'TVS';
      const rows = PERM_BITS.filter(([bit, key, sc]) => sc.includes(scope) || sc.length > 3)
        .filter(([bit, key]) => !f || key.includes(f));
      grid.innerHTML = rows.map(([bit, key]) => {
        const st = hasBit(state.allow, bit) ? 'allow' : hasBit(state.deny, bit) ? 'deny' : 'none';
        return `<div class="pg-row"><span>${key}</span><button class="pg-state ${st}" data-bit="${bit}">${st}</button></div>`;
      }).join('');
    };
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
    const paintList = () => m.el.querySelector('#_owlist').innerHTML = ow.map((o, i) =>
      `<div class="list-item"><span class="t">${esc(W.roles.find(r => r.id === o.id)?.name || o.id)}</span><span class="meta"><button class="mic" data-rm="${i}">remove</button></span></div>`).join('');
    m.el.querySelector('#permFilter2').oninput = paint;
    m.el.querySelector('#_owadd').onclick = () => {
      const sel = m.el.querySelector('#_owtarget');
      const id = sel.value;
      const ex = ow.find(o => o.id === id);
      if (ex) { ex.allow = state.allow; ex.deny = state.deny; }
      else ow.push({ id, type: 0, allow: state.allow, deny: state.deny });
      state = { allow: 0n, deny: 0n }; paint(); paintList(); tt('queued overwrite');
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
  v.innerHTML = `<div class="toolbar"><button class="btn" id="jobNew">+ new job</button></div>
  <div class="mem-list">${jobs.map(j => `<div class="list-item">
    <span class="t"><b>${esc(j.name)}</b> <span class="count">${esc(j.type)} · every ${everyLabel(j.intervalMs)} · runs ${j.runCount} · ${j.lastStatus || '—'} ${j.payload?.channelId ? '· ch ' + esc(String(j.payload.channelId).slice(-6)) : ''}</span></span>
    <span class="meta"><button class="mic" data-a="toggle" data-id="${j.id}">${j.active ? 'pause' : 'resume'}</button><button class="mic" data-a="del" data-id="${j.id}">✕</button></span></div>`).join('') || '<div class="empty">no jobs</div>'}</div>`;
  $('#jobNew').onclick = () => {
    const m = modal('new scheduler job', `
      <div class="field"><label>name</label><input id="_jn" placeholder="daily ping"></div>
      <div class="field"><label>type</label><select id="_jt"><option value="send_message">send_message</option><option value="change_presence">change_presence</option></select></div>
      <div class="field"><label>channel id (send_message)</label><input id="_jc" value="${esc(W.channel?.id || '')}"></div>
      <div class="field"><label>content (send_message)</label><textarea id="_jx" rows="2" placeholder="repeating message…"></textarea></div>
      <div class="field"><label>presence status (change_presence)</label><select id="_js"><option value="online">online</option><option value="idle">idle</option><option value="dnd">dnd</option><option value="invisible">invisible</option></select></div>
      <div class="field"><label>every</label><select id="_ji"><option value="60000">minute</option><option value="3600000">hour</option><option value="86400000" selected>day</option><option value="604800000">week</option></select></div>`,
      `<button class="btn primary" data-ok>create</button>`);
    m.el.querySelector('[data-ok]').onclick = async () => {
      const type = m.el.querySelector('#_jt').value;
      const id = 'job' + Date.now().toString(36);
      const body = { name: m.el.querySelector('#_jn').value, type, intervalMs: parseInt(m.el.querySelector('#_ji').value, 10),
        payload: type === 'send_message' ? { channelId: m.el.querySelector('#_jc').value, content: m.el.querySelector('#_jx').value } : { botId: W.me.id, status: m.el.querySelector('#_js').value } };
      if (type === 'send_message' && !body.payload.channelId) return tt('channel id required', true);
      await bapi(`/gateway/scheduler/job/${id}`, { method: 'POST', body });
      tt('job created'); m.close(); renderView();
    };
  };
  v.onclick = e => {
    const b = e.target.closest('.mic'); if (!b) return;
    if (b.dataset.a === 'toggle') bapi(`/gateway/scheduler/job/${b.dataset.id}/toggle`, { method: 'POST' }).then(renderView);
    if (b.dataset.a === 'del') confirmModal('delete job', 'delete this job?', async () => { await bapi(`/gateway/scheduler/job/${b.dataset.id}`, { method: 'DELETE' }); renderView(); });
  };
}
function everyLabel(ms) { return ms >= 604800000 ? Math.round(ms / 604800000) + 'w' : ms >= 86400000 ? Math.round(ms / 86400000) + 'd' : ms >= 3600000 ? Math.round(ms / 3600000) + 'h' : Math.round(ms / 60000) + 'm'; }

/* ---- voice ---- */
async function viewVoice(v) {
  const st = await bapi(`/gateway/${W.me.id}/voice/status`).catch(() => ({ connected: false }));
  const voiceChans = W.channels.filter(c => c.type === 2 || c.type === 13);
  v.innerHTML = `<div class="toolbar"><span class="count">gateway ${st.connected ? 'connected' : 'DOWN'} · voice ${st.voice ? 'in #' + esc(st.voice.channel_name || st.voice.channel_id) : 'idle'} ${st.playing ? '· playing' : ''}</span>
    <button class="mic" id="vsRefresh">refresh</button></div>
  <div class="mem-list">${voiceChans.map(c => `<div class="list-item">
    <span class="t">♪ <b>${esc(c.name)}</b></span>
    <span class="meta"><button class="mic" data-a="join" data-id="${c.id}">join</button><button class="mic" data-a="play" data-id="${c.id}">play file</button></span></div>`).join('') || '<div class="empty">no voice channels visible</div>'}</div>
  <div class="btn-row" style="margin-top:10px"><button class="btn danger" id="vLeave">leave voice</button><button class="btn" id="vStop">stop playback</button></div>
  <input type="file" id="vFile" accept="audio/*,video/*" hidden>`;
  $('#vsRefresh').onclick = renderView;
  $('#vLeave').onclick = () => bapi(`/gateway/${W.me.id}/voice/leave`, { method: 'POST', body: {} }).then(() => { tt('left voice'); renderView(); });
  $('#vStop').onclick = () => bapi(`/gateway/${W.me.id}/voice/stop`, { method: 'POST', body: {} }).then(() => { tt('stopped'); renderView(); });
  v.onclick = async e => {
    const b = e.target.closest('.mic[data-join],.mic[data-play]'); if (!b) return;
    const cid = b.dataset.id;
    if (b.dataset.a === 'join') {
      await bapi(`/gateway/${W.me.id}/connect`, { method: 'POST', body: {} }).catch(() => {}); // ensure live session (token injected server-side)
      await bapi(`/gateway/${W.me.id}/voice/join`, { method: 'POST', body: { guild_id: W.guild.id, channel_id: cid } }); tt('joined'); renderView();
    }
    if (b.dataset.a === 'play') {
      await bapi(`/gateway/${W.me.id}/connect`, { method: 'POST', body: {} }).catch(() => {});
      $('#vFile').onchange = async ev => {
        const f = ev.target.files[0]; if (!f) return;
        const rd = new FileReader();
        rd.onload = async () => {
          tt('playing… (transcode may take a few s)');
          try {
            await bapi(`/gateway/${W.me.id}/voice/play`, { method: 'POST', body: { guild_id: W.guild.id, channel_id: cid, audio_base64: btoa(rd.result), filename: f.name } });
            tt('playing ' + f.name); renderView();
          } catch (err) { tt(err.message, true); }
        };
        rd.readAsBinaryString(f);
        ev.target.value = '';
      };
      $('#vFile').click();
    }
  };
}

/* ---- backups ---- */
async function viewBackups(v) {
  const r = await fetch('/api/backups').then(x => x.json());
  const chans = W.channels.filter(c => c.type === 0 || c.type === 5);
  v.innerHTML = `<div class="toolbar"><select id="bkChan">${chans.map(c => `<option value="${c.id}">#${esc(c.name)}</option>`).join('')}</select>
    <button class="btn primary" id="bkOne">backup channel</button>
    <button class="btn" id="bkAll">backup ALL</button><span class="count" id="bkProg"></span></div>
  <div class="mem-list">${(r.items || []).map(b => `<div class="list-item">
    <span class="t">${esc(b.name)}</span>
    <span class="meta"><span class="sz">${(b.size / 1024).toFixed(0)}KB</span><span class="src">${esc(b.src)}</span><span class="tm">${new Date(b.mtime).toLocaleString()}</span><a class="mic" href="/api/backups/file/${encodeURIComponent(b.name)}" download>⬇</a></span></div>`).join('') || '<div class="empty">no backups on disk</div>'}</div>`;
  $('#bkOne').onclick = async () => {
    const id = $('#bkChan').value; if (!id) return;
    $('#bkProg').textContent = 'backing up…';
    const res = await bapi(`/gateway/backup/channel/${id}`, { method: 'POST', body: {} });
    tt(`backup: ${res.messageCount} messages → ${res.filename}`); $('#bkProg').textContent = ''; renderView();
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
