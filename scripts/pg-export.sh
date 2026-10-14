#!/usr/bin/env bash
# pg-export.sh: Dump a PostgreSQL database
# Usage: pg-export.sh -c <container> -d <database> [-n <name>] [-o <file>]
#
#   -o  Exact output path (overrides -n and the default location).
#
#   -n  Name used for the dump file (defaults to <database>).
#       Restore uses the file name prefix as the default target
#       database, so e.g. "-d premas -n premas_qa" produces a dump
#       ready to be restored as "premas_qa".
#
# Output file: /backups/<name>_<DD-MM-YYYY_HH_MM_SS>.sql

set -euo pipefail

usage() {
  echo "Usage: $0 -c <container> -d <database> [-n <name>] [-o <file>]"
  exit 1
}

CONTAINER=""
DATABASE=""
NAME=""
OUTPUT_FILE=""

while getopts ":c:d:n:o:" opt; do
  case $opt in
    c) CONTAINER="$OPTARG" ;;
    d) DATABASE="$OPTARG" ;;
    n) NAME="$OPTARG" ;;
    o) OUTPUT_FILE="$OPTARG" ;;
    *) usage ;;
  esac
done

[[ -z "$CONTAINER" || -z "$DATABASE" ]] && usage

NAME="${NAME:-$DATABASE}"
if [[ ! "$NAME" =~ ^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$ ]]; then
  echo "[pg-export] ERROR: Invalid name '${NAME}'. Use letters, digits, _, \$ or -." >&2
  exit 1
fi

if [[ -z "$OUTPUT_FILE" ]]; then
  TIMESTAMP=$(date +%d-%m-%Y_%H_%M_%S)
  OUTPUT_FILE="/backups/${NAME}_${TIMESTAMP}.sql"
fi

echo "[pg-export] Exporting database '${DATABASE}' from container '${CONTAINER}'..."
echo "[pg-export] Output file: ${OUTPUT_FILE}"

# No -t: a TTY would turn every newline in the dump into \r\n
docker exec -u postgres "${CONTAINER}" \
  pg_dump -C "${DATABASE}" > "${OUTPUT_FILE}"

echo "[pg-export] Done. Dump saved to: ${OUTPUT_FILE}"
