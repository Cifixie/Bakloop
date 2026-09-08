# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**Working on:** Just landed a change to how roles are structured, what each one is allowed
to see, and — new — what the loop records about itself. The through-line: bakloop already
had deterministic routing and machine-only verdicts, but every role was handed every field
of the task, two phases were doing work that shouldn't share a context, and nothing
measured any of it.

1. **Context is rationed per role** (`src/prompts.ts`). `formatContext` now takes the
   role and consults a declarative `CONTEXT` policy table instead of concatenating every
   populated field. Two independent reasons, both recorded in the file's own comment: an
   unbounded prompt is what eventually overflows a small local model, and a role that
   reads another role's account of the work inherits its framing.
2. **`implementationNotes` is guidance; `comments` is the progress log.** Notes are now
   written only by architect/researcher/senior and read only by planner/executor/senior/
   documenter/reviewer. Gate failures, model-call failures, and the documenter's own
   summary go to `Backlog.comment` instead, attributed to the role (`@executor`,
   `@senior`, …). This unblocked `Backlog.comment`, which had been implemented and unused.
   The documenter's one-shot marker moved with it: `hasDocumented` now looks for an
   `@documenter` comment rather than a `**documenter:**` string in notes.
3. **The documenter is triggered by the diff.** `src/gates.ts`'s `docsRelevant` /
   `classifyDocsRelevance` checks whether the branch touched a doc file, a declared
   interface (`package.json`, OpenAPI, `*.config.*`), or an `export`. If not, the tick is
   skipped. It over-triggers by design — a bare `.md` anywhere counts — because a wasted
   documenter tick is cheaper than undocumented public surface.
4. **Context overflow routes to a split instead of `Blocked`** (`src/tick.ts`). A model
   refusing a call for size is a statement about the task's size, not its correctness, so
   the task gets a `needs-split` label and goes back to the planner on `prompts/
   planner-split.md`, which only offers the split branch. Excluded: subtasks (nested
   splits, see gotchas) and tasks already carrying the label. If the planner writes a plan
   anyway, the task blocks — decomposition failing is structural, not retryable.
5. **`owner` split into `owner` + `criteria`.** Owner writes description + type; the new
   toolless `criteria` role writes acceptance criteria + Definition of Done from the
   description *and nothing else*. `parseOwnerOutput` now returns `{description, type}`;
   `parseCriteriaOutput` is new. `src/promote-draft.ts` makes both calls too, for the same
   reason.

**Backlog.md fields now used that weren't before:** `type`, `definitionOfDone`,
`comments`. All three were in the CLI and the JSON all along. DoD items are force-checked
on green gates by the same D-001 reasoning as acceptance criteria, but are deliberately
*not* a routing input — `acDone` in `src/phase.ts` stays acceptance-criteria only.

**bakloop now has tests.** `npm test` runs `src/*.test.ts` through Node's built-in runner
via tsx — no framework installed, deliberately. `routing.test.ts` covers `resolvePhase`'s
full routing table plus `classifyDocsRelevance`, `isContextOverflow`, and the `spec.ts`
parsers; `journal.test.ts` covers the SQLite round trip and the report aggregation. To
keep the router testable, `resolvePhase` now takes its machine observations as an injected
`Signals` argument (`{docsRelevant}`) computed by `tick.ts`; keep IO out of it.

**bakloop now records what it does.** Every tick writes a row to
`state/<project>/journal.db` (SQLite via Node's built-in `node:sqlite`, no dependency);
`npm run report <project>` aggregates it. See README's Observability section for the
fields and the two numbers worth watching. Three design points worth not re-litigating:

- `tick()` is now a thin recording wrapper around `runTick`, because a `finally` there is
  the only place that sees every exit *including a throw* — and a crashed tick is exactly
  the one an overnight run needs recorded.
- Every `return` in `runTick` carries a `TickOutcome` from a closed union, so the report
  never pattern-matches on prose and the compiler catches a new exit path that forgot to
  say what it did.
- Transcripts (`state/<project>/transcripts/<task-id>/`) are markdown files, not database
  blobs: they exist to be read by a person iterating on a prompt.

**Next action:**
1. **This has not been run against a live model yet.** Typecheck, tests, a direct
   integration probe of the new `Backlog` methods against the real store, and an
   end-to-end `tick()` against a fake agent all pass — but no tick has executed with a
   real local model and these prompts. Run `npm start book` and watch an owner → criteria
   → planner sequence before trusting it overnight: the two new prompts (`criteria.md`,
   `planner-split.md`) have never been seen by the local model, and local models are
   exactly where format-following breaks. Then read
   `state/book/transcripts/TASK-*/…-criteria.md` and compare it against what actually
   landed in the task's AC — that comparison is the fastest way to tell a prompt problem
   from a parser problem.
2. **Capture a baseline before changing anything else.** `npm run report book` after the
   first real run gives ticks-per-completed-task and per-role prompt sizes for the
   current design. Without that number recorded, the next change to role structure has
   nothing to be judged against — which is the position this session started in.
3. `TASK-7` in the backlog ("On repeated local-model failure, decide whether to split the
   task instead of just blocking it") is what item 4 above implements, by hand. Its own
   acceptance criteria describe a slightly different design — an explicit `Inspection`
   state — where what landed reuses the existing `needs-split` → planner route instead.
   Archive it or rewrite its criteria to match; don't leave it to be picked up as if it
   were still open.
4. Still open from before: the first unattended overnight pass against `TASK-6`'s children
   (`book` project). `nohup caffeinate -i -s npm start book > ~/.bakloop/state/book/overnight.log 2>&1 &`,
   then check the log for `blocked after N local-model failures` — and now also for
   `labelled needs-split for re-planning`, which is the new path doing its job.

**Deliberately not built: stacked/dependent branches.** If tasks are logically sequential
but should stay separately reviewable (not one shared branch), the correct fix is not the
parent/children trick — it needs `ensureTaskBranch` to fork a dependent task from another
task's branch instead of always `baseBranch`, which touches `src/gates.ts`'s diff-vs-base
assumptions (D-001) and needs its own decision proposal before building. `TASK-6`'s five
children are currently ordered `1 → 2 → 4 → 5 → 3` on one shared branch as the interim
workaround; the real dependency graph is `1 → 2 → {3, 4 → 5}`, and 3 sits last (not third)
so that if it fails and blocks the container, the hard chain has already landed.

**Blocked on:** nothing.

**Needs your sign-off:**

1. **D-007? The documenter writes files unsupervised.** D-002's rationale ("owner/
   architect/researcher/planner are read-only or write only to task metadata… running
   them unsupervised is low-risk") predates `documenter`, which writes real files with no
   label of its own. It's scoped deliberately (docs-only tool restriction; only ever runs
   inside a task a human already approved), which is why it was built this way rather than
   with a second approval gate — but that's a judgment call D-002's text doesn't cover.
2. **D-008? Context is rationed per role, and roles don't read each other's accounts.**
   Item 1 above is a real architectural commitment, not an optimisation: it's why
   `criteria` is toolless and why the reviewer is kept off the progress log. Nothing in
   `wiki/decisions.md` currently says a role may be denied a field, so the next person to
   "helpfully" widen `CONTEXT` won't know they're crossing a line.
3. **The split threshold is still the planner's judgement.** Item 4 only fires after a
   machine failure has already happened. Deciding *up front* that a task is too big would
   need a computed size score (AC count, files named in the plan, plan step count) — which
   isn't derivable before the plan exists, so the honest version is a post-plan check that
   forces a re-split. Worth a decision entry before building, since it changes what the
   planner is allowed to output.

**Notes:**
- `Readiness.blockingDependencies` / `missingDependencies` (`src/types.ts`) are parsed but
  still unused anywhere in the pipeline — scaffolding, not dead-by-mistake.
- Every fact about branch/subtask behaviour lives in `wiki/decisions.md` (D-004) and the
  nested-splits gotcha. Don't restate it here.
