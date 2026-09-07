# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**Working on:** Nothing in flight. The last landed feature is the planner's subtask-split
mechanism (see D-004/D-005 in `wiki/decisions.md`) and clean Ctrl+C/SIGTERM handling
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
