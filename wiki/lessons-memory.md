# Lessons memory — design (proposed, R-003)

> **Status: proposed, not implemented.** Nothing here is wired. It is gated on the D-019
> local-model smoke (`current-work.md`): a reflection step on top of an unverified pipeline
> would learn from noise. Origin: the "improvement harness" idea in Google Research's
> Harness² (github.com/google-research/harness2, Apache 2.0) — keep evidence-supported
> lessons from each finished task and feed them into the next. We adopt the idea, not the
> code (it is Python/Vertex/OpenCode-based and its executors run unsandboxed).

## Problem

Every ticket starts cold. The same repo quirks (which command runs tests, a module that
needs a specific import style, a type the Executor keeps getting wrong) are rediscovered
through gate failures and Tester `CHANGES`, each costing ticks on a small local model.
The evidence of what went wrong already exists — task comments from gates/Tester, and
`journal.db` — but nothing carries it forward. Retained journals are reference-only by
rule (workflow.md, clean-slate rollout), so any carry-forward needs its own store.

## Shape

```
ticket reaches Done/Blocked
        │
        ▼
  evidence packet (deterministic)  ── gate failures, Tester CHANGES text,
        │                              reassessment, attempts/rounds, outcome
        ▼
  reflect tick (toolless, 1 model call)  ── proposes ≤3 lessons, each citing evidence refs
        │
        ▼
  validate (deterministic)  ── cites real evidence? bounded? not a duplicate? not a rule-breaker?
        │
        ▼
  lessons.db  candidate ──(seen in ≥2 root tickets, or human approves)──► active
        │
        ▼
  injected into planning / reassessment / executor prompts under a hard char budget
```

## Store

`$BAKLOOP_HOME/state/<project>/lessons.db` (SQLite via `node:sqlite`, same as the journal).
Out of the target repo, per project, never cross-project. Separate file from `journal.db`
because the journal is "safe to delete" derived state and lessons accumulate value; but
lessons are still **derived and deletable** — the backlog stays authoritative.

| column | meaning |
|---|---|
| `id` | stable slug |
| `text` | one imperative sentence, ≤240 chars |
| `roles` | which prompts may receive it: subset of `planning`, `reassessment`, `executor` |
| `status` | `candidate` / `active` / `retired` |
| `evidence` | JSON list of `{taskId, ts, kind: gate\|tester\|reassess}` refs |
| `seen_roots` | distinct root tickets that produced matching evidence |
| `created`, `last_injected`, `injected_count` | for decay and evaluation |

## Producing lessons

1. **Trigger.** Orchestrator-side, once per root ticket reaching `Done` or `Blocked` (and
   optionally on a gate-fail→green transition). A new `TickMode` `reflect`, role-less,
   toolless — same pattern as `finalize` and criteria mode.
2. **Evidence packet** is built deterministically from comments authored by gates/Tester
   and the ticket's journal rows. The model never sees the Executor's own account of its
   success. This keeps D-001: lessons come from gate and Tester artifacts, never from a
   model's self-assessment.
3. **Validation (fail closed).** A proposed lesson is dropped unless it cites at least one
   evidence ref that exists in the packet, fits the length cap, names an allowed role set,
   and is not a near-duplicate of an existing lesson (then it only bumps `seen_roots`).
   Unparseable reflect output produces zero lessons, never a retry loop.
4. **Promotion.** `candidate → active` when the same lesson is supported by ≥2 distinct
   root tickets, or on explicit human approval (`pnpm --filter engine lessons approve <id>`).
   Retire on human command, or automatically after N injections with no gate/Tester
   improvement on tickets that received it (see Evaluation).

## Consuming lessons

Add one field to `ContextPolicy` in `src/prompts.ts`: `lessons?: number` (char budget).

| mode | gets lessons? | why |
|---|---|---|
| `criteria` | **no** | Its isolation (raw + description only) is the point; lessons would reintroduce context it was built to exclude. |
| `planning`, `reassessment` | yes (≤600 chars) | Repo conventions and prior split/plan failures. |
| `executor` | yes (≤600 chars) | Prior gate failures in this repo. |
| `tester` | **no** (v1) | Independence: it judges the diff, not the pipeline's history. Revisit only with evidence. |
| `research`, `alignment`, `finalize` | no | Not where recurring failures originate. |

Selection is deterministic: active lessons whose `roles` include this mode, ordered by
`injected_count` desc then recency, truncated at the budget. No retrieval model. A small
local model's context is the scarcest resource (prompts.ts, "Cost"), so the budget is a
constant, not a tuning knob per ticket.

## Constraint check

| Hard constraint / rule | Effect |
|---|---|
| Gate verdicts are the only pass/fail | Lessons only change prompt text. They never touch gates, verdict parsing, or routing. Evidence comes from gate/Tester output. |
| One ticket at a time | Reflection runs after the root is terminal, before the next root is planned; it adds no concurrent work. |
| Backlog store not in the target repo | `lessons.db` lives under `state/<project>`. |
| Retained journals never feed control flow | Lessons don't read old journals; evidence is built from the *current* ticket only. Prompt text is not control flow. |
| `git push` hard-blocked | Unaffected; `reflect` has no tools. |
| Criteria independence | Preserved by excluding `criteria` and `tester`. |

## Evaluation

Without measurement this is superstition. Add to `ticks`: `lesson_ids` (JSON) and
`lessons_chars`. A `BAKLOOP_LESSONS=0` switch disables injection, so tickets can be
alternated. Compare, per root ticket: ticks to Done, gate failures, Tester rounds,
reassessment rate, Blocked rate. Samples will be small — treat results as a signal to
keep or retire the feature, not a proof. `pnpm run report` already aggregates ticks; extend
it, don't build a second reporter.

## Risks

- **Confidently wrong lessons.** A small local model may over-generalise from one failure.
  Mitigations: evidence citation, ≥2-root promotion, hard char budget, human retire.
- **Prompt bloat → context overflow**, bakloop's most common failure. Budget is constant
  and lessons are not injected in modes that don't need them.
- **Stale lessons** after a refactor of the target repo. `last_injected` plus retirement on
  no-improvement; `clean-start` should also clear that project's `lessons.db`.
- **Poisoned evidence.** Task text can contain arbitrary content; lessons are data in
  prompts, so keep them in a clearly delimited section and never let them carry
  instructions about tools, gates or git.

## Phasing

0. Finish the D-019 local-model smoke (prerequisite).
1. Store + evidence packet + validator, with no model call — unit-testable, like
   `journal.test.ts`. Human-curated lessons can already be injected at this stage.
2. `reflect` tick producing candidates.
3. Injection behind `BAKLOOP_LESSONS`, journal columns, report extension.
4. Review results; keep, tune budgets, or retire.

## Open questions

- Should `candidate` lessons ever be injected, or only `active`? (Proposed: only `active`.)
- Does `clean-start` clear lessons? (Proposed: yes, per project.)
- Reflect on `Blocked` roots too? They hold the most failure evidence but also the most
  possible wrong conclusions. (Proposed: yes, but candidates only until a human approves.)
