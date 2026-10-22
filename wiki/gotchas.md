# Gotchas

Append-only. Each entry: symptom, cause, fix. Newest at the bottom.

Capped at ~15 entries — this file loads every session.

> **Historical note (refactor in progress, D-019).** Entries below were written against the
> previous multi-role pipeline and its draft-promotion flow. Several name roles that are now
> retired (`critic`, `senior`, `planner`, `documenter`, `researcher`) and files
> that are being rewritten. They are kept as-is — gotchas are append-only and record traps
> as they were found; do not edit what an old entry means. Read them for the *mechanism*
> (parser fragility, shared counters, CLI traps), not as a description of the current
> pipeline. Current guidance lives in `workflow.md`, `split.md`, and D-019.

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

---

## `caffeinate -i` does not survive a closed lid on battery

**Symptom:** An overnight unattended run (`src/power.ts`'s `startCaffeinate`) still stops
partway through even though the process never crashed and the battery floor was never hit.
**Cause:** `-i` only asserts against *idle system* sleep. It has no effect on the
lid-close sleep macOS forces on battery power regardless of any assertion held — that
requires `-s` (which only works while on AC) or disabling lid-close sleep at the OS level
(`pmset`). Neither is done automatically, since forcing `-s` off is a machine-wide setting
change bakloop shouldn't make silently.
**Fix:** For a run that must survive a closed lid, keep the machine on AC power (README's
"Unattended runs" note) or open the lid; don't rely on `BAKLOOP_NO_CAFFEINATE`'s absence to
mean "won't sleep."

---

## `attempts` is one counter shared by every executor invocation, regardless of trigger

**Symptom:** A task that's already passed gates once (critic's `CHANGES`, D-013, sent it
back to `executor` for a revision) could, in principle, get routed to the read-only
`senior` role instead of back to `critic`/`executor` — stranding a perfectly fine,
almost-shipped task.
**Cause:** `log.attempts` increments on every executor tick, success or failure, and is
never reset. `resolvePhase`'s senior-escalation check (`attempts >= 2`) is now scoped to
only fire pre-first-success (`!acDone`) specifically to prevent this — but the scoping
only protects the *window* while `NEEDS_CHANGES_LABEL` is actively set. A task that
interleaves genuine gate failures with critic-requested revisions (not just clean
revision successes) could still land on a tick where `acDone` briefly reads false again
with `attempts` already high, and get escalated to `senior` mid-cycle.
**Fix:** Nothing to fix reactively today — this is safe (soft-halts for a human, exactly
`senior`'s intended semantics) and narrow (requires failures interleaved with revisions,
not just revisions). If it turns out to matter in practice, the fix is a counter fully
independent of `attempts` for the whole post-first-success phase, not a bigger
`MAX_ATTEMPTS`. See D-013.

---

## `restrictToTree`'s planning-only guard only stops execution — it can't force more planning

**Symptom:** You'd expect `promote-draft`'s plan-mode loop (D-015) to keep going until
every subtask in a split tree has a written `implementationPlan`, but it can stop with
some children still unplanned.
**Cause:** `resolvePhase`'s dependency gate (`task.readiness.isBlocked` → `null`) runs
before the blank-plan check, same as it always has in the main loop — a chained subtask
(child 2 `dependsOn` child 1) isn't even a planning candidate until child 1 reaches `Done`.
Since `Done` only happens through real execution, which the promotion loop never runs, a
dependency-gated child is correctly left unplanned; the loop's stop condition ("no task in
the tree resolves to a planning role") is satisfied the moment the front of the chain is
planned, matching the main loop's own steady state.
**Fix:** This is intended, not a bug — "fully spec'd" for a chained split means every
task has a description/AC/DoD and the front of the chain has a plan; the rest plan
just-in-time during real execution, exactly as before D-015. Nested splits (a subtask
itself splitting again) are implemented but have never been exercised end-to-end.

---

## A promoted draft's task had no `project` field, so the loop never saw it

**Symptom:** `promote-draft.ts` runs, prints `Promoted DRAFT-1 -> TASK-1, project="book"`,
the plan-mode loop even runs against it — but the *main* loop (`npm start`) afterward logs
`no-ready-tasks` forever, and `backlog task list --project book` shows nothing even though
`backlog task list` (no filter) shows the task right there in `Backlog`.
**Cause:** `backlog draft promote` has no `--project` flag — it just converts the draft
file to a task file, carrying over nothing project-related. `promote-draft.ts` only ever
*removed* the temporary `project:<key>` label (used to route the draft, since drafts have
no structured project field) and never set the real `--project` field on the resulting
task. `Backlog.list(status, project)` filters via `backlog task list --project <key>`, so
a task with no project field is invisible to it forever — the exact same trap already
documented for `Backlog.createChild` above, hit via a second, separate code path.
**Fix:** `promote-draft.ts` now runs `backlog task edit <id> --project <project>` right
after promotion, before removing the label. If you find another stray promoted task with
this problem, `backlog task edit <id> --project <key>` fixes it in place — no need to
re-promote.

---

## A well-formed split with no literal `SPLIT` line parsed as a plan, subtask blocks and all

**Symptom:** During TASK-1's real D-015 promotion run, the planner announced its intent in
prose ("I will split this into two independently implementable subtasks...") and went
straight into well-formed `## Subtask:` blocks — but never emitted the bare `SPLIT` marker
line the prompt asks for. `parsePlannerOutput` found no `SPLIT` line, fell through to
`{ kind: "plan" }`, and saved the *entire* reply — lead-in prose plus both subtask blocks —
verbatim into Implementation Plan. No children were created; TASK-1 looked "planned" but
was actually an unsplit container with someone else's subtask spec buried in its plan text.
**Cause:** `parsePlannerOutput` (`src/spec.ts`) treated the literal `SPLIT` marker as the
only signal that a split was intended, unlike the header-tolerance fix above (which assumes
the marker is present and only relaxes the header format after it).
**Fix:** If no `SPLIT` line is found, `parsePlannerOutput` now also checks whether the
*first* line matching `SUBTASK_HEADER` starts the body — if so, it parses from there
instead of falling through to "plan". A bare mention of the word "subtask" in prose with no
actual header still parses as a plan, unchanged. See `src/routing.test.ts`'s
"planner split is detected even without the literal SPLIT line" test.

---

## Auto-derived prefix collision from different keys

**Symptom:** Two projects register without `--prefix` but derive the same prefix slug
(e.g. `HTTPSGIT` for two different GitHub URLs), and the collision check at register
time should catch it.
**Cause:** `key.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()` strips all
non-alphanumeric characters, so different URLs can collapse to the same 8-char slug.
**Fix:** Register with explicit `--prefix=ABC` to guarantee uniqueness. The collision
check at register time rejects duplicates, but the derived prefix is a last resort
for legacy entries. If two legacy entries collide after migration (e.g. both were
registered before D-016), re-register one with `--prefix=NEW` to disambiguate.
