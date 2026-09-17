# ROADMAP

Future-facing ideas, not yet decided. Unlike `decisions.md`, nothing here is
`Accepted` — an entry here is a candidate shape for a `Proposed` or `Accepted` decision,
not one itself. When an idea below actually gets built, write it up properly in
`decisions.md` and either delete or shrink its entry here to a one-line pointer.

---

## R-001 — Draft-scoped loop: one draft on the board at a time, one PR per draft

**Idea:** Fold draft promotion into the main loop itself instead of treating it as a
separate step the human runs first. Shape: the board only ever holds tasks belonging to
a single draft's tree. When the loop finds no ready tasks, instead of idling it promotes
the next queued draft (D-015's promotion path already does the real work: full
plan-mode run, verbatim draft in context for every planning tick) and starts working the
resulting tree. When that tree is exhausted, it goes back to promoting the next draft.
Before the loop starts, the human picks which drafts to run and in what order, instead of
being asked per-tick.

**Why this looks like a real win, not just a workflow change:**

- **It closes D-011 for free, for the normal (non-autonomous) loop.** D-011 is open
  because two *independently-created* top-level tasks in the same project are invisible
  to both D-008's `SiblingScope` and D-009's automatic overlap check — each root ancestor
  only ever sees its own tree. If the board structurally never holds more than one
  draft's tree at once, there is no second independent top-level task to collide with in
  the first place. D-012 already gets this property for autonomous projects via a
  different mechanism (rebase-and-regate before merge catches it as a real conflict); this
  would get the same property for the *default*, non-autonomous loop, which D-011's
  "Update" note explicitly says is still fully open today.
- **It matches D-004's existing granularity instead of fighting it.** "One PR per draft"
  only works cleanly if a draft maps to exactly one top-level task/branch — which is
  already what D-015's promotion produces (one task, split into subtasks sharing one
  branch per D-004's `rootAncestorId`). So this isn't a new branching model, it's
  packaging the loop around a shape bakloop already builds.
- **It reduces subtask/task friction the user is pointing at in R-002 too** — see below;
  the two ideas reinforce each other if bakloop starts trusting "the draft's tree is the
  unit of work" as a first-class assumption rather than something promotion just happens
  to produce once.

**Open questions before this is a decision, not a proposal:**

1. What does "only one draft's tasks on the board" mean mechanically? Backlog.md has no
   concept of hiding a project's other tasks — this would likely mean bakloop's own
   candidate-filtering (the same kind of tree-scoping `restrictToTree` already does for
   promotion, per D-015) extended to the *execution* loop, not a real board change. Worth
   checking whether that's a natural generalization of `restrictToTree` or a distinct
   mechanism.
2. Where do already-`Done` tasks from a prior draft live? Presumably untouched in
   Backlog.md, just excluded from `resolvePhase` candidates going forward — needs to be
   explicit so nothing re-touches a finished tree.
3. What's the queuing mechanism for "which drafts, what order"? A config file next to
   `projects.json`, a CLI flag, an interactive prompt at `npm start` — this is the one
   piece with no existing analog in the codebase to lean on.
4. Does a mid-tree failure (a task stuck past `MAX_CRITIC_ROUNDS`, or blocked on
   `needs-manual-merge`) stall the whole loop, or does bakloop move on to the next queued
   draft and come back? The current loop has no "skip and revisit" concept anywhere.

**Verdict on the user's question ("would this help us?"):** yes, on the two structural
grounds above (D-011 closure, D-004 alignment) — this isn't just a UX nicety, it's the
first design that makes the still-open D-011 gap disappear by construction for the
default loop. The remaining work is almost entirely the queuing/config-value question
(#3), not the loop mechanics, since promotion and tree-scoped ticking already exist.

---

## R-002 — Just-in-time subtask refinement: plan the next child, not the whole split

**Idea:** Today, a split (D-007) requires an architect contract before *any* children
exist, and the planner's split proposal seeds every child with a full description up
front. The idea: since each child already carries the parent's interface contract in its
`implementationNotes` (D-007) and the draft's own detail no longer needs re-deriving once
the task is real, stop requiring every subtask to be planned in detail before the first
one runs. Refine and execute the first child to `Done`, *then* refine the next one — using
the now-finished previous sibling as real, checkable context instead of a guess made
before any code existed. The stated motivation: this is exactly what causes hallucinated
requirements today — a subtask planned against an imagined version of its predecessor's
output, rather than the predecessor's actual finished shape.

**How this sits against what's already built:**

- **Compatible with, and arguably completes, D-008's dependency chain.** `createChild`
  already chains every split child linearly via `dependsOn`, and `readiness.isBlocked`
  already prevents a later child from *executing* before its predecessor is `Done`. What
  D-008 doesn't do is delay *planning* the same way — all children get a full plan at
  split time, then sit blocked. R-002 is really asking to align planning granularity with
  the execution granularity that already exists.
- **Directly in tension with D-007's "contract before any children exist" gate.**
  D-007 was written to stop siblings independently reinventing a shared interface with
  zero visibility into each other — solved by making the *contract* exist before any
  child does. R-002 doesn't need to weaken that: the contract can still be written once,
  up front, covering the shared interface; what changes is that each child's own detailed
  plan/AC — the part that risks guessing at a predecessor's real output — is deferred
  until it's next in line.
- **Possibly a chance to do better than D-009 for split children, not just a conflict
  with it.** `findCollisions` runs once, right after a split, and extracts *claimed*
  paths from prose (description/plan/AC/DoD) — D-009's own writeup lists the heuristic
  cost of that: `node_modules` false positives, suffix-path merging, a
  shared-by-convention exemption list that's an admitted policy judgment, not a fact.
  It's a guess about what a not-yet-written child *will* touch. Under strict JIT
  refinement, children are only ever created and planned one at a time, in dependency
  order — which means by the time child N+1 is being planned, every child before it is
  either not yet created (nothing to collide with) or already `Done`, with a real `git
  diff` on disk. That's strictly better data than prose extraction: feed the planner (and
  the architect, if it re-checks) the *actual* files created/modified by every finished
  predecessor in the tree, and have it plan child N+1 against ground truth instead of
  against the earlier prose guess of what those predecessors would touch. This wouldn't
  cover D-011's cross-top-level-task case (still a separate, open question — see R-001),
  but for overlap *within* one split's chain specifically, real-diff-based checking at
  plan time could be a genuine upgrade over D-009's static extraction, not merely a
  workaround for R-002 breaking it. No decision fixed here — D-009 isn't sacred, and
  CLAUDE.md's own rule is "reality wins over the record": if this turns out to be the
  better mechanism, D-009 gets superseded in the same change that ships it, not kept
  around as a second, weaker check running alongside a stronger one.

**Open questions before this is a decision, not a proposal:**

1. Does "refine" mean the planner writes each child's description/AC/plan lazily
   (child N+1 only gets planned once child N is `Done`), or does the *architect* also
   re-visit its contract at each step? If the contract can also evolve, D-007's alignment
   pass (the second architect check before `reviewer`) needs to know it's checking against
   a contract that was itself allowed to change mid-tree, not a fixed one from the start.
2. Is the real-diff-based check above actually strictly better, or does it just move the
   blind spot? It only sees what a `Done` predecessor *actually* touched — a predecessor
   that's still executing (not yet `Done`) is invisible to it the same way an unplanned
   child is invisible to D-009 today. Given D-008's strict dependency chain this may not
   matter (nothing runs concurrently to collide with), but that assumption should be
   checked explicitly, not assumed.
3. Is a "stub" child (dependency-chained, no description yet) something `resolvePhase`
   needs to explicitly special-case, or does the existing owner/criteria/researcher chain
   already produce this for free once a child's description starts blank? D-015 already
   does something adjacent (blanking the description to force a normal `owner` pass on
   promotion) — worth checking whether the same trick covers this without new machinery.

**Verdict:** worth pursuing. The design center of this one is whether real-diff-based
checking at plan time is actually a strictly better replacement for D-009's prose-based
extraction within a split's chain — not whether R-002 is allowed to weaken D-009, since
nothing here is fixed yet. If it holds up, this supersedes D-009 for split children (per
CLAUDE.md's "reality wins over the record") rather than running alongside it; D-011's
cross-top-level-task case is untouched either way and stays a separate open question.
