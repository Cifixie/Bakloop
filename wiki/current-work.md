# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**Working on:** Nothing in flight. Latest landed: `npm run setup` (`src/setup.ts`)
non-interactively initializes the shared Backlog.md store under `$BAKLOOP_HOME` — it
`git init`s the store first (backlog.md only prompts to create a repo if one isn't
already there; this keeps the store on its own local git history, no GitHub remote,
without the interactive wizard) then runs `backlog init` and rewrites `config.yml`'s
`statuses`/`default_status` to match `STATUS` in `src/types.ts`. Idempotent — re-running
only re-applies the status fix-up. Gotcha worth knowing if you touch this again: `backlog
init` creates its own `backlog/` subdir under whatever cwd it's given, so it must run
from `bakloopHome()`, one level above `backlogDir()` — running it from `backlogDir()`
itself nests a second `backlog/` inside it. Before that: `pnpm start <key>` accepts the project
key as an argv fallback (`BAKLOOP_PROJECT` env still wins if set — `src/main.ts`), and a
two-step manual-task path — `pnpm run new-draft <key>` (`src/create-draft.ts`) captures a
copy-pasted ticket (roadmap entry, GitHub issue) as a Backlog.md *draft*, tagged for a
project via a `project:<key>` label since drafts have no structured `project` field of
their own; `pnpm run promote-draft [draft-id] [key]` (`src/promote-draft.ts`) runs the
same `owner` prompt the tick loop uses to draft a description + acceptance criteria from
the raw text, shows it for review, then promotes and sets project/type/priority. Drafts
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
