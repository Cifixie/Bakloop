# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**D-007/D-008 (sibling overlap prevention) are built, tested, and now observed running**
on the `book` project: a fresh planner run produced three top-level tasks — TASK-1 (S3
source of truth), TASK-2 (extraction bridge, split into five children under an architect
contract), TASK-3 (SourceHealth v1) — and TASK-2's five children do not collide with each
other or duplicate one another's shape. That part of the fix works as designed.

**D-011 (open, not urgent for `book` right now):** overlap across *independently-created
top-level tasks* is still undetected by anything that runs automatically — only a manual
`npm run overlap <project>` catches it. On `book`, TASK-1 and TASK-3 genuinely write
conflicting logic into the same four files; TASK-3 now has explicit `dependencies:
[TASK-1, TASK-2]` set (via `backlog task edit --dep`), so `readiness.isBlocked` stops it
from starting before those finish — this fixes *when* TASK-3 can run, not what its branch
is based on. See D-012 below for the piece that actually closes the loop for a project
that opts into it. For a project that doesn't, D-011 is still exactly the open question
it was: run `findCollisions` on every promotion, or widen scope-sharing to the whole
project, not just one split's tree. Not decided.

**D-012, shipped this session: autonomous integration for opted-in projects.**
`ProjectEntry.autonomous` (`src/config.ts`) — when set, `case "reviewer":` in
`src/tick.ts` rebases the task's branch onto `baseBranch`, re-runs gates against the
rebased tip, squash-merges on green, and marks the task `Done` itself; a conflict or a
post-rebase gate failure blocks the task (`needs-manual-merge`) and never force-resolves.
Registering a project from a git URL (`npm run register-project -- <key> <owner/repo>`,
cloned via `gh repo clone`) implies `autonomous: true` automatically, into
`$BAKLOOP_HOME/clones/<key>` on its own `bakloop/trunk`; registering from an existing
local path keeps today's supervised behavior unless `--autonomous` is passed explicitly
(a known, loudly-flagged risk against a real checkout). `git push` remains hard-blocked
everywhere, unconditionally — nothing in this path calls it. Typechecked, unit-tested
(existing suite, unchanged and green), and manually verified end-to-end at the git level:
local-path registration, `--autonomous` local-path registration, URL registration via a
real `gh repo clone`, a clean rebase + squash-merge, and a rebase conflict correctly
aborting with the task branch left at its original tip. **Not yet run through a real
`npm start` loop against a live local model** — the git-command sequences were verified
directly, not via a full tick. See D-012 in `wiki/decisions.md` for the design rationale.

**Next action:** run an autonomous project through a real `npm start` loop end to end
(register a throwaway repo by URL, let a task go executor → reviewer → integration,
confirm `Done` lands and the trunk branch advances) to close the "not yet run through a
real loop" gap above. Separately, `book` itself is registered as a supervised (non-
autonomous) project — TASK-1 is unblocked and safe to move to `Ready for Work` now that
TASK-3 depends on it; TASK-2 is currently `Blocked`/`needs-replan` from D-009's automatic
post-split check on the TASK-2.4/TASK-2.5 `lambdas/extraction/handler.ts` finding, which
looks like a false positive (2.4 creates the handler; 2.5 only points a CDK `entry` at
its path) — decide whether to clear that label by hand or teach `findCollisions` to tell
"creates" from "references the path of" apart before unblocking it.
