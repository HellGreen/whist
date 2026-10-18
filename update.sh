#!/usr/bin/env bash
# Henter den nyeste kode fra GitHub, installerer pakker og genstarter servicen.
# Køres på serveren: sudo /opt/whist/update.sh   (WHIST_BRANCH=gren for at køre en anden gren end main)
# Databasen i data/ røres ikke.
set -euo pipefail

# Alt ligger i en funktion, så bash har læst hele scriptet, før git udskifter filen undervejs.
main() {
  local dir branch
  dir="$(cd "$(dirname "$0")" && pwd)"
  branch="${WHIST_BRANCH:-main}"

  if [ "$(id -u)" -ne 0 ]; then
    echo "Kør med sudo: sudo $0" >&2
    exit 1
  fi

  cd "$dir"
  as_whist() { sudo -u whist -H "$@"; }

  local before
  before="$(as_whist git log -1 --format='%h %s')"
  as_whist git fetch --quiet origin "$branch"
  as_whist git checkout --quiet --force -B "$branch" "origin/$branch"
  echo "Før:  $before"
  echo "Nu:   $(as_whist git log -1 --format='%h %s')"

  as_whist npm ci --omit=dev --no-audit --no-fund
  systemctl restart whist
  sleep 1
  systemctl is-active whist
}

main "$@"
exit
