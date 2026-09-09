# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**Status:** the overlap-in-subtasks problem has three distinct causes; two are now fixed
deterministically and one is built but **still never observed running**.

| Cause | Mechanism | State |
|---|---|---|
| Siblings independently invent the same shared artifact | architect contract seeded into every child (D-007) | built, **never once executed** |
| No ordering — last writer clobbers | children dependency-chained (D-008) | built + tested |
| A nested split can't see what its aunts/uncles own | `SiblingScope` for planner/architect (D-008) | built + tested |

The reason D-007 has never run: the planner's split output crashed the loop on a header
regex (`## Subtask 1:` vs the literal `## Subtask:`), five times, before the contract gate
was ever reached — see the header-format entry in `wiki/gotchas.md`. Fixed, with a
regression test replaying the real output. **Every planner iteration so far has been
judged on a tree the current code never produced.**

How it works: `tick.ts`'s `case "planner"` won't create children from a `SPLIT` until
`hasArchitectContract(task)` (`phase.ts`) is true; until then the task gets
`needs-architecture` and the split is discarded. `architect` (`prompts/architect.md`)
writes the contract into `implementationNotes` and clears its own label. Children are
seeded with that contract at creation (`Backlog.createChild`'s `notes` option). Once every
child is `Done`, `phase.ts` routes to `architect` again (`prompts/architect-alignment.md`,
picked by `task.subtasks.length > 0`) for a second, distinctly-marked pass
(`hasAlignmentCheck`) that must answer `ALIGNED`/`DRIFT`; `DRIFT` blocks the container
immediately rather than just annotating it.

**The `book` project's current task tree predates this fix and has no architect
contracts.** Do not move anything in it to `Ready for Work` or execute against it until
it's reset (see Next action).

**Also uncommitted, unrelated to the split flow: `promote-draft` is now fully
non-interactive.** `src/promote-draft.ts` runs `owner`/`criteria`, prints the result, and
promotes immediately — no `y/N` gate, no type/priority prompt. Type comes from whatever
`owner` drafted; priority is left unset. This doesn't touch the D-002 invariant: the
promoted task still lands in `Waiting for Approval` and needs a human to move it to
`Ready for Work` before execution. Documented in README's "Adding tasks" section.

**Same area, also uncommitted: fixed information loss on draft promotion.** Two gaps,
found when a user pastes an already-rich draft (e.g. a plan they had another AI write) and
watches promote-draft flatten it: (1) the human's original draft text was never kept
anywhere on the resulting task — only the `owner` role's rewritten `description`
survived — so it's now also written verbatim as a `"draft"`-authored comment
(`src/promote-draft.ts`); (2) `prompts/owner.md`'s tick-loop instruction to treat notes as
"informing the description without being copied verbatim" is right for incremental
machine bookkeeping but wrong for a one-shot human draft, so it paraphrased away
already-worked-out specifics. `src/prompts.ts`'s `templateFor` now picks a distinct
`owner-from-draft` template (keyed on the fake stand-in task's `status: "Draft"`, which no
real task ever has) instructing the model to preserve substantive content rather than
summarize it. Not yet run against a real draft with a real local model — only
typechecked.

**Decision records are now the agent's to write and keep current** (CLAUDE.md, Write
access). D-007 is recorded as `Accepted`; D-002 and D-004 have been rewritten to match the
code, each carrying an `Amended` note explaining what changed and why. Nothing in
`wiki/decisions.md` is waiting on a countersignature.

**Needs your sign-off:**

1. Parked, not urgent: a prior-session proposal to capture a plan's base commit and check
   it before executing. Untouched since it was raised; pick it up from git history if
   it's still wanted.

**Next action — stop adding mechanism, run it.** In order:

1. **Reset the `book` task tree** (it predates D-007 and has no contracts), keeping
   `state/book/journal.db` for the 3.5-ticks-per-task baseline.
2. **Re-plan a task that has to split**, then `npm run overlap book`. Zero blocking
   collisions is the pass. Also read the tree once by hand for the symptoms the path check
   cannot see: the same interface given two different signatures, a child re-stating a
   sibling's scope in prose, or an expensive-to-reverse choice (a file extension, a key
   layout) decided differently in two places. This observation has been skipped three
   times.
3. **Then** the original goal: exercise the _executor_ path against a real local model
   (`npm run report book` for ticks/completed once there's execution data).

**Overlap is now detected, not eyeballed** (D-009). `npm run overlap <project>` reports
every file claimed by two unrelated tasks in a tree; the same check runs automatically
right after a split and blocks the container on a real collision.

**Baseline, measured on the pre-reset `book` tree (2026-09-09) — this is the "before":**

```
7 blocking path collision(s) across 14 task(s)
  apps/infra/lib/source-content.ts            TASK-1, 1.2, 1.4.2, 1.4.3, 1.4.4, 1.4.5, 2
  apps/infra/lib/bookmark-digest-stack.ts     TASK-1.1, 1.3, 1.4.1, 1.4.3, 1.4.4, 3
  apps/infra/lib/dynamo.ts                    TASK-1.2, 1.3, 1.5, 1.6
  apps/infra/lambdas/fetch-source/handler.ts  TASK-1.4.3, 1.4.4, 3
  apps/infra/lambdas/generate-digest/handler.ts  TASK-1.4.4, 1.4.5, 3
  apps/infra/lambdas/ingest-url/handler.ts    TASK-1.3, 1.4.4, 3
  packages/schemas/src/index.ts               TASK-2, 3
plus 7 shared-by-convention (manifests and .md), not blocking
```

That tree was produced by the pre-D-007 one-shot split. Seven tasks each intended to write
`source-content.ts`; six each intended to write the CDK stack. **The target after re-planning
is zero blocking collisions** — anything above zero means D-007/D-008 didn't hold and the
tree needs re-splitting, not executing. Recorded here rather than in `tmp/`, which is
gitignored and will not survive the reset.
