#!/usr/bin/env bash
# pg-create.sh: Create a PostgreSQL database
# Usage: pg-create.sh -c <container> -d <database>

set -euo pipefail

PG_EXEC_SH="$(dirname "${BASH_SOURCE[0]}")/pg-exec.sh"
if [[ ! -f "$PG_EXEC_SH" ]]; then
  echo "[pg-create] ERROR: ${PG_EXEC_SH} not found (it must sit next to this script)." >&2
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

echo "[pg-create] Creating database '${DATABASE}' on container '${CONTAINER}'..."

pg_docker_exec "${CONTAINER}" psql -d postgres -c \
  "CREATE DATABASE \"${DATABASE}\";"

echo "[pg-create] Done."

