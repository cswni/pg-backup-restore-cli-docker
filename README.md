# PG Backup & Restore

A Docker image (`pg-backup-restore-cli`) with two parts:

- A **web UI** (the default `serve` command) that backs up and restores
  PostgreSQL, MySQL / MariaDB and MongoDB databases, in Docker containers or on
  remote servers, with schedules, remote destinations and monitoring.
- A **bash CLI** (`pg-backup export`, `restore`, `unblock`, `delete`, `create`)
  for PostgreSQL only, for scripts and CI/CD pipelines.

The image is published as `ghcr.io/cswni/pg-backup-restore-cli` and
`cswni/pg-backup-restore-cli` (Docker Hub).

---

## Usage

### Web UI

Mount the Docker socket so the UI can reach database containers, and a host
directory on `/backups` so backups (and the app's own data in
`/backups/.pgui`) persist:

```bash
docker run -d --name pg-backup -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/backups:/backups \
  -e BASIC_AUTH_USER=admin \
  -e BASIC_AUTH_PASSWORD='<at least 10 characters>' \
  -e APP_SECRET='<long random string>' \
  ghcr.io/cswni/pg-backup-restore-cli:latest
```

Open `http://localhost:3000` and sign in as `admin`. The two `BASIC_AUTH_*`
variables only create the first admin (see [Web UI authentication](#web-ui-authentication));
`APP_SECRET` encrypts stored credentials (see [Backup storage](#backup-storage-compression-encryption-remote-copies-retention)).

With Docker Compose:

```yaml
# docker-compose.yml
services:
  pg-backup:
    image: ghcr.io/cswni/pg-backup-restore-cli:latest
    command: serve
    ports:
      - "3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./backups:/backups
    environment:
      BASIC_AUTH_USER: ${BASIC_AUTH_USER:-admin}
      BASIC_AUTH_PASSWORD: ${BASIC_AUTH_PASSWORD:?BASIC_AUTH_PASSWORD must be set}
      APP_SECRET: ${APP_SECRET:?APP_SECRET must be set}
      PUBLIC_URL: ${PUBLIC_URL:-}   # external https URL, needed for Google Drive
      TZ: ${TZ:-UTC}                # default timezone for new schedules
```

The repository's `docker-compose.yml` is a Swarm stack behind Traefik. On
Swarm the Docker socket is only the one of the node the task runs on, so pin
the service to a node with a placement constraint.

### CLI (PostgreSQL only)

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/backups:/backups \
  ghcr.io/cswni/pg-backup-restore-cli <command> [options]
```

Inside a running container (for example the web UI one) the same commands are
available as `pg-backup <command>`:

```bash
docker exec pg-backup pg-backup export -c postgres -d your_db
docker compose exec pg-backup pg-backup restore -c postgres -d your_db -x
```

MySQL / MariaDB and MongoDB are handled by the web UI only (see
[MySQL / MariaDB and MongoDB](#mysql--mariadb-and-mongodb)).

#### export

Back up a database to `/backups/<name>_<DD-MM-YYYY_HH_MM_SS>.sql` (a
`pg_dump -C` dump). `-n <name>` is optional and defaults to the database name.
Restore uses the file name prefix as the default target database, so
`-d premas -n premas_qa` produces a backup that restores as `premas_qa`.

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/backups:/backups \
  ghcr.io/cswni/pg-backup-restore-cli export -c <container> -d <database> [-n <name>]
```

#### restore

Restore a database from a backup. `-f` is optional; without it the newest
`<database>_*.sql` in `/work` or `/backups` is used.

- `-d` is the **target** database. The backup is always restored into it,
  whatever database it was taken from (e.g. a `premas` backup restored into
  `premas_qa`). The target is created if it does not exist.
- `-x` drops the target database (`WITH (FORCE)`) first, so the restore starts
  from an empty database. This replaces the old unblock, delete, create,
  restore sequence.
- Without `-x`, restoring into an existing database that already has tables is
  refused. The command exits non-zero if psql reports any SQL error.

```bash
# Replace "premas_qa" with a backup of "premas"
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/backups:/backups \
  ghcr.io/cswni/pg-backup-restore-cli restore -c <container> -d premas_qa -x -f premas_01-01-2025_12_00_00.sql
```

File resolution order for `-f <file>`:

1. `/work/<file>`: mount your current directory with `-v $(pwd):/work`
2. `/backups/<file>`: mount your backups directory with `-v /path/to/backups:/backups`
3. `<file>` as-is: an absolute path inside the container

#### unblock, delete, create

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/cswni/pg-backup-restore-cli unblock -c <container> -d <database>   # terminate active connections
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/cswni/pg-backup-restore-cli delete -c <container> -d <database>    # DROP DATABASE ... WITH (FORCE)
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/cswni/pg-backup-restore-cli create -c <container> -d <database>    # CREATE DATABASE
```

On Swarm, container names follow `<stack>_<service>.<task_number>.<task_id>`;
use `docker ps --filter name=<stack>_postgres` on the node to find the exact name.

---

## Engines

| Engine | Docker containers | Direct servers (tools in this image) | Backup file |
|---|---|---|---|
| PostgreSQL | the CLI scripts (`psql`, `pg_dump` inside the container) | `psql`, `pg_dump` | `.sql` |
| MySQL / MariaDB | `mariadb` / `mariadb-dump` or `mysql` / `mysqldump` inside the container | `mariadb`, `mariadb-dump` | `.sql` |
| MongoDB | `mongodump` / `mongorestore` and `mongosh` inside the container | `mongodump`, `mongorestore` and the Node.js driver | `.archive` |

Web UI backups can be compressed (`.gz`) and encrypted (`.enc`), e.g.
`shop_<ts>.archive.gz.enc`. The CLI writes plain `.sql` files.

### Container credentials

By default the tools in a Docker container log in with what the container
itself provides: PostgreSQL runs as the `postgres` OS user (`docker exec -u
postgres`), MySQL / MariaDB uses `root` with `MARIADB_ROOT_PASSWORD` /
`MYSQL_ROOT_PASSWORD`, MongoDB uses `MONGO_INITDB_ROOT_USERNAME` /
`MONGO_INITDB_ROOT_PASSWORD` (or their `*_FILE` variants).

When that does not work (a password changed after the container was created,
an image without a `postgres` OS user), an admin can save credentials per
container in **Servers → Container credentials** on the Docker server's card,
or with the **Credentials** button on the container page:

- PostgreSQL: username, password, OS user (leave it empty to use the image's
  default user) and host (`127.0.0.1` logs in with the password over TCP
  instead of the local socket)
- MySQL / MariaDB: username, password
- MongoDB: username, password, auth database (default `admin`)

Saved credentials are used for backups, restores, database lists and the
Explorer. They are stored encrypted (like server passwords), never sent back to
the browser, and reach the container only as environment variables
(`docker exec -e NAME`, never on a command line). For a Swarm task container
(`<service>.<slot>.<task id>`) they are saved under the service name, so they
still apply after a redeploy. Without saved credentials nothing changes.

The PostgreSQL CLI commands honour the same settings through environment
variables of the `pg-backup` container:

| Variable | Effect |
|---|---|
| `PG_EXEC_USER` | OS user for `docker exec -u`. Unset: `postgres`. Set but empty: no `-u` |
| `PGUSER`, `PGPASSWORD`, `PGHOST` | Forwarded to `psql` / `pg_dump` with `docker exec -e NAME` when not empty |

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v $(pwd)/backups:/backups \
  -e PG_EXEC_USER= -e PGUSER=app -e PGPASSWORD -e PGHOST=127.0.0.1 \
  ghcr.io/cswni/pg-backup-restore-cli export -c mcp-postgres-core -d app
```

---

## Web UI authentication

The web UI uses **user accounts** stored in its SQLite database
(`$DATA_DIR/app.db`, by default `/backups/.pgui/app.db`, so it persists with the
backups volume). Users sign in on a login page and get a session cookie
(`pgui_session`: HttpOnly, SameSite=Lax, Secure over HTTPS, 7-day sliding
expiry). The page and its assets are public; every `/api` endpoint except login
requires authentication.

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
embedded in a backup (e.g. `\!` runs a shell command), and this container has
the Docker socket mounted. Only restore backups you trust.

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
| `admin` | also run SQL in the console (PostgreSQL and MySQL/MariaDB), and edit or delete single rows |

Browsing and the console are read-only:

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

### Editing and deleting rows (admins)

Admins can change or delete one row at a time from the Data tab:

- Only tables with a primary key (PostgreSQL, MySQL/MariaDB) and collections
  (MongoDB, by `_id`) can be edited. Views, foreign tables and tables without
  a primary key stay read-only, and the Structure tab says why.
- Primary key columns, generated and identity `ALWAYS` columns, binary
  columns, PostgreSQL arrays and values cut at 2,000 characters cannot be
  edited.
- Conflict check: the change only applies when the row still holds the values
  the page showed (`IS NOT DISTINCT FROM` on PostgreSQL, `<=>` on MySQL, an
  equality filter on MongoDB). If someone changed or deleted it in between,
  nothing is written and the UI asks you to reload. A delete compares every
  loaded value of the row. MySQL `FLOAT`/`DOUBLE` columns are not compared
  (the page shows a rounded value).
- `bigint` and `decimal` values are shown as text so they keep every digit.
- MongoDB values are read as Extended JSON (`{"$oid": "…"}`,
  `{"$date": "…"}`); field names starting with `$` or containing dots are
  refused, and `_id` cannot be changed.
- Each change has a 10 s statement timeout and runs as a job
  (`explorer-update` or `explorer-delete`) that records the server, database,
  table, the row's key and the changed column names (never the new values) and
  who made it, so it shows up in Jobs history and in notifications.

---

## Remote servers and SSH tunnels

Besides the Docker socket of the host it runs on (**Local Docker**, always
present), the web UI can back up and restore databases on other machines.
Add them on the **Servers** page (admins only; every user can see the list).
There are two kinds:

| Kind | How it connects | Where the tools run |
|------|-----------------|---------------------|
| **Docker host over SSH** | `DOCKER_HOST=ssh://…`, the same container workflow as the local socket | `docker exec` inside the remote containers |
| **Direct database** | TCP to `host:port` with a username/password, optionally through an SSH tunnel | inside this image: `psql` / `pg_dump`, `mariadb` / `mariadb-dump` or `mongodump` / `mongorestore` (see [Engines](#engines)) |

Credentials (private keys, database passwords) are stored encrypted (AES-256-GCM,
key from `APP_SECRET` or `DATA_DIR/secret.key`) and are never sent back to the
browser: the UI only shows "•••• configured". When editing a server, leave a
secret field empty to keep the stored value. Deleting a server keeps every
backup that was made from it. Use **Test** on a server to check connectivity
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
4. Pick the server in the selector on the **Containers** page; back up, restore,
   create, delete and unblock work exactly as for local containers.

Backups are always written to this container's `/backups` volume; dumps stream
over the SSH connection.

### Direct database connections

**Servers → Add server → Direct database**: engine (PostgreSQL, MySQL / MariaDB
or MongoDB, see [below](#mysql--mariadb-and-mongodb)), host, port,
username, password, maintenance database (default `postgres`, used for
`CREATE/DROP DATABASE`) and `sslmode` (`disable`, `prefer`, `require`,
`verify-full`). The PostgreSQL user needs `CREATEDB` (and ownership or superuser
rights to drop databases / terminate connections), e.g. a managed-database admin
user.

Each direct server's databases are listed on its **Databases** page (the link on
its card on the Servers page), with the same operations as a container. For
PostgreSQL the semantics match the CLI scripts: dumps are `pg_dump -C`, restores
are retargeted to the chosen database name (the shared
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

The **web UI** (not the bash CLI, which stays PostgreSQL-only) also backs up and
restores MySQL / MariaDB and MongoDB, both in Docker containers and on direct
servers (optionally through an SSH tunnel). Scheduled backups, compression,
encryption and remote copies work the same as for PostgreSQL. Pick the engine
when adding a direct server (default ports 3306 / 27017); containers are
detected by image:

| Engine | Images detected | Raw backup file | Operations |
|---|---|---|---|
| MySQL / MariaDB | `mysql`, `mariadb`, `percona` (any name containing them) | `.sql` | back up, restore, create, delete, unblock |
| MongoDB | `mongo` (any name containing it, e.g. `mongo`, `bitnami/mongodb`) | `.archive` | back up, restore, delete |

Operations a driver does not support are hidden: MongoDB has no `CREATE
DATABASE` (a database exists once it holds data) and no per-database
connection kill. Restore dialogs only offer backups and targets of a matching
engine: the catalog engine is used when known, uploads are inferred from the
extension (`.archive` → MongoDB; a `.sql` of unknown origin can go to PostgreSQL
or MySQL, so pick the right target).

**Rename semantics** (restore a backup of `shop` as `shop_qa`):

- *MySQL*: backups dump one database **without** `--databases`
  (`mariadb-dump` or `mysqldump` with `--single-transaction --quick --routines
  --triggers --events --hex-blob --no-tablespaces --default-character-set=utf8mb4
  <db>`), so the file has no `CREATE DATABASE` / `USE`. A restore creates the
  target if missing and pipes the file into the client for `<target>`. Top-level
  `CREATE DATABASE …;` / `` USE `x`; `` lines (dumps made elsewhere with
  `--databases`) and the MariaDB 11 sandbox-mode marker are stripped on the fly;
  a dump with **several** databases is refused.
- *MongoDB*: backups are `mongodump --archive --db <db>`. A restore reads the
  source database name from the archive's own prelude (so uploads without a
  catalog row work, including `mongodump --gzip --archive` files) and runs
  `mongorestore --archive --nsInclude '<src>.*' --nsFrom '<src>.*' --nsTo
  '<target>.*' --stopOnError`. Archives with several databases are refused.

Like PostgreSQL: *Drop target database* drops the target first; without it a
restore into an existing database that has tables (MySQL) / collections
(MongoDB) is refused; a tool exiting non-zero, any `ERROR …` line from the MySQL
client, or `N document(s) failed to restore` fails the job, and partial backup
files are removed.

**Credentials for containers** are read inside the container from the official
images' environment, never passed on a command line, unless an admin saved
others (see [Container credentials](#container-credentials)):

- MySQL / MariaDB / Percona: user `root`, password from `MARIADB_ROOT_PASSWORD` or
  `MYSQL_ROOT_PASSWORD` (or the `*_FILE` variants). They are written to a
  `mktemp` option file (`--defaults-extra-file`, removed afterwards). Both the
  `mariadb`/`mariadb-dump` and `mysql`/`mysqldump` tool names are supported.
  `MYSQL_RANDOM_ROOT_PASSWORD` / `MARIADB_ROOT_PASSWORD_HASH` setups cannot be
  discovered: save the credentials in the UI instead.
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

**Required privileges**: MySQL backup: `SELECT`, `SHOW VIEW`, `TRIGGER`,
`EVENT`, `LOCK TABLES` (`PROCESS` is avoided via `--no-tablespaces`);
restore/create/delete: `CREATE`, `DROP`, `ALTER`, `INSERT`, `CREATE ROUTINE`,
`EVENT`, `TRIGGER` and, for routines/views with a `DEFINER` other than the
restoring user, `SET_USER_ID`/`SUPER`; unblock: `CONNECTION_ADMIN`/`PROCESS`
(or `SUPER`). MongoDB: `backup` to back up, `restore` + `dropDatabase` on the
target for restores/deletes, `listDatabases` for listing (e.g. the built-in
`backup`, `restore` and `readAnyDatabase` roles, or `root`).

**Limitations**: MySQL users and grants are **not** part of a single-database
dump (re-create them on the target); dumps from a GTID-enabled MySQL server may
contain `SET @@GLOBAL.GTID_PURGED`, which can fail on a target with its own GTID
history; MongoDB backups do not include users/roles (`--dumpDbUsersAndRoles` is
not used).

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

## Backup storage: compression, encryption, remote copies, retention

Configured in the web UI under **Storage** (`/settings/storage`, admin only).
Every web UI backup runs through this pipeline:

```
dump tool → db_<ts>.sql (.archive for MongoDB) → gzip → .sql.gz → encrypt → .sql.gz.enc → upload → retention
```

Restores run the reverse automatically (download if the file is only remote →
decrypt → decompress) using temporary files in `$DATA_DIR/tmp` that are deleted
afterwards. Compression and encryption defaults can be overridden per backup in
the backup dialog, which also lets you pick the remote destinations to upload to.

| Variable | Description |
|----------|-------------|
| `BACKUP_ENCRYPTION_PASSPHRASE` | Encryption passphrase. When set it **overrides** the passphrase stored in the UI |
| `PUBLIC_URL` | External URL of the UI, e.g. `https://backups.example.com`. Used to build the Google OAuth redirect URI. If unset it is derived from the request (`X-Forwarded-Proto`/`Host` behind a proxy) |
| `APP_SECRET` | Key used to encrypt stored credentials (database passwords, SSH keys, S3 keys, OAuth secrets/tokens, the passphrase). If unset a key is generated in `$DATA_DIR/secret.key`: back it up or set `APP_SECRET` |

### Compression

Streaming gzip (`.gz`), on by default at level 6 (1 = fastest … 9 = smallest).
Uploaded `.sql.gz` files can be restored like plain `.sql` backups.

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
| end - 16 | 16 | GCM authentication tag |

The 56-byte header is authenticated together with the data, so any modification
of the file is detected. On restore the file is decrypted to a temporary file
which is only used after the authentication tag has verified. A single file is
limited to 64 GiB (AES-GCM limit).

> **Losing the passphrase makes encrypted backups unrecoverable.** Store it in
> a password manager or vault, outside the backup server.

**Changing the passphrase** only affects new backups. Replaced passphrases are
kept (encrypted) and tried automatically when restoring older backups. If you
lose the app database, older backups need the passphrase that was active when
they were created. Keep a record of every passphrase you have used.

#### Offline decryption (disaster recovery)

`decrypt-cli.js` needs only Node.js ≥ 18: no web server, database or
`node_modules`. Inside the image:

```bash
docker run --rm -it -v $(pwd)/backups:/backups --entrypoint node ghcr.io/cswni/pg-backup-restore-cli \
  /ui/server/storage/decrypt-cli.js --gunzip /backups/premas_01-10-2026_02_00_00.sql.gz.enc /backups/premas.sql
```

It prompts for the passphrase (no echo); alternatively pass it as
`BACKUP_ENCRYPTION_PASSPHRASE` or pipe it on stdin. Without `--gunzip` it writes
the decrypted `.sql.gz`. On any machine with Node.js you can instead copy the two
files `ui/server/storage/decrypt-cli.js` and `ui/server/storage/crypto-format.js`
from this repository and run `node decrypt-cli.js [--gunzip] <in.enc> <out>`.
The output file is removed if the passphrase is wrong or the file was tampered with.

### Remote destinations

Add remote destinations under **Storage → Remote destinations**. Destinations
marked *default* receive every backup unless the backup selects destinations
explicitly. Each upload is recorded in the backup catalog; the Backups page shows
the remote copies of each backup, and backups whose local file was deleted (e.g.
by retention) stay listed as *remote only* and can still be restored (they are
downloaded and their SHA-256 checksum is verified first).

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
| Access key ID / Secret access key | an access key limited to that bucket (needs `PutObject`, `GetObject`, `DeleteObject`) |
| Force path-style URLs | enable for MinIO and most self-hosted servers |

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
5. In **Storage → + Google Drive** paste the OAuth client ID and secret,
   optionally a folder ID (the last part of the folder URL), and save.
6. Click **Connect Google Drive**, sign in and allow access. You are redirected
   back to the Storage page; the refresh token is stored encrypted.

Use *Reconnect* if access was revoked. Changing the client ID requires
connecting again.

### Retention

Policies: keep the **newest N** backups and/or backups **younger than D days**,
for local files (Storage → Retention) and separately for each remote destination
(in its form). Retention runs after every backup and once a day (and on demand
with *Run retention now*); every deletion is written to the job log.

- Policies apply per **group**: same server + container + source database.
- A copy is deleted only if it is outside **every** configured rule.
- The newest copy of each group in each place (local / each destination) and
  the backup just created are never deleted.
- Deleting a local file keeps the catalog entry while remote copies exist.
- Files without catalog metadata (uploads, CLI backups) are only touched when
  their `name_DD-MM-YYYY_HH_MM_SS` prefix matches exactly one group; anything
  else is left alone.

---

## Maintainers

### Build and publish

Every push to `main` runs `.github/workflows/publish.yml`: unit tests and the
frontend build, CLI and web UI integration tests against a PostgreSQL container,
then a push to `ghcr.io/cswni/pg-backup-restore-cli` and
`cswni/pg-backup-restore-cli` (tags `latest` and `sha-<commit>`).

Local build:

```bash
docker build -t pg-backup-restore-cli .
```

### Docker Hub authentication

Pushing to Docker Hub (and pulling when rate-limited) needs a valid session. If
you see:

```
Error response from daemon: Head "https://registry-1.docker.io/v2/cswni/pg-backup-restore-cli/manifests/latest":
unauthorized: personal access token is expired
```

the personal access token (PAT) has expired:

1. Log in to [hub.docker.com](https://hub.docker.com), open **Account Settings →
   Security → Personal Access Tokens** and click **Generate new token** (e.g.
   `pg-backup-ci`, **Read & Write** scope). Copy it now; it is shown only once.
2. Log in from the CLI and paste the token as the password:

   ```bash
   docker login -u <your-dockerhub-username>
   # or, in CI:
   echo "<your-pat>" | docker login -u <your-dockerhub-username> --password-stdin
   ```

3. Update the `DOCKERHUB_TOKEN` repository secret used by the publish workflow.
4. Verify with `docker pull cswni/pg-backup-restore-cli:latest`.
