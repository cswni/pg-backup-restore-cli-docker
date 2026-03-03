#!/usr/bin/env bash
# ============================================================
# pg-export.sh  –  Dump a PostgreSQL database
# ============================================================
# Usage: pg-export.sh -c <container> -d <database>
#
# Output file: /backups/<database>_<DD-MM-YYYY_HH_MM_SS>.sql
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

TIMESTAMP=$(date +%d-%m-%Y_%H_%M_%S)
OUTPUT_FILE="/backups/${DATABASE}_${TIMESTAMP}.sql"

echo "[pg-export] Exporting database '${DATABASE}' from container '${CONTAINER}'..."
echo "[pg-export] Output file: ${OUTPUT_FILE}"

docker exec -t -u postgres "${CONTAINER}" \
  pg_dump -C "${DATABASE}" > "${OUTPUT_FILE}"

echo "[pg-export] Done. Dump saved to: ${OUTPUT_FILE}"

