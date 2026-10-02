#!/usr/bin/env bash
# ============================================================
# pg-restore.sh  –  Restore a PostgreSQL database from a dump
# ============================================================
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
# If -f is omitted the script picks the latest dump for the given
# database name, searching /work first, then /backups.
#
# Examples:
#   # Restore a "premas" dump into "premas_qa", replacing it:
#   docker run --rm \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v $(pwd)/backups:/backups \
#     cswni/pg-backup restore -c my_postgres -d premas_qa -x -f premas_01-01-2025_12_00_00.sql
# ============================================================

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
# admin_sql <sql>
#   Runs a statement against the maintenance database "postgres".
#   Optional second argument: database to run it in (default "postgres").
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# retarget_dump <target>
#   Reads a plain SQL dump on stdin and makes it restore into <target>:
#   - drops the header "CREATE DATABASE <src>" and "\connect <src>" lines
#     emitted by `pg_dump -C` (we connect to the target ourselves)
#   - rewrites "ALTER DATABASE <src> ..." / "COMMENT ON DATABASE <src> ..."
#     so they apply to the target database
#   Dumps without -C pass through unchanged.
# ---------------------------------------------------------------------------
retarget_dump() {
  awk -v qtarget="\"$1\"" '
    BEGIN { header = 1; src = "" }
    header && NR <= 200 && /^CREATE DATABASE / { src = $3; next }
    header && NR <= 200 && /^\\connect / { header = 0; next }
    src != "" {
      alter = "ALTER DATABASE " src " "
      comment = "COMMENT ON DATABASE " src " "
      if (index($0, alter) == 1) {
        $0 = "ALTER DATABASE " qtarget " " substr($0, length(alter) + 1)
      } else if (index($0, comment) == 1) {
        $0 = "COMMENT ON DATABASE " qtarget " " substr($0, length(comment) + 1)
      }
    }
    { print }
  '
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
  echo "[pg-restore] Database '${DATABASE}' exists and is empty – restoring into it."
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
  echo "[pg-restore] FAILED: restore finished with ${ERRORS} SQL error(s) – see the log above." >&2
  exit 1
fi

echo "[pg-restore] Done. Restore completed without errors."
