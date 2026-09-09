# Gotchas

Append-only. Each entry: symptom, cause, fix. Newest at the bottom.

Capped at ~15 entries — this file loads every session.

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

---

## A local-model refusal (context overflow, OOM) used to kill the entire overnight run

**Symptom:** oh-my-pi/MLX throws something like `Prefill context too large for available
memory (pre-chunk guard ...): predicted peak would exceed prefill safety cap ... (90% of
metal_cap ceiling ...)`. Before this was handled, that error propagated uncaught from
`runAgent` through `tick.ts` and `main.ts`'s `for(;;)` loop straight to `main().catch`,
which exits the whole process — one capacity hiccup on any task ended the whole run, not
just that task.
**Cause:** A model-call failure isn't a gate verdict (D-001) and shouldn't be conflated
with one, but it also wasn't being caught anywhere at all.
**Fix:** `tick.ts` now wraps the `runAgent` call in a try/catch, tracking consecutive
failures in `AttemptLog.modelErrors` (separate from the gate-attempt counter, reset on any
success) and blocking that one task after `MAX_MODEL_ERRORS` (3) — the rest of the queue
keeps going. `main.ts` also has a bounded top-level catch (`MAX_CONSECUTIVE_CRASHES`, 5)
as a backstop for anything tick.ts's own handling doesn't cover. If you hit the wired-limit
error itself repeatedly, that's a hardware/config ceiling (`sudo sysctl
iogpu.wired_limit_mb=...`, or lower `OMLX_CONTEXT_WINDOW`), not something retrying will fix
on its own — the retry buys resilience against a transient/one-off hit, not a
structurally-undersized memory cap.

---

## `npx backlog` is a different program than the `backlog` bakloop calls

**Symptom:** You check a CLI flag with `npx backlog task create --help` while debugging,
get a completely different set of options (`--repository`, `P0`–`P3` priorities, a
`task remove` subcommand), and conclude bakloop is calling the CLI wrong — or "discover"
that a field like Definition of Done doesn't exist when it does.
**Cause:** `backlog` on npm is an unrelated package (v1.4.56). Backlog.md installs as a
binary on `PATH` (homebrew, v1.51.0), which is what `src/backlog.ts` invokes by bare name.
`npx` prefers the registry package and silently fetches it.
**Fix:** Always verify flags with the bare `backlog ...`, never `npx backlog ...`. Confirm
with `backlog --version` — bakloop's types are pinned to Backlog.md schemaVersion 1 and
`src/backlog.ts` throws on a mismatch, but that check only fires on `--json` reads, not on
a help page you read by hand.

---

## Backlog.md has no `task remove`; a failed cleanup is easy to miss

**Symptom:** A throwaway probe task you "deleted" is still in `backlog task list` and
becomes a real candidate for the next tick loop.
**Cause:** Backlog.md v1.51.0 offers `archive`, `complete`, and `demote` — there is no
`remove`, and no `-y` flag anywhere (both belong to the unrelated npm `backlog` package
above). A cleanup line written as `backlog task remove X -y 2>/dev/null` fails silently
and leaves the task in the store.
**Fix:** Use `backlog task archive <id>`, and never redirect stderr away from a cleanup
step. If you create probe tasks against `$BAKLOOP_HOME`, list the store afterwards and
confirm they're gone — the store is shared with every registered project's loop.

---

## Definition of Done has no replace-all flag, unlike acceptance criteria

**Symptom:** A task ends up with its Definition-of-Done items duplicated after a role
re-runs.
**Cause:** `--acceptance-criteria` replaces the whole AC list, so `setAcceptanceCriteria`
is idempotent. DoD only has `--dod` (append) and `--remove-dod <index>`, so
`Backlog.addDefinitionOfDone` appends and cannot be made idempotent the same way.
**Fix:** It's safe today only because `resolvePhase` routes to `criteria` solely when the
task has no acceptance criteria at all, and `tick.ts` additionally checks
`definitionOfDone.length === 0` before appending. If you ever let another role write DoD,
clear the existing items by index first — don't assume the write replaces.

---

## A planner's split header format could kill the whole run, not just the task

**Symptom:** `main` logs `tick threw (1/5): Planner requested a split but no subtasks were
parseable`, five times, then the loop exits — discarding a split proposal that reads
perfectly well in the log.
**Cause:** Two compounding bugs. `spec.ts`'s `SUBTASK_HEADER` demanded the literal
`## Subtask:`, so a model writing `## Subtask 1:` (or bolding the marker) parsed to zero
children; and `parsePlannerOutput` *threw* on zero children, which propagates past
`tick.ts` into `main.ts`'s `MAX_CONSECUTIVE_CRASHES` counter.
**Fix:** The header matchers now tolerate numbering, `###`, em-dashes, and `**bold**`
(including `**Header:**`, where the colon sits inside the bold — the obvious
`(?:\*\*)?…(?:\*\*)?:` shape does *not* match that). And a failed parse returns
`{ kind: "unparseable" }` rather than throwing: `tick.ts` blocks the one task with the
verbatim proposal in a comment. Rule for any new model-output parser here: never throw
from one. A malformed reply must cost one task, never the run.
