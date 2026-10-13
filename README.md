# pg-backup – PostgreSQL Backup / Restore Docker Image

A lightweight Docker image (Alpine-based) that wraps common PostgreSQL
backup and restore operations using the Docker CLI.  
Designed to be used in CI/CD pipelines.

---

## Prerequisites — Docker Hub Authentication

All `docker pull` / `docker push` operations require a valid Docker Hub session.
If you see:

```
Error response from daemon: Head "https://registry-1.docker.io/v2/cswni/pg-backup/manifests/latest":
unauthorized: personal access token is expired
```

your token has expired. Follow these steps to re-authenticate:

### 1 — Create a new Personal Access Token (PAT)

1. Log in to [hub.docker.com](https://hub.docker.com).
2. Go to **Account Settings → Security → Personal Access Tokens**.
3. Click **Generate new token**, give it a description (e.g. `pg-backup-ci`), choose **Read & Write** scope, and click **Generate**.
4. **Copy the token now** — it will not be shown again.

### 2 — Log in from the CLI

```bash
docker login -u <your-dockerhub-username>
# Paste the new PAT when prompted for the password
```

Or pass the token directly (useful for CI/CD):

```bash
echo "<your-pat>" | docker login -u <your-dockerhub-username> --password-stdin
```

### 3 — Verify

```bash
docker pull cswni/pg-backup:latest
```

---

## Build

```bash
docker build -t cswni/pg-backup:latest .
```

## Push

```bash
docker push cswni/pg-backup:latest
```

---

## Usage

Mount the Docker socket so the container can talk to other containers,
and mount a host directory to `/backups` to persist dump files.

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/backups:/backups \
  cswni/pg-backup <command> [options]
```

---

## Commands

### export
Dump a database to `/backups/<name>_<DD-MM-YYYY_HH_MM_SS>.sql`.
`-n <name>` is optional and defaults to the database name. Restore uses the file
name prefix as the default target database, so `-d premas -n premas_qa` produces
a dump that restores as `premas_qa` by default.

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/backups:/backups \
  cswni/pg-backup export -c <container> -d <database> [-n <name>]
```

### unblock
Terminate all active connections to a database (useful before drop/restore).

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  cswni/pg-backup unblock -c <container> -d <database>
```

### delete
Drop a database with `FORCE` (terminates remaining connections automatically).

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  cswni/pg-backup delete -c <container> -d <database>
```

### create
Create a new database.

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  cswni/pg-backup create -c <container> -d <database>
```

### restore
Restore a database from a dump file.  
`-f` is optional — if omitted the latest dump for that database is used.

- `-d` is the **target** database. The dump is always restored into it, whatever
  database it was exported from (e.g. a `premas` dump restored into `premas_qa`).
  The target is created if it does not exist.
- `-x` drops the target database (`WITH (FORCE)`) before restoring, so the restore
  starts from an empty database instead of failing with "already exists" errors.
- Without `-x`, restoring into an existing database that already has tables is
  refused. The command exits non-zero if psql reports any SQL error.

```bash
# Restore a dump of "premas" into "premas_qa", replacing it
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/backups:/backups \
  cswni/pg-backup restore -c <container> -d premas_qa -x -f premas_01-01-2025_12_00_00.sql
```

**File resolution order for `-f <file>`:**
1. `/work/<file>` — mount your current directory with `-v $(pwd):/work`
2. `/backups/<file>` — mount your backups dir with `-v /path/to/backups:/backups`
3. `<file>` as-is — absolute path already inside the container

```bash
# Restore from a file in the CURRENT directory (most common for ad-hoc restores)
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd):/work \
  cswni/pg-backup restore -c <container> -d <database> -f <file.sql>

# Restore from the backups directory
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/backups:/backups \
  cswni/pg-backup restore -c <container> -d <database> -f <file.sql>

# Restore latest dump automatically (searches /work then /backups)
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd):/work \
  cswni/pg-backup restore -c <container> -d <database>
```

---

## Web UI authentication

The Web UI (`serve`, the default command) protects the UI, the API and backup
downloads with HTTP Basic authentication. **Credentials are required**: the server
refuses to start unless both variables are set.

| Variable | Description |
|----------|-------------|
| `BASIC_AUTH_USER` | Username (required) |
| `BASIC_AUTH_PASSWORD` | Password (required) |
| `BASIC_AUTH_DISABLED` | Set to `true` to run without authentication (local development only) |

Always serve the UI over HTTPS (e.g. behind Traefik), since Basic auth sends
credentials on every request. Browsers remember Basic credentials until they are
closed, so after a redeploy you may not be prompted again in an already-open browser.

For local development run the server with `BASIC_AUTH_DISABLED=true` (or set
credentials) before `pnpm run dev:server`.

---

## Backup storage: compression, encryption, cloud copies, retention

Configured in the Web UI under **Storage** (`/settings/storage`, admin only).
Every Web UI export runs through this pipeline:

```
pg_dump → db_<ts>.sql → gzip → db_<ts>.sql.gz → encrypt → db_<ts>.sql.gz.enc → upload → retention
```

Restores run the reverse automatically (download if the file is only remote →
decrypt → decompress) using temporary files in `$DATA_DIR/tmp` that are deleted
afterwards. Compression and encryption defaults can be overridden per export in
the Export dialog, which also lets you pick the destinations to upload to.

| Variable | Description |
|----------|-------------|
| `BACKUP_ENCRYPTION_PASSPHRASE` | Encryption passphrase. When set it **overrides** the passphrase stored in the UI |
| `PUBLIC_URL` | External URL of the UI, e.g. `https://backups.example.com`. Used to build the Google OAuth redirect URI. If unset it is derived from the request (`X-Forwarded-Proto`/`Host` behind a proxy) |
| `APP_SECRET` | Key used to encrypt stored credentials (S3 keys, OAuth secrets/tokens, the passphrase). If unset a key is generated in `$DATA_DIR/secret.key` — back it up or set `APP_SECRET` |

### Compression

Streaming gzip (`.sql.gz`), on by default at level 6 (1 = fastest … 9 = smallest).
Uploaded `.sql.gz` files can be restored like plain dumps.

### Encryption

Authenticated encryption with **AES-256-GCM**. The key is derived from your
passphrase with **scrypt** (N=2^15, r=8, p=1) and a random salt per file, and a
random nonce is used per file. Encrypted files end in `.enc`.

File format (version 1):

| Offset | Size | Field |
|--------|------|-------|
| 0 | 7 | magic `PGBKENC` |
| 7 | 1 | format version (`1`) |
| 8 | 1 | KDF id (`1` = scrypt) |
| 9 | 3 | scrypt log2(N), r, p |
| 12 | 16 | salt |
| 28 | 12 | AES-GCM nonce |
| 40 | 16 | key check (lets a wrong passphrase fail immediately) |
| 56 | … | ciphertext |
| end − 16 | 16 | GCM authentication tag |

The 56-byte header is authenticated together with the data, so any modification
of the file is detected. On restore the file is decrypted to a temporary file
which is only used after the authentication tag has verified. A single file is
limited to 64 GiB (AES-GCM limit).

> ⚠️ **Losing the passphrase makes encrypted backups unrecoverable.** Store it in
> a password manager or vault, outside the backup server.

**Changing the passphrase** only affects new backups. Replaced passphrases are
kept (encrypted) and tried automatically when restoring older backups. If you
lose the app database, older backups need the passphrase that was active when
they were created — keep a record of every passphrase you have used.

#### Offline decryption (disaster recovery)

`decrypt-cli.js` needs only Node.js ≥ 18 — no web server, database or
`node_modules`. Inside the image:

```bash
docker run --rm -it -v $(pwd)/backups:/backups --entrypoint node cswni/pg-backup \
  /ui/server/storage/decrypt-cli.js --gunzip /backups/premas_01-10-2026_02_00_00.sql.gz.enc /backups/premas.sql
```

It prompts for the passphrase (no echo); alternatively pass it as
`BACKUP_ENCRYPTION_PASSPHRASE` or pipe it on stdin. Without `--gunzip` it writes
the decrypted `.sql.gz`. On any machine with Node.js you can instead copy the two
files `ui/server/storage/decrypt-cli.js` and `ui/server/storage/crypto-format.js`
from this repository and run `node decrypt-cli.js [--gunzip] <in.enc> <out>`.
The output file is removed if the passphrase is wrong or the file was tampered with.

### Remote destinations

Add destinations under **Storage → Remote destinations**. Destinations marked
*default* receive every backup unless the export selects destinations
explicitly. Each upload is recorded in the backup catalog; the Backups page shows
☁ badges, and backups whose local file was deleted (e.g. by retention) stay
listed as *remote only* and can still be restored (they are downloaded and their
SHA-256 checksum is verified first).

If an upload fails, the job **fails by default** (the local backup is kept and
catalogued, successful uploads are recorded). Switch *When an upload fails* to
*best effort* to only log a warning. Use **Test** on a destination to write and
delete a small probe file.

#### S3 and S3-compatible storage

Works with AWS S3, MinIO, Backblaze B2, Cloudflare R2, Wasabi, etc. Multipart
uploads stream from disk.

| Field | Example |
|-------|---------|
| Endpoint | empty for AWS · `https://<account>.r2.cloudflarestorage.com` · `https://s3.<region>.backblazeb2.com` · `https://s3.<region>.wasabisys.com` · `http://minio:9000` |
| Region | `us-east-1` · `auto` for R2 |
| Bucket / Prefix | `my-backups` / `postgres/prod/` |
| Access key ID / Secret | an access key limited to that bucket (needs `PutObject`, `GetObject`, `DeleteObject`) |
| Force path style | enable for MinIO and most self-hosted servers |

#### Google Drive (OAuth with your Google account)

Works with a normal Gmail account; files are uploaded with the
`drive.file` scope (the app only sees files it created).

1. In [Google Cloud Console](https://console.cloud.google.com/) create (or pick)
   a project and enable the **Google Drive API**.
2. Configure the **OAuth consent screen** (External, add yourself as a test
   user — or publish the app so the refresh token does not expire after 7 days).
3. **Credentials → Create credentials → OAuth client ID → Web application.**
   Under *Authorized redirect URIs* add the URI shown in the destination form:
   `https://<your PUBLIC_URL>/api/storage/gdrive/oauth/callback`.
4. Set `PUBLIC_URL` on the container to the URL you open the UI with (the
   redirect URI must match exactly).
5. In **Storage → + Google Drive** paste the client ID and secret, optionally a
   folder ID (the last part of the folder URL), and save.
6. Click **Connect Google Drive**, sign in and allow access. You are redirected
   back to the Storage page; the refresh token is stored encrypted.

Use *Reconnect* if access was revoked. Changing the client ID requires
connecting again.

### Retention

Policies: keep the **newest N** backups and/or backups **younger than D days** —
for local files (Storage → Retention) and separately for each destination (in
its form). Retention runs after every backup and once a day (and on demand with
*Run retention now*); every deletion is written to the job log.

- Policies apply per **group**: same server + container + source database.
- A copy is deleted only if it is outside **every** configured rule.
- The newest copy of each group in each place (local / each destination) and
  the backup just created are never deleted.
- Deleting a local file keeps the catalog entry while remote copies exist.
- Files without catalog metadata (uploads, CLI exports) are only touched when
  their `name_DD-MM-YYYY_HH_MM_SS` prefix matches exactly one group; anything
  else is left alone.

---

## Docker Compose Usage

Run `pg-backup` side by side with your PostgreSQL container using a shared network.
The Docker socket is mounted so `pg-backup` can reach the `postgres` container by name.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    container_name: postgres
    environment:
      POSTGRES_USER: your_user
      POSTGRES_PASSWORD: your_password
      POSTGRES_DB: your_db
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - db_network

  pg-backup:
    image: cswni/pg-backup:latest
    container_name: pg-backup
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./backups:/backups
      - .:/work                 # mounts compose project dir so any local .sql file is accessible
    networks:
      - db_network
    # Keep the container alive so you can exec commands on demand
    entrypoint: ["tail", "-f", "/dev/null"]
    depends_on:
      - postgres

networks:
  db_network:
    driver: bridge

volumes:
  pgdata:
```

### Running commands via Compose

```bash
# Export
docker compose exec pg-backup pg-backup export -c postgres -d your_db

# Restore from a file in the current directory (via /work mount)
docker compose exec pg-backup pg-backup restore -c postgres -d your_db -f your_file.sql

# Restore from the /backups directory
docker compose exec pg-backup pg-backup restore -c postgres -d your_db -f your_db_01-01-2025_12_00_00.sql

# Restore latest dump automatically (searches /work then /backups)
docker compose exec pg-backup pg-backup restore -c postgres -d your_db

# Full restore pipeline
docker compose exec pg-backup pg-backup unblock -c postgres -d your_db
docker compose exec pg-backup pg-backup delete  -c postgres -d your_db
docker compose exec pg-backup pg-backup create  -c postgres -d your_db
docker compose exec pg-backup pg-backup restore -c postgres -d your_db -f your_file.sql
```

---

## Docker Swarm Usage

In Swarm mode the Docker socket is available on the manager node.
Use an overlay network so all services can communicate across nodes.

> **Note:** The Docker socket (`/var/run/docker.sock`) is only available on the
> node where the task is scheduled. Pin `pg-backup` to the manager node with
> a placement constraint so it can always reach the socket and other containers.

```yaml
# docker-compose.swarm.yml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: your_user
      POSTGRES_PASSWORD: your_password
      POSTGRES_DB: your_db
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - db_network
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
      placement:
        constraints:
          - node.role == manager

  pg-backup:
    image: cswni/pg-backup:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/backups:/backups        # host path on the manager node
      - /opt/work:/work              # drop any .sql file here for ad-hoc restores
    networks:
      - db_network
    entrypoint: ["tail", "-f", "/dev/null"]
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
      placement:
        constraints:
          - node.role == manager      # must run on the manager for socket access

networks:
  db_network:
    driver: overlay
    attachable: true                  # allows `docker run` / one-off tasks to join

volumes:
  pgdata:
    driver: local
```

### Deploy to Swarm

```bash
docker stack deploy -c docker-compose.swarm.yml pg
```

### Running commands in Swarm

```bash
# Find the pg-backup task container ID on the manager node
CONTAINER=$(docker ps --filter name=pg_pg-backup --format "{{.ID}}" | head -1)

# Export
docker exec "$CONTAINER" pg-backup export -c pg_postgres.<replica_id> -d your_db

# Full restore pipeline
docker exec "$CONTAINER" pg-backup unblock -c pg_postgres.<replica_id> -d your_db
docker exec "$CONTAINER" pg-backup delete  -c pg_postgres.<replica_id> -d your_db
docker exec "$CONTAINER" pg-backup create  -c pg_postgres.<replica_id> -d your_db
docker exec "$CONTAINER" pg-backup restore -c pg_postgres.<replica_id> -d your_db
```

> **Tip:** In Swarm, container names follow the pattern `<stack>_<service>.<task_number>.<task_id>`.
> Use `docker ps --filter name=pg_postgres` on the manager node to find the exact name.

---

## Typical pipeline sequence (full restore)

```bash
# 1. Unblock existing connections
docker run ... pg-backup unblock -c postgres_container -d my_db

# 2. Drop the old database
docker run ... pg-backup delete -c postgres_container -d my_db

# 3. Create an empty database
docker run ... pg-backup create -c postgres_container -d my_db

# 4. Restore from the latest backup
docker run ... pg-backup restore -c postgres_container -d my_db
```
