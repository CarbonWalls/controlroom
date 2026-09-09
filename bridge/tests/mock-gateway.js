// mock discord gateway for testing the bridge's reconnect/heartbeat logic.
// token controls behavior:
//   NORMAL -> READY + heartbeats acked
//   ZOMBIE -> READY but heartbeats never acked (bridge must terminate + reconnect)
//   OP7    -> READY, then op 7 reconnect request, then READY again
//   GHOST  -> READY then close 4000 (must auto-reconnect)
//   FAIL   -> close 4000 immediately, forever (backoff must stay capped, no storm)
const ws = require('ws');
const PORT = parseInt(process.env.MOCK_PORT || '8790', 10);
const wss = new ws.WebSocketServer({ port: PORT });
const seen = []; // event log for assertions
const log = (e) => { seen.push({ t: Date.now(), e }); console.log('[mock]', e); };

wss.on('connection', (ws, req) => {
  log('connect');
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 300 } }));
  let zombie = false;
  ws.on('message', (raw) => {
    const d = JSON.parse(raw.toString());
    if (d.op === 2) {
      const token = String((d.d && d.d.token) || '');
      const botId = 'mock-' + token.toLowerCase();
      log('identify ' + botId);
      if (token === 'FAIL') { ws.close(4000, 'mock fail'); return; }
      ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { user: { id: '999', username: botId, bot: true }, session_id: 's1' } }));
      if (token === 'ZOMBIE') zombie = true;
      if (token === 'OP7') setTimeout(() => { log('send op7'); ws.send(JSON.stringify({ op: 7, d: {} })); }, 500);
      if (token === 'GHOST') setTimeout(() => { log('ghost close 4000'); ws.close(4000, 'ghost'); }, 700);
    } else if (d.op === 1) {
      if (!zombie) ws.send(JSON.stringify({ op: 11 }));
    }
  });
});

require('http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events: seen.slice(-80) }));
}).listen(PORT + 1);

console.log('mock gateway on ws://127.0.0.1:' + PORT);
