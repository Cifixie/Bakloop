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
| `architect` | notes (constraints), only when labeled `needs-architecture` | read-only |
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
independently — including their own approval gate — but share the parent's branch, so
many subtasks still add up to one PR. A subtask finalizes to `Done` itself once its
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
```

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
  reverted or force-pushed. Subtasks created by a split share their parent's branch
  rather than getting their own.
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

## Running

From the bakloop checkout, passing the registered project key:

```bash
pnpm start bogi   # tsx src/main.ts bogi
```

`BAKLOOP_PROJECT` (if set) takes priority over this argument; with neither set, the
project is resolved from `ORC_REPO_CWD`/`cwd` instead.

## Adding tasks

Two steps, kept deliberately separate: capture (raw, human-typed) and promotion (AI
formats it into a real task, human reviews the result). Drafts are invisible to the tick
loop — only real tasks feed it — so nothing here can ever be picked up half-formed.

```bash
pnpm run new-draft bogi       # capture: title + pasted text -> a Backlog.md draft
pnpm run promote-draft         # list drafts (omit the id to just see what's pending)
pnpm run promote-draft DRAFT-3 bogi   # AI drafts description + AC, you review, then promote
```

`new-draft` prompts for a title (leave it blank to have a lightweight local model name
it — or paste something starting with a `# Heading` line and that's used for free) and a
pasted description (end with a line containing just `.`). `promote-draft` runs the same
`owner` and `criteria` prompts the tick loop itself uses, as two separate calls for the
same reason the loop does, shows you the drafted description, acceptance criteria, and
definition of done before doing anything, and lets you confirm type/priority.

The loop runs ticks until there's no ready work left in the project's lane, checking
the working tree back out to the base branch on exit. State (attempt logs, detected
gate config) lives under `$BAKLOOP_HOME/state/<project>`, out of the target repo's own
git history.
