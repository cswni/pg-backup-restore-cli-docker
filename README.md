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

## Scheduled backups

The **Schedules** page (`/schedules`) runs backups automatically. Each schedule has a
target (server, engine, container, database, optional output name), backup options
(compress / encrypt / remote destinations, passed through to the backup pipeline), a
cron expression and a timezone. Admins create, edit, enable/disable and delete
schedules; any signed-in user can see them and use **Run now**.

**Cron syntax** — standard 5 fields, evaluated with [croner](https://github.com/hexagon/croner):

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

**Timezone** — every schedule stores an IANA timezone (e.g. `Europe/Madrid`); runs follow
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

`status` is `ok`, `degraded` (local Docker daemon unreachable — checked with a 3 s
timeout, cached 30 s) or `error` (app database unusable; HTTP `503`). Use it for Docker
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
| `METRICS_TOKEN` | — | Bearer token accepted by `/api/metrics` |
| `PUBLIC_URL` | — | Base URL used for links in notifications |

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
