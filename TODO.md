# TODO

Work in progress: [docs/plan/2026-10-14-antislop-and-db-explorer.md](docs/plan/2026-10-14-antislop-and-db-explorer.md) (antislop MEDIUM/LOW fixes, Database Explorer).

- [x] Add authentication and authorization (session login + HTTP Basic for scripts, admin/user roles)
- [x] Add support for several servers (Servers page): remote Docker hosts over SSH and direct database connections
- [x] Add SSH tunnels for direct database connections
- [x] Implement user management (admin-managed accounts, login, profile)
- [x] Copy backups to Google Drive (OAuth with your own Google account)
- [ ] Add support for incremental backups: deferred, see [docs/incremental-backups.md](docs/incremental-backups.md)
- [x] Compress backups (gzip)
- [x] Copy backups to S3 and S3-compatible storage (AWS S3, MinIO, B2, R2, Wasabi…)
- [x] Add support for other databases (MySQL/MariaDB, MongoDB)
- [x] Implement scheduling for automatic backups
- [x] Encrypt backups (AES-256-GCM, offline decryption CLI)
- [x] Implement backup retention policies (e.g. keep the last 7 backups)
- [x] Add logging and monitoring for backup operations (job history, persisted logs, health, Prometheus metrics, webhook notifications)

## Fixed

- [x] Restoring over an existing database failed with "already exists" errors and left it half restored: fixed with the "Drop target database before restore" option (`restore -x`)
- [x] Uploads stuck at 1% behind Cloudflare (100 MB request limit): uploads are chunked and resumable

## Needs verification on a real deployment

- [ ] Remote Docker over SSH and SSH tunnels against real hosts
- [ ] MySQL/MariaDB and MongoDB backup/restore against real containers and servers
- [ ] S3-compatible providers and Google Drive OAuth with real credentials
- [ ] MySQL rename: views/routines that reference the source schema by name (`premas`.`t`) or carry DEFINERs. Test `premas` → `premas_qa` with a real view; target DB uses the server's default charset/collation
- [ ] Cancelling/failing a Docker-based job kills the local `docker exec`, but the tool inside the container may keep running until its pipe closes
- [ ] Docker MySQL restore: run the in-container client with `--sandbox` when it supports it (direct restores already do)
