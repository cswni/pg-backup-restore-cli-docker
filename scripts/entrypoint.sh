#!/usr/bin/env bash
# ============================================================
# Entrypoint – PostgreSQL Backup / Restore Utility
# ============================================================
# Usage:
#   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
#              [-v $(pwd):/work]           # mounts CWD for restore -f <file>
#              [-v $(pwd)/backups:/backups] # mounts backups dir
#              <image> <command> [options]
#
# Commands:
#   export    Export (dump) a database
#   unblock   Terminate all connections to a database
#   delete    Drop a database
#   create    Create a database
#   restore   Restore a database from a dump file
#   help      Show this help message
# ============================================================

set -euo pipefail

COMMAND="${1:-help}"
shift || true   # shift away the command; remaining args passed to sub-script

case "$COMMAND" in
  export)  exec /usr/local/bin/pg-export.sh  "$@" ;;
  unblock) exec /usr/local/bin/pg-unblock.sh "$@" ;;
  delete)  exec /usr/local/bin/pg-delete.sh  "$@" ;;
  create)  exec /usr/local/bin/pg-create.sh  "$@" ;;
  restore) exec /usr/local/bin/pg-restore.sh "$@" ;;
  --help|help|*)
    cat <<'EOF'
PostgreSQL Backup / Restore Utility
====================================

Usage:
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    [-v $(pwd):/work]            \  # mount CWD so restore can find files by name
    [-v $(pwd)/backups:/backups] \  # mount backups dir
    <image> <command> [options]

Commands:
  export   -c <container> -d <database>             Export database to /backups
  unblock  -c <container> -d <database>             Terminate active connections
  delete   -c <container> -d <database>             Drop database (force)
  create   -c <container> -d <database>             Create database
  restore  -c <container> -d <database> [-f <file>] Restore from dump file
  help                                               Show this help message

Restore file resolution (-f):
  1. /work/<file>     – file in current directory (mount with -v $(pwd):/work)
  2. /backups/<file>  – file in backups dir (mount with -v /path/to/backups:/backups)
  3. <file> as-is     – absolute path inside the container
  If -f is omitted, the latest dump for the database is used.

Examples:
  # Export
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    -v $(pwd)/backups:/backups my-pg-backup \
    export -c my_postgres_container -d my_database

  # Restore from file in current directory
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    -v $(pwd):/work my-pg-backup \
    restore -c my_postgres_container -d my_database -f my_database.sql

  # Restore from backups directory
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    -v $(pwd)/backups:/backups my-pg-backup \
    restore -c my_postgres_container -d my_database -f my_database_01-01-2025_12_00_00.sql
EOF
    ;;
esac

