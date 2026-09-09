# controlroom

single self-contained web app for running a discord **bot** (vendored bridge manager) and a discord **selfbot** (vendored mercury ambient agent) from one UI: chat, members, roles, channels (+permission editors), scheduler, voice player, channel backups, live logs, config hot-reload.

**the repo is the whole project.** clone it, install, paste tokens, run. there is nothing else to set up.

## quick start

```
git clone https://github.com/CarbonWalls/controlroom.git
cd controlroom
npm i                      # ws, ffmpeg-static, @snazzah/davey for the vendored bridge
cp bridge/.env.example bridge/.env && chmod 600 bridge/.env
#   → edit bridge/.env: TOKEN_BOT=<bot token>   (bot token: discord dev portal)
cp mercury/.env.template mercury/.env && chmod 600 mercury/.env   # optional
#   → mercury/.env: DISCORD_TOKEN=<user token>  (selfbot — ban risk is yours)
./start.sh                 # panel on http://127.0.0.1:8800
```

then open the panel → bridge tab → **start bridge**. that's it: the panel spawns the vendored bridge (port 8789) and drives it — you never touch a second terminal.

## layout

```
server.js            panel (node stdlib only, :8800) — serves UI, proxies bridge, spawns both
bridge/              vendored bot manager (bridge.js + tests + locales + data/ at runtime)
mercury/             vendored selfbot (mercury3.py, config from .template, runtime data here)
www/                 the UI (vanilla js/css, no build step)
```

runtime files created on first run (gitignored): `bridge/.env`, `bridge/data/`, `mercury/.env`, `mercury/config.json`, `mercury/run.log`, `mercury/outbox/`, `.tmp/`.

## env overrides (all optional)

| var | default | what |
|---|---|---|
| `PORT` | 8800 | panel port |
| `BRIDGE_PORT` | 8789 | bridge port |
| `BRIDGE_DIR` | ./bridge | vendored bridge dir |
| `BRIDGE_START` | node bridge.js | bridge launch cmd |
| `BRIDGE_ENV` | ./bridge/.env | bot token file |
| `HUM_DIR` | ./mercury | selfbot dir |

## security notes

- binds 127.0.0.1 only; CSRF/dns-rebind guarded (sec-fetch-site + Host checks)
- bot token + bridge nonce are injected server-side, never sent to the page
- `.env` files are gitignored and never served; providers keys are stripped structurally
- mercury is a selfbot: using a user token violates discord ToS — the ban risk is yours

## legacy

this app replaced two separate projects (`bot-mn-1` bot manager + `hum-testing` selfbot). both are vendored here; the old folders are no longer needed.
