# ROADMAP

Future-facing ideas, not yet decided. Unlike `decisions.md`, nothing here is
`Accepted` — an entry here is a candidate shape for a `Proposed` or `Accepted` decision,
not one itself. When an idea below actually gets built, write it up properly in
`decisions.md` and either delete or shrink its entry here to a one-line pointer.

> **Historical note (refactor in progress, D-019).** Both entries below were written
> against the previous draft-promotion pipeline and reference roles (`planner`,
> `architect`, `critic`) and concepts (draft trees, draft promotion) that the refactor
> retires or reshapes. They are kept as-is for the record, not as live proposals. R-001's
> core idea — the board holds one ticket's work at a time — is now part of D-019's
> "one top-level ticket at a time" rule; R-002's "plan the next child just-in-time" is now
> part of D-019's serial child scheduling. Reconcile these against D-019 before acting on
> anything here.

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

---

# Harness² backlog (R-003 – R-007)

Source: Google Research's Harness² (github.com/google-research/harness2, Apache 2.0,
paper arXiv 2610.14224). We borrow ideas only — it is Python/Vertex/OpenCode, its executors
run network-open and (Codex) unsandboxed, and it targets benchmarks, not a gate-driven
queue. Every item below must keep D-001 (gates decide pass/fail), D-003 (`git push`
blocked), D-019 (role isolation) intact. All are **unscheduled** until the D-019
local-model smoke (`current-work.md`) has run: tuning or learning on an unverified
pipeline measures noise.

**Suggested order:** smoke → R-004 (measurement) → R-006 (cheap, independent) → R-003
(lessons) → R-005 (prompt tuning) → R-007 (audit). R-004 first because R-003 and R-005
are unfalsifiable without it.

## R-003 — Lessons memory: carry evidence-backed lessons from finished tickets into later ones

**Idea:** the "improvement harness" — after a root ticket ends, keep evidence-backed lessons
and inject the active ones into planning/reassessment/executor prompts under a char budget.
Plan lives in `lessons-memory.md`. Phases: store + evidence packet + validator (no model)
→ `reflect` tick → injection behind `BAKLOOP_LESSONS` + journal columns → review.
Depends on: smoke; benefits from R-004 for evaluation.

## R-004 — Replay benchmark: measure a prompt/engine change on past tickets

**Idea:** Harness² never changes a harness without running it on tasks and comparing.
bakloop has no way to answer "did this prompt change help?" except waiting for new
tickets. Build a small replay corpus so changes can be compared on the same work.

**Fit:** the journal (`journal.ts`) already records ticks per task, gate failures, Tester
rounds and outcomes; transcripts hold exact prompts. What is missing is a *fixed input*.

**Plan:**
1. Corpus format: a directory of cases, each = target repo pinned at a commit + the
   ticket's `raw`/description + the gate set. Cases come from tickets that finished
   `Done` (known-solvable). Store outside the repo, under `$BAKLOOP_HOME/bench/`.
2. Runner: `pnpm --filter engine bench <case|all> [--runs N]` — clone the case into a
   scratch dir, run the normal tick loop against a throwaway task store/journal
   (`BAKLOOP_HOME` override), never the real one. `git-guard` stays on.
3. Metrics per run, straight from the journal: ticks to Done, gate failures, Tester
   rounds, reassessments, Blocked, prompt chars. Report mean/range over N runs; local
   models are noisy, so single runs prove nothing.
4. Compare mode: same cases under two configs (prompts dir, `BAKLOOP_LESSONS`, model).
   Output a table, not a verdict.

**Acceptance:** one case replays end-to-end offline; two runs produce comparable journal
rows; a deliberately broken prompt measurably scores worse.

**Risks:** cases that overfit the corpus; corpus rot as engine changes (pin engine commit
per report); wall-clock cost on a local model (start with 3–5 small cases).
**Depends on:** smoke. **Unblocks:** R-003 eval, R-005.

## R-005 — Offline prompt tuning (Propose–Probe–Compose, human-gated)

**Idea:** Harness² improves a harness by proposing edits, probing them on the same task,
and composing from the behavioural contrast between runs — with no ground-truth feedback.
We *do* have ground truth in gates, which makes this easier for us.

**Fit:** `packages/engine/prompts/*.md` (architect-criteria/planning/reassessment/
research/split/alignment, executor, tester) are the editable surface; they are templates
with `{{context}}`, so edits are text-only and diffable.

**Plan:**
1. Tool: `pnpm --filter engine tune <mode> [--k N]`, never part of the tick loop.
2. Propose: an editor model call gets the current template plus the worst journal
   evidence for that mode (gate failures, Tester `CHANGES`, overflow) and returns up to K
   candidate edits as unified diffs of that one template.
3. Probe: run each candidate through R-004 on the same cases; collect metrics.
4. Compose: keep the best candidate only if it beats baseline on the metrics by a margin
   across repeated runs; otherwise report "no improvement".
5. Output is a patch plus the comparison table for **human review**. Never auto-applied,
   never edits `prompts/` directly. Distinguish *invariant* edits (any project) from
   *project-specific* ones (route those to R-006).
6. Constraint guards: reject any candidate that adds tools, weakens the Tester's
   fail-closed verdict wording, or injects history into `criteria` mode.
7. Editor model — local by default, cloud strictly opt-in (see below).

**Acceptance:** produces a reviewable patch for one mode with before/after numbers; a
no-op run says so.
**Editor model configuration (opt-in cloud).** The editor is the one place a stronger
model may pay off: it writes a few candidate prompt diffs offline, rarely, and a human
reviews the result. Today every request stays on the machine (`src/local-model.ts`,
`OMLX_*` env vars in `src/agent.ts`), so a cloud editor is a new data boundary and gets
explicit consent rather than a silent fallback.

- **Default:** the editor uses the same local model as the loop. Nothing changes unless
  cloud is switched on.
- **Two switches, both required for a cloud call:**
  1. *Provider configured* — `BAKLOOP_EDITOR_PROVIDER` + `BAKLOOP_EDITOR_MODEL` (env, same
     style as `OMLX_*`). The API key comes from the provider's standard env var through
     pi-ai's `envApiKeyAuth`; it is never written to `projects.json` or any state file.
  2. *Per-run flag* — `tune <mode> --editor cloud`. Omitted → local.
  Missing either is a hard error naming which, never a quiet downgrade either way.
- **Sees only what it needs:** the template under edit plus a bounded evidence digest
  (gate failure signatures, Tester `CHANGES` text), not transcripts or whole files. With
  `--redact` on by default, absolute paths become repo-relative and each excerpt is
  truncated to a fixed length. Everything outbound is assembled in one function so there
  is one place to audit.
- **`--dry-run`:** prints the exact outbound payload and its size, makes no call.
- **Cost and audit:** `--max-tokens`/`--max-cost` caps per run; each cloud call is
  appended to the tune run's own log (provider, model, chars in/out, cost, timestamp). A
  run summary states plainly that a cloud model was used.
- **Never reachable from the loop:** the cloud provider lives in a separate module
  (`editor-model.ts`) that `agent.ts`/`tick.ts` do not import; a test asserts the tick
  path's import graph excludes it. The Architect/Executor/Tester stay local-only.
- **Needs a decision record** when accepted: it amends the "local model, nothing leaves the
  machine" stance in `CLAUDE.md`, scoped to the offline tuning tool.

**Risks:** metric gaming (a prompt that games tick counts); small samples; leaking
project-specific content to a third party if redaction is incomplete (hence the dry-run
and the explicit per-run flag); cloud-editor patches that look good but don't win on R-004's
metrics (the compose step judges by measured results, not by who wrote the patch).
**Depends on:** R-004 (hard).

## R-006 — Per-project prompt overlay

**Idea:** Harness² separates invariant edits from domain-specific ones. bakloop has only
global templates, so project quirks (test command, conventions) either bloat shared
prompts or live in the task text.

**Plan:**
1. Optional file `$BAKLOOP_HOME/state/<project>/overlay/<mode>.md`, human-written.
2. `renderPrompt` (`src/prompts.ts`) appends it under a clearly delimited heading, after
   `{{context}}`, within a fixed char budget; over-budget overlays are truncated with a
   logged warning, not silently.
3. Allowed modes: planning, reassessment, executor. Never `criteria` or `tester` (same
   isolation reasoning as R-003).
4. `register`/`list-projects` show whether an overlay exists; journal records overlay
   chars so prompt-size regressions are visible.
5. Becomes the landing place for R-005's project-specific patches and for human-approved
   R-003 lessons, if we choose to merge them.

**Acceptance:** overlay text appears in the rendered executor prompt in a test
(`routing.test.ts` style); absent overlay changes nothing.
**Risks:** overlay becoming a dumping ground that causes context overflow — hence the
budget. Small, independent, no dependencies; good first item after the smoke.

## R-007 — Contrastive reassessment evidence

**Idea:** Harness² composes from the *contrast between executions*, not from one run's
failure. bakloop's `reassessment` mode currently gets the last 10 gate/Tester comments
(`failures: 10` in `src/prompts.ts`) — a flat list, no comparison across attempts.

**Plan:**
1. Deterministic digest built by the orchestrator, no model call: per attempt, the gate
   that failed (normalised signature), whether that signature repeated or changed from
   the prior attempt, and the files touched (diffstat). Tester `CHANGES` items are listed
   once each with the round they appeared.
2. Render it into reassessment context as "what changed between attempts and what did not"
   (e.g. "tsc TS2322 in src/x.ts persisted across 3 attempts; the Executor edited
   src/y.ts instead").
3. Tests: given scripted attempt logs, the digest flags a repeated signature and a
   changed one.

**Acceptance:** reassessment prompt contains the digest; with R-004, reassessment-then-pass
rate is compared before/after.
**Risks:** gate output normalisation is fragile across tsc/biome/vitest formats; keep
raw failure text as fallback. Independent of the other items; cheapest to try.

## Considered and not planned

- **Parallel candidate harnesses per ticket (k probes, compose).** Each probe is a full
  Executor run on a small local model; cost scales linearly and there is one working tree
  and one branch per root (D-004). Revisit only if R-005's offline results show high
  variance between candidates.
- **Running Harness² itself against bakloop.** Would need a substrate adapter and an
  unsandboxed network-open executor; the README itself warns about this. The same value
  is available through R-004/R-005 on our own gates.
- **Sequential recursion within a ticket.** Already approximated by the bounded
  rework/Tester loop plus a single reassessment (D-019); more iterations would break the
  "block for a human rather than loop" rule.
- **Harness component checklist (system prompt, guardrails, memory, tool guidance,
  subagents, skills, scripts, plugins).** Useful as a vocabulary when writing R-005's
  editor prompt; not a work item on its own. bakloop's equivalents: prompts, `git-guard`/
  gates, R-003, `ROLE_TOOLS`, the three roles.
