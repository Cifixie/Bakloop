# Split workflow — decomposition, children, alignment

> **Status: accepted design, implementation underway.** This describes the split flow
> the engine is moving to under D-019. `src/types.ts` already carries the new roles;
> the split/queue/prompt migration and removal of the old planner→architect→critic flow
> are still in flight and unverified. `../wiki/decisions.md` D-019 and `workflow.md` are
> the authoritative homes; keep this file in sync when the code changes.

A split partitions one large task into independently-planned and independently-executed
children. Children share their top-level ancestor's branch (`bakloop/<ROOT-ID>`), so many
children still add up to one PR (D-004).

## Trigger conditions

A task is split two ways:

**1. Architect-initiated.** In `planning` mode the Architect responds with a split
proposal — scoped child `raw`/title/description definitions plus a shared interface
contract.

**2. Machine-initiated (context overflow).** A tick fails because the prompt exceeded the
context window. That says the task is too big, not wrong, so rather than re-sending a
prompt that still won't fit, the task is routed back to planning on a prompt that only
offers the split branch. If the Architect writes a plan anyway, the task is `Blocked` for a
human — decomposition failing is structural, not something to retry.

## Pre-split: shared interface contract

Because planning is scoped per task, a child can't see its siblings. So no children are
created until the Architect has written a **shared interface contract** for the parent:
which child creates which shared artifact, signature contracts, resource IDs. Only then
are children created, each seeded with that contract — the only cross-sibling context any
child gets. This is D-007's requirement, now an Architect mode rather than a separate
`architect` tick behind a label.

`raw` context for a child is **scoped, not copied**: each child gets its own `raw` plus the
parent's request and the contract as bounded ancestor context. The entire parent request is
not duplicated into every child (it stays on the parent).

## Child creation

Each child is created as a **normal queued task** with its own scoped `raw`, title, and
human-readable description, plus:

- **the shared interface contract** as ancestor context, so its planning and execution know
  the shared surface from the start;
- **`dependsOn`** on its immediate predecessor, giving a strict serial chain — child N+1 is
  not even planned until child N reaches `Done`. Ordering is enforced by `readiness.isBlocked`
  (the loop's only ordering mechanism, D-008).

Children execute **serially in dependency order, one at a time**, on the root ancestor's
branch.

## Partial planning is intentional

Because of the dependency chain, only the next eligible child is planned at a time — the
same just-in-time behavior the main loop already had. A dependency-gated child stays
unplanned until its predecessor is `Done`; that is the design, not a gap. "Fully spec'd"
means: every task has a description/AC/DoD and the front of the chain has a plan.

## Leaf completion

A child reaches `Done` only after **deterministic gates pass and the Tester returns
`PASS`**. There is no self-finalize-on-green-gates shortcut — the Tester gate applies to
children too. Then the next eligible child is planned and executed. If any child ends
`Blocked`, the parent does too.

## Finalizing a split

After every child is `Done`:

1. **Architect alignment** — a distinctly-marked alignment mode checks the combined result
   against the shared interface contract. A detected mismatch (`DRIFT`) **blocks the parent**
   for human intervention.
2. **Tester on the integrated diff** — evaluates the combined diff against the parent-level
   criteria. `PASS` sends the parent to `Review`; `CHANGES` follows the usual bounded
   Executor revision path.

The parent does not reach `Review` until all three hold: every child `Done`, alignment
passed, integrated diff passed Tester.

## Overlap detection

Path-collision detection (`findCollisions`, `src/overlap.ts`, D-009) still runs after a
split creates children: it extracts repo-relative paths from each task's text and reports
any path claimed by two tasks that are not in an ancestor/descendant relationship. A
blocking collision comments the report on the parent, labels it `needs-replan`, and sets it
`Blocked`. The same check is available ad hoc via `pnpm run overlap <project>`.

## Special cases

**Nested splits:** a child can itself be split. `rootAncestorId` walks to the root, so
nested children still share the top-level branch (`bakloop/<ROOT-ID>`) — one PR total.
Implemented but never exercised end-to-end in practice (`gotchas.md`).

**Unparseable split:** a malformed proposal must never crash the run — `tick.ts` blocks the
one task with the verbatim output preserved in a comment for debugging.

**Pre-existing children:** a task that already has children is treated as a container; the
Architect does not split it again, and it routes through alignment + integrated Tester
before review.
