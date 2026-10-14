# pg-backup: database backup and restore Docker image

An Alpine-based Docker image with two parts:

- A **web UI** (the default `serve` command) that backs up and restores
  PostgreSQL, MySQL / MariaDB and MongoDB databases, in Docker containers or on
  remote servers, with schedules, storage destinations and monitoring.
- A **bash CLI** (`export`, `restore`, `unblock`, `delete`, `create`) for
  PostgreSQL only, for scripts and CI/CD pipelines.

---

## Prerequisites: Docker Hub Authentication

All `docker pull` / `docker push` operations require a valid Docker Hub session.
If you see:

```
Error response from daemon: Head "https://registry-1.docker.io/v2/cswni/pg-backup/manifests/latest":
unauthorized: personal access token is expired
```

your token has expired. Follow these steps to re-authenticate:

### 1. Create a new Personal Access Token (PAT)

1. Log in to [hub.docker.com](https://hub.docker.com).
2. Go to **Account Settings → Security → Personal Access Tokens**.
3. Click **Generate new token**, give it a description (e.g. `pg-backup-ci`), choose **Read & Write** scope, and click **Generate**.
4. **Copy the token now**. It will not be shown again.

### 2. Log in from the CLI

```bash
docker login -u <your-dockerhub-username>
# Paste the new PAT when prompted for the password
```

Or pass the token directly (useful for CI/CD):

```bash
echo "<your-pat>" | docker login -u <your-dockerhub-username> --password-stdin
```

### 3. Verify

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

The CLI commands below are **PostgreSQL-only**. MySQL / MariaDB and MongoDB are
supported through the Web UI (see [MySQL / MariaDB and MongoDB](#mysql--mariadb-and-mongodb)).

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
`-f` is optional. If omitted, the latest dump for that database is used.

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
1. `/work/<file>`: mount your current directory with `-v $(pwd):/work`
2. `/backups/<file>`: mount your backups dir with `-v /path/to/backups:/backups`
3. `<file>` as-is: absolute path already inside the container

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

The Web UI (`serve`, the default command) uses **user accounts** stored in its
SQLite database (`$DATA_DIR/app.db`, by default `/backups/.pgui/app.db`, so it
persists with the backups volume). Users sign in on a login page and get a
session cookie (`pgui_session`: HttpOnly, SameSite=Lax, Secure over HTTPS,
7-day sliding expiry). The page and its assets are public; every `/api`
endpoint except login requires authentication.

**First admin (fail closed).** On startup, if there are no users yet, an admin is
created from these variables; with no users and no credentials the server
refuses to start:

| Variable | Description |
|----------|-------------|
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | Initial admin username and password (names kept for backward compatibility) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Same, takes precedence when set |
| `BASIC_AUTH_DISABLED` | Set to `true` to run without authentication: every request is an admin (local development only) |

> The variables only **seed** the first admin. Once any user exists they are
> ignored, so changing `BASIC_AUTH_PASSWORD` later does **not** change an existing
> password. Change it on the Profile page (or have another admin reset it).

**Users and roles.** Only admins create accounts (Users page, no public
sign-up). Every user can edit their own display name, email and password on the
Profile page. Passwords need at least 10 characters and are stored as scrypt
hashes.

| Role | Can |
|------|-----|
| `admin` | Everything: restores, create/drop/unblock databases, deleting backups, servers, storage, schedules, notifications and users |
| `user` | View, back up, upload, download and run schedules |

Restores are admin-only on purpose: `psql` and `mysql` execute meta-commands
embedded in a dump (e.g. `\!` runs a shell command), and this container has
the Docker socket mounted. Only restore dumps you trust.

Disabling a user or resetting/changing a password signs that user out
everywhere (the user who changes their own password stays signed in). The last
active admin cannot be deleted, disabled or demoted. Failed logins are limited
to 5 per username and IP every 15 minutes (HTTP 429).

**Scripts and CI** can keep using HTTP Basic auth with any account, with no session
or extra header needed:

```bash
curl -u admin:secret http://localhost:3000/api/backups
```

Browser requests authenticated by the session cookie must send
`X-Requested-With: pgui` on POST/PUT/PATCH/DELETE (CSRF protection; the UI does
this automatically). Always serve the UI over HTTPS (e.g. behind Traefik).

**Behind a proxy.** `X-Forwarded-*` headers (client IP for rate limiting,
`https` for secure cookies) are trusted only from loopback and private-network
hops, which covers Traefik on a Docker network. Set `TRUST_PROXY` to an
[Express "trust proxy" value](https://expressjs.com/en/guide/behind-proxies.html)
(e.g. a hop count or CIDR list) if your proxy chain differs.

For local development run the server with credentials (or
`BASIC_AUTH_DISABLED=true`) before `pnpm run dev:server`.

---

## Database Explorer

Browse what is inside a database from the Web UI: tables and views
(PostgreSQL, MySQL/MariaDB) or collections and views (MongoDB), their columns
and indexes, and their rows page by page. It works on every server kind
(Docker containers and direct servers, also through SSH tunnels) with the same
credentials the backups use.

| Who | Can |
|-----|-----|
| every signed-in role | list objects, see their structure, page through rows (any role can already download full backups) |
| `admin` | also run SQL in the console (PostgreSQL and MySQL/MariaDB) |

Everything is read-only:

- Every query runs in a read-only transaction with a 10 s statement timeout
  (`statement_timeout` on PostgreSQL, `max_execution_time` on MySQL,
  `max_statement_time` on MariaDB, `maxTimeMS` on MongoDB).
- Pages hold 1 to 200 rows (default 50); the console returns at most 500.
  Text longer than 2,000 characters is cut, binary values show their size and
  the first 32 bytes as hex.
- The console takes one statement. On PostgreSQL it runs as a subquery, so
  it accepts queries (`SELECT`, `WITH`, `VALUES`, `TABLE`); on MySQL it runs
  through `PREPARE`, so the mysql client never parses it. Client commands
  (`\` in psql; `\`, `system`, `source`, `tee`, `pager`, `!` in mysql) are
  refused, and so is a semicolon anywhere but at the end, also inside strings.
- MongoDB rows can be filtered with an Extended JSON object such as
  `{"status": "active"}`; `$where`, `$function` and `$accumulator` are refused.
- Table and collection names are only used when they appear in the database's
  catalog, and are then quoted.

The read-only transaction is the guard against writes, so extensions that open
their own connections (such as `dblink`) can still write; that is one reason
the console is admin-only. MySQL console results are text (numbers included),
and a text value `NULL` cannot be told apart from a real NULL there.

---

## Remote servers & SSH tunnels

Besides the Docker socket of the host it runs on (**Local Docker**, always
present), the Web UI can back up and restore databases on other machines.
Add them on the **Servers** page (admins only; every user can see the list).
There are two kinds:

| Kind | How it connects | Where the tools run |
|------|-----------------|---------------------|
| **Docker host over SSH** | `DOCKER_HOST=ssh://…`, the same container workflow as the local socket | `docker exec` inside the remote containers (the bash scripts) |
| **Direct database** | TCP to `host:port` with a username/password, optionally through an SSH tunnel | `psql` / `pg_dump` inside this image (`postgresql18-client`) |

Credentials (private keys, database passwords) are stored encrypted (AES-256-GCM,
key from `APP_SECRET` or `DATA_DIR/secret.key`) and are never sent back to the
browser: the UI only shows "•••• configured". When editing a server, leave a
secret field empty to keep the stored value. Deleting a server keeps every
backup that was made from it. Use **⚡ Test** on a server to check connectivity
(latency and server version, or a readable error).

### Adding a remote Docker host

1. On the remote host, create (or reuse) a user that can run `docker` without
   sudo (member of the `docker` group). The docker CLI must be installed there:
   the connection runs `docker system dial-stdio` over SSH.
2. Generate a dedicated, **unencrypted** deploy key (passphrase-protected keys
   are rejected because SSH runs non-interactively):

   ```bash
   ssh-keygen -t ed25519 -N '' -C pg-backup-ui -f pgui_deploy
   ssh-copy-id -i pgui_deploy.pub deploy@docker.example.com   # or append it to ~/.ssh/authorized_keys
   ```

3. In the UI: **Servers → Add server → Docker host over SSH**, enter host, port
   (22), user and paste the contents of `pgui_deploy` (the private key).
4. Pick the server in the selector on the **Containers** page; export, restore,
   create, delete and unblock work exactly as for local containers.

Backups are always written to this container's `/backups` volume; dumps stream
over the SSH connection.

### Direct database connections

**Servers → Add server → Direct database**: engine (PostgreSQL, MySQL / MariaDB
or MongoDB, see [below](#mysql--mariadb-and-mongodb)), host, port,
username, password, maintenance database (default `postgres`, used for
`CREATE/DROP DATABASE`) and `sslmode` (`disable`, `prefer`, `require`,
`verify-full`). The user needs `CREATEDB` (and ownership or superuser rights to
drop databases / terminate connections), e.g. a managed-database admin user.

The server's databases are listed under **Servers → Databases →**, with the same
operations as a container. Semantics match the CLI scripts: dumps are
`pg_dump -C`, restores are retargeted to the chosen database name (the shared
`scripts/pg-retarget.awk`), the target is created if missing, *Drop target*
drops it `WITH (FORCE)` first, a restore into an existing database with tables is
refused, and any `ERROR:` reported by `psql` fails the job. Passwords are passed
through `PGPASSWORD`, never on the command line.

### SSH tunnels

Enable **Connect through an SSH tunnel** on a direct server for databases that
are only reachable from a bastion/jump host (private subnets, VPCs). For each
operation the UI runs
`ssh -N -L 127.0.0.1:<free port>:<db host>:<db port> <bastion>` with
`ExitOnForwardFailure=yes`, waits until the local port accepts connections,
runs the tools against it and always closes the tunnel afterwards (also on
errors). The database host is resolved **from the bastion**, so internal names
such as `db.internal` work. With `sslmode=verify-full` the certificate is still
checked against the real database host name. The bastion needs
`AllowTcpForwarding yes`; the key setup is the same as for Docker hosts (the
bastion user does not need Docker).

### How SSH is configured (and the host-key trust model)

The UI manages its own OpenSSH configuration in `DATA_DIR/ssh/` (default
`/backups/.pgui/ssh/`) and never touches `~/.ssh`:

- `config`: one `Host pgui-<id>` block per server (HostName, Port, User,
  `IdentityFile`, `IdentitiesOnly yes`, `BatchMode yes`, `ServerAliveInterval`),
  regenerated whenever servers change.
- `<id>.key`: each server's private key (mode `0600`), written from the
  encrypted database copy.
- `known_hosts`: trusted host keys.
- `bin/ssh`: a wrapper that runs the system `ssh` with `-F DATA_DIR/ssh/config`.
  The docker CLI has no option to pass ssh flags, so docker/script processes for
  a remote host get `DOCKER_HOST=ssh://pgui-<id>` and this directory first on
  `PATH`. Keep `DATA_DIR` on a filesystem that allows executables (not `noexec`).

Host keys use **trust on first use** (`StrictHostKeyChecking accept-new`): the
first successful connection records the host's key, and later connections fail
if the key changes (possible man-in-the-middle). Each server's stored
fingerprint (`SHA256:…`) is shown on the Servers page. Compare it with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host. If the host was
legitimately reinstalled, use **Forget host key** (or change the server's host,
which forgets it automatically) and test again to trust the new key.

---

## MySQL / MariaDB and MongoDB

The **Web UI** (not the bash CLI, which stays PostgreSQL-only) also backs up and
restores MySQL / MariaDB and MongoDB, both in Docker containers and on direct
servers (optionally through an SSH tunnel). Pick the engine when adding a direct
server (default ports 3306 / 27017); containers are detected by image:

| Engine | Images detected | Raw backup file | Operations |
|---|---|---|---|
| MySQL / MariaDB | `mysql`, `mariadb`, `percona` (any name containing them) | `.sql` | export, restore, create, delete, unblock |
| MongoDB | `mongo` (any name containing it, e.g. `mongo`, `bitnami/mongodb`) | `.archive` | export, restore, delete |

Operations a driver does not support are hidden (MongoDB has no `CREATE
DATABASE` (a database exists once it holds data) and no per-database
connection kill). Restore dialogs only offer backups / targets of a matching
engine: the catalog engine is used when known, uploads are inferred from the
extension (`.archive` → MongoDB; a `.sql` of unknown origin can go to PostgreSQL
or MySQL, so pick the right target).

**Rename semantics** (restore a dump of `shop` as `shop_qa`):

- *MySQL*: exports dump ONE database **without** `--databases`
  (`mysqldump --single-transaction --quick --routines --triggers --events
  --hex-blob --no-tablespaces --default-character-set=utf8mb4 <db>`), so the file
  has no `CREATE DATABASE` / `USE`. A restore creates the target if missing and
  pipes the file into `mysql <target>`. Top-level `CREATE DATABASE …;` / `` USE `x`; ``
  lines (dumps made elsewhere with `--databases`) and the MariaDB 11
  sandbox-mode marker are stripped on the fly; a dump with **several** databases
  is refused.
- *MongoDB*: exports are `mongodump --archive --db <db>`. A restore reads the
  source database name from the archive's own prelude (so uploads without a
  catalog row work, including `mongodump --gzip --archive` files) and runs
  `mongorestore --archive --nsInclude '<src>.*' --nsFrom '<src>.*' --nsTo
  '<target>.*' --stopOnError`. Archives with several databases are refused.

Like PostgreSQL: *Drop target database* drops the target first; without it a
restore into an existing database that has tables (MySQL) / collections
(MongoDB) is refused; a tool exiting non-zero, any `ERROR …` line from `mysql`, or
`N document(s) failed to restore` fails the job, and partial export files are
removed.

**Credentials for containers** are read inside the container from the official
images' environment, never passed on a command line:

- MySQL / MariaDB / Percona: user `root`, password from `MARIADB_ROOT_PASSWORD` or
  `MYSQL_ROOT_PASSWORD` (or the `*_FILE` variants). They are written to a
  `mktemp` option file (`--defaults-extra-file`, removed afterwards). Both the
  `mariadb`/`mariadb-dump` and `mysql`/`mysqldump` tool names are supported.
  `MYSQL_RANDOM_ROOT_PASSWORD` / `MARIADB_ROOT_PASSWORD_HASH` setups cannot be
  discovered.
- MongoDB: `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD` (or
  `*_FILE`), authSource `admin`; no authentication when unset. The password
  reaches mongodump/mongorestore via a `mktemp` `--config` YAML file and mongosh
  via its environment. Listing / dropping databases uses the container's
  `mongosh` (MongoDB **6.0+** images); mongod must listen on the default port 27017.

**Direct servers** use the tools in this image: `mariadb` / `mariadb-dump`
(MariaDB client, works against MySQL 5.7+/8.x and MariaDB) with user and password
in a private option file (mode `0600`, deleted afterwards) and `--sandbox` for
restores (shell meta-commands such as `\!` in a dump are refused);
`mongodump` / `mongorestore` (mongodb-tools) with the connection string in a
private `--config` YAML file. MongoDB listing / dropping / connection tests use
the official Node.js driver (`mongodb` npm package), because `mongosh` is not in
the image; *Test* reports the server version and the `mongodump` version.
The maintenance-database field is the MongoDB auth database (default `admin`;
unused for MySQL). Connections use `directConnection=true`, so point a MongoDB
server at the **primary**. `sslmode` maps to `--skip-ssl` (disable),
unverified TLS when offered (prefer), `--ssl --skip-ssl-verify-server-cert` /
`tls=true&tlsInsecure=true` (require) and full verification (verify-full);
MongoDB has no opportunistic TLS, so `prefer` connects without TLS.
`verify-full` through an SSH tunnel is not supported for these engines (the
tools cannot verify the real host name over `127.0.0.1`). Use `require`.

**Required privileges**: MySQL export: `SELECT`, `SHOW VIEW`, `TRIGGER`,
`EVENT`, `LOCK TABLES` (and `PROCESS` is avoided via `--no-tablespaces`);
restore/create/delete: `CREATE`, `DROP`, `ALTER`, `INSERT`, `CREATE ROUTINE`,
`EVENT`, `TRIGGER` and, for routines/views with a `DEFINER` other than the
restoring user, `SET_USER_ID`/`SUPER`; unblock: `CONNECTION_ADMIN`/`PROCESS`
(or `SUPER`). MongoDB: `backup` for exports, `restore` + `dropDatabase` on the
target for restores/deletes, `listDatabases` for listing (e.g. the built-in
`backup`, `restore` and `readAnyDatabase` roles, or `root`).

**Limitations**: MySQL users and grants are **not** part of a single-database
dump (re-create them on the target); dumps from a GTID-enabled MySQL server may
contain `SET @@GLOBAL.GTID_PURGED`, which can fail on a target with its own GTID
history; MongoDB exports do not include users/roles (`--dumpDbUsersAndRoles` is
not used); scheduled backups, compression, encryption and remote copies work the
same for all engines.

---

## Scheduled backups

The **Schedules** page (`/schedules`) runs backups automatically. Each schedule has a
target (server, engine, container, database, optional output name), backup options
(compress / encrypt / remote destinations, passed through to the backup pipeline), a
cron expression and a timezone. Admins create, edit, enable/disable and delete
schedules; any signed-in user can see them and use **Run now**.

**Cron syntax**: standard 5 fields, evaluated with [croner](https://github.com/hexagon/croner):

```
┌───────────── minute (0-59)
│ ┌─────────── hour (0-23)
│ │ ┌───────── day of month (1-31)
│ │ │ ┌─────── month (1-12 or JAN-DEC)
│ │ │ │ ┌───── day of week (0-7 or SUN-SAT, 0 and 7 = Sunday)
│ │ │ │ │
0 2 * * *      daily at 02:00
15 * * * *     every hour at :15
30 3 * * 1-5   weekdays at 03:30
0 4 1 * *      on the 1st of every month at 04:00
```

`@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` are accepted too. Seconds
fields are rejected. The form offers presets and shows the next 5 run times
(`GET /api/schedules/preview?cron=…&tz=…`).

**Timezone**: every schedule stores an IANA timezone (e.g. `Europe/Madrid`); runs follow
local time in that zone including daylight-saving changes (times skipped by a DST jump
do not run, repeated times run once). New schedules default to the browser's timezone in
the UI, or the server's `TZ` (falling back to `UTC`) through the API.

**Behaviour**

- A single timer checks for due schedules every 15 seconds.
- **No overlap:** if the previous run of a schedule is still running when the next one is
  due, that run is skipped (logged as a warning) and the schedule moves to its next slot.
  **Run now** is refused with `409` while a run is in progress.
- **Catch-up after downtime:** missed runs are *not* replayed. If one or more runs were
  missed while the server was down, the schedule runs **once** shortly after startup and
  then continues on its normal cadence.
- Disabled schedules never run; re-enabling one schedules it from the next matching time.
- Scheduled jobs run as user `scheduler` and are tagged with the schedule in the job
  history; the schedule shows the last status with a link to the job log.
- Set `SCHEDULER_ENABLED=false` to turn off the timer (and overdue checks) on extra
  replicas so only one instance runs schedules. The API and **Run now** keep working.

API: `GET /api/schedules`, `GET /api/schedules/:id`, `POST /api/schedules` (admin),
`PUT /api/schedules/:id` (admin, partial bodies allowed), `DELETE /api/schedules/:id`
(admin), `POST /api/schedules/:id/run`.

---

## Monitoring

### Job history and logs

The **Jobs** page (`/jobs`) lists every operation with type/status filters, user,
duration and a link to its log. Job log lines are written to
`$DATA_DIR/logs/<jobId>.log` (JSON lines) while the job runs, so logs remain available
after the job leaves memory and across restarts. Log files older than
`JOB_LOG_RETENTION_DAYS` (default `30`) are deleted daily.

### Health check

`GET /api/health` needs no authentication and returns no secrets:

```json
{ "status": "ok", "version": "1.0.0", "uptimeSeconds": 3600, "time": "…",
  "checks": { "database": { "ok": true }, "docker": { "reachable": true, "serverVersion": "27.1.0" } } }
```

`status` is `ok`, `degraded` (local Docker daemon unreachable, checked with a 3 s
timeout and cached 30 s) or `error` (app database unusable; HTTP `503`). Use it for Docker
`HEALTHCHECK`s or load-balancer probes.

### Prometheus metrics

`GET /api/metrics` returns the Prometheus text format:

| Metric | Description |
|--------|-------------|
| `pgbackup_jobs_total{type,status}` | Jobs recorded by type and status |
| `pgbackup_jobs_running` | Jobs currently running |
| `pgbackup_job_duration_seconds{type}` | Histogram of finished job durations |
| `pgbackup_last_successful_backup_timestamp_seconds{server,database}` | Last successful backup per database |
| `pgbackup_schedule_last_success_timestamp_seconds{schedule_id,schedule}` | Last successful run per schedule (0 = never) |
| `pgbackup_schedule_next_run_timestamp_seconds{schedule_id,schedule}` | Next planned run |
| `pgbackup_schedule_overdue{schedule_id,schedule}` | `1` when the schedule is overdue (see below) |
| `pgbackup_schedule_enabled{schedule_id,schedule}` | `1` enabled, `0` disabled |
| `pgbackup_backup_files`, `pgbackup_backup_bytes` | Backup files in the backups directory |
| `pgbackup_up`, `pgbackup_process_uptime_seconds` | Liveness |

Authentication: set `METRICS_TOKEN` and scrape with `Authorization: Bearer <token>`
(no other credentials needed). Without the token header the endpoint requires the
normal UI login.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: pg-backup
    metrics_path: /api/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ['backups.example.com']
```

Example alert: `time() - pgbackup_last_successful_backup_timestamp_seconds > 2 * 86400`
or `pgbackup_schedule_overdue == 1`.

### Notifications

**Notifications** (`/settings/notifications`, admins only) manages webhooks. Each webhook
has a name, URL, payload format and the events it receives:

| Format | Payload |
|--------|---------|
| Generic JSON | `{ event, title, text, timestamp, jobId, status, database, error, … }` |
| Slack | `{ "text": "…" }` (Slack / Mattermost incoming webhooks) |
| Discord | `{ "content": "…" }` |
| Microsoft Teams | Adaptive Card message (Teams *Workflows* "post to a channel when a webhook request is received") |

Events: **job failed**, **job succeeded**, **schedule missed / overdue**. A schedule is
overdue when its last successful run is older than twice its interval (measured from the
last edit for new schedules) or when a planned run is more than 10 minutes late; each
incident is notified once and re-arms after the schedule is healthy again.

Webhook URLs are treated as secrets: stored encrypted, never returned by the API and
never logged. Delivery uses a 10 s timeout and up to 3 retries with backoff (network
errors, `429`, `5xx`) and never blocks or fails the job. **Send test** posts a test
message with a single attempt. Set `PUBLIC_URL` (e.g. `https://backups.example.com`) to
include a link to the job log in notifications.

### Logging and environment variables

Server logs from the scheduler and monitoring modules are structured.

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `LOG_FORMAT` | text | `json` writes one JSON object per line (for Loki, ELK, CloudWatch…) |
| `JOB_LOG_RETENTION_DAYS` | `30` | Days to keep persisted job logs |
| `TZ` | `UTC` | Default timezone for new schedules created through the API |
| `SCHEDULER_ENABLED` | `true` | `false` disables the schedule timer and overdue checks |
| `METRICS_TOKEN` | (none) | Bearer token accepted by `/api/metrics` |
| `PUBLIC_URL` | (none) | Base URL used for links in notifications |

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
| `APP_SECRET` | Key used to encrypt stored credentials (S3 keys, OAuth secrets/tokens, the passphrase). If unset a key is generated in `$DATA_DIR/secret.key`: back it up or set `APP_SECRET` |

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
they were created. Keep a record of every passphrase you have used.

#### Offline decryption (disaster recovery)

`decrypt-cli.js` needs only Node.js ≥ 18: no web server, database or
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
   user, or publish the app so the refresh token does not expire after 7 days).
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

Policies: keep the **newest N** backups and/or backups **younger than D days**,
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

The image includes a `pg-backup` command (a link to its entrypoint), so the CLI
commands also run inside an already running container:

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
