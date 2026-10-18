#!/usr/bin/env bash
# Lægger den committede kode (HEAD) på Linux-serveren og genstarter servicen.
# Brug: ./deploy.sh bruger@server   (eller sæt WHIST_HOST)
# Databasen i data/ på serveren røres ikke.
set -euo pipefail

HOST="${1:-${WHIST_HOST:-}}"
DIR="${WHIST_DIR:-/opt/whist}"

if [ -z "$HOST" ]; then
  echo "Brug: ./deploy.sh bruger@server   (eller sæt WHIST_HOST)" >&2
  exit 1
fi

cd "$(dirname "$0")"
if [ -n "$(git status --porcelain)" ]; then
  echo "Advarsel: der er ændringer, som ikke er committet – de kommer ikke med." >&2
fi

echo "Sender $(git log -1 --format='%h %s') til $HOST:$DIR"
git archive --format=tar.gz HEAD | ssh "$HOST" 'cat > /tmp/whist-deploy.tar.gz'

ssh -t "$HOST" "set -e
  sudo mkdir -p '$DIR'
  sudo tar -xzf /tmp/whist-deploy.tar.gz -C '$DIR'
  rm /tmp/whist-deploy.tar.gz
  sudo chown -R whist: '$DIR'
  cd '$DIR' && sudo -u whist npm ci --omit=dev --no-audit --no-fund
  sudo systemctl restart whist
  sleep 1
  systemctl is-active whist"
