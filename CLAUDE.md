# bakloop

A local, backlog-driven agent loop that turns raw Backlog.md tickets into reviewed,
branch-isolated pull requests against a local model, one tick (= one model call) at a
time. It is not itself agent-built software with tests of its own yet — bakloop is the
orchestrator; the gates it runs (`tsc`/`biome`/`vitest`) are checks on the *target* repo,
not on bakloop.

## Hard constraints — do not violate

These are peer constraints — no single one sits above the others.

- **At most one task `In Progress` per project.** Enforced as a hard invariant checked
  every tick (`src/tick.ts`) — it throws rather than silently proceeding if violated.
- **Execution never starts without a human `approved` label.** A task with a description,
  acceptance criteria, and a plan is parked in `Waiting for Approval`; only a human moving
  it forward (adding the label) lets the executor phase begin (`src/phase.ts`).
- **Gate verdicts are the only source of pass/fail — never the model's own summary.**
  `tsc`, `biome`, `vitest`, and a diff-vs-base check decide success (`src/gates.ts`); the
  model's final message text is never parsed for a verdict, for either the executor or the
  reviewer role.
- **`git push` is hard-blocked**, not just discouraged in a prompt (`src/git-guard.ts`).
  Branches are reviewed and pushed by a human. See D-003 for how, and its acknowledged
  limits.
- **The backlog store is never inside a target repo's own git history.** Task state lives
  under `$BAKLOOP_HOME/state/<project>`, out of the target repo entirely, so writing task
  metadata never shows up in that repo's `git diff` and skews the gates (`src/backlog.ts`,
  `src/log.ts`).
- **A subtask's branch is its immediate `parentTaskId`'s branch, not a root ancestor's.**
  See D-004 and the nested-splits entry in `wiki/gotchas.md` before relying on this for a
  subtask that itself gets split.

Each of these has a full rationale in `wiki/decisions.md`. Read it before proposing a
change to any of them.

## Working in this repo

Read at the start of every session:
1. `wiki/current-work.md` — where things stand right now
2. `wiki/gotchas.md` — known traps, read before debugging anything

There is deliberately no roadmap file: bakloop's development is feature-driven, not
phased, so there is no build order to record. `wiki/current-work.md` carries the state
instead.

**Write access:**
- `wiki/current-work.md` — update this as you go. Keep it to the current state, not a
  changelog. Overwrite freely.
- `wiki/gotchas.md` — append when you discover a new trap. Never rewrite existing entries.
- `wiki/decisions.md` — **do not edit.** Propose changes in chat; the human writes these.
  If your work contradicts a decision, stop and say so rather than amending the record.
  Entries marked `Status: Proposed` are drafts awaiting sign-off — do not treat them as
  binding, and do not promote one to `Accepted` yourself.

## Maintaining this documentation

**These files are the project's memory, and the primary reader is an agent starting cold.**
Keeping them correct is part of doing the work, not a separate chore — a change that makes
a document wrong is not finished.

Update in the same change that caused it, never "later":

| When | Do |
|---|---|
| finishing any task | `wiki/current-work.md` — next action, blockers, what you learned |
| discovering a trap | append to `wiki/gotchas.md` |
| removing or renaming anything | `git grep` the old name; fix or delete **every** reference |
| a doc contradicts reality | reality wins — fix the doc in that same change |
| any code review, including self-review before calling a task done | run the doc-consistency check below |

**Doc-consistency check, as part of review.** Before a change is done, grep for whatever
fact it touched — a config value, a threshold, a rule, a date field — across `wiki/`.
Every fact gets exactly one home; everywhere else either doesn't mention it or points at
the home (`"see D-004"`, `"see CLAUDE.md hard constraints"`) rather than restating it.
Finding a second copy is a bug in the docs, not a coincidence — collapse it in the same
change, don't leave it for later.

**Curate, don't accumulate.** Growth is not progress. Prefer deleting a stale section to
patching it.

**Keep `wiki/gotchas.md` capped** (see its own header for the number). It loads every
session, so length is a tax on every future task. Append freely; when a trap has become
structurally impossible, propose removing it. Never change what an existing entry means.

**Park decision proposals in `wiki/current-work.md` under "Needs your sign-off".** Chat is
lost when the session ends; that file is not.

**One fact, one home.** If the same threshold, name, or procedure appears in two files,
one is already stale — fix it by deleting the copy, not by syncing them.

**Human-only. Never do these, even if asked to "finish the task":**
- promoting a decision from `Proposed` to `Accepted`
- adding an `approved` label to a task on a human's behalf, merging a PR, or marking
  anything `Done` other than a subtask on green gates (`src/tick.ts` does this
  automatically; a top-level task's `Done` is still human/GitHub-sync only)

## Testing

See `wiki/current-work.md` for the current state of bakloop's own test coverage. The
gates it runs (`tsc`/`biome`/`vitest`) apply to the *target* repos it drives, not to
bakloop itself. If bakloop gets its own tests, the first one should cover `src/phase.ts`'s
routing table — it's the one piece of logic with no other verification signal (see
`src/phase.ts`'s own comment on this).

To sanity-check a change by hand: `npm run typecheck`, then run `npm start` against a
registered project with a real Backlog.md store and watch a tick or two.

## Deliberately not built yet

- **Nested splits** (a subtask itself getting split again) — architecturally possible,
  never exercised. See `wiki/gotchas.md`.
- **GitHub sync for `Done`** — `src/types.ts` anticipates "a future GitHub sync" setting
  top-level tasks to `Done`; nothing implements it yet.

## Map

- `wiki/` — living state: decisions, gotchas, current work
- `README.md` — the pipeline diagram, safety model, and setup/run instructions; read it
  first for how to actually run bakloop. This file (`CLAUDE.md`) is for an agent about to
  change bakloop's own code, not for a user running it.
