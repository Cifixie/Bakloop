# Workflow — draft → promote → main loop → done

## 1. Draft — raw capture

**Action:** `pnpm run new-draft <project>`

Creates a Backlog.md entry with status `Draft` — a raw title + human-pasted description. No model runs. Drafts are invisible to the tick loop (`src/tick.ts`).

The verbatim text is stored in `draft_source TEXT` on the task row (D-018). It is injected into every role's prompt throughout the entire lifecycle so the original ask is never summarized away.

## 2. Promote — plan-mode loop (no execution)

**Action:** `pnpm run promote-draft <draft-id> <project>`

Sets status to **`ToDo`** (`promote-draft.ts:71`, `STATUS.todo`). Drives each draft through plan-mode roles scoped to its tree (`restrictToTree: draftId`), up to 40 ticks (`MAX_PLAN_TICKS`), then returns. The repo is left on its base branch for human review.

Since `createDraft` already wrote the description, `resolvePhase` skips `owner` and routes:

| Tick | Condition | Role |
|---|---|---|
| 1 | `ToDo`, no acceptance criteria | `criteria` — writes `acceptanceCriteria` + `definitionOfDone` (reads description only) |
| 2 | No `needs-split` label, blank plan | `planner` — writes `implementationPlan` or proposes `SPLIT` |

If the planner proposes a split, `hasArchitectContract(task)` is checked (`tick.ts:527`). Without a contract, the proposal is discarded, the task is labelled `needs-architecture`, and `architect` runs to write the interface contract first. Children are only created after the contract exists.

By return, every task in the tree is planned or has spec'd children. `printTreeSummary` prints the tree for human review (`promote-draft.ts:121-136`).

## 3. Main loop — execution

**Action:** `pnpm start <project>` (i.e. `tsx src/main.ts <project>`)

Polls for tasks in `Backlog` or `ToDo`. Enforces exactly one `In Progress` per project per tick (hard invariant in `tick.ts`). Drives the full role pipeline:

```
Backlog → owner → criteria → researcher/architect → planner
       → ToDo → executor (gate loop: tsc/biome/vitest/diff)
       → senior (repeated failure) → documenter (if diff touches docs)
       → critic (SHIP/CHANGES/RESPEC) → reviewer → Review (human merges) → Done
```

For a new task in `Backlog` with no description, `resolvePhase` routes: `owner → criteria → planner → ToDo`. Tasks already-planned from promotion start in `ToDo` with a plan, so `executor` picks them up directly (D-014 — no human approval gate).

### Role pipeline details

**`owner`** (tick.ts:744-759): writes `description` + optional `type`. Fails loudly on empty output.

**`criteria`** (tick.ts:761-782): writes `acceptanceCriteria` + `definitionOfDone`. Reads description only — never its own earlier reasoning, to avoid criteria that restate the description.

**`planner`** (tick.ts:498-620): writes `implementationPlan` or proposes `SPLIT`. Sets task to `ToDo` on plan completion.

**`researcher`** (tick.ts:648): triggered by `needs-research` label. Writes findings to `implementationNotes`.

**`architect`** (tick.ts:621-646): two distinct passes:
- **Pre-split** (`needs-architecture` label): writes interface contract to `implementationNotes`, clears the label.
- **Post-split alignment** (all children `Done`, `hasAlignmentCheck` not yet seen): checks finished siblings against the contract. `DRIFT` → `Blocked`.

**`executor`** (tick.ts:785-847): gate loop. Runs `tsc`, `biome`, `vitest`, diff-vs-base. On green: marks acceptance criteria and DoD as complete. On failure: logs attempt (capped at `MAX_ATTEMPTS=4`). If stuck (same signature persists), blocks for human.

**`senior`** (tick.ts:649-654): triggered after `attempts >= 2` on first gate pass. Writes advice to `implementationNotes`. Does not reset attempts — a task that passed gates at least once never re-trips this.

**`documenter`** (tick.ts:655-668): triggered when the diff touches a documented surface (README, docs/, wiki/, config files, OpenAPI specs, exports). Forbidden from touching source code (no `bash` tool — uses `docsWrite`/`docsEdit`). Commits deterministically via `commitAll` (`src/branch.ts`).

**`critic`** (tick.ts:670-731): independent verdict on the actual diff, never the executor's own account (D-013).
- `SHIP`: one-shot marker written (`hasCriticVerdict`), proceeds to reviewer.
- `CHANGES`: feedback sent back to executor via comment. Capped at `MAX_CRITIC_ROUNDS=3`; exhausted → `Blocked` + `needs-human-review`.
- `RESPEC`: blanks the plan, resets status to `ToDo`. Task re-routes to planner.

**`reviewer`** (tick.ts:732-743): writes `finalSummary`, sets status to `Review`.

### Safety mechanisms

- **Gates drive pass/fail** — never the model's own summary (D-001, `src/gates.ts`). `tsc`, `biome`, `vitest`, diff-vs-base.
- **Subtask self-finalize** (tick.ts:813-817): when gates go green, a subtask (`task.parentTaskId` set) immediately becomes `Done` — no separate review. The parent only proceeds once every child is `Done`.
- **`git push` is hard-blocked** via PATH-shadowing wrapper (`src/git-guard.ts`). Branches are reviewed and pushed by a human.
- **One task per slot** — at most one `In Progress` per project. Containers (tasks with subtasks) are excluded from selection until all children are `Done` (`excludeInFlightContainers`, tick.ts:203-212).

## 4. Done — human or autonomous merge

After `reviewer`, status becomes `Review` — human-owned, agent never touches again (`resolvePhase:115` returns `null` for `STATUS.review`).

- **Standard project:** Human reviews the PR and merges. Task is marked `Done` externally.
- **Autonomous project** (`--autonomous` on register, D-012): after `reviewer` passes, `integrate()` runs for **top-level tasks only** (`tick.ts:739`: `if (!autonomousIntegration || task.parentTaskId)`). It rebases onto `baseBranch`, re-runs gates, and squash-merges. On rebase conflict → `Blocked` + `needs-manual-merge` (`tick.ts:874-888`). On post-rebase gate failure → `Blocked` + `needs-manual-merge` (`tick.ts:893-907`). Subtasks still self-finalize on green gates — the `--autonomous` flag only changes what happens to top-level tasks after review.

## Loop lifecycle

Runs ticks (`src/main.ts`) until no task is `Backlog`/`ToDo`/`In Progress`. On `SIGINT`/`SIGTERM`, the in-flight tick finishes before stopping (D-006). On exit, the working tree is checked back to `baseBranch`.

Observability: every tick is journal'd to `$BAKLOOP_HOME/state/<project>/journal.db` (SQLite). Transcripts are written to `state/<project>/transcripts/<task-id>/`.
