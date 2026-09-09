# Decisions

Agent-maintained. Write entries here yourself and keep them matching the code — see
CLAUDE.md's Write access section for the rules.

Format: context, decision, consequences. Superseded entries stay, marked as such.

Every entry carries a **Date** and a **Status**:

- `Accepted` — decided, and the rest of the system may rely on it.
- `Proposed` — a genuinely open question awaiting a human's pick. **Not yet binding**,
  and not a waiting room for behavior that already ships.
- `Superseded by D-0NN` — kept for the record, no longer in force.

D-001..D-006 were transcribed from rationale already stated in code comments and commit
messages for shipped, running behavior — not fresh proposals — so they're recorded as
`Accepted`. Those commits all landed 2026-09-07 (bakloop was built in one day), so
identical dates across those entries reflect that, not a copy error. Entries from D-007
on carry the date the behavior actually landed.

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

## D-002 — Execution requires a human moving the task to `Ready for Work`

**Date:** 2026-09-07
**Status:** Accepted

**Context:** Owner, architect, researcher, and planner roles are read-only or write only
to task metadata — running them unsupervised is low-risk. The executor role runs
read/write/edit/bash against a real repo; running that unsupervised on every backlog item
was judged too risky to leave fully autonomous.

**Decision:** A task only leaves `Waiting for Approval` into executor once a human moves
it to the `Ready for Work` status. This is a start-up check only — once a tick is already
`In Progress`, it isn't re-checked mid-run (`src/phase.ts`).

**Amended 2026-09-08:** originally an `approved` *label*. Replaced by a status/column move
because a label is invisible on the board — the human checkpoint has to be somewhere a
human actually looks, and a Kanban column move is that place. A label was also writable by
the same `addLabel` path the roles use for `needs-split`/`needs-architecture`, so the one
gate meant to be human-only shared its mechanism with routine machine bookkeeping.

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

## D-004 — One branch per top-level ticket; subtasks share their root ancestor's branch

**Date:** 2026-09-07
**Status:** Accepted

**Context:** Splitting an oversized task into independently-planned/executed subtasks is
useful for fitting a small local model's context window, but the user wants exactly one
PR per top-level ticket, not one per internal piece.

**Decision:** `ensureTaskBranch` keys off `rootAncestorId(task.id, all)`, so every subtask
checks out and commits to its top-level ancestor's single branch (`bakloop/<root-id>`)
rather than getting its own.

**Consequences:** Buys "many subtasks, one PR" for free once the branch is shared, at the
cost that subtask commits interleave on one branch with no per-subtask isolation — a bad
subtask attempt's commits aren't quarantined from its siblings the way a top-level
attempt's are.

**Amended 2026-09-08:** originally `task.parentTaskId ?? task.id`, which covered exactly
one level of nesting — a subtask of a subtask forked its own branch off its immediate
parent, defeating the one-PR-per-ticket goal at the second level. `rootAncestorId` walks
the whole chain instead (and throws on a cycle); tested in `routing.test.ts`. The
nested-splits entry in `wiki/gotchas.md` is still live: this makes nesting correct on
paper, but it has never been exercised end-to-end.

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

---

## D-007 — A split requires an architect-written interface contract before children exist; a container requires a second alignment pass before review

**Date:** 2026-09-08
**Status:** Accepted

**Context:** The planner splits a task into subtasks with zero visibility into any
sibling's plan (context is rationed per role/per task — see the rationale in
`src/prompts.ts`). Observed in practice on the `book` project: one task's subtree
produced seven incompatible reimplementations of the same shared accessor function
and four separate, conflicting CDK bucket definitions, because nothing forced
agreement on the shared interface before the subtasks existed independently.

**Decision:** A planner's split proposal is provisional until `architect` has written
an interface contract for the parent task (`hasArchitectContract`, `phase.ts`) — only
then are children actually created, each seeded with that contract in its own
`implementationNotes`. Once every child is Done, a second, distinctly-marked architect
pass (`hasAlignmentCheck`) must confirm the finished siblings still agree with the
contract before the container can reach `reviewer`; on `DRIFT` the container is
blocked for a human, not merely annotated.

**Consequences:** Every split costs at least two extra architect ticks (one before,
one after) beyond today's one-shot planner split — acceptable because model time is
free and both failure modes this catches (siblings reinventing a shared interface
differently; siblings drifting from an agreed shape by the time they're all done) are
silent otherwise. The alignment check's verdict is a single required token
(`ALIGNED`/`DRIFT`) parsed the same way as `SPLIT`/`TYPE`, not a prose-parsed
model summary — kept distinct from D-001's gate verdicts, which this doesn't touch;
`tsc`/`biome`/`vitest` remain the only pass/fail signal for the executor and reviewer.
A false `DRIFT` costs one human look; a missed one costs exactly what already happened
on `book`'s `TASK-1.4` subtree.

---

## D-008 — Split children are dependency-chained, and scope-deciding roles see what the rest of the tree already owns

**Date:** 2026-09-09
**Status:** Accepted

**Context:** D-007 seeds every child of a split with one architect contract, which stops
siblings from independently inventing the same shared artifact *within one split*. Two
overlap causes survive it, both observed on `book`:

1. **No ordering.** `createChild` set no dependencies, so all children of a split were
   simultaneously ready and ordered only by ordinal — whichever executed last clobbered
   the others' edits to a shared file. Meanwhile both planner prompts already ask for
   subtasks "in the order they should be implemented" and `architect.md` already names
   which single child creates each shared artifact: the ordering intent was being
   generated and then thrown away.
2. **Cross-branch blindness.** A contract cannot fix duplication between *branches* of a
   tree. When `TASK-1.4` was split again, its architect knew nothing of `TASK-1.1` or
   `TASK-1.2` and re-specified their work verbatim — `TASK-1.4.1` duplicated `TASK-1.1`
   word for word. D-007 is structurally incapable of catching this, because each contract
   is written per-parent.

**Decision:** Two mechanisms, both deterministic:

- `tick.ts` chains each split child on its immediate predecessor via `createChild`'s
  `dependsOn`. `readiness.isBlocked` is already the loop's only ordering mechanism
  (`resolvePhase`), so a linear chain — the strongest order derivable without a model —
  becomes enforced rather than advisory. Safe against stalling because a subtask
  self-finalizes to `Done` on green gates and never waits for a human.
- `planner` and `architect` alone receive a `SiblingScope` (`prompts.ts`), computed by
  `siblingScopeFor` (`tick.ts`): the ancestor chain with descriptions, plus the ids,
  titles and statuses of every other task in the root ancestor's tree that is not this
  task, its descendants, or its ancestors. Their prompts instruct them to treat that work
  as owned elsewhere and out of scope.

**Consequences:** Splits now execute strictly in order — a subtask cannot start until its
predecessor is `Done` — which trades the (never-used) possibility of parallel siblings for
the elimination of clobbering. The chain is linear even where the planner's real dependency
graph is a tree; that over-constrains ordering but never wrongly permits it, and costs only
wall-clock, which is free here. `SiblingScope` deliberately excludes the executor: knowing
what a sibling owns would invite reaching into that sibling's files, the opposite of the
isolation a split exists to create. It also excludes a task's own descendants, which are
work being delegated rather than work already spoken for. Titles-not-descriptions for the
owned list keeps the cost at zero extra CLI calls (the project listing is already in hand)
and proved sufficient on the observed failure, where the duplicated titles were plainly
recognisable as the same work.

**Not addressed:** nothing yet *detects* overlap after the fact. D-007's alignment pass
asks a model; there is no deterministic check that two sibling tasks name the same file.
Until one exists, "did this work?" is answered by a human reading the tree — which is how
the `book` duplication was found in the first place.

---

## D-009 — Overlap is detected by deterministic path collision, not by a model

**Date:** 2026-09-09
**Status:** Accepted

**Context:** D-007 and D-008 try to *prevent* siblings from overlapping. Nothing detected
it: the `book` duplication was found by a human reading fourteen task files by hand, which
is not a check that runs. A role was proposed for this — a "friendkeeper" agent that reads
the whole task tree, finds overlaps, and tags `needs-replan`.

**Decision:** Detect it deterministically instead. `findCollisions` (`src/overlap.ts`)
extracts repo-relative paths from every task's description, plan, acceptance criteria and
DoD, and reports any path claimed by two or more tasks that are not in an
ancestor/descendant relationship. It runs at two points: `npm run overlap <project>` for a
whole existing tree, and automatically in `tick.ts` immediately after a split creates
children — the earliest moment the question is answerable. A blocking collision comments
the report on the container, labels it `needs-replan`, and sets it `Blocked`.

**Why not a role:** three reasons, each sufficient. A prompt holding N task files is the
context-overflow shape bakloop already dies on. A model asked to compare N tasks answers
differently each run, so it cannot be a gate (D-001's reasoning). And path collision is
decidable, so deciding it is strictly better than asking about it.

**Consequences:** The ancestor/descendant exclusion is the load-bearing subtlety — a
container legitimately describes the files its own children will touch, so without it every
split reads as a collision. Extraction is deliberately conservative: a path needs a
directory segment, so a bare `handler.ts` in prose is ignored and a path with a placeholder
segment (`sources/<hash>/raw.html`) is missed rather than half-matched. A missed collision
costs what already happens today; a false one costs trust in the only overlap signal that
doesn't need a human.

Running it against `book`'s real tree drove three corrections that a synthetic test would
never have surfaced, and they are the reason the check is usable rather than noise:
`node_modules/@aws-sdk/client-s3/package.json` in an install-verification step parsed as a
claim on a source file; `lib/dynamo.ts` and `apps/infra/lib/dynamo.ts` were counted as two
half-collisions on one file; and files that are shared *by convention* — manifests,
lockfiles, and any `.md` — buried the real findings under a `package.json` claimed by nine
tasks. Those are now excluded, suffix-merged, and reported-but-never-blocking respectively.
Result on the same tree: 16 undifferentiated findings became 7 blocking collisions, led by
the shared accessor module that four tasks each intended to create.

**Consequence to watch:** the shared-by-convention list is a policy judgement, not a fact.
Exempting all `.md` means a genuine documentation conflict between two tasks is reported
and not blocked. That is deliberate — this check exists to stop broken builds — but if doc
clobbering turns out to matter, the exemption is the thing to revisit, not the extractor.
