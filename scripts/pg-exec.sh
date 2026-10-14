# pg-exec.sh: sourced by the pg-*.sh scripts; defines pg_docker_exec.
#
# Optional environment (none set = psql runs as the postgres OS user):
#   PG_EXEC_USER               OS user for docker exec -u. Unset: postgres.
#                              Set but empty: no -u (the image's default user).
#   PGUSER, PGPASSWORD, PGHOST forwarded with docker exec -e NAME when not
#                              empty, so values never appear on a command line.

PG_EXEC_OPTS=()
if [[ -z "${PG_EXEC_USER+x}" ]]; then
  PG_EXEC_OPTS+=(-u postgres)
elif [[ -n "$PG_EXEC_USER" ]]; then
  PG_EXEC_OPTS+=(-u "$PG_EXEC_USER")
fi
for _pg_var in PGUSER PGPASSWORD PGHOST; do
  if [[ -n "${!_pg_var:-}" ]]; then
    export "$_pg_var"
    PG_EXEC_OPTS+=(-e "$_pg_var")
  fi
done
unset _pg_var

# pg_docker_exec [docker exec options] <container> <command> [args...]
pg_docker_exec() {
  docker exec ${PG_EXEC_OPTS[@]+"${PG_EXEC_OPTS[@]}"} "$@"
}
