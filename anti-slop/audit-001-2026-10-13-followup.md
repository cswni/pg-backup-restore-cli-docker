# antislop audit 001: follow-up

Mode: after. Approved by the user: all HIGH findings (1 to 11). MEDIUM and LOW (12 to 24) were not touched.

## Fixed

| # | Rule | Fix |
|---|------|-----|
| 1 | R-38 | User role text matches the API (no restores for `user`). Dashboard says "Database containers". Sidebar shows the live version from `/api/health`. One product name, "PG Backup & Restore", shared by Layout, Login and the page title. Non-admins see "Upload", not "Upload & Restore". |
| 2 | R-38 | README intro and CLI help describe the web UI for PostgreSQL, MySQL/MariaDB and MongoDB plus the PostgreSQL-only CLI. The image now has a `pg-backup` command (symlink to `entrypoint.sh`), so the documented `docker exec … pg-backup …` examples work. The help example no longer has a comment after a line-continuation backslash. |
| 3 | R-38 | The seven false comments now match the code (entrypoint `exec`/trap and cwd, jobs.js flat fields, CI step mounts, Dockerfile duplicate `WORKDIR` removed, real example keys in settings.js and db.js). |
| 4 | R-03 | `* { font-size: 24px }` replaced by `html { font-size: 125% }`: text stays larger, headings and labels keep their hierarchy. |
| 5 | R-25 | Secondary text and placeholders moved to zinc-400 (6.75:1 on zinc-900, 7.59:1 on zinc-950, 5.68:1 on zinc-800; before 1.7 to 4.1). Primary buttons use dark text on emerald-500 (8.04:1, hover 10.26:1; before 3.65 and 2.47). Danger hover red-700 (6.42:1). Input borders and toggle track zinc-500 (3.67:1; before 1.70). Checked with `contrast-check.py`. |
| 6 | R-32 | Shared `Modal` (role dialog, labelled, Escape, initial focus, focus trap, focus return, scrolls in the viewport) used by every dialog. Keyboard-reachable upload drop zone. Icon-only buttons labelled. Labels tied to their controls. |
| 7 | R-27 | Failed requests show the real error with Retry instead of "0 containers", "Loading…" forever or "No running container". JobLog tells a lost live connection apart from a failed job. Spinner and toasts are announced (`role="status"` / `alert`). |
| 8 | R-26 | Copy buttons use `navigator.clipboard` only on secure origins, fall back otherwise, and say whether the copy worked. |
| 9 | R-03 | Below md the sidebar becomes a top bar with a Menu drawer. Page padding `p-4 md:p-8`, wrapping headers, one-column forms, modals that scroll, row actions visible on touch, 44px tap targets. |
| 10 | R-02 | No em or en dashes left in the web UI, server messages, scripts, README, TODO or docs. Empty values read "never", "none", "unknown" and similar words. |
| 11 | R-36 | "Encrypted backups can't be restored without it, by this app or any other tool." |

## Delivery Gate

**Block 1, Hard Gate: PASS.** The HIGH findings (R-02, R-03, R-25, R-26, R-27, R-32, R-36, R-38) are resolved in the files the audit cited. No new decoration, gradients, invented content or false claims were added.

**Block 2, Purpose-Gate: not run.** MEDIUM findings 12 to 15 (emoji icons, arrows on links, pulse animation without a reduced-motion guard, `h-screen`) were not approved and remain open.

**Block 3, Liveliness: unchanged.** The direction is the existing dark zinc/emerald look, kept as decided. No restyling.

**Block 4, Craftsmanship and Quality Locks: partial.** The fixes follow existing patterns, every file stays under 400 lines, and the shared Modal, Toast and clipboard helper removed duplicated code. LOW findings 16 to 24 (comment clutter, badge radii and colors, dashboard order, terminology, README structure) remain open.

## Evidence

- `pnpm test`: 256 tests, 256 pass. `pnpm run build`: passes.
- Browser check (local server, no Docker):
  - Dashboard shows the real Docker error and "Unavailable" instead of 0. The live version shows.
  - At 375px wide: no horizontal overflow; the Menu drawer opens with focus inside, closes on Escape and returns focus to Menu.
  - The upload dialog closes on Escape and returns focus.
- Not verified: a real screen reader, a real job's lost-stream path, copying on a non-HTTPS origin, the Docker image build (CI will build it).

## Still open (not approved)

12 to 24 from `audit-001-2026-10-13.md`.
