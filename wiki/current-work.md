# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

## In progress: serial Architect → Executor → Tester refactor (D-019)

The D-019 workflow is implemented in the engine and passes focused typecheck/tests. The
capture command stores request bytes verbatim; Architect modes, serial root-tree routing,
gate-before-Tester review, bounded rework, split alignment, integrated testing and the
scoped `clean-start` command are wired. A scripted end-to-end scenario against a scratch git
repository passed (criteria → split → serial child plan/execute → alignment → Tester →
child Done and root Review). No local-model run has been performed; the local-model smoke and
before/after journal comparison remain outstanding.

**Clean-slate rollout:** `pnpm --filter engine clean-start <project>` selects a new
globally unused prefix before clearing the project's task rows and per-task attempts. The
operation preserves the shared DB, other-project rows/configuration, journals, transcripts,
and all repository branches. As a necessary non-destructive schema cutover on the shared
SQLite table, it adds only the fresh `raw` column; it does not migrate any task row. Each
project must be clean-started before its old task rows can be used by the new workflow.
The existing `book` registration was clean-started during this work; its task prefix is now
unique for the fresh workflow. The shared store is empty, with no per-task attempt logs.

**Verification:** engine typecheck clean; 50 focused engine tests pass; scripted end-to-end
workflow passes in a disposable git repo. A targeted clean-start check showed that selected
project task rows are removed, a synthetic other-project row survives unchanged, the task
prefix rotates, and pre-existing branch refs are untouched; the synthetic row was then
removed. No local-model smoke or historical journal comparison was performed.

**Remaining action:** run the queued-task split/serial-child/tester scenario against the
configured local model when a safe compatible model session is available, and compare
journal metrics with the previous workflow where history allows.

## Design record

D-019 supersedes the draft entity/promotion path and old task-role routing. Historical
journal/transcript files are retained but are reference-only. See `workflow.md` for the
state machine and `decisions.md` D-019 for the accepted boundaries.

## Needs your sign-off

Nothing blocking the refactor — its shape is decided (D-019). One proposal awaits a go/no-go:
lessons memory (`lessons-memory.md`, R-003), which should wait for the local-model smoke.
Other open design questions live in `ROADMAP.md` (R-001/R-002).
