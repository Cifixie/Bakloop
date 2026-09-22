# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

**Two promote-draft bugs fixed + draft_source feature — shipped.** The promote loop now
finds tasks and preserves verbatim draft text through the entire lifecycle.

**Bug fixes:**
- `promote-draft.ts:71` — removed `await backlog.setDescription(draftId, "")` that wiped
  the draft text before any tick ran. The draft text is now preserved.
- `backlog.list(undefined, project)` — project name was passed as the status parameter,
  making the query `WHERE status = 'book'` which matched nothing. Fixed to
  `backlog.list(project)` in tick.ts (×2), overlap.ts, and promote-draft.ts.

**draft_source: D-018** — the verbatim draft text persists in a `draft_source TEXT`
column on the tasks table:
- `resolvePhase` routes to `criteria` directly when `draftSource` is set, so the owner
  rewrite never runs on the root task and the original words are never overwritten.
- `createChild` inherits `draftSource` from the parent, so every subtask carries the
  original ask.
- Both loops (`promote-draft.ts` and `main.ts`) inject `draftSource` as an "Original
  request" block in `renderPrompt`, visible to every role throughout the lifecycle.
- Schema migration in `Backlog` constructor adds the column for existing DBs; new DBs
  get it from `CREATE TABLE IF NOT EXISTS`.
- `INSERT` derived from `COLUMNS` ensures column-order consistency; `createDraft` uses
  a named-INSERT for safety.

**Verified:** 40/40 tests pass, typecheck clean. The round-trip test in routing.test.ts
confirms the schema column, migration, and inheritance work end-to-end against a real DB.
BOOK-1 is in Draft with 6567 chars of `draft_source` — ready to promote with
`pnpm run promote-draft book`.

**Project prefix and task ID format (D-016, D-017) — shipped and verified.** Every project
now carries a `prefix: string` on registration (`--prefix=ABC`), auto-derived from the key
slug if omitted. Task IDs are `PREFIX-N` (e.g. `BOOK-1`, `BOOK-2`). The prefix is unique
across all registered projects, validated at register time. `pnpm run unregister <key|prefix>`
removes per-project state and optionally clone directories.

`pnpm run list` shows `(baseBranch) [PREFIX]` per entry.
