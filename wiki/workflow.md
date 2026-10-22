# Workflow — capture → select → plan → execute → test → done

> **Status: accepted design, implementation underway (not verified end-to-end).** The state
> machine below is the one D-019 commits the engine to. `src/types.ts` already carries the
> new `Role`/`ArchitectMode` types; routing, prompts, the queue/scheduling logic, and the
> retired draft paths are still being migrated. Write code against this document, and
> update this document in the same change that makes any part of it real. See
> `../wiki/decisions.md` D-019 and `current-work.md`.

The engine processes **one top-level ticket at a time**. Three task-facing roles carry the
work: **Architect**, **Executor**, **Tester**. Each journal tick records
`role=architect|executor|tester` plus a `mode` field.

## 1. Capture — raw, direct

**Action:** create a normal backlog task (no `Draft` status, no promotion command).

A captured task stores the request **verbatim** in an immutable `raw` field — the source
of truth for planning, editable only by an explicit human edit. `title` is the
human-readable name; `description` is optional human-facing text about why the work
matters. The system never rewrites `description` from `raw`. Capturing more tasks does not
start planning them.

## 2. Select — one tree at a time

Selection picks the next eligible **top-level** task by the deterministic
ordering/dependency rules already in `resolvePhase`. Once selected, that task's tree is
the only one that may advance, until its root reaches `Done` or `Blocked`. A later
top-level task is never planned while the current one is unfinished. At most one task
`In Progress` per project (unchanged hard invariant).

## 3. Plan — Architect, two modes

The Architect runs on the selected leaf.

**Mode `criteria`** (toolless): sees only `raw` and the human `description` — never the
repository, never an implementation plan — and writes `acceptanceCriteria` +
`definitionOfDone`. Isolating this mode is what keeps criteria independently checkable
instead of restating the request.

**Mode `planning`** (read-only): takes those criteria plus bounded repository context and
writes a bounded `implementationPlan`, or a split proposal — scoped child
`raw`/title/description plus a **shared interface contract** — which is created only after
the contract exists (D-007 carried forward). Children are dependency-chained (D-008) and
execute serially.

**Mode `research`** (read-only): runs only when the task explicitly needs external
information; ordinary tasks do not pay for a research pass.

The Architect never writes source files.

## 4. Execute — Executor, gate loop

The planned leaf moves into execution. The **Executor** owns all source *and*
documentation writes (`read`/`write`/`edit`/`bash`); there is no separate documentation
role and no docs-only tool boundary. Deterministic gates (`tsc`/`biome`/`vitest`/
diff-vs-base, `src/gates.ts`) decide pass/fail — never the model's completion claim
(D-001). Gate failures return the actual failure output to the Executor for a bounded
iteration.

## 5. Test — Tester, PASS or CHANGES

After gates pass, the **Tester** independently examines the *actual diff* plus the
criteria, `raw`, and plan. It is read-only.

- `PASS` — the leaf advances (to `Done` if it is a child, to `Review` if top-level).
- `CHANGES` — actionable findings return to the Executor, which revises and re-runs the
  gate loop, then the Tester again.
- An **unparseable or ambiguous verdict fails closed** (treated as `CHANGES`, i.e.
  blocking).

Repeated Tester rejection is bounded. After repeated gate or Tester failure the Architect
may **reassess the plan exactly once**; if the revised plan still fails its next
execution/review cycle, the task **blocks for a human** rather than looping.

Tester replaces the old `critic` + `reviewer`, and adds a semantic quality gate on top of
the deterministic gates — it never replaces or bypasses them (D-013's rationale, under a
new name; D-001 boundary intact).

## 6. Complete a leaf

A subtask reaches `Done` only after deterministic gates **and** a Tester `PASS` — the old
self-finalize-on-green-gates shortcut is gone. Then the next eligible child is selected
and planned; dependency order stays enforced.

## 7. Finalize a split

After every child is `Done`:

1. **Architect alignment** — the split-alignment mode checks the combined result against
   the shared interface contract. A mismatch **blocks the parent** for human intervention.
2. **Tester on the integrated diff** — evaluates the combined diff against the parent
   criteria. `PASS` sends the parent to `Review`; `CHANGES` follows the usual bounded path.

## Scheduling invariant

Planning a later task must never overlap with execution, testing, or unresolved review of
the current top-level task. Queue advancement waits for **top-level `Done`**, not merely
`Review` — under `autonomous: true` (D-012) the engine does the merge itself and marks
`Done`; under a supervised project a human merges and marks `Done` externally.

## Unchanged safety mechanisms

- **Gates drive pass/fail** — `tsc`/`biome`/`vitest`/diff, never the model's summary
  (D-001).
- **`git push` is hard-blocked** unconditionally via PATH-shadowing wrapper
  (`src/git-guard.ts`, D-003). Branch isolation unchanged: one branch per top-level task
  (`bakloop/<task-id>`), shared by all descendants (D-004). Branches are never deleted.
- **Machine routing stays deterministic** — model output supplies bounded content or a
  parsed, fail-closed verdict, never a bypass of gates or an assertion of completion.
- **Autonomous projects** keep their explicit opt-in behavior (D-012) — rebase, re-gate,
  squash-merge, mark `Done`, inside the project's own clone/checkout only.

## Clean-slate rollout

No migration or old-schema compatibility. Before the new workflow runs on a project:

1. **Assign a fresh, globally unique prefix** to that project (D-016) — before clearing
   anything — so no new task ID can map to a pre-existing `bakloop/<task-id>` branch.
2. **Reset only that project's task rows and per-task attempt logs.** The shared database
   is never dropped or recreated, and other projects' rows, project registration,
   target-repo files, and **all branches and historical journal/transcript data are
   retained**. Old branches are never deleted or reused.
3. Retained journals/transcripts are reference-only and must never feed control flow.

## Loop lifecycle

Runs ticks until no ready work remains. On `SIGINT`/`SIGTERM`, the in-flight tick finishes
before stopping (D-006). On exit the working tree is checked back to `baseBranch`.

Observability: every tick is journaled to `$BAKLOOP_HOME/state/<project>/journal.db`
(SQLite), recording role, **mode**, reason, prompt/output sizes, tool calls, durations,
gate outcomes, and Tester rounds. Transcripts to `state/<project>/transcripts/<task-id>/`.
