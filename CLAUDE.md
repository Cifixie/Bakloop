# bakloop

A local, backlog-driven agent loop that turns raw Backlog.md tickets into reviewed,
branch-isolated pull requests against a local model, one tick (= one model call) at a
time. bakloop is the orchestrator: the gates it runs (`tsc`/`biome`/`vitest`) are checks
on the *target* repo, not on bakloop. bakloop's own tests are a separate, much smaller
thing — see Testing below.

## Hard constraints — do not violate

These are peer constraints — no single one sits above the others.

- **At most one task `In Progress` per project.** Enforced as a hard invariant checked
  every tick (`src/tick.ts`) — it throws rather than silently proceeding if violated.
- **Gate verdicts are the only source of pass/fail — never the model's own summary.**
  `tsc`, `biome`, `vitest`, and a diff-vs-base check decide success (`src/gates.ts`); the
  model's final message text is never parsed for a verdict, for either the executor or the
  reviewer role. The narrow, deliberate exception is a distinct role judging a *different*
  role's finished artifact rather than trusting its own account — the architect's
  alignment pass (D-007) and `critic` (D-013) — and even then the parsed verdict only
  ever adds a gate on top of gates already green, never bypasses them. See D-001's
  amendment for the exact boundary.
- **`git push` is hard-blocked**, not just discouraged in a prompt (`src/git-guard.ts`).
  Branches are reviewed and pushed by a human. See D-003 for how, and its acknowledged
  limits.
- **The backlog store is never inside a target repo's own git history.** Task state lives
  under `$BAKLOOP_HOME/state/<project>`, out of the target repo entirely, so writing task
  metadata never shows up in that repo's `git diff` and skews the gates (`src/backlog.ts`,
  `src/log.ts`).
- **A subtask's branch is its top-level ancestor's branch, not its immediate parent's.**
  `rootAncestorId` (`src/tick.ts`) walks `parentTaskId` to the root, so however many
  levels of splitting produced a subtask, it lands on one branch and one eventual PR. See
  D-004, and the nested-splits entry in `wiki/gotchas.md` before relying on it for a
  subtask that itself gets split.

Each of these has a full rationale in `wiki/decisions.md`. Read it before proposing a
change to any of them — these specific constraints are the one part of that file whose
*behavior* you raise before changing, even though the file itself is yours to maintain.

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
- `wiki/decisions.md` — **write it yourself, and keep it current.** Record a decision as
  `Accepted` the moment the behavior it describes is real: shipped, typechecked, and
  tested. Don't park it as a proposal for a human to countersign — an undecided record of
  decided behavior is worse than no record, because the next agent can't tell which of
  the two to trust.
  - **Reality wins over the record.** If your work contradicts an entry, the entry is now
    wrong: rewrite it in the same change, or mark it `Superseded by D-0NN` and write the
    successor. Never leave a decision describing behavior the code no longer has, and
    never quietly implement against a stale entry.
  - **`Proposed` is only for a genuinely open question** — a fork you can't resolve from
    the code, where you need the human to pick. It is not a waiting room for finished
    work. If you write one, say so in chat *and* park it in `wiki/current-work.md`.
  - **Changing an accepted decision needs a reason in the entry, not permission in chat.**
    Rewriting the *record* to match reality is routine. Changing the *behavior* a hard
    constraint depends on is not — for those, see the hard-constraints list above and
    raise it before you build.

## Maintaining this documentation

**These files are the project's memory, and the primary reader is an agent starting cold.**
Keeping them correct is part of doing the work, not a separate chore — a change that makes
a document wrong is not finished.

Update in the same change that caused it, never "later":

| When | Do |
|---|---|
| finishing any task | `wiki/current-work.md` — next action, blockers, what you learned |
| deciding something the next agent must not re-litigate | add it to `wiki/decisions.md` as `Accepted`, in this same change |
| finding a decision that no longer matches the code | rewrite it, or supersede it and write its successor — same change |
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

**Only genuinely open questions go under "Needs your sign-off" in `wiki/current-work.md`**
— a fork you cannot resolve from the code. Anything you've already decided and shipped
belongs in `wiki/decisions.md` as `Accepted`, written by you in the same change. Chat is
lost when the session ends; both files are not.

**One fact, one home.** If the same threshold, name, or procedure appears in two files,
one is already stale — fix it by deleting the copy, not by syncing them.

**Human-only. Never do these, even if asked to "finish the task":**
- merging a PR, or marking anything `Done` other than a subtask on green gates (`src/tick.ts` does this
  automatically; a top-level task's `Done` is still human/GitHub-sync only) —
  **except** for a project registered with `autonomous: true` (D-012), where the agent
  itself rebases, re-gates, and squash-merges a reviewed task's branch into
  `baseBranch` and marks it `Done`, by design and with no human step. This carve-out
  applies only inside that project's own clone/checkout, never to `git push`, which
  stays hard-blocked everywhere unconditionally (D-003).

## Testing

`npm test` runs `src/*.test.ts` through Node's built-in test runner via tsx — **no test
framework is installed, and adding one needs a reason.** Coverage is deliberately narrow:
it covers `src/phase.ts`'s routing table plus the pure functions that feed it
(`classifyDocsRelevance`, `isContextOverflow`, the `spec.ts` parsers). Routing is the one
piece of logic with no other verification signal — a bad choice there corrupts the loop
silently instead of failing a task loudly — so it is the piece that earns a test. The same
rationale extends to any other parser of another program's output with no other check —
e.g. `src/power.ts`'s `parseBatteryState` (`pmset -g batt`): a silent mis-parse there reads
as "battery fine" and drains the machine instead of failing loudly.

Keep that boundary. `resolvePhase` takes its machine observations as an injected
`Signals` argument specifically so it stays pure and testable without a repo; if you need
a new observation to route on, compute it in `tick.ts` and add it to `Signals` rather
than doing IO inside the router.

The gates bakloop runs (`tsc`/`biome`/`vitest`) still apply only to the *target* repos it
drives, not to bakloop itself.

To sanity-check a change by hand: `npm run typecheck && npm test`, then run `npm start`
against a registered project with a real Backlog.md store and watch a tick or two.

**Before/after numbers come from `npm run report <project>`,** not from impressions. Every
tick is journaled to `state/<project>/journal.db` (see README's Observability section). If
you change how roles are structured, what they're given, or how many ticks a task takes,
record ticks-per-completed-task and per-role prompt size before and after — that's the
whole reason the journal exists. Adding a field to `TickRecord` is cheap; do it when you
have a question it would answer, not because a value was in scope.

## Deliberately not built yet

- **Nested splits** (a subtask itself getting split again) — architecturally possible,
  never exercised. See `wiki/gotchas.md`.
- **GitHub sync for `Done`** — `src/types.ts` anticipates "a future GitHub sync" setting
  top-level tasks to `Done`; nothing implements it yet.

## Map

- `wiki/` — living state: decisions, gotchas, current work
- `src/journal.ts` + `src/report.ts` — the tick journal and its report; read these before
  trying to answer any question about how the loop performs
- `README.md` — the pipeline diagram, safety model, and setup/run instructions; read it
  first for how to actually run bakloop. This file (`CLAUDE.md`) is for an agent about to
  change bakloop's own code, not for a user running it.
