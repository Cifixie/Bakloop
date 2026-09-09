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

**Amended 2026-09-09 (D-013):** this decision is about trusting an *acting* role's
account of *its own* work — it was never a blanket ban on any parsed model verdict
anywhere in the loop. Two roles now legitimately drive control flow off a parsed
verdict: the architect's post-split alignment pass (D-007, `ALIGNED`/`DRIFT`) and
`critic` (D-013, `SHIP`/`CHANGES`/`RESPEC`). Both are distinct, adversarial roles
judging a *different* role's finished artifact, never their own, and both verdicts only
ever add a gate on top of gates already green — neither can make a gate-failing task
pass. That is the exact boundary that keeps this decision intact: self-report is never
trusted; a separate role's independent judgment of someone else's finished diff is a
different thing entirely, and always has been.

---

## D-002 — Execution requires a human moving the task to `Ready for Work`

**Date:** 2026-09-07
**Status:** Superseded by D-014

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

**Amended 2026-09-09 (D-012):** the push block itself is unchanged and unconditional —
D-012's autonomous integration never calls `git push` anywhere, so `git-guard.ts` needed
no change. What D-012 does grant, for an opted-in project only, is local merge/`Done`
authority that this decision never covered one way or the other: this decision is about
the network boundary specifically, and merging into a local `baseBranch` (whether that's
bakloop's own clone or, with `--autonomous`, a human's real checkout) was always a
distinct operation from pushing to a remote.

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

**Not addressed:** nothing yet *detects* overlap after the fact — since fixed by D-009. But
D-009's automatic check only runs right after a split creates children; it does not run
when a top-level task is independently created or promoted. `SiblingScope` here is scoped
per root ancestor, so two top-level tasks in the same project (each its own root) are
invisible to each other in both mechanisms. Observed for real on `book`: TASK-1 and TASK-3,
two independently-planned top-level tasks, ended up writing conflicting logic into the same
four files, and neither D-008 nor D-009's automatic trigger caught it — only a manual
`npm run overlap book` did. See D-011 (proposed) for closing this.

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

---

## D-010 — The loop holds a `caffeinate -i` for its lifetime and stops at a battery floor

**Date:** 2026-09-09
**Status:** Accepted

**Context:** `main.ts`'s `for (;;)` loop has no pacing between ticks — an unattended,
possibly overnight run against a local model is just one long-lived process. Two
machine-level failure modes had no handling: macOS idle-sleeps a machine with no held
power assertion, and a run left going on battery has no floor and will flatten it.

**Decision:** `src/power.ts` adds `startCaffeinate()` (spawns `caffeinate -i -w <pid>` for
the process's lifetime, released on the normal stop path via its returned stop function
and automatically via `-w` on `kill -9`) and `readBatteryState()` (parses `pmset -g batt`
into `{ percent, onAcPower }`, tolerant of the charge-state word and time-remaining field
since both vary by OS version). `main.ts` checks the battery once per iteration boundary,
before starting a tick — same reasoning as D-006's `stopRequested`: a tick is one model
call and shouldn't be torn in half. On battery, once `percent <= BAKLOOP_BATTERY_FLOOR`
(default `20`; `0` disables), the loop **stops cleanly** — the same `break` path as
Ctrl+C, through the existing `finally` (signal handlers off, journal closed, working tree
back to `baseBranch`) — not a pause-and-resume. `BAKLOOP_NO_CAFFEINATE=1` opts out of the
caffeinate child; both env vars follow the existing `BAKLOOP_HOME`/`BAKLOOP_PROJECT` style,
not a `projects.json` field, since this is a machine concern, not a per-project one.

**Consequences:** `caffeinate -i` prevents idle sleep only, not lid-close sleep on battery
— see the gotchas.md entry. The battery check has tick-boundary granularity, not mid-tick,
so the loop can stop a few points under the nominal floor; the default (`20`) has headroom
for that. Stopping cleanly rather than pausing means a run left overnight on battery ends
instead of waiting to be plugged back in — deliberate, matching D-006's preference for a
clean, well-understood stop boundary over added state-machine complexity.

---

## D-011 (proposed) — Overlap across independently-created top-level tasks is undetected

**Date:** 2026-09-09
**Status:** Proposed

**Context:** D-008's `SiblingScope` and D-009's automatic post-split check both operate on
one root ancestor's tree. Two top-level tasks in the same project — each its own root,
never produced by the same split — are invisible to both mechanisms. Observed on `book`:
TASK-1 and TASK-3, planned independently, ended up writing real conflicting logic into the
same four files (`ingest-url/handler.ts`, `fetch-source/handler.ts`,
`bookmark-digest-stack.ts`, `dynamo.ts`), and only a manually-run `npm run overlap book`
caught it — nothing in the loop itself did. See `wiki/current-work.md` for the full
`tmp/overlap-2.txt` finding.

**The fork this needs a human on:** `findCollisions` (`src/overlap.ts`) already answers
this correctly for the whole tree when run by hand — the question is only *when* it runs
automatically. Two shapes, not mutually exclusive:

1. Run it against the whole project tree whenever a task is promoted to `ToDo`, not only
   right after a split. Cheap, but a collision found this late still means one of two
   already-planned tasks needs replanning.
2. Give the planner/architect visibility into *other top-level tasks* in the project, not
   just its own tree's siblings — i.e. extend `SiblingScope` (or a variant of it) to the
   whole project rather than one root ancestor. Prevents the collision from being planned
   in the first place, at the cost of the same context-size pressure D-008's rationale
   already weighs against widening scope.

Not resolved here because it changes what counts as a task's "scope" for planning
purposes, which is worth a decision before code, not after.

**Update (D-012):** for a project opted into D-012's autonomous integration, this gap is
effectively moot — the mandatory rebase-then-regate step before any merge is a real
compile+test run against the actual current `baseBranch`, strictly stronger than the
static path-collision guess this decision is about. TASK-1/TASK-3's collision would
surface as an integration conflict or gate failure on whichever task tried to integrate
second, not silently. This decision remains fully open for every non-autonomous project,
which is still the default.

---

## D-012 — Autonomous integration for opted-in projects: the agent rebases, re-gates, and
squash-merges its own clone's task branches, no human step

**Date:** 2026-09-09
**Status:** Accepted

**Context:** D-011 (above) identified that sequencing top-level tasks with `dependencies`
fixes *when* the loop starts a dependent task but not *what it starts from*: without a
human merging a finished branch back to `baseBranch` first, the next task still forks
from a stale base and can reproduce the exact collision the dependency was meant to
prevent. The human asked to remove that human step entirely, while keeping the existing
hard constraint intact: the agent never pushes anywhere (D-003), and never touches a
developer's own working checkout without being explicitly told to.

**Decision:** `ProjectEntry.autonomous` (`src/config.ts`) is an opt-in per-project flag.
When set, `case "reviewer":` in `src/tick.ts` (after the existing final-summary/status
write) runs a deterministic, model-free integration instead of stopping at `Review`:

1. Rebase the task's branch onto `baseBranch`. A conflict aborts the rebase, blocks the
   task (`STATUS.blocked`, label `needs-manual-merge`), and never auto-resolves.
2. On a clean rebase, re-run `captureBaseline`/`runGates` (`src/gates.ts`) against the
   *rebased* tip — the same functions the executor path already uses. This is the
   load-bearing check: "gates were green before rebase" says nothing about after, and
   rebasing onto a branch that moved is exactly D-011's collision shape. A post-rebase
   gate failure resets the task branch back to its pre-rebase tip (`git reset --hard`)
   and blocks the same way a conflict does — never leaves a broken rebase in place.
3. On green gates, squash-merge the branch into `baseBranch` and mark the task `Done`.
   The task branch is never deleted, success or failure, so a human can inspect exactly
   what merged and why whenever they come back.

Every step writes a `backlog.comment` — there is no silent state transition in this path.

**How a project opts in (`src/register-project.ts`):** registering from a git URL (or an
`owner/repo` shorthand, cloned via `gh repo clone` to ride an existing `gh auth` session
instead of requiring local SSH-key/PAT setup, falling back to plain `git clone` when `gh`
isn't available or the source isn't GitHub-shaped) clones into
`$BAKLOOP_HOME/clones/<key>`, checks out a dedicated `bakloop/trunk` branch, and sets
`autonomous: true` automatically — there is no developer working checkout at that path to
protect, so full autonomy is the natural default. Registering from an existing local path
keeps today's exact supervised behavior unless `--autonomous` is passed explicitly, which
prints a loud warning: that's a known, plainly-flagged risk against a real checkout the
human may also be working in, not something this decision tries to soften.

At the start of a run (not per-tick), an autonomous project's `main.ts` does one
best-effort `git pull --rebase` on `baseBranch` before the loop begins, so upstream
movement has *some* chance to reach the trunk before a run of tasks builds on it. A
failed pull just aborts and continues on the existing tip — never blocks the run, and
nothing pulls again mid-run.

**Consequences:** D-003's push block is completely unmodified — nothing in this path ever
calls `git push`, so `src/git-guard.ts` needed no change; the boundary this decision
respects is "never push," not "never merge." Merge/`Done` authority for a top-level task
is genuinely new and, for an opted-in project, supersedes the "human/GitHub-sync only"
line in CLAUDE.md's human-only list — see that file's amendment in the same change as
this decision. A long-running autonomous loop can still drift from the real upstream
over its lifetime, since sync only happens once at start-of-run; accepted as a known
limit rather than risking a mid-loop pull moving `baseBranch` out from under a task
that's mid-attempt on it.

---

## D-013 — A real review gate: `critic`, with push-back and re-spec, ahead of `reviewer`

**Date:** 2026-09-09
**Status:** Accepted

**Context:** `prompts/reviewer.md` says outright *"your job is not to re-verify
correctness but to write the final summary"* — it's read-only and `tick.ts` never
parses its text for a verdict. Before this decision, `reviewer` contributed nothing but
documentation; the only real quality bar was "acceptance criteria met + gates green," a
compile/lint/test-count bar, never a correctness or design one. For a supervised
project, a human reading the PR was the actual review; for a D-012 autonomous project,
that human doesn't exist and nothing replaced it.

**Decision:** A new role, `critic` (`ROLE_TOOLS`: read-only + `bash`, so it runs its own
`git diff`/`git log` rather than trusting a description of one), sits between
"acceptance criteria met" and `reviewer` for every project, autonomous or not
(`src/phase.ts`, `src/tick.ts`'s `case "critic":`). It answers on its first line with
`SHIP`, `CHANGES`, or `RESPEC` (`parseCriticOutput`, `src/spec.ts`, same explicit-
first-line-or-fail-safe contract as `parseAlignmentOutput`, defaulting unparseable
output to `CHANGES` — the milder of the two blocking options, since an ambiguous reply
is far more likely a formatting slip than a genuine "the whole plan is wrong" finding):

- `SHIP` writes a one-shot `**critic:**` marker to `implementationNotes`
  (`hasCriticVerdict`) and the task proceeds to `reviewer`.
- `CHANGES` posts critic's feedback as a comment (the executor's own `CONTEXT` policy
  already includes the last 3 comments, so this is what actually reaches it) and sets
  `NEEDS_CHANGES_LABEL`, which routes straight back to `executor` — bypassing the
  acceptance-criteria-complete check even though AC stay checked throughout. Bounded by
  its own counter, `AttemptLog.criticRounds`, capped at `MAX_CRITIC_ROUNDS` (3); beyond
  that the task blocks (`NEEDS_HUMAN_REVIEW_LABEL`, purely informational like
  `NEEDS_MANUAL_MERGE_LABEL`).
- `RESPEC` clears `implementationPlan` and resets `status` to `ToDo` — blank-plan
  routing alone would already route to `planner` regardless of status, but the reset
  keeps a re-spec'd task in the normal queue rather than wherever `critic` left it.
  Verified end-to-end: a `RESPEC`'d task returns to `planner`, and only reaches
  `executor` again once a fresh plan is written (see D-014, which retired the
  human-approval gate this bullet used to describe).
- A **container** (subtasks present) has no single executor to hand `CHANGES` feedback
  to, so it gets a binary gate: `SHIP` proceeds, anything else reuses `NEEDS_REPLAN_LABEL`
  + `STATUS.blocked` — the exact pattern `DRIFT` already uses.

**Not a D-001 violation:** see D-001's 2026-09-09 amendment — this is a distinct,
adversarial role judging a different role's finished diff, never trusting an actor's
account of its own work, and it only ever adds a gate on top of gates already green.

**A necessary, deliberate reorder to make this correct:** `if (attempts >= 2) return
senior` was checked unconditionally in `resolvePhase`, *before* `acDone` was even
computed — despite its own comment saying it's gated behind "repeated machine failure,"
which only makes sense pre-first-success. Nothing ever resets `attempts`, so once a task
crossed that threshold (from raw retries before ever going green), it would silently
route to the read-only `senior` role forever afterward — including on every tick of a
perfectly good critic/executor revision cycle, since `attempts` keeps incrementing on
every executor invocation regardless of trigger. Fixed by moving the `attempts >= 2`
check inside the `!acDone` branch. Verified: `attempts` reaching 4 across four
successful critic-driven revision rounds never misrouted to `senior` (see the
exhaustion-ceiling scratch run in this change).

**Consequences:** `log.attempts`/`log.signatures`/`MAX_ATTEMPTS`/`isStuck` are
completely untouched by this feature and keep meaning exactly what they meant before —
a critic-requested fix that itself fails to compile is still a normal "the executor is
struggling" situation and correctly falls through to that existing machinery (observed
directly: a stub that made no real progress across three `NEEDS_CHANGES_LABEL` rounds
hit the pre-existing `blocked-attempts` ceiling at attempt 4, exactly as it would for
any other stuck executor). `criticRounds` is a deliberately separate counter for
exactly this reason — reusing `attempts` for it would have reintroduced the same
stranding bug this decision's reorder just fixed, one layer down.

**Known rough edge, not fixed here (see `wiki/gotchas.md`):** because `NEEDS_CHANGES_LABEL`
only overrides the reordered senior-check while it's actively set, a task that
interleaves several *raw* gate failures with critic rounds (rather than clean
critic-round successes) could still, in principle, hit an in-between tick where
`acDone` reads false and `attempts` is already high enough to escalate to `senior` mid-
cycle. Safe (soft-halts for a human, matching `senior`'s existing semantics) and rare,
not silently wrong — not worth a second parallel counter for a case this narrow.

---

## D-014 — Retire D-002: `ToDo` replaces `Waiting for Approval` + `Ready for Work`, no human gate

**Date:** 2026-09-09
**Status:** Accepted

**Context:** D-002 required a human to move a spec+plan'd task from `Waiting for
Approval` to `Ready for Work` before the executor phase could begin, on the reasoning
that the executor is the only role with real read/write/edit/bash access to a target
repo and was judged too risky to leave fully unsupervised. In practice this added a
second status purely to hold a human checkpoint, and the user has decided to run bakloop
fully autonomously through planning and execution — the human review that matters now
happens at `Review` (PR merge) and, for `autonomous: true` projects, not even there.

**Decision:** Collapse `waitingForApproval` and `readyForWork` into a single status,
`todo` (`"ToDo"`). The planner parks a finished spec+plan directly in `ToDo`
(`src/tick.ts`'s planner case). `resolvePhase`'s executor gate (`src/phase.ts`) accepts
`ToDo` or `In Progress` — the same shape as before, just one fewer status to move
between. No human action is required anywhere between planning and execution starting.

**Consequences:** The loop can now make progress on any spec+plan'd task with nothing
left to do but wait its turn — no more stalling on an un-moved column. The cost D-002
was accepted for (an executor running unsupervised) is now accepted as the default,
not a carve-out; the only remaining human checkpoints in the default pipeline are the
`Review` merge and `critic`'s `MAX_CRITIC_ROUNDS`/container-blocked backstops, plus
whatever gates (`tsc`/`biome`/`vitest`/diff checks) `src/gates.ts` enforces regardless.
Supersedes D-002.

**Migration note:** existing tasks already sitting at the old `Waiting for Approval` or
`Ready for Work` status strings are not touched by this change — those statuses no
longer appear in a freshly-run `npm run setup`'s `config.yml`, so any task left at one
of them needs a manual `backlog task edit <id> -s "ToDo"` before it becomes eligible
again.
