# Decisions

Human-written. Agents propose, they do not edit.

Format: context, decision, consequences. Superseded entries stay, marked as such.

Every entry carries a **Date** and a **Status**:

- `Accepted` — decided, and the rest of the system may rely on it.
- `Proposed` — drafted, awaiting sign-off. **Not yet binding.**
- `Superseded by D-0NN` — kept for the record, no longer in force.

All entries below are transcribed from rationale already stated in code comments and
commit messages for shipped, running behavior — not fresh proposals — so they're recorded
as `Accepted`. All commits landed 2026-09-07 (bakloop was built in one day), so identical
dates across entries reflect that, not a copy error.

---

## D-001 — Gate every unread verdict through `tsc`/`biome`/`vitest`, never the model's text

**Date:** 2026-09-07
**Status:** Accepted

**Context:** A model asked to report its own success/failure will sometimes report
success on a no-op diff, a skipped test, or a still-broken build — its summary isn't a
verification signal. The alternative (trust the model's final message) is cheaper but
gives no real backstop.

**Decision:** Every executor and reviewer verdict comes from running the type checker,
linter, and test suite and diffing the branch against its base (`src/gates.ts`), never
from parsing `result.text`. On green, acceptance criteria are force-checked by the
orchestrator itself rather than asking the model whether it's done.

**Consequences:** Buys a hard backstop against plausible-but-wrong "done" claims, at the
cost of requiring every target repo to have a runnable `tsc`/`biome`/`vitest` setup (or a
subset — gates are detected per-repo, `src/gates.ts`'s `detectGateConfig`) before bakloop
can drive it usefully. A repo with none of the three effectively has no gate at all.

---

## D-002 — Execution requires an explicit human `approved` label

**Date:** 2026-09-07
**Status:** Accepted

**Context:** Owner, architect, researcher, and planner roles are read-only or write only
to task metadata — running them unsupervised is low-risk. The executor role runs
read/write/edit/bash against a real repo; running that unsupervised on every backlog item
was judged too risky to leave fully autonomous.

**Decision:** A task only leaves `Waiting for Approval` into executor once a human adds
the `approved` label. This is a start-up check only — once a tick is already
`In Progress`, the label isn't re-checked mid-run (`src/phase.ts`).

**Consequences:** Buys a deliberate human checkpoint between "here's the plan" and "code
gets written," at the cost of the loop stalling on anything not yet approved — bakloop
will not make progress on unapproved backlog items no matter how long it runs.

---

## D-003 — Hard-block `git push` via a `PATH`-shadowing wrapper, not a prompt instruction

**Date:** 2026-09-07
**Status:** Accepted

**Context:** Prompt instructions telling the executor not to push are advisory only — a
model can ignore or "forget" them under pressure to make gates pass. A mechanical block
was judged necessary for anything that reaches outside the local branch.

**Decision:** A wrapper script shadows `git` on the executor's `PATH` and refuses any
command containing `push` (`src/git-guard.ts`).

**Consequences:** Buys real enforcement instead of a hopeful instruction, at the
explicitly acknowledged cost that it isn't a real sandbox — an absolute path to the real
`git` binary or a shell alias would bypass it. It stops an honest mistake, not a
determined adversarial model.

---

## D-004 — One branch per top-level ticket; subtasks share the parent's branch

**Date:** 2026-09-07
**Status:** Accepted

**Context:** Splitting an oversized task into independently-planned/executed subtasks is
useful for fitting a small local model's context window, but the user wants exactly one
PR per top-level ticket, not one per internal piece.

**Decision:** `ensureTaskBranch` keys off `task.parentTaskId ?? task.id`, so every subtask
of a given parent checks out and commits to that parent's single branch
(`bakloop/<parent-id>`) rather than getting its own.

**Consequences:** Buys "many subtasks, one PR" for free once the branch is shared, at the
cost that subtask commits interleave on one branch with no per-subtask isolation — a bad
subtask attempt's commits aren't quarantined from its siblings the way a top-level
attempt's are. This decision covers exactly one level of nesting; see the nested-splits
gap in `wiki/gotchas.md` for what happens if a subtask itself gets split.

---

## D-005 — Use Backlog.md's native `--parent` relation for splits, not `milestone`

**Date:** 2026-09-07
**Status:** Accepted

**Context:** Backlog.md offers two ways to group related tasks: `milestone` (a loose,
purely organizational grouping) and `--parent` (a structural parent/child relationship).
Only one of them carries semantics bakloop can hang branch-sharing and status-propagation
logic off of.

**Decision:** The planner's split output creates children via `task create --parent <id>`
(`src/backlog.ts`'s `createChild`), not via a shared milestone tag.

**Consequences:** Buys a structural relationship the orchestrator can query
(`task.parentTaskId`, `task.subtasks`) to drive branch-sharing, container-status
propagation, and scheduling exclusion — at the cost of coupling bakloop's split feature
tightly to Backlog.md's specific parent/child model rather than a looser tagging scheme
that might transfer to a different backlog tool more easily.

---

## D-006 — A killed loop finishes its current tick before exiting

**Date:** 2026-09-07
**Status:** Accepted

**Context:** The loop is run interactively (e.g. during a meeting) and the user needs to
stop it without corrupting task/branch state, but also doesn't want to be stuck waiting
out a long, hung tick.

**Decision:** `SIGINT`/`SIGTERM` set a `stopRequested` flag; the in-flight tick is allowed
to finish (commits, gate results, attempt log all land) before the loop breaks and checks
the working tree back to the base branch. A second signal while still waiting force-exits
immediately (code 130).

**Consequences:** Buys a clean stop boundary — no tick is ever left half-committed — at
the cost of the first Ctrl+C not being instant; a slow tick (e.g. a long test run) still
has to finish before the process exits, unless the user sends a second signal and accepts
losing that tick's state.
