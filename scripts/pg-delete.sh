#!/usr/bin/env bash
# ============================================================
# pg-delete.sh  –  Drop a PostgreSQL database (with FORCE)
# ============================================================
# Usage: pg-delete.sh -c <container> -d <database>
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

echo "[pg-delete] Dropping database '${DATABASE}' on container '${CONTAINER}'..."

docker exec -u postgres "${CONTAINER}" psql -c \
  "DROP DATABASE ${DATABASE} WITH (FORCE);"

echo "[pg-delete] Done."

