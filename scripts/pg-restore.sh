#!/usr/bin/env bash
# pg-restore.sh: Restore a PostgreSQL database from a dump
# Usage: pg-restore.sh -c <container> -d <target_database> [-f <file>] [-x]
#
#   -d  Target database name. The dump is always restored into THIS
#       database, even if it was exported from a database with another
#       name (e.g. dump of "premas" restored into "premas_qa").
#       The database is created if it does not exist.
#   -x  Drop the target database (WITH FORCE) before restoring.
#
# File resolution order for -f <file>:
#   1. /work/<file>     (mount your CWD with -v $(pwd):/work)
#   2. /backups/<file>  (mount your backups dir with -v /path/to/backups:/backups)
#   3. <file> as-is     (absolute path inside the container)
#
# If -f is omitted the script picks the newest <database>_*.sql dump
# found in /work or /backups.
#
# Examples:
#   # Restore a "premas" dump into "premas_qa", replacing it:
#   docker run --rm \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v $(pwd)/backups:/backups \
#     cswni/pg-backup-restore-cli restore -c my_postgres -d premas_qa -x -f premas_01-01-2025_12_00_00.sql

set -euo pipefail

usage() {
  echo "Usage: $0 -c <container> -d <target_database> [-f <dump_file>] [-x]"
  echo "  -c  Target Docker container name or ID"
  echo "  -d  Target database name (created if missing; dump's own name is ignored)"
  echo "  -f  Dump file name or path. Searched in /work, then /backups, then as absolute."
  echo "      Optional: defaults to the latest dump found in /work or /backups."
  echo "  -x  Drop the target database before restoring"
  exit 1
}

CONTAINER=""
DATABASE=""
FILE=""
DROP_EXISTING=0

while getopts ":c:d:f:x" opt; do
  case $opt in
    c) CONTAINER="$OPTARG" ;;
    d) DATABASE="$OPTARG" ;;
    f) FILE="$OPTARG" ;;
    x) DROP_EXISTING=1 ;;
    *) usage ;;
  esac
done

[[ -z "$CONTAINER" || -z "$DATABASE" ]] && usage

if [[ ! "$DATABASE" =~ ^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$ ]]; then
  echo "[pg-restore] ERROR: Invalid database name '${DATABASE}'. Use letters, digits, _, \$ or -." >&2
  exit 1
fi

# Prints the first existing path of /work/<name>, /backups/<name>, <name>; exits 1 if none.
resolve_file() {
  local name="$1"

  if [[ -f "/work/${name}" ]]; then
    echo "/work/${name}"
    return 0
  fi

  if [[ -f "/backups/${name}" ]]; then
    echo "/backups/${name}"
    return 0
  fi

  if [[ -f "${name}" ]]; then
    echo "${name}"
    return 0
  fi

  echo "[pg-restore] ERROR: File not found in /work, /backups, or as absolute path: ${name}" >&2
  exit 1
}

# admin_sql <sql> [db]: runs a statement in <db>, default the maintenance database "postgres".
admin_sql() {
  docker exec -u postgres "${CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -X -q -tA -d "${2:-postgres}" -c "$1"
}

# Number of user tables in <db> (system schemas excluded)
count_user_tables() {
  admin_sql "SELECT count(*) FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND n.nspname NOT LIKE 'pg_toast%';" "$1"
}

# retarget_dump <target>: rewrites a plain SQL dump on stdin to restore into <target>.
# pg-retarget.awk is shared with the web UI's direct PostgreSQL driver.
RETARGET_AWK="$(dirname "${BASH_SOURCE[0]}")/pg-retarget.awk"
if [[ ! -f "$RETARGET_AWK" ]]; then
  echo "[pg-restore] ERROR: ${RETARGET_AWK} not found (it must sit next to this script)." >&2
  exit 1
fi

retarget_dump() {
  awk -v qtarget="\"$1\"" -f "$RETARGET_AWK"
}

# Without -f, use the newest <database>_*.sql found in /work or /backups.
if [[ -z "$FILE" ]]; then
  LATEST=$(ls -t /work/"${DATABASE}"_*.sql /backups/"${DATABASE}"_*.sql 2>/dev/null | head -n 1 || true)
  if [[ -z "$LATEST" ]]; then
    echo "[pg-restore] ERROR: No dump file found in /work or /backups for database '${DATABASE}'."
    exit 1
  fi
  FILE="$LATEST"
  echo "[pg-restore] No file specified, using latest dump: ${FILE}"
else
  FILE=$(resolve_file "$FILE")
fi

if [[ "$DROP_EXISTING" -eq 1 ]]; then
  echo "[pg-restore] Dropping existing database '${DATABASE}' (if any)..."
  admin_sql "DROP DATABASE IF EXISTS \"${DATABASE}\" WITH (FORCE);"
fi

if [[ -z "$(admin_sql "SELECT 1 FROM pg_database WHERE datname = '${DATABASE}';")" ]]; then
  echo "[pg-restore] Creating database '${DATABASE}'..."
  admin_sql "CREATE DATABASE \"${DATABASE}\";"
else
  # Restoring a full dump on top of existing tables only produces
  # "already exists" / duplicate key errors and a half-merged database.
  TABLES=$(count_user_tables "$DATABASE")
  if [[ "$TABLES" -gt 0 ]]; then
    echo "[pg-restore] ERROR: Database '${DATABASE}' already exists and contains ${TABLES} table(s)." >&2
    echo "[pg-restore] ERROR: Enable 'Drop target database before restore' (-x) or choose another target name." >&2
    exit 1
  fi
  echo "[pg-restore] Database '${DATABASE}' exists and is empty, restoring into it."
fi

echo "[pg-restore] Restoring into '${DATABASE}' on container '${CONTAINER}' from: ${FILE}"

# psql keeps going after SQL errors and exits 0, so capture stderr
# (still streamed to the job log) and count the errors afterwards.
ERR_LOG=$(mktemp)
trap 'rm -f "$ERR_LOG"' EXIT

# fd swap: psql stdout -> fd 3 (our stdout), psql stderr -> tee -> our stderr
{
  retarget_dump "$DATABASE" < "${FILE}" \
    | docker exec -i -u postgres "${CONTAINER}" psql -X -d "${DATABASE}" 2>&1 1>&3 \
    | tee "$ERR_LOG" >&2
} 3>&1

ERRORS=$(grep -c '^ERROR:' "$ERR_LOG" || true)
if [[ "$ERRORS" -gt 0 ]]; then
  echo "[pg-restore] FAILED: restore finished with ${ERRORS} SQL error(s). See the log above." >&2
  exit 1
fi

echo "[pg-restore] Done. Restore completed without errors."
