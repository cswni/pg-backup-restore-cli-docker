# antislop audit 001: follow-up for MEDIUM and LOW (12 to 24)

Mode: after. Approved by the user: all MEDIUM and LOW findings. HIGH (1 to 11) were fixed
earlier (`audit-001-2026-10-13-followup.md`). Direction unchanged: the dark zinc/emerald look.

## Fixed

| # | Rule | Fix | Commits |
|---|------|-----|---------|
| 12 | R-04 | Emoji used as icons replaced by one monochrome set (`lucide-react`, `aria-hidden`, `currentColor`), including nav, buttons, toasts, empty states and the favicon (neutral database glyph instead of the PostgreSQL mascot). Reason for the library: one consistent, accessible stroke set instead of mixed emoji glyphs that render differently per OS. | 860c88e |
| 13 | R-08 | Arrows only on back links. | 860c88e |
| 14 | R-19 | Pulse animation runs only under `prefers-reduced-motion: no-preference`. | 4b57b5c |
| 15 | R-03 | `h-dvh` / `min-h-dvh` instead of `h-screen`. | 4b57b5c |
| 16 | R-31 | Comment clutter removed in client, server, scripts, Dockerfile, CI and compose (banners, separators, restating comments, redundant JSDoc, repeated step orders, commented-out image line). Explanatory comments kept. | 4b57b5c, d9e2dba, dd5b640 |
| 17 | R-31 | Decorative status dots removed; dots that mark real state are `aria-hidden`. | 860c88e |
| 18 | R-11 | One chip radius (`rounded-md`). | 860c88e |
| 19 | R-29 | Engine, kind, role and backup badges are neutral; color only marks status. | 860c88e |
| 20 | R-20 | Dashboard shows failures, next runs and last backups before the smaller stat row. | 860c88e |
| 21 | R-16 | "Back up" (action), "backup" (file), "remote destinations" / "remote copies" in UI and docs; ScheduleForm hints rewritten. | 860c88e, fcb1fdd |
| 22 | R-20 | One product name, "PG Backup & Restore"; command `pg-backup`; README examples use the published image `pg-backup-restore-cli`. | dd5b640, fcb1fdd |
| 23 | R-16 | Server validation errors use the form labels; specific not-found messages; bootstrap log points to the Profile page; tests updated. | 63abe85 |
| 24 | R-05/R-16 | README: usage first (web UI, then CLI), engines table, `restore -x`, maintainers section at the end; TODO headings and casing. | fcb1fdd |

Found during the fixes:
- The schedule form asked for remote destination IDs (UUIDs the UI never shows). It now
  lists the destinations by name as checkboxes and keeps deleted IDs visible (aa54b50).
- Reported: the upload dialog showing "No running container…" when Docker is down. Not
  reproducible on the merged build: it shows "Could not list containers: <error>".

## Delivery Gate

**Block 1, Hard Gate: PASS.** No em/en dashes, invented content, decorative gradients or
false claims introduced; HIGH fixes intact (contrast pairs re-checked for the new chips:
zinc-300 on zinc-800 10.08:1, amber-300 chip 9.41:1, brand icon 9.22:1).

**Block 2, Purpose-Gate: PASS.** Icons are functional and labelled by the text next to
them; motion respects reduced-motion; arrows only where they mean "go back".

**Block 3, Liveliness: unchanged by design.** The direction is the existing look; no
restyling was requested.

**Block 4, Craftsmanship and Quality Locks: PASS.** One chip radius, status-only color,
consistent terminology and naming, files under 400 lines, comments that explain why.

## Evidence

- `pnpm test` 256/256, `pnpm run build` passes (after merging A1 and A2, commit 6edd63a, and after aa54b50).
- Browser: every page at desktop and 375px (no page-level horizontal scroll), dialogs close
  with Escape, schedule destination picker with and without destinations.
- Not verified: pages with real container, backup and job data (no Docker locally).
