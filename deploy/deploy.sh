#!/usr/bin/env bash
# Ship XPoke to your server and restart it. Usage: XPOKE_HOST=root@your-server deploy/deploy.sh
# Touches only /root/xpoke and xpoke.service. The Caddy vhost is added once by hand (deploy/Caddyfile.snippet).
set -euo pipefail
HOST="${XPOKE_HOST:?set XPOKE_HOST=user@your-server}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

(cd server && node --import tsx --test test/*.test.ts >/dev/null && npx tsc --noEmit)   # a failure stops the deploy
(cd web && npm run build >/dev/null)

# whole directories, never a hand-written file list
ssh "$HOST" "mkdir -p /root/xpoke/server /root/xpoke/web/dist"
# ⚠ excludes are anchored with /: a bare "data" also matched src/data and shipped a server with no Pokédex
rsync -az --delete \
  --exclude /node_modules --exclude /data --exclude /.env --exclude /data-src --exclude .git \
  "$DIR/server/" "$HOST:/root/xpoke/server/"
rsync -az --delete "$DIR/web/dist/" "$HOST:/root/xpoke/web/dist/"
scp -q "$DIR/deploy/xpoke.service" "$DIR/deploy/xpoke-backup.service" "$DIR/deploy/xpoke-backup.timer" "$HOST:/etc/systemd/system/"

ssh "$HOST" 'set -e; cd /root/xpoke/server
  test -f .env || { echo "missing /root/xpoke/server/.env"; exit 1; }
  grep -q "^DEV_MODE=1" .env && { echo "DEV_MODE=1 in production .env, refusing"; exit 1; } || true
  mkdir -p data && chmod 700 data
  npm install --no-audit --no-fund >/dev/null
  systemctl daemon-reload
  systemctl enable xpoke >/dev/null
  systemctl enable --now xpoke-backup.timer >/dev/null
  systemctl restart xpoke   # restart, never enable --now: that can leave an old process running
  for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:5340/api/config && break; sleep 1; done
  systemctl is-active xpoke
  curl -sf http://127.0.0.1:5340/api/agent/status; echo
  curl -s -o /dev/null -w "/ -> %{http_code}\n" http://127.0.0.1:5340/
  curl -s -o /dev/null -w "/api/nope -> %{http_code} (want 404)\n" http://127.0.0.1:5340/api/nope'
echo deployed
