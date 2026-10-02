# AGENTS.md

This project uses **spec-driven development** (SDD) via **Blueprint
Blueprint** (the `blueprint` command). Every AI coding agent working here —
Cursor, Claude Code, Codex, OpenCode — should read this file first.

## Project metadata

- **Name:** `pg-backup-restore-cli`
- **Type:** `generic`
- **Initialized:** 2026-10-02 via `blueprint init`
- **Memory store:** `~/.blueprint/local.db` (queryable via the
  `blueprint` MCP server; see below)

## Working style

Every non-trivial feature moves through the SDD pipeline. Blueprint wraps
[Spec Kit](https://github.com/github/spec-kit): `blueprint <phase>` records
the run; the agent then runs the printed `/speckit-<phase>` slash command so
artifacts are authored with Spec Kit's templates under `.specify/`.
`blueprint init` scaffolds Spec Kit into the repo automatically.

1. `blueprint specify <slug>` — write `specs/<slug>/spec.md`. What are we
   building? What's the user-facing outcome? What's explicitly out of
   scope?
2. `blueprint clarify` — surface ambiguity **before** planning. Do not skip
   for anything with meaningful uncertainty.
3. `blueprint plan` — produces `specs/<slug>/plan.md`: tech stack decisions,
   architecture sketch, risks.
4. `blueprint checklist` + `blueprint analyze` — validate the spec/plan/tasks
   trio is internally consistent.
5. `blueprint tasks` — produces `specs/<slug>/tasks.md`: ordered, dependency-
   aware task list.
6. `blueprint implement` — execute tasks in order.
7. `blueprint converge` — re-audit after implementation; append remaining
   gaps as new tasks. Repeat until converged.

During **specify**, **clarify**, and **plan**, switch to **Plan mode** and use
`AskQuestion` for confirmations (clickable Questions card). Never paste Option
A/B/C as markdown. Switch to **Agent mode** before tasks / implement / converge.

`specs/` is **VCS-ignored on purpose** — the source of truth is the
Blueprint memory store (queryable, live-viewable). Commit only shipped code.

## Memory protocol

Before proposing a solution:

```
blueprint memory search <keywords> --project pg-backup-restore-cli    # prior decisions
blueprint memory context --project pg-backup-restore-cli --limit 10   # recent activity
```

Or via MCP: call `bp_memory_search` / `bp_memory_context` on the `blueprint`
server (already registered in this workspace's `.cursor/mcp.json`).

After every non-trivial decision, save an observation:

```
blueprint memory save "Chose X over Y" "Reasoning: ..." \
    --type decision --scope project --project pg-backup-restore-cli \
    --topic <area>/<decision-name>
```

The `--topic` key makes future revisions of the same decision merge
into the same row (revision-tracked, not duplicated).

## Type-specific guidance

- No project-type-specific overlay applies. Follow the general SDD
  cadence: `specify → clarify → plan → analyze → tasks → implement →
  converge`, and update this section with domain conventions as they
  emerge.
- **Skills to load:** `ponytail` (always).

## Handoff protocol

When ending a session, save a summary observation so the next agent
(or a fresh chat) picks up cleanly:

```
blueprint memory save "Session summary: <one-line what changed>" \
    "<3-5 bullet points on state, blockers, next step>" \
    --type discovery --scope project --project pg-backup-restore-cli
```

## Cursor-native rules

`.cursor/rules/blueprint.mdc` mirrors these instructions in Cursor's rule
format and is auto-applied to every chat in this workspace.
