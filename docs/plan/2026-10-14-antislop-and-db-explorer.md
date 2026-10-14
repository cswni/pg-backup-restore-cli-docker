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
- [ ] B4 browser check against a real database if one is reachable, else with the API mocked/fake; README section "Database Explorer"
- [ ] B5 antislop Delivery Gate for the new UI (`anti-slop/explorer-2026-10-14-delivery.md`)

## Phase C: release

- [ ] push `ui` and fast-forward `main`; CI green
- [ ] redeploy s1 (`cd /var/www/image-pg-backup-restore && set -a && . ./.env && set +a && docker stack deploy -c docker-compose.yml pgbackup --with-registry-auth --resolve-image always`), wait until the new task runs, check `/api/health`, auth, backups and containers

## Log

- 2026-10-14: plan created (after commit 487f365, deployed image `1407cde51d83`).
- 2026-10-14: A2 done (d9e2dba, 63abe85, dd5b640, fcb1fdd): server/scripts/CI comment cleanup, form-label validation messages, README restructure; tests 256/256, build passes. README image name now matches CI (`pg-backup-restore-cli`, was `cswni/pg-backup`).
- 2026-10-14: A1 client fixes #12 to #22 done in 4b57b5c and 860c88e (lucide-react devDependency, build + 256 tests green, browser check desktop + 375px).
- 2026-10-14: Phase A complete (A1+A2 merged in 6edd63a, picker fix aa54b50, follow-up report written). B1 and B2 running in parallel.
- 2026-10-14: B1 done (d56cc4a): ui/server/explorer API + README "Database Explorer" section; mysql drivers export open(); tested with fake tools only, not against real databases.
- 2026-10-14: B2 client done (aef64f9, 5148f4b, fdcf243, bd4d7ec): `/explorer` page with URL state, object list, Data/Structure/Query tabs, Explore action on database rows; checked against a throwaway mock of the contract at desktop and 375px; build + 256 tests green.
- 2026-10-14: B3 done. Local smoke test: Explorer deep link, real errors with Retry, console guards (one statement, no meta-commands, MongoDB 400, user 403). Next: deploy and B4 check against s1 databases.
