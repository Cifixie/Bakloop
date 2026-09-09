# bakloop

A local, backlog-driven agent loop that turns raw [Backlog.md](https://github.com/MrLesk/Backlog.md)
tickets into reviewed, branch-isolated pull requests — running entirely against a
local model, with a human approval gate between planning and execution.

## How it works

`bakloop` polls a shared [Backlog.md](https://github.com/MrLesk/Backlog.md) store one
**tick** at a time (one tick = one model call). Each task moves through a fixed
pipeline of **roles**, each one writing exactly one field on the task:

```
Backlog → owner → criteria → architect/researcher (optional) → planner
        → Waiting for Approval → [human moves to Ready for Work] → executor (gated)
        → senior (on repeated failure) → documenter (when docs are affected)
        → reviewer → Review (human merges) → Done
```

| Role | Writes | Tools |
|---|---|---|
| `owner` | description + type | none |
| `criteria` | acceptance criteria + definition of done | none |
| `architect` | notes (constraints), when labeled `needs-architecture` or bracketing a split | read-only |
| `researcher` | notes (findings), only when labeled `needs-research` | read + fetch |
| `planner` | implementation plan, or a split into subtasks | read-only |
| `executor` | files | read, write, edit, bash |
| `senior` | notes (advice), only after repeated failed attempts | read-only |
| `documenter` | doc files, only when the diff touches a documented surface | read, docs-only write/edit |
| `reviewer` | final summary, moves task to Review | read, bash |

Which role runs next is **derived from task state**, never chosen by a model — see
`src/phase.ts`. This is the one routing decision with no verification signal, so it
has to be deterministic instead of guessed, and it's what `npm test` covers.

**`owner` and `criteria` are two ticks, deliberately.** The role that writes the
acceptance criteria sees the description and nothing else — not the codebase, not the
plan, not its own earlier reasoning. A context that just wrote the description tends to
write criteria that restate it; one that only reads it has to commit to something
checkable.

**Context is rationed per role** (`src/prompts.ts`). Each role's prompt contains only
the fields it needs, rather than every field the task has accumulated. Two separate
reasons: a prompt that grows without bound is what eventually overflows a small local
model, and a role that reads another role's account of the work inherits its framing.

**`implementationNotes` is guidance; `comments` is the progress log.** Only `architect`,
`researcher`, and `senior` write notes, and only the executor and planner read them.
Machine bookkeeping — gate failures, model-call failures, what the documenter did — goes
to the task's comments instead, attributed to the role it came from. That keeps the
executor's prompt from growing by one failure record per attempt.

**A split doesn't create subtasks on the spot — `architect` has to write the interface
contract first.** When the planner proposes splitting a task, `tick.ts` discards that
proposal and labels the task `needs-architecture` instead, unless an architect contract
already exists (`hasArchitectContract`, `src/phase.ts`). `architect` then names the exact
shared signatures/resource IDs the subtasks are likely to need and which one should own
creating each — this is the only cross-sibling context any subtask ever gets, since each
one's own planner tick otherwise sees only its own task. Only then are children created,
each seeded with that contract in its own `implementationNotes`. Once every child is Done,
`architect` runs a second time (a distinctly-marked pass, `hasAlignmentCheck`) to check the
finished siblings against that contract before the container can reach `reviewer`; on
`DRIFT` the container is blocked for a human rather than reaching review looking clean. See
D-007 in `wiki/decisions.md`.

**`documenter` is triggered by the diff, not by the calendar.** After the gates go green,
`src/gates.ts` checks whether the branch actually touched a documentation file, a
declared interface (`package.json`, an OpenAPI spec, a `*.config.*`), or an `export`. If
it didn't, the documenter tick is skipped entirely. When it does run, its write/edit
tools physically refuse any path that isn't documentation (`README*`, `docs/**`,
`wiki/**`, `*.md`/`*.mdx`) — it cannot touch source, even if the model tries. It has no
`bash` tool either, so the orchestrator commits its changes deterministically
(`src/branch.ts`'s `commitAll`), same reasoning as every other piece of bookkeeping here
never trusting a model's own follow-through.

Once a task has a description, acceptance criteria, and a plan, it's parked in
**Waiting for Approval**. Execution never starts on its own — a human has to move the
task to **Ready for Work** first, a visible column move in the Backlog.md board rather
than a label. From there the executor runs the gate loop (typecheck, lint,
tests, diff checks) until the acceptance criteria are met or it's declared `Blocked`
after repeated failure. A task only reaches `Review` once a human is expected to open
and merge its PR — `bakloop` never merges, pushes, or marks anything `Done` itself.

If a task is too large for one executor pass, the planner can split it into subtasks
(Backlog.md's `--parent`) instead of writing a plan. Subtasks run the full pipeline
independently — including their own approval gate — but share their top-level
ancestor's branch, so many subtasks still add up to one PR. A subtask finalizes to `Done` itself once its
gates go green (no separate review); the parent only reaches `documenter`/`reviewer`
once every subtask is `Done`, and turns `Blocked` immediately if any subtask does.

A split can also be forced by a machine failure rather than the planner's judgement. If
a local model refuses a call because the prompt didn't fit, that says the task is too
big — not that it's wrong — so instead of spending the remaining retries re-sending a
prompt that is still too large, the task gets a `needs-split` label and goes back to the
planner on a prompt that only offers the split branch. If the planner writes another
plan anyway, the task is `Blocked` for a human: decomposition failing is a structural
problem, not something to retry.

## Observability

Every tick is recorded to `$BAKLOOP_HOME/state/<project>/journal.db` (SQLite, via Node's
built-in `node:sqlite` — no dependency). One row per tick: role, why that role was chosen,
prompt/output/thinking sizes, tool calls, model time, tick time, gate failures, and a
machine-readable `outcome` from a closed vocabulary. Nothing here feeds control flow — it
exists to be read afterwards.

```bash
pnpm run report book       # ticks per role, prompt sizes, outcomes, gate failures
pnpm run overlap book      # do two unrelated tasks claim the same file?
```

`overlap` is the one check with no model in it: it extracts repo-relative paths from every
task's description, plan and acceptance criteria, and reports any file claimed by two tasks
that aren't parent and child. Two tasks naming the same path will write it twice, and
whichever runs last wins. Manifests, lockfiles and `.md` files are listed but never
flagged — several tasks touching those is normal. Exit code is non-zero when there's a real
collision, so it works in a pre-flight script. The same check runs automatically after a
split and blocks the parent task on a hit (see D-009).

The number worth watching across changes is **ticks per completed task**. Prompt size by
role is the other one: it's the only way to tell whether rationing context per role
actually did anything.

For anything the report doesn't cover, query the file directly — that's why it's SQLite
and not a format only bakloop can read:

```bash
sqlite3 ~/.bakloop/state/book/journal.db \
  "SELECT role, count(*), round(avg(prompt_chars)) FROM ticks GROUP BY role"
```

Alongside it, `state/<project>/transcripts/<task-id>/` holds the exact prompt sent and
text returned for every model call, one markdown file per tick. Task fields only ever
hold what a parser managed to extract; when a local model ignores a prompt's requested
format, the difference between the transcript and the field is the bug report. Set
`BAKLOOP_NO_TRANSCRIPTS=1` to keep the metrics and skip the files.

Both are derived state — safe to delete, the backlog stays authoritative — and live
outside the target repo, so they never show up in its `git diff` and skew the gates.

## Safety model

- **One branch per top-level ticket** (`bakloop/<task-id>`), forked from the project's
  base branch. A bad attempt's commits stay isolated on that branch; nothing is ever
  reverted or force-pushed. Subtasks created by a split share their top-level
  ancestor's branch rather than getting their own, however deeply they nest (see D-004).
- **`git push` is hard-blocked**, not just discouraged in a prompt: a wrapper script
  shadows `git` on the executor's `PATH` and refuses any command containing `push`
  (see `src/git-guard.ts`). Branches are reviewed and pushed by a human.
- **Gates are the only verdict that counts.** The model's own summary of its work is
  never parsed or trusted — pass/fail comes from running `tsc`, `biome`, and `vitest`
  and diffing the branch against its base (`src/gates.ts`).
- **At most one task In Progress per project.** Enforced as a hard invariant on every
  tick.

## Setup

```bash
npm install
```

Initialize the shared Backlog.md store (idempotent — safe to re-run):

```bash
npm run setup   # tsx src/setup.ts
```

This runs `backlog init` non-interactively under `$BAKLOOP_HOME`, with its own local
git history (never a GitHub remote), and sets the board's statuses/columns to
bakloop's pipeline (`Backlog`, `Waiting for Approval`, `In Progress`, `Review`,
`Blocked`, `Done` — see `src/types.ts`'s `STATUS`).

Register each repo you want `bakloop` to drive against a project key (this also
records the branch currently checked out as the base every task branch forks from, and
adds the key to the shared store's `projects` list in `backlog/config.yml`):

```bash
npm run register-project -- <key> [path]   # path defaults to cwd; tsx src/register-project.ts
```

`path` also accepts a git URL or an `owner/repo` shorthand instead of a local directory
(cloned via `gh repo clone` when it's GitHub-shaped, falling back to plain `git clone`
otherwise). That clones bakloop's own copy under `$BAKLOOP_HOME/clones/<key>` and runs
it fully autonomously (D-012): on a passed review the agent itself rebases, re-gates,
and squash-merges a task's branch into its own trunk and marks it `Done` — no human PR
step, since there's no developer checkout at that path to protect. Passing `--autonomous`
with a local `path` opts that same real checkout into the identical behavior — a known,
explicitly-flagged risk against a directory you may also be working in yourself, not
something bakloop tries to soften. Either way, task branches are never deleted and
`git push` stays hard-blocked everywhere unconditionally (D-003) — nothing in this repo
ever pushes anywhere.

Point it at a local, OpenAI-compatible model server (e.g. [oMLX](https://github.com/ml-explore/mlx)
at `http://localhost:8000/v1`):

| Env var | Default |
|---|---|
| `OMLX_BASE_URL` | `http://localhost:8000/v1` |
| `OMLX_MODEL_ID` | `mlx-community--Qwen3.6-35B-A3B-6bit` |
| `OMLX_CONTEXT_WINDOW` | `262144` |
| `OMLX_SUMMARY_MODEL_ID` | unset (disables the console summarizer) |
| `OMLX_SUMMARY_BASE_URL` | falls back to `OMLX_BASE_URL` |
| `OMLX_SUMMARY_CONTEXT_WINDOW` | `32768` |
| `BAKLOOP_HOME` | `~/.bakloop` |
| `BAKLOOP_PROJECT` | resolved from cwd if unset |
| `ORC_REPO_CWD` | `process.cwd()` |
| `BAKLOOP_BATTERY_FLOOR` | `20` (percent; `0` disables the check) |
| `BAKLOOP_NO_CAFFEINATE` | unset (set to `1` to skip holding a `caffeinate -i`) |

## Running

From the bakloop checkout, passing the registered project key:

```bash
pnpm start bogi   # tsx src/main.ts bogi
```

`BAKLOOP_PROJECT` (if set) takes priority over this argument; with neither set, the
project is resolved from `ORC_REPO_CWD`/`cwd` instead.

**Unattended runs (macOS):** the loop holds a `caffeinate -i` for its lifetime so idle
system sleep doesn't kill an overnight run (`BAKLOOP_NO_CAFFEINATE=1` to skip this). This
only prevents *idle* sleep — closing the lid on battery still sleeps the machine; run on
AC, or with the lid open, for a run that must survive it. On battery, the loop also stops
cleanly (same path as Ctrl+C) once the charge drops to `BAKLOOP_BATTERY_FLOOR` percent
(default `20`; `0` disables the check) — checked once per tick, not mid-tick.

## Adding tasks

Two steps, kept deliberately separate: capture (raw, human-typed) and promotion (AI
formats it into a real task). Drafts are invisible to the tick loop — only real tasks feed
it — so nothing here can ever be picked up half-formed. Promotion itself is fully
automatic, no prompts — the task lands in `Waiting for Approval` and still needs a human
to move it to `Ready for Work` before the executor touches it (see D-002), so review
happens once, against the full spec, not here.

```bash
pnpm run new-draft bogi       # capture: title + pasted text -> a Backlog.md draft
pnpm run promote-draft         # list drafts (omit the id to just see what's pending)
pnpm run promote-draft DRAFT-3 bogi   # AI drafts description + AC, then promotes immediately
```

`new-draft` prompts for a title (leave it blank to have a lightweight local model name
it — or paste something starting with a `# Heading` line and that's used for free) and a
pasted description (end with a line containing just `.`). `promote-draft` runs the same
`owner` and `criteria` prompts the tick loop itself uses, as two separate calls for the
same reason the loop does, prints the drafted description, acceptance criteria, and
definition of done, and promotes immediately — type comes from whatever `owner` drafted,
priority is left unset, and either can be changed on the task afterward.

The loop runs ticks until there's no ready work left in the project's lane, checking
the working tree back out to the base branch on exit. State (attempt logs, detected
gate config) lives under `$BAKLOOP_HOME/state/<project>`, out of the target repo's own
git history.
