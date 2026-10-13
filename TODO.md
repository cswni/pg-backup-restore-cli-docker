# TODO

- [x] Add authentication and authorization (session login + HTTP Basic for scripts, admin/user roles)
- [x] Add support for multiple database connections and server (multiple containers on distinct hosts) — Servers page: remote Docker hosts over SSH + direct connections
- [x] Add support for ssh tunnels for remote database connections
- [x] Implement user management (admin-managed accounts, login, profile)
- [x] Send it to Google Drive besides local storage (OAuth with your own Google account)
- [ ] Add support for incremental backups — deferred, see [docs/incremental-backups.md](docs/incremental-backups.md)
- [x] backup compression (e.g., gzip)
- [x] Backup on S3 or other cloud storage services (AWS S3 and S3-compatible: MinIO, B2, R2, Wasabi…)
- [x] Add support for other databases (MySQL/MariaDB, MongoDB)
- [x] Implement scheduling for automatic backups
- [x] Add encryption for backup files (AES-256-GCM, offline decryption CLI)
- [x] Implement backup retention policies (e.g., keep last 7 backups)
- [x] Add logging and monitoring for backup operations (job history, persisted logs, health, Prometheus metrics, webhook notifications)

## FIX (ASAP)

- [x] When trying to restore over the same database all queries say, already exists, but the database is not dropped, and the restore process is not completed. The database should be dropped before restore, or the restore process should be able to overwrite existing objects. (Fixed: "Drop target database before restore" option / `restore -x`)
- [x] Uploads stuck at 1% behind Cloudflare (100 MB request limit) — uploads are now chunked and resumable

## Needs verification on a real deployment

- [ ] Remote Docker over SSH and SSH tunnels against real hosts
- [ ] MySQL/MariaDB and MongoDB backup/restore against real containers and servers
- [ ] S3-compatible providers and Google Drive OAuth with real credentials
- [ ] MySQL rename: views/routines that reference the source schema by name (`premas`.`t`) or carry DEFINERs — test `premas` → `premas_qa` with a real view; target DB uses the server's default charset/collation
- [ ] Cancelling/failing a Docker-based job kills the local `docker exec`, but the tool inside the container may keep running until its pipe closes
- [ ] Docker MySQL restore: run the in-container client with `--sandbox` when it supports it (direct restores already do)
