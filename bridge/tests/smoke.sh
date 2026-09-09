#!/bin/bash
# end-to-end smoke suite for bridge.js.
# usage: BASE_URL=http://127.0.0.1:8789 TEST_TOKEN=<bot token> bash tests/smoke.sh
# TEST_TOKEN must belong to a real bot in a guild with text + voice channels
# (channel ids below are patched automatically from the api when possible).
set -u
B="${BASE_URL:-http://127.0.0.1:8789}"
# token: env wins, otherwise try .env in the repo root
if [ -z "${TEST_TOKEN:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
  TEST_TOKEN=$(grep -m1 '^TOKEN_BOT=' "$(dirname "$0")/../.env" | cut -d= -f2)
fi
if [ -z "${TEST_TOKEN:-}" ]; then echo "no TEST_TOKEN and no .env found"; exit 2; fi

NONCE=$(curl -s "$B/" | grep -o 'x-bridge-nonce" content="[a-f0-9]*' | cut -d'"' -f3)
[ -z "$NONCE" ] && { echo "cannot read nonce from $B — bridge running?"; exit 2; }
TMP="$(dirname "$0")/../.tmp"; mkdir -p "$TMP"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (expected '$2' got '$3')"; fail=$((fail+1)); fi; }

chk health 200 "$(curl -s -o /dev/null -w '%{http_code}' "$B/bridge/health")"
chk nonce-wall-403 403 "$(curl -s -o /dev/null -w '%{http_code}' "$B/gateway/status")"
chk archive-legacy-404 404 "$(curl -s -o /dev/null -w '%{http_code}' "$B/archive/1")"
chk traversal-404 404 "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$B/..%2f..%2f.env")"
chk i18n 200 "$(curl -s -o /dev/null -w '%{http_code}' "$B/i18n/languages")"

curl -s -X POST -H "x-client-nonce: $NONCE" -H "Content-Type: application/json" \
  -d "{\"token\":\"$TEST_TOKEN\"}" "$B/gateway/smoke/connect" > /dev/null
sleep 4
curl -s -H "x-client-nonce: $NONCE" "$B/gateway/status" | grep -q '"connected":true' \
  && chk connect true true || chk connect true false
chk presence 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-client-nonce: $NONCE" -H "Content-Type: application/json" -d '{"status":"idle"}' "$B/gateway/smoke/presence")"

# first text channel the bot can see (for the archive route check)
GUILD=$(curl -s -H "x-client-nonce: $NONCE" -H "x-bot-token: $TEST_TOKEN" "$B/discord/users/@me/guilds" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].id)}catch{console.log('')}})")
CHANNEL=$(curl -s -H "x-client-nonce: $NONCE" -H "x-bot-token: $TEST_TOKEN" "$B/discord/guilds/$GUILD/channels" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const c2=JSON.parse(d).find(c=>c.type===0);console.log(c2?c2.id:'')}catch{console.log('')}})")
if [ -n "$CHANNEL" ]; then
  chk archive-gateway 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "x-client-nonce: $NONCE" "$B/gateway/archive/$CHANNEL")"
fi

chk sched-invalid 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-client-nonce: $NONCE" -H "Content-Type: application/json" -d '{"type":"change_presence","payload":{"botId":"smoke","status":"bogus"}}' "$B/gateway/scheduler/job/smoke-s1")"
chk sched-create 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-client-nonce: $NONCE" -H "Content-Type: application/json" -d '{"type":"change_presence","payload":{"botId":"smoke","status":"dnd"},"intervalMs":60000}' "$B/gateway/scheduler/job/smoke-s1")"
chk sched-toggle 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-client-nonce: $NONCE" "$B/gateway/scheduler/job/smoke-s1/toggle")"
chk sched-delete 200 "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "x-client-nonce: $NONCE" "$B/gateway/scheduler/job/smoke-s1")"

# voice: join the first voice channel of the guild, then leave
VCH=$(curl -s -H "x-client-nonce: $NONCE" -H "x-bot-token: $TEST_TOKEN" "$B/discord/guilds/$GUILD/channels" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const c2=JSON.parse(d).find(c=>c.type===2);console.log(c2?c2.id:'')}catch{console.log('')}})")
if [ -n "$VCH" ]; then
  curl -s -X POST -H "x-client-nonce: $NONCE" -H "Content-Type: application/json" \
    -d "{\"token\":\"$TEST_TOKEN\",\"guild_id\":\"$GUILD\",\"channel_id\":\"$VCH\"}" "$B/gateway/smoke/voice/join" > /dev/null
  sleep 4
  curl -s -H "x-client-nonce: $NONCE" "$B/gateway/smoke/voice/status" | grep -q '"voiceTransportReady":true' \
    && chk voice-ready true true || chk voice-ready true false
  curl -s -X POST -H "x-client-nonce: $NONCE" "$B/gateway/smoke/voice/leave" > /dev/null
fi

# transcode path (local ffmpeg, no discord traffic)
if command -v ffmpeg > /dev/null; then
  ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:duration=0.5" -ar 48000 "$TMP/smoke.wav" 2>/dev/null
  node -e "require('fs').writeFileSync('$TMP/smoke.json', JSON.stringify({audio_base64:require('fs').readFileSync('$TMP/smoke.wav').toString('base64'),filename:'s.wav'}))"
  chk transcode 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-client-nonce: $NONCE" -H "Content-Type: application/json" --data-binary @"$TMP/smoke.json" "$B/gateway/tools/transcode-voice")"
fi

chk disconnect 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-client-nonce: $NONCE" "$B/gateway/smoke/disconnect")"
echo "=== $pass passed, $fail failed ==="
exit $fail
