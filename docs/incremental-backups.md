# Incremental backups — design note (deferred)

Status: **not implemented** — deferred on purpose (decision of 2026-10-12).
This note records why, and how it could be built later.

## Why the current tool can't do incrementals

Every backup this tool makes is a **logical dump** (`pg_dump`, `mysqldump`,
`mongodump`): a full, self-contained snapshot of one database as SQL/BSON.
Logical dumps have no notion of "what changed since the last dump", so they
can't be incremental. Compression (gzip) and retention already keep their
storage cost manageable.

## How PostgreSQL does incrementals

Real incrementals work at the **physical** level (data files + WAL):

| Approach | What it needs | Restore |
|---|---|---|
| `pg_basebackup --incremental` (PostgreSQL 17+) | `summarize_wal = on` on the server, a role with `REPLICATION`, a reachable replication connection, the previous backup's `backup_manifest` | `pg_combinebackup full incr1 incr2 … -o restored/`, then start a server on that data directory |
| WAL archiving + base backups (PITR) | `archive_mode = on`, `archive_command` shipping WAL to storage | base backup + replay WAL to a point in time |
| Dedicated tools (pgBackRest, Barman, WAL-G) | their own agents/config | their own restore commands |

## Consequences for this tool

- Physical backups cover the **whole cluster** (all databases, roles,
  config), not one database. They can't be restored into a different
  database name — the main workflow here (e.g. `premas` → `premas_qa`).
- Restoring means **replacing a server's data directory** (stop the
  container, swap the volume, start it). That's far more invasive than
  today's restore and easy to get catastrophically wrong from a web UI.
- It requires changing the source server's configuration
  (`summarize_wal`, replication role, `pg_hba.conf`).

## Possible implementation (if needed later)

1. New engine driver kind `postgres-physical` for **direct** servers
   (PG 17+ only), with a replication-capable role stored like other
   credentials.
2. Backup chain stored as a directory per chain:
   `chains/<server>/<timestamp>-full/`, `…-incr-N/`, each with its
   `backup_manifest`; catalog rows link incrementals to their parent.
3. Scheduler policy "full weekly, incremental daily"; retention deletes
   whole chains only (never a parent of a kept incremental).
4. "Restore" = run `pg_combinebackup` into a new directory and produce a
   ready-to-mount data directory + instructions; never swap volumes
   automatically.
5. Verification job: `pg_verifybackup` on each new backup.

Until then, recommended alternatives for large databases: run the
scheduler more often with compression + retention, or use pgBackRest /
WAL-G alongside this tool.
