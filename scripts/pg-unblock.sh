#!/usr/bin/env bash
# ============================================================
# pg-unblock.sh  –  Terminate all active connections to a DB
# ============================================================
# Usage: pg-unblock.sh -c <container> -d <database>
# ============================================================

set -euo pipefail

usage() {
  echo "Usage: $0 -c <container> -d <database>"
  exit 1
}

CONTAINER=""
DATABASE=""

while getopts ":c:d:" opt; do
  case $opt in
    c) CONTAINER="$OPTARG" ;;
    d) DATABASE="$OPTARG" ;;
    *) usage ;;
  esac
done

[[ -z "$CONTAINER" || -z "$DATABASE" ]] && usage

echo "[pg-unblock] Terminating all connections to '${DATABASE}' on container '${CONTAINER}'..."

docker exec -u postgres "${CONTAINER}" psql -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();"

echo "[pg-unblock] Done."

