# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**Working on:** Nothing in flight. Latest landed two fixes to the draft-capture path,
both discovered from the same "draft export cuts/garbles the description" report — they
turned out to be two unrelated bugs, not one:

1. `src/create-draft.ts`'s `readMultiline` used to capture the pasted description by
   calling `rl.question("")` in a loop, one call per line, until a lone `.` sentinel. A
   large multi-line paste of long/wrapped lines arriving in one burst could get its
   per-call prompt redraws interleaved by the terminal, splicing fragments of different
   lines together — real corruption of the captured text (word fragments spliced
   mid-line), not a display artifact, confirmed by inspecting the actual draft file on
   disk. Fixed by capturing through `$EDITOR` instead (temp file, spawn editor, read
   back, same pattern as `git commit`/`crontab -e`) — the paste lands in the user's own
   editor and never touches Node's line-based redraw logic. The instructions footer is
   cut at an exact sentinel line (`EDITOR_SENTINEL`), not filtered by a "starts with #"
   line match — the description may legitimately start with its own markdown `# Heading`
   (used for title auto-detection), and a prefix filter would eat that. Follow-up: a
   plain `:qa`/`:q` in Vim refuses to quit once the buffer has unsaved changes (its own
   safety behavior, not ours to override), so a non-zero editor exit is now treated as an
   intentional cancel (`readMultiline` returns `null`, `create-draft.ts` prints "Cancelled
   — no draft created." and exits clean) — the footer tells the user to exit with `:cq`
   to cancel unconditionally, the same convention `git commit` relies on. Second
   follow-up, the real fix: pasting into the spawned `$EDITOR` still misbehaved (couldn't
   get `:wq` to register) because `create-draft.ts`'s own `readline` interface (for the
   project/title prompts) stayed open across the `spawnSync` call — it's only closed in
   `main()`'s outer `finally`. Readline puts the tty in raw mode for its own line-editing
   and doesn't hand it cleanly back until `close()` runs, so vim inherited a terminal
   still in Node's raw-mode state instead of a normal one. Fixed by scoping `rl` tightly
   around just the two line-prompts and explicitly closing it (`rl.close()` +
   `process.stdin.setRawMode(false)`) before the editor spawns, not after `main()`
   returns.
2. Separately, `parseOwnerOutput` (`src/spec.ts`) truncated the description whenever the
   owner role's own prose contained a list-like line (e.g. "supports: 1. X 2. Y") before
   the real acceptance-criteria list — it split at the *first* list-like line in the
   whole text, cutting everything after it (including the rest of the description) into
   "acceptance criteria." Fixed by having `prompts/owner.md` ask for the same explicit
   `Acceptance criteria:` header line that `prompts/planner.md` already requires (see
   `parsePlannerOutput`'s `AC_HEADER`), so `parseOwnerOutput` can split on a literal
   header instead of guessing from list shape; a backward-scan heuristic is kept only as
   a fallback for when a local model ignores the header.

Both affect `src/promote-draft.ts`'s draft-promotion flow; #2 also affects
`src/tick.ts`'s owner phase. No test suite exists yet to lock either in — see Notes
below.

Before that: `npm run setup` (`src/setup.ts`)
non-interactively initializes the shared Backlog.md store under `$BAKLOOP_HOME` — it
`git init`s the store first (backlog.md only prompts to create a repo if one isn't
already there; this keeps the store on its own local git history, no GitHub remote,
without the interactive wizard) then runs `backlog init` and rewrites `config.yml`'s
`statuses`/`default_status` to match `STATUS` in `src/types.ts`, forces `remote_operations:
false` (single local store, no remote configured), and forces `auto_commit: true` (the
store is its own git repo, never the target repo's, so committing every task write is
safe and keeps its history durable). Idempotent — re-running only re-applies these
fix-ups. Gotcha worth knowing if you touch this again: `backlog
init` creates its own `backlog/` subdir under whatever cwd it's given, so it must run
from `bakloopHome()`, one level above `backlogDir()` — running it from `backlogDir()`
itself nests a second `backlog/` inside it.

`register-project.ts` now also handles a fresh store correctly: backlog.md omits the
`projects:` key entirely from `config.yml` when the list is empty (it doesn't write
`projects: []`), so the script used to only warn and leave the project unregistered in
backlog.md's own config on a brand-new store. It now appends a new `projects: [...]`
line when the key is missing, in addition to the existing append-to-array path when it's
already there. Before that: `pnpm start <key>` accepts the project
key as an argv fallback (`BAKLOOP_PROJECT` env still wins if set — `src/main.ts`), and a
two-step manual-task path — `pnpm run new-draft <key>` (`src/create-draft.ts`) captures a
copy-pasted ticket (roadmap entry, GitHub issue) as a Backlog.md *draft*, tagged for a
project via a `project:<key>` label since drafts have no structured `project` field of
their own; `pnpm run promote-draft [draft-id] [key]` (`src/promote-draft.ts`) runs the
same `owner` prompt the tick loop uses to draft a description + acceptance criteria from
the raw text, shows it for review, then promotes and sets project/type/priority.
`pnpm run promote-draft -- --all` loops that same per-draft flow over every existing
draft in one process instead of re-invoking per id — the y/N review gate still runs once
per draft; it's not batch-approved. Drafts
are invisible to the tick loop (`Backlog.list()` only ever calls `task list`, never
`draft list`), so a half-formed capture can't be picked up mid-pipeline. Before that: the
planner's subtask-split mechanism (D-004/D-005) and clean Ctrl+C/SIGTERM handling
(D-006). No fixed roadmap — development here is feature-driven; see `CLAUDE.md`'s Map.

**Next action:**
1. If picking up nested-split support: read the gotcha in `wiki/gotchas.md` first — the
   branch-sharing logic needs to walk to the root ancestor, not just the immediate parent,
   before it's safe to let a subtask itself be split.
2. Otherwise: no specific next feature is queued. Check with the user before assuming
   scope.

**Blocked on:** nothing.

**Needs your sign-off:** nothing pending.

**Notes:**
- bakloop has no test suite of its own (`package.json`'s `test` script is a stub). The
  gates it runs apply only to the target repos it drives.
- `Backlog.comment` (`src/backlog.ts`) and `Readiness.blockingDependencies`/
  `missingDependencies` (`src/types.ts`) are implemented/parsed but not currently used
  anywhere in the pipeline — likely scaffolding for a future feature, not dead-by-mistake.
