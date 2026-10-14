# Database Explorer: antislop Delivery Gate

Feature: `/explorer` page and `/api/explorer/*` (read-only browsing of tables, views and
collections; admin SQL console for PostgreSQL and MySQL). Mode: after (session choice).
Direction: the existing dark zinc/emerald look.

## Block 1, Hard Gate: PASS

- No invented content: every number on the page comes from the database catalog; unknown
  row counts and sizes are left out instead of shown as 0 (R-17, R-38).
- Honest states: loading, empty ("no tables") and error states for every request; tool and
  database errors are shown verbatim with Retry (R-27).
- Contrast AA for every new pair (zinc-400 on zinc-900/950/800: 6.91/7.76/5.81; selected
  row text 5.69 and 8.18; error text 6.40; focus outline 9.22) (R-25).
- Keyboard and screen readers: real `<table>` with caption and `th scope`, sort buttons
  with `aria-sort`, WAI-ARIA tabs with arrow/Home/End, labelled controls, cell detail in the
  shared Modal (Escape, focus return), errors as `role="alert"` (R-32).
- No em/en dashes, no emoji, no decorative gradients (R-02, R-04).

## Block 2, Purpose-Gate: PASS

- Color only marks state (selected object, errors); NULL is an outlined token, value kinds
  differ by tone and shape, not by new hues.
- Icons (lucide) only next to text labels and `aria-hidden`.

## Block 3, Liveliness: unchanged by design

The view reuses the app's existing components and direction; no new visual language.

## Block 4, Craftsmanship and Quality Locks: PASS

- One chip radius, the shared Modal/Toast/ErrorAlert, files under 400 lines
  (largest explorer component under 160 lines).
- Mobile at 375px: the object list becomes a select, tables scroll inside their card, no
  page-level horizontal scroll, 44px tap targets (row actions fixed in 40d6885).
- URL holds the whole selection, so links can be shared and back/forward works.

## Evidence

- Server tests: 308/308 (50 explorer tests: SQL builders, guards, parsers, cell shapes,
  permissions, 400/403/404/502). Build passes.
- Against real databases on s1 (read-only, values not inspected): MariaDB 58 objects,
  structure with PK and indexes, rows with mixed types and NULL, sorting, unknown column 400,
  unknown table 404, console `SELECT 1` and two-statement rejection; PostgreSQL 26 objects,
  structure, rows with truncated long values, sorting, the same guards and console checks.
- Local: deep link, error states without Docker, meta-command rejection, JSON 400 for
  malformed bodies.

## Known limitations (documented in README "Database Explorer")

- PostgreSQL console accepts queries only (SELECT, WITH, VALUES, TABLE); a semicolon is
  only allowed at the end, even inside string literals.
- MySQL console values come back as text; an empty result has no column names.
- MongoDB sort columns are checked against a 100-document sample.
- Not yet run against MongoDB or a direct (SSH-tunnelled) server.
