#!/usr/bin/env bash
# ============================================================
# Entrypoint – PostgreSQL Backup / Restore Utility
# ============================================================

set -euo pipefail

# ── Trap: print a clear message on any unexpected exit ───────────────────────
_exit_handler() {
  local code=$?
  # A web server should NEVER exit cleanly — treat exit 0 as an error too
  if [[ $code -ne 0 ]] || [[ "${COMMAND:-}" == "serve" ]]; then
    echo ""
    echo "================================================================" >&2
    echo "  CONTAINER EXITED WITH CODE ${code}" >&2
    echo "  Command: ${COMMAND:-<unknown>}" >&2
    echo "  Time:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')" >&2
    echo "  CWD:     $(pwd)" >&2
    echo "================================================================" >&2
    echo "" >&2
    echo "  Troubleshooting:" >&2
    echo "    • Docker socket: make sure /var/run/docker.sock is mounted" >&2
    echo "      -v /var/run/docker.sock:/var/run/docker.sock" >&2
    echo "    • Node.js:  $(node --version 2>/dev/null || echo 'NOT FOUND')" >&2
    echo "    • Server:   $(ls -la /ui/server/index.js 2>/dev/null || echo '/ui/server/index.js NOT FOUND')" >&2
    echo "    • Modules:  $(ls /ui/node_modules 2>/dev/null | wc -l) packages in /ui/node_modules" >&2
    echo "    • WORKDIR:  $(cat /proc/1/cwd 2>/dev/null || pwd)" >&2
    echo "================================================================" >&2
  fi
}
trap '_exit_handler' EXIT

# ── Helper: start the web UI with pre-flight checks ──────────────────────────
start_server() {
  echo "================================================================"
  echo "  PG Backup & Restore — Web UI"
  echo "  Starting at: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo "================================================================"

  # Check Node.js is available
  if ! command -v node &>/dev/null; then
    echo "[ERROR] node is not installed or not in PATH" >&2
    exit 1
  fi
  echo "[boot] Node.js: $(node --version)"

  # Check the server file exists
  if [[ ! -f /ui/server/index.js ]]; then
    echo "[ERROR] /ui/server/index.js not found — was the image built correctly?" >&2
    exit 1
  fi
  echo "[boot] Server:  /ui/server/index.js ✓"

  # Check node_modules exist
  if [[ ! -d /ui/node_modules ]]; then
    echo "[ERROR] /ui/node_modules not found — dependencies were not installed in the image" >&2
    exit 1
  fi
  echo "[boot] Modules: /ui/node_modules ✓"

  # Check Docker socket
  if [[ ! -S /var/run/docker.sock ]]; then
    echo "[WARN] /var/run/docker.sock not found — container listing will not work" >&2
    echo "[WARN] Mount it with: -v /var/run/docker.sock:/var/run/docker.sock" >&2
  else
    echo "[boot] Docker socket: /var/run/docker.sock ✓"
  fi

  echo "[boot] Launching server on port ${PORT:-3000}..."
  echo "================================================================"

  # Always run node from /ui so require() resolves node_modules correctly
  cd /ui

  # Quick sanity-check: try to require express before handing off
  if ! node -e "require('express')" 2>/dev/null; then
    echo "[ERROR] Cannot require 'express' from /ui/node_modules" >&2
    echo "[ERROR] node_modules contents:" >&2
    ls /ui/node_modules 2>/dev/null | head -20 >&2 || echo "  (empty or missing)" >&2
    exit 1
  fi
  echo "[boot] Dependencies OK ✓"

  # exec replaces this shell — the trap fires only if node itself exits non-zero
  exec node /ui/server/index.js
}

# ─────────────────────────────────────────────────────────────────────────────
COMMAND="${1:-serve}"
shift || true

case "$COMMAND" in
  export)    exec /usr/local/bin/pg-export.sh  "$@" ;;
  unblock)   exec /usr/local/bin/pg-unblock.sh "$@" ;;
  delete)    exec /usr/local/bin/pg-delete.sh  "$@" ;;
  create)    exec /usr/local/bin/pg-create.sh  "$@" ;;
  restore)   exec /usr/local/bin/pg-restore.sh "$@" ;;
  serve)     start_server ;;
  --help|help)
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
  serve                                              Start the Web UI (default)
  help                                               Show this help message

Restore file resolution (-f):
  1. /work/<file>     – file in current directory (mount with -v $(pwd):/work)
  2. /backups/<file>  – file in backups dir (mount with -v /path/to/backups:/backups)
  3. <file> as-is     – absolute path inside the container
  If -f is omitted, the latest dump for the database is used.
EOF
    ;;
  *)
    start_server ;;
esac

