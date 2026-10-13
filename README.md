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
> password — change it on the Profile page (or have another admin reset it).

**Users and roles.** Only admins create accounts (Users page, no public
sign-up). Every user can edit their own display name, email and password on the
Profile page. Passwords need at least 10 characters and are stored as scrypt
hashes.

| Role | Can |
|------|-----|
| `admin` | Everything, including managing users and deleting backups |
| `user` | View, back up, restore, upload and download |

Disabling a user or resetting/changing a password signs that user out
everywhere (the user who changes their own password stays signed in). The last
active admin cannot be deleted, disabled or demoted. Failed logins are limited
to 5 per username and IP every 15 minutes (HTTP 429).

**Scripts and CI** can keep using HTTP Basic auth with any account — no session
or extra header needed:

```bash
curl -u admin:secret http://localhost:3000/api/backups
```

Browser requests authenticated by the session cookie must send
`X-Requested-With: pgui` on POST/PUT/PATCH/DELETE (CSRF protection; the UI does
this automatically). Always serve the UI over HTTPS (e.g. behind Traefik).

For local development run the server with credentials (or
`BASIC_AUTH_DISABLED=true`) before `pnpm run dev:server`.

---

## Remote servers & SSH tunnels

Besides the Docker socket of the host it runs on (**Local Docker**, always
present), the Web UI can back up and restore databases on other machines.
Add them on the **Servers** page (admins only; every user can see the list).
There are two kinds:

| Kind | How it connects | Where the tools run |
|------|-----------------|---------------------|
| **Docker host over SSH** | `DOCKER_HOST=ssh://…` — the same container workflow as the local socket | `docker exec` inside the remote containers (the bash scripts) |
| **Direct database** | TCP to `host:port` with a username/password, optionally through an SSH tunnel | `psql` / `pg_dump` inside this image (`postgresql18-client`) |

Credentials (private keys, database passwords) are stored encrypted (AES-256-GCM,
key from `APP_SECRET` or `DATA_DIR/secret.key`) and are never sent back to the
browser — the UI only shows "•••• configured". When editing a server, leave a
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

**Servers → Add server → Direct database**: engine (PostgreSQL), host, port,
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

- `config` — one `Host pgui-<id>` block per server (HostName, Port, User,
  `IdentityFile`, `IdentitiesOnly yes`, `BatchMode yes`, `ServerAliveInterval`),
  regenerated whenever servers change.
- `<id>.key` — each server's private key (mode `0600`), written from the
  encrypted database copy.
- `known_hosts` — trusted host keys.
- `bin/ssh` — a wrapper that runs the system `ssh` with `-F DATA_DIR/ssh/config`.
  The docker CLI has no option to pass ssh flags, so docker/script processes for
  a remote host get `DOCKER_HOST=ssh://pgui-<id>` and this directory first on
  `PATH`. Keep `DATA_DIR` on a filesystem that allows executables (not `noexec`).

Host keys use **trust on first use** (`StrictHostKeyChecking accept-new`): the
first successful connection records the host's key, and later connections fail
if the key changes (possible man-in-the-middle). Each server's stored
fingerprint (`SHA256:…`) is shown on the Servers page — compare it with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host. If the host was
legitimately reinstalled, use **Forget host key** (or change the server's host,
which forgets it automatically) and test again to trust the new key.

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
