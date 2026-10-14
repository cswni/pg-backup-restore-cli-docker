# pg-retarget.awk: Make a plain SQL dump restore into another database
# Usage: awk -v qtarget='"<target>"' -f pg-retarget.awk < dump.sql
#
#   qtarget  Target database name, already quoted as an SQL identifier.
#
# - drops the header "CREATE DATABASE <src>" and "\connect <src>" lines
#   emitted by `pg_dump -C` (the caller connects to the target itself)
# - rewrites "ALTER DATABASE <src> ..." / "COMMENT ON DATABASE <src> ..."
#   so they apply to the target database
# Dumps without -C pass through unchanged.
#
# Shared by pg-restore.sh (Docker containers) and the Web UI's direct
# PostgreSQL driver so both retarget dumps identically.
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
