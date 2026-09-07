# Gotchas

Append-only. Each entry: symptom, cause, fix. Newest at the bottom.

Capped at ~15 entries — this file loads every session.

---

## Nested splits are untested and can fragment the one-branch-per-ticket invariant

**Symptom:** A subtask that itself gets split (its planner emits `SPLIT` instead of a
plan) appears to work — `resolvePhase`'s container check applies generically, and
`createChild`/`ensureTaskBranch` don't reject it — but the resulting grandchild subtasks
commit to the *immediate* parent's branch, not the top-level ticket's.
**Cause:** `ensureTaskBranch` keys off `task.parentTaskId ?? task.id` (see D-004 in
`wiki/decisions.md`), which only looks one level up. A grandchild's `parentTaskId` points
at the subtask that split it, not at the original top-level ticket, so its branch name
diverges from the ticket's single branch.
**Fix:** Treat nested splits as unsupported, not merely unverified. If the planner ever
needs to split a subtask, resolve `ensureTaskBranch` to the *root* ancestor first (walk
`parentTaskId` to its end) rather than assuming one level of nesting — and add a real test
for a two-level split before relying on it.

---

## `git-guard.ts`'s push block is not a sandbox

**Symptom:** Someone points at `src/git-guard.ts` as proof the executor "can't push."
**Cause:** The block works by shadowing `git` on `PATH` with a wrapper that refuses any
command containing `push`. It relies on the executor only ever invoking `git` by that bare
name.
**Fix:** Don't extend the executor's tool surface (e.g. a raw shell-exec with a
user-supplied `PATH`, or letting it read `/usr/bin/git`'s absolute path) without checking
whether it can route around the wrapper. This is documented as a deliberate, acknowledged
gap (D-003), not an oversight — but it's easy to accidentally widen.

---

## A container task's own owner/planner/executor phases are permanently skipped

**Symptom:** A parent task that has been split never gets its own description or plan
touched again, even if its subtasks are all still in `Backlog`.
**Cause:** `resolvePhase` checks `subtasks.length > 0` before any other field check — once
a task has children, it's a container forever, routed only to `reviewer` (and only once
every child is `Done`). This is correct behavior, not a bug, but it means you can't "fix
up" a container's own description after the fact through the normal owner phase.
**Fix:** Edit a container's description directly via the Backlog.md CLI if it needs
correcting — bakloop's own pipeline will never touch it again.
