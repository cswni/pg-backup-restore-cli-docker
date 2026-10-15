# Plan: antislop MEDIUM/LOW fixes + Database Explorer

Started: 2026-10-14. Branch: `ui` (merge to `main` builds the image; deploy notes at the end).
This file is the single source of truth for this work. **Keep it updated**: tick a box
as soon as its work is committed, and add the commit hash. Any agent can resume from here.

## How to resume (for a new agent)

1. Read this file top to bottom, then `git log --oneline -15` on `ui`.
2. Find the first unticked box in the current phase. Check `git log` / the code to see
   whether it was partly done (a phase may be half-merged).
3. Conventions: `CLAUDE.md` (antislop skills; session mode is **after**, already chosen by
   the user, so do not ask again), Node 24, `npx -y pnpm@12.11.2` from `ui/`
   (`install`, `test`, `run build`), Windows + Git Bash, no Docker locally.
   Tests need Git's `usr/bin` on PATH for `awk` (`C:\Program Files\Git\usr\bin`).
4. Before ticking anything: `npx -y pnpm@12.11.2 test` and `npx -y pnpm@12.11.2 run build`
   must pass. Commit with conventional messages, no attribution lines. Never touch `.ai/`
   or `.codex/`.
5. When a phase is done, run the antislop Delivery Gate and write the result into
   `anti-slop/` (see Phase A3 / B5).

## Decisions (apply everywhere)

- **Direction**: keep the current dark zinc/emerald look. No redesign.
- **Product name**: "PG Backup & Restore" (UI, docs). The command inside the image is
  `pg-backup`; the image is `pg-backup-restore-cli`.
- **Terminology**: the action is **Back up** (button/label text; the API op id stays
  `export`), the artifact is a **backup** (never "dump file" in UI copy; "dump" only when
  describing the tool output, e.g. pg_dump). Remote storage targets are **remote
  destinations**; the files stored there are **remote copies**. No "cloud".
- **Icons**: replace emoji used as icons with one monochrome SVG set: `lucide-react`
  (devDependency; bundled into the frontend), `aria-hidden` when decorative, sized with
  `size-4`/`size-5`, `currentColor`. Keep plain-text status words.
- **Color**: color is for status only (success/warning/error/running). Engine and server
  kind badges become neutral zinc chips with text. One chip radius: `rounded-md`.

## Phase A: antislop findings 12 to 24 (`anti-slop/audit-001-2026-10-13.md`)

A1, client (`ui/client/**`):
- [x] #12 emoji as icons replaced by lucide-react icons (nav, buttons, badges, toasts, favicon/logo; 🐘 no longer stands for every engine) (commit 860c88e)
- [x] #13 arrows kept only on back links (commit 860c88e)
- [x] #14 pulse animation behind `prefers-reduced-motion: no-preference` (commit 4b57b5c)
- [x] #15 `h-screen` → `h-dvh` (commit 4b57b5c)
- [x] #16 client comment slop (JSX section labels, restating comments, banners, index.css notes) (commit 4b57b5c, 860c88e)
- [x] #17 decorative status dots removed or tied to real state (commit 860c88e)
- [x] #18 one chip radius (`rounded-md`) (commit 860c88e)
- [x] #19 engine/kind badges neutral; color only for status (commit 860c88e)
- [x] #20 dashboard: failures / next runs before the stat row (commit 860c88e)
- [x] #21 terminology in UI copy (see Decisions) (commit 860c88e)
- [x] #22 product name consistent in the UI (commit 860c88e)

A2, server, scripts, docs (everything outside `ui/client`):
- [x] #16 comment slop in `ui/server`, `scripts/`, Dockerfile, CI, compose (banners, separators, restating comments, redundant JSDoc, repeated step orders, commented-out `#image:` line) (commits d9e2dba, dd5b640)
- [x] #21 terminology in docs (README, TODO, docs/) (commit fcb1fdd)
- [x] #22 product name consistent in README and `entrypoint.sh` help (commits dd5b640, fcb1fdd)
- [x] #23 server messages: validation errors use form labels instead of API field names, specific "not found" messages, bootstrap log points to the Profile page (update tests that assert messages) (commit 63abe85)
- [x] #24 README structure: Usage (web UI first) at the top, maintainer Docker Hub section at the end, `restore -x` instead of the old pipeline sequence, engine coverage (mariadb-dump/mongodump, `.archive`), Limitations cleanup, dangling arrow; TODO heading/casing (commit fcb1fdd)

A3:
- [x] merge A1 + A2 into `ui`, tests + build green, browser check (desktop + 375px) (merge 6edd63a; schedule destination picker fix aa54b50)
- [x] follow-up report `anti-slop/audit-001-2026-10-14-followup-medium-low.md` with Delivery Gate

## Phase B: Database Explorer

Goal: browse what is inside a database from the web UI: tables/views (PostgreSQL, MySQL)
or collections (MongoDB), their structure, and their rows, page by page. Optional
read-only SQL console for admins.

Access: browsing is allowed for every signed-in role (users can already download full
backups); the SQL console is admin-only. Everything is read-only.

### API contract (both B1 and B2 build against this; do not change without updating here)

Common query parameters: `serverId` (default `local`), `engine` (`postgres|mysql|mongodb`),
`container` (Docker servers only), `database` (validated with `isValidDbName`).

- `GET /api/explorer/objects?…&database=` →
  `{ objects: [{ schema, name, type: 'table'|'view'|'collection', rows: number|null, sizeBytes: number|null }] }`
  (`schema` is `null` for MySQL/MongoDB; `rows` is an estimate from catalog stats)
- `GET /api/explorer/structure?…&database=&schema=&name=` →
  `{ columns: [{ name, type, nullable, default: string|null, primaryKey: bool }], indexes: [{ name, columns: [string], unique: bool }] }`
  (MongoDB: `columns` from sampling up to 100 documents, `type` = observed BSON types joined by `|`; `indexes` from `listIndexes`)
- `GET /api/explorer/rows?…&database=&schema=&name=&limit=50&offset=0&sort=<column>&dir=asc|desc[&filter=<MongoDB JSON filter>]` →
  `{ columns: [string], rows: [[cell]], offset, limit, hasMore: bool, total: number|null }`
  - `limit` 1 to 200 (default 50); cells are JSON values; strings longer than 2,000
    characters are cut and flagged as `{ truncated: true, value, length }`; binary values
    are `{ binary: true, length, preview: '<hex of first 32 bytes>' }`
  - `sort` must be an existing column (checked against the structure); `filter` only for MongoDB (parsed as Extended JSON, must be an object)
- `POST /api/explorer/query` (admin only; PostgreSQL and MySQL) body `{ serverId, engine, container, database, sql, limit=200 }` →
  `{ columns, rows, truncated: bool, durationMs }`; runs in a read-only transaction with a
  10 s statement timeout; at most 500 rows; rejects input that starts a client meta-command
  (psql backslash commands; mysql `\`, `system`, `source`, `tee`, `pager`, `!`)

Errors: `{ error }` with 400 (validation), 403 (console for non-admin), 404 (unknown
object), 502 (database unreachable / tool failure, with the tool's message).

Security rules: object names are never interpolated unless they exist in the catalog
listing for that database, and are then quoted with the engine's identifier quoting;
numbers are validated integers; passwords go through env/option files exactly like the
backup drivers (`connectivity/process.js` `toolEnv`, `tunnel.js` `withConnection`);
Docker targets run the client inside the container like the drivers do.

### Tasks

B1, server (`ui/server/explorer/**`, one line in `modules.js`, small exports from driver helpers if needed):
- [x] PostgreSQL adapter (Docker + direct): objects, structure, rows, query (commit d56cc4a)
- [x] MySQL/MariaDB adapter (Docker + direct): objects, structure, rows, query (commit d56cc4a)
- [x] MongoDB adapter (Docker via mongosh, direct via `mongodb` driver): objects, structure, rows (+ filter) (commit d56cc4a)
- [x] routes + validation + permissions, tests with fake tools (no real DB locally) (commit d56cc4a)

B2, client (`ui/client/**`):
- [x] `/explorer` page (nav "Explorer"): pick server → container (Docker) → database; deep link via query string (commit 5148f4b)
- [x] object list with search (tree on desktop, select on mobile), row-count/size hints (commit 5148f4b)
- [x] Data tab: paginated table, sort by column, page size, cell detail for truncated/binary/JSON values, MongoDB filter box (commits aef64f9, 5148f4b)
- [x] Structure tab: columns + indexes (commit 5148f4b)
- [x] Query tab (admins, PostgreSQL/MySQL only): textarea, run, result grid, timing, truncation notice (commits 5148f4b, bd4d7ec)
- [x] "Explore" action on database rows (DatabaseWorkspace) linking to `/explorer?…` (commit fdcf243)
- [x] accessible + responsive (antislop rules: real `<table>`, `th scope`, keyboard, 375px) (commit 5148f4b)

B3-B5:
- [x] B3 merge B1 + B2, tests + build green (merges e0c349d, 18f6757; fixes 40d6885: JSON 400 for malformed bodies, 44px row actions)
- [x] B4 check against real databases on s1 (MariaDB + PostgreSQL containers, read-only API checks) and local browser check; README section "Database Explorer" (d56cc4a)
- [x] B5 antislop Delivery Gate for the new UI (`anti-slop/explorer-2026-10-14-delivery.md`)

## Phase D: container credentials (requested 2026-10-14)

Problem: Docker targets only use the container's own env vars (`MYSQL_ROOT_PASSWORD`,
`MARIADB_ROOT_PASSWORD`, `MONGO_INITDB_ROOT_*`) and PostgreSQL always runs as OS user
`postgres`. On s1 `legacy_legacydb` fails (stale env password) and `mcp-postgres-core`
fails (image has no `postgres` OS user). Admins need to set credentials per server/container.

Design (decided):
- Stored per **server + container key**, encrypted with `secrets.js`, admin-only.
  Key = Swarm **service name** when the container name looks like a Swarm task
  (`<service>.<slot>.<25-char task id>`, e.g. `legacy_legacydb.1.oznkxm16y64xdhboove8qazir`
  → `legacy_legacydb`), otherwise the container name. So credentials survive redeploys.
- Fields: `engine`; PostgreSQL: `username` (default postgres), `password`, `osUser`
  (OS user for `docker exec -u`; default `postgres`; empty = the image's default user),
  `host` (optional, e.g. `127.0.0.1` to force TCP + password); MySQL/MariaDB: `username`,
  `password`; MongoDB: `username`, `password`, `authSource` (default `admin`).
- Without an override nothing changes (current env-var behaviour is the fallback).
- Secrets never on argv: set them in the env of the local `docker` process and pass them
  with `docker exec -e NAME` (no value; Docker copies it from the client env). Never return
  passwords to the browser (`passwordConfigured: true`).
- Used everywhere a Docker target runs a client: `postgres-docker` driver (listDatabases
  and the bash scripts via env vars the scripts honour), `mysql-docker` and `mongodb-docker`
  drivers (their in-container `sh -c` wrappers prefer the override vars), Explorer adapters.

API (admin only):
- `GET /api/servers/:id/container-credentials` → `[{ key, engine, username, osUser, host, authSource, passwordConfigured, updatedAt }]`
- `PUT /api/servers/:id/container-credentials/:key` body `{ engine, username, password?, osUser?, host?, authSource? }` (blank password keeps the stored one; `password: null` clears it)
- `DELETE /api/servers/:id/container-credentials/:key`
- `POST /api/servers/:id/container-credentials/:key/test` body `{ container }` → `{ ok, databases?: number, error? }` (lists databases with the saved credentials)
- `GET /api/containers` adds `credentialKey` and `credentialsConfigured` to each container.

Tasks:
- [x] D1 store + key derivation + resolution helper (`ui/server/containercreds/`), migration, tests (commits 5d591bd, b41913f)
- [x] D2 bash scripts honour `PG_EXEC_USER` (OS user; empty = none), `PGUSER`, `PGPASSWORD`, `PGHOST` (passed with `docker exec -e`), defaults unchanged; `bash -n`; CLI help documents them (commit 8310067)
- [x] D3 drivers + Explorer use the override (postgres/mysql/mongodb Docker), tests with fakes (commit 5d591bd)
- [x] D4 API routes + permission/validation tests (commit b41913f)
- [x] D5 UI: "Container credentials" section per Docker server on the Servers page (list running containers + saved keys, status: saved / from container env), edit dialog per engine, test button; "Credentials" button on the container page; admin-only (commit 99c5147)
- [ ] D6 README section (done, 3eae0cb), tests + build green (done), deploy, verify on s1 with `legacy_legacydb` and `mcp-postgres-core` (user enters the real credentials) (code, README, tests 331/331, CI 38568470803 and deploy done: image bc885eeb24a0; remaining: user enters credentials for legacy_legacydb and premas-arch-2025_mcp-postgres-core in Servers > Local Docker > Container credentials, then verify)

## Phase E: edit and delete rows in the Explorer (requested 2026-10-14)

Clicking a row in the Data tab opens the row. Admins can edit (update) or delete it.

Decisions (defaults chosen by the lead; the user may change them):
- Admin only. Everyone else gets the read-only row view.
- Only tables with a primary key (PostgreSQL, MySQL) or collections (MongoDB, `_id`).
  Views, tables without a primary key, and partitioned parents if unsupported: read-only
  with a short explanation.
- One row per request, addressed by its full primary key (`_id` for MongoDB). Primary key
  columns themselves are not editable.
- Optimistic concurrency: the request carries the original values of the edited fields;
  the UPDATE/DELETE matches them too (`IS NOT DISTINCT FROM` in PostgreSQL, `<=>` in MySQL,
  equality filter in MongoDB). 0 affected rows → 409 "This row changed or no longer exists.
  Reload and try again." Delete matches the key plus the row's other loaded non-truncated
  values the same way.
- Not editable here: truncated cells (`{ truncated }`), binary cells, generated/identity
  "always" columns where detectable; shown read-only with a reason.
- Values: the client sends JSON values (string, number, boolean, null, or object/array for
  JSON/document fields). PostgreSQL: literals quoted safely and cast to the column type
  (`'…'::<type>`); MySQL: hex string literals (`CONVERT(X'…' USING utf8mb4)`), as the
  console does; MongoDB: Extended JSON parsed with the driver's EJSON, `$`-prefixed keys
  and operators refused in values.
- Identifiers only from the catalog (as for reads); columns must exist in the structure.
- Statement timeout 10 s; no read-only transaction for these two endpoints only.
- Audit: each change runs as a job (type `explorer-update` / `explorer-delete`) with
  server, database, object, key and changed column names (no values) and the username, so
  it appears in Jobs history and notifications.

API (admin only):
- `PATCH /api/explorer/row` body `{ serverId, engine, container?, database, schema?, name, key: { col: value }, original: { col: value }, changes: { col: value } }` → `{ ok: true, jobId }`
- `DELETE /api/explorer/row` body `{ serverId, engine, container?, database, schema?, name, key, original }` → `{ ok: true, jobId }`
- `GET /api/explorer/structure` additionally returns `editable: bool`, `editableReason: string|null`, `primaryKey: [col]`, and per column `editable: bool`.
- Errors: 400 validation, 403 non-admin, 404 unknown object, 409 concurrency conflict / no matching row, 502 database error (message verbatim).

Tasks:
- [x] E1 server: structure `editable`/`primaryKey`, PATCH/DELETE routes, SQL builders per engine (PostgreSQL, MySQL, MongoDB; Docker + direct), audit jobs, tests (injection attempts, conflicts, permissions) (commits 9e18034, 3884205, 037e5e6, b79a6fa, 74b72e0, fc39cd5, README fa74b96)
- [ ] E2 client: row click opens a row dialog (all roles, read-only fields); admins: Edit (per-field inputs: text, NULL toggle, JSON textarea for json/jsonb/document), Save with conflict handling, Delete with confirmation showing the key; refresh the page after success; Data tab copy no longer says read-only
- [ ] E1 server: structure `editable`/`primaryKey`, PATCH/DELETE routes, SQL builders per engine (PostgreSQL, MySQL, MongoDB; Docker + direct), audit jobs, tests (injection attempts, conflicts, permissions)
- [x] E2 client: row click opens a row dialog (all roles, read-only fields); admins: Edit (per-field inputs: text, NULL toggle, JSON textarea for json/jsonb/document), Save with conflict handling, Delete with confirmation showing the key; refresh the page after success; Data tab copy no longer says read-only (commits 60d0765, b98d7f7)
- [ ] E3 README + Explorer copy ("Nothing here changes data" → accurate), tests + build, deploy, verify on s1 on a scratch table (create a throwaway table only with the user's consent)

## Phase C: release

- [x] push `ui` and fast-forward `main`; CI green (70a4761, run 38543533600)
- [x] redeploy s1, image 3f5d077f32ec (`cd /var/www/image-pg-backup-restore && set -a && . ./.env && set +a && docker stack deploy -c docker-compose.yml pgbackup --with-registry-auth --resolve-image always`), wait until the new task runs, check `/api/health`, auth, backups and containers

## Log

- 2026-10-14: plan created (after commit 487f365, deployed image `1407cde51d83`).
- 2026-10-14: A2 done (d9e2dba, 63abe85, dd5b640, fcb1fdd): server/scripts/CI comment cleanup, form-label validation messages, README restructure; tests 256/256, build passes. README image name now matches CI (`pg-backup-restore-cli`, was `cswni/pg-backup`).
- 2026-10-14: A1 client fixes #12 to #22 done in 4b57b5c and 860c88e (lucide-react devDependency, build + 256 tests green, browser check desktop + 375px).
- 2026-10-14: Phase A complete (A1+A2 merged in 6edd63a, picker fix aa54b50, follow-up report written). B1 and B2 running in parallel.
- 2026-10-14: B1 done (d56cc4a): ui/server/explorer API + README "Database Explorer" section; mysql drivers export open(); tested with fake tools only, not against real databases.
- 2026-10-14: B2 client done (aef64f9, 5148f4b, fdcf243, bd4d7ec): `/explorer` page with URL state, object list, Data/Structure/Query tabs, Explore action on database rows; checked against a throwaway mock of the contract at desktop and 375px; build + 256 tests green.
- 2026-10-14: B3 done. Local smoke test: Explorer deep link, real errors with Retry, console guards (one statement, no meta-commands, MongoDB 400, user 403). Next: deploy and B4 check against s1 databases.
- 2026-10-14: B4/B5 and Phase C done. Explorer verified on s1 against MariaDB and PostgreSQL containers. Deployed image 3f5d077f32ec.
- 2026-10-14: D1 to D5 + README done (8310067, 5d591bd, b41913f, 99c5147, 3eae0cb); tests 331/331, build passes. Checked locally with a faked docker CLI (desktop + 375px): save, wrong/right password test, clear password, delete, not-running key, container page button. Not yet run against real containers; next: deploy and D6 check on s1. Note: pg-create/delete/unblock now pass `-d postgres` explicitly (same database psql picked before for the postgres user).
- 2026-10-14: E1 done (9e18034..fa74b96): PATCH/DELETE /api/explorer/row as explorer-update/explorer-delete jobs, structure editability, rows now return bigint/decimal as text; tests 354/354, build passes. Fakes only, not run against real databases. Choices: PostgreSQL casts to format_type without typmod, json/jsonb compared as ::jsonb, arrays/composites via to_jsonb, arrays read-only; MySQL `_utf8mb4 X'..'` literals, bare numbers for exact numeric text, UPDATE counts matched rows with SELECT ... FOR UPDATE (ROW_COUNT() counts changed rows), FLOAT/DOUBLE not compared; MongoDB reads the document, compares display values, then writes with `$eq` on the raw values.

## Follow-ups (not started)

- [ ] `legacy_legacydb` (MariaDB): root password in the container env no longer matches the server, so listing databases fails (Access denied). Option: per-container credentials override in the UI.
- [ ] `mcp-postgres-core`: custom image without an OS user `postgres`, so `docker exec -u postgres` fails. Option: fall back to `docker exec <ctr> psql -U postgres` when the user does not exist.
- [ ] Explorer not yet exercised against MongoDB or a direct (SSH-tunnelled) server.
- 2026-10-14: Phase D merged (067fd77), CI green, deployed bc885eeb24a0; no regressions on s1 (mariadb 4 dbs, postgres 8 dbs). Waiting for the user to save credentials for the two failing containers.
- 2026-10-14: E2 done (60d0765, b98d7f7): RowDialog/RowField/rowValues in `components/explorer`, `api.explorer.updateRow/deleteRow`; checked against a throwaway mock of the Phase E contract (desktop + 375px, PATCH payloads, 409 + Reload, 502 verbatim, delete confirmation, view not editable, non-admin read-only); build + 331 tests green. Client keeps PostgreSQL arrays and MongoDB date/ObjectId/long/decimal fields read-only. Also fixed a 375px page overflow from the grid's sr-only labels.
