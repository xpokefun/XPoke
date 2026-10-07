#!/usr/bin/env bash
# Launch day: deploy/go-ca.sh <MINT> [--dry] [--no-payouts]
# Runs the checks on the box, creates the pool's token account, switches the shop + wagers on, restarts.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: deploy/go-ca.sh <MINT> [--dry] [--no-payouts]"; exit 1; }
ssh "${XPOKE_HOST:?set XPOKE_HOST=user@your-server}" "set -o pipefail; cd /root/xpoke/server && npm run -s golive -- $* 2>&1 | { grep -v -e ExperimentalWarning -e trace-warnings -e 'bigint: Failed' || true; }"
