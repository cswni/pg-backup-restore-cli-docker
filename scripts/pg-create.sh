#!/usr/bin/env bash
# ============================================================
# pg-create.sh  –  Create a PostgreSQL database
# ============================================================
# Usage: pg-create.sh -c <container> -d <database>
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

echo "[pg-create] Creating database '${DATABASE}' on container '${CONTAINER}'..."

docker exec -u postgres "${CONTAINER}" psql -c \
  "CREATE DATABASE ${DATABASE};"

echo "[pg-create] Done."

