# controlroom

unified web panel for two self-hosted discord services on one termux box:

- **mercury** — `~/projects/hum-testing/mercury3.py` (ambient chat selfbot, python)
- **bridge** — `~/projects/bot-mn-1{,-debug}/bridge.js` (bot manager, node, port 8789)

one page: live status of both, start/stop/restart mercury, SSE live log tail,
outbox composer, hot-reloadable config editor, persona notes editor, and a
read-only window into the bridge (health, gateway sessions, rate limits,
scheduler jobs, channel backups) proxied through the panel — the per-boot
bridge nonce and the bot token are handled server-side, never exposed to the page.

## stack

zero dependencies: node >= 18 stdlib server + vanilla js/css frontend.
mobile-first dark terminal aesthetic; tested at 320/390/1280 widths.

## run

```
node server.js            # binds 127.0.0.1:8800
PORT=9000 node server.js  # custom port
```

env overrides: `HUM_DIR`, `BRIDGE_ENV` (path to the bridge's `.env` for the
proxied discord calls), `BRIDGE_PORTS` (comma list to probe, default `8789,8793`).

## security notes

- binds 127.0.0.1 only; nothing listens on the network
- the panel never serves or logs `.env` contents; providers are key-redacted
- config writes are deep-merged and validated (`channel_id` required) before
  touching `config.json`; the mercury watchdog hot-reloads within ~3s
- `/api/bridge/*` attaches the bridge session nonce + bot token server-side

## endpoints

| route | what |
|---|---|
| `GET /api/status` | both services: pid, uptime, mem, bridge health |
| `GET /api/logs?tail=N` · `GET /api/logs/follow` | run.log tail / SSE stream |
| `POST /api/hum/start` · `stop` | lifecycle via flock-detected pid |
| `POST /api/hum/outbox` | queue a .txt for mercury to post |
| `GET/POST /api/hum/config` | config.json editor (deep-merge) |
| `GET/POST /api/hum/memory` | persona notes |
| `GET /api/backups` | channel backups from both bridge clones |
| `ANY /api/bridge/*` | nonce+token-injecting bridge proxy |

?still=1&tab=X forces a static render for headless screenshots.

*the mercury service is a selfbot; account risk is on its owner.*
