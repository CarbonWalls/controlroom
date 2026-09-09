#!/bin/sh
# controlroom launcher — survives terminal/session teardown
cd "$(dirname "$0")" || exit 1
mkdir -p .tmp
if [ -f .tmp/panel.pid ] && kill -0 "$(cat .tmp/panel.pid)" 2>/dev/null; then
  echo "already running (pid $(cat .tmp/panel.pid)) — http://127.0.0.1:${PORT:-8800}"
  exit 0
fi
# --wait keeps the setsid process alive as long as node runs, so $! (stored
# in the pid file) remains a valid liveness handle
setsid --wait node server.js >> .tmp/panel.log 2>&1 &
echo $! > .tmp/panel.pid
echo "started pid $! — http://127.0.0.1:${PORT:-8800} (log: .tmp/panel.log)"
