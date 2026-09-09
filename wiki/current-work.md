# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**D-014, shipped this session: the human-approval gate (D-002) is retired.**
`Waiting for Approval` and `Ready for Work` are collapsed into a single status, `ToDo`
(`src/types.ts`'s `STATUS.todo`). The planner now parks a finished spec+plan directly in
`ToDo`, and `resolvePhase`'s executor gate (`src/phase.ts`) accepts `ToDo` or
`In Progress` with no human column-move required. `RESPEC` still resets a task's status
(to `ToDo` now, not `Waiting for Approval`) so it re-enters the queue and routes back
through `planner`, but that reset no longer re-imposes any human checkpoint — it's just
queue bookkeeping. Typechecked and unit-tested (`routing.test.ts`, including a new
defensive regression test confirming a plan-bearing task at `Blocked`/`Review`/`Done`/
`Backlog` still never routes to `executor`). **Deliberately not migrated:** `book`'s
three existing tasks (`task-1`, `task-2.1`, `task-3`) are still sitting at the
now-retired `Waiting for Approval` status string, which no longer appears in
`config.yml` after the next `npm run setup` — they need a manual
`backlog task edit <id> -s "ToDo"` before they're eligible to run again. See D-014 in
`wiki/decisions.md`.

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

**D-012, autonomous integration for opted-in projects.**
`ProjectEntry.autonomous` (`src/config.ts`) — when set, `case "reviewer":` in
`src/tick.ts` rebases the task's branch onto `baseBranch`, re-runs gates against the
rebased tip, squash-merges on green, and marks the task `Done` itself; a conflict or a
post-rebase gate failure blocks the task (`needs-manual-merge`) and never force-resolves.
Registering a project from a git URL (`npm run register-project -- <key> <owner/repo>`,
cloned via `gh repo clone`) implies `autonomous: true` automatically, into
`$BAKLOOP_HOME/clones/<key>` on its own `bakloop/trunk`; registering from an existing
local path keeps today's supervised behavior unless `--autonomous` is passed explicitly
(a known, loudly-flagged risk against a real checkout). `git push` remains hard-blocked
everywhere, unconditionally — nothing in this path calls it.

**D-013, shipped this session: a real review gate, `critic`, ahead of `reviewer`.**
Closes the gap D-012 exposed: `reviewer` was always documentation-only
(`prompts/reviewer.md` says so outright), never a real quality bar — the only actual gate
was "AC met + gates green," a compile/lint/test bar, not a correctness one. `critic`
(`src/phase.ts`/`src/tick.ts`) now sits between the two for every project, autonomous or
not, and answers `SHIP` (proceeds to reviewer), `CHANGES` (specific feedback, back to
executor, capped at `MAX_CRITIC_ROUNDS`=3 before blocking for a human), or `RESPEC`
(clears the plan, resets to `ToDo` — routes back through `planner` before execution can
resume; see D-014, which retired the human-approval gate this used to re-impose).
Required a small, deliberate reorder in `resolvePhase`
(moving `attempts >= 2`'s senior-escalation check inside the `!acDone` branch) to stop a
legitimate critic/executor revision cycle from getting silently stranded on the
read-only `senior` role — see D-013 and its gotchas.md entry for the residual, narrow
edge case left open. Typechecked, unit-tested (5 new tests in `routing.test.ts`), and
manually verified end-to-end against a scratch repo with a stubbed model: the full
`SHIP`/`CHANGES` cycle, `RESPEC` correctly routing back through `planner`, and the
`MAX_CRITIC_ROUNDS` ceiling blocking on the 4th `CHANGES` verdict without ever
misrouting to `senior` despite `attempts` climbing to 4 in the process.

**Next action:** both D-012 and D-013 are now built and verified at the git/tick level
against scratch repos, but neither has been run through a real `npm start` loop against
a live local model end to end together — worth doing once, registering a throwaway repo
by URL, to see a real model's `critic` output land correctly. Separately, `book` itself
is registered as a supervised (non-autonomous) project — TASK-1 is unblocked, but still
needs the manual `ToDo` migration noted above (D-014) before the executor will pick it
up directly, now that TASK-3 depends on it; TASK-2 is currently
`Blocked`/`needs-replan` from D-009's automatic post-split check on the
TASK-2.4/TASK-2.5 `lambdas/extraction/handler.ts` finding, which looks like a false
positive (2.4 creates the handler; 2.5 only points a CDK `entry` at its path) — decide
whether to clear that label by hand or teach `findCollisions` to tell "creates" from
"references the path of" apart before unblocking it.
