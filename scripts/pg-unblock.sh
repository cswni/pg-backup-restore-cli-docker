#!/usr/bin/env bash
# pg-unblock.sh: Terminate all active connections to a DB
# Usage: pg-unblock.sh -c <container> -d <database>

set -euo pipefail

PG_EXEC_SH="$(dirname "${BASH_SOURCE[0]}")/pg-exec.sh"
if [[ ! -f "$PG_EXEC_SH" ]]; then
  echo "[pg-unblock] ERROR: ${PG_EXEC_SH} not found (it must sit next to this script)." >&2
  exit 1
fi
# shellcheck source=pg-exec.sh
source "$PG_EXEC_SH"

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

pg_docker_exec "${CONTAINER}" psql -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE}' AND pid <> pg_backend_pid();"

echo "[pg-unblock] Done."

