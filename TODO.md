# TODO

- [x] Add authentication and authorization (HTTP Basic auth via `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`)
- [ ] Add support for multiple database connections and server (multiple containers on distinct hosts)
- [ ] Add support for ssh tunnels for remote database connections
- [ ] Implement user management (registration, login, profile)
- [ ] Send it to Google Drive besides local storage
- [ ] Add support for incremental backups
- [ ] backup compression (e.g., gzip)
- [ ] Backup on S3 or other cloud storage services
- [ ] Add support for other databases (MySQL, MongoDB, etc.)
- [ ] Implement scheduling for automatic backups
- [ ] Add encryption for backup files
- [ ] Implement backup retention policies (e.g., keep last 7 backups)
- [ ] Add logging and monitoring for backup operations

## FIX (ASAP)

- [x] When trying to restore over the same database all queries say, already exists, but the database is not dropped, and the restore process is not completed. The database should be dropped before restore, or the restore process should be able to overwrite existing objects. (Fixed: "Drop target database before restore" option / `restore -x`)
