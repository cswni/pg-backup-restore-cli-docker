#!/usr/bin/env bash
# ============================================================
# pg-restore.sh  –  Restore a PostgreSQL database from a dump
# ============================================================
# Usage: pg-restore.sh -c <container> -d <database> [-f <file>]
#
# File resolution order for -f <file>:
#   1. /work/<file>     (mount your CWD with -v $(pwd):/work)
#   2. /backups/<file>  (mount your backups dir with -v /path/to/backups:/backups)
#   3. <file> as-is     (absolute path inside the container)
#
# If -f is omitted the script picks the latest dump for the given
# database name, searching /work first, then /backups.
#
# Examples:
#   # File in current directory (no /backups mount needed):
#   docker run --rm \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v $(pwd):/work \
#     cswni/pg-backup restore -c my_postgres -d my_db -f my_db.sql
#
#   # File in backups directory:
#   docker run --rm \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v $(pwd)/backups:/backups \
#     cswni/pg-backup restore -c my_postgres -d my_db -f my_db_01-01-2025_12_00_00.sql
# ============================================================

set -euo pipefail

usage() {
  echo "Usage: $0 -c <container> -d <database> [-f <dump_file>]"
  echo "  -c  Target Docker container name or ID"
  echo "  -d  Database name"
  echo "  -f  Dump file name or path. Searched in /work, then /backups, then as absolute."
  echo "      Optional: defaults to the latest dump found in /work or /backups."
  exit 1
}

CONTAINER=""
DATABASE=""
FILE=""

while getopts ":c:d:f:" opt; do
  case $opt in
    c) CONTAINER="$OPTARG" ;;
    d) DATABASE="$OPTARG" ;;
    f) FILE="$OPTARG" ;;
    *) usage ;;
  esac
done

[[ -z "$CONTAINER" || -z "$DATABASE" ]] && usage

# ---------------------------------------------------------------------------
# resolve_file <name>
#   Tries /work/<name>, /backups/<name>, then <name> as-is (absolute).
#   Prints the resolved path if found, exits 1 otherwise.
# ---------------------------------------------------------------------------
resolve_file() {
  local name="$1"

  # 1. Current-directory mount
  if [[ -f "/work/${name}" ]]; then
    echo "/work/${name}"
    return 0
  fi

  # 2. Backups directory mount
  if [[ -f "/backups/${name}" ]]; then
    echo "/backups/${name}"
    return 0
  fi

  # 3. Treat as absolute / already-resolved path
  if [[ -f "${name}" ]]; then
    echo "${name}"
    return 0
  fi

  echo "[pg-restore] ERROR: File not found in /work, /backups, or as absolute path: ${name}" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# If no file given, auto-detect the latest dump in /work then /backups
# ---------------------------------------------------------------------------
if [[ -z "$FILE" ]]; then
  LATEST=$(ls -t /work/"${DATABASE}"_*.sql /backups/"${DATABASE}"_*.sql 2>/dev/null | head -n 1 || true)
  if [[ -z "$LATEST" ]]; then
    echo "[pg-restore] ERROR: No dump file found in /work or /backups for database '${DATABASE}'."
    exit 1
  fi
  FILE="$LATEST"
  echo "[pg-restore] No file specified – using latest dump: ${FILE}"
else
  FILE=$(resolve_file "$FILE")
fi

echo "[pg-restore] Restoring '${DATABASE}' on container '${CONTAINER}' from: ${FILE}"

cat "${FILE}" | docker exec -i "${CONTAINER}" psql -U postgres

echo "[pg-restore] Done."

