# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**Working on:** Nothing in flight. Latest landed: `pnpm start <key>` accepts the project
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
