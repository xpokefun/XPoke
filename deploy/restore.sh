#!/usr/bin/env bash
# Restore XPoke's database from a snapshot, on the box.
#   deploy/restore.sh xpoke-2026-10-07T18-17-00-000Z.db.gz          (a file in /root/xpoke-backups on the box)
# Stops xpoke, keeps the current database aside (never deleted), restores, checks it, starts xpoke.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: deploy/restore.sh <snapshot file name in /root/xpoke-backups>"; exit 1; }
ssh "${XPOKE_HOST:?set XPOKE_HOST=user@your-server}" "set -euo pipefail
  snap=/root/xpoke-backups/$1
  test -f \"\$snap\" || { echo \"no snapshot \$snap\"; exit 1; }
  cd /root/xpoke/server/data
  systemctl stop xpoke
  aside=xpoke.db.before-restore-\$(date +%Y%m%d-%H%M%S)
  [ -f xpoke.db ] && mv xpoke.db \"\$aside\" && rm -f xpoke.db-wal xpoke.db-shm && echo \"current database kept as data/\$aside\"
  gunzip -c \"\$snap\" > xpoke.db && chmod 600 xpoke.db
  sqlite3 xpoke.db 'pragma integrity_check; select count(*) || \" trainers\" from trainers;'
  systemctl start xpoke
  sleep 4; systemctl is-active xpoke; curl -s -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:5340/api/health"
