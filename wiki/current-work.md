# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**Status:** the planner-split flow now routes through an architect-written interface
contract before children are created, and through a second architect alignment pass
before a container can reach `reviewer`. Implemented and covered by `routing.test.ts`
(container → architect → reviewer sequencing, the two marker types not being confused,
`parseAlignmentOutput`'s default-to-`drift`). **Not yet run against a real local model
end-to-end** — nobody has watched an actual split produce a contract, children inherit
it, and the alignment pass catch a real disagreement.

How it works: `tick.ts`'s `case "planner"` won't create children from a `SPLIT` until
`hasArchitectContract(task)` (`phase.ts`) is true; until then the task gets
`needs-architecture` and the split is discarded. `architect` (`prompts/architect.md`)
writes the contract into `implementationNotes` and clears its own label. Children are
seeded with that contract at creation (`Backlog.createChild`'s `notes` option). Once every
child is `Done`, `phase.ts` routes to `architect` again (`prompts/architect-alignment.md`,
picked by `task.subtasks.length > 0`) for a second, distinctly-marked pass
(`hasAlignmentCheck`) that must answer `ALIGNED`/`DRIFT`; `DRIFT` blocks the container
immediately rather than just annotating it.

**The `book` project's current task tree predates this fix and has no architect
contracts.** Do not move anything in it to `Ready for Work` or execute against it until
it's reset (see Next action).

**Also uncommitted, unrelated to the split flow: `promote-draft` is now fully
non-interactive.** `src/promote-draft.ts` runs `owner`/`criteria`, prints the result, and
promotes immediately — no `y/N` gate, no type/priority prompt. Type comes from whatever
`owner` drafted; priority is left unset. This doesn't touch the D-002 invariant: the
promoted task still lands in `Waiting for Approval` and needs a human to move it to
`Ready for Work` before execution. Documented in README's "Adding tasks" section.

**Needs your sign-off:**
1. **D-007, drafted below** — architect contract required before a split creates
   children; second alignment pass required before a container reaches `reviewer`.
2. `wiki/decisions.md` D-002's text still describes the retired `approved` label, not
   today's `Ready for Work` status (see CLAUDE.md's hard constraints for current
   behavior). Needs a human rewrite — not mine to edit.
3. `wiki/decisions.md` D-004's text still says branch-sharing covers "exactly one level
   of nesting." `rootAncestorId` (`src/tick.ts`) now walks to the root ancestor and this
   is tested (`routing.test.ts`). Needs a human rewrite — not mine to edit.
4. Parked, not urgent: a prior-session proposal to capture a plan's base commit and check
   it before executing. Untouched since it was raised; pick it up from git history if
   it's still wanted.
5. `src/phase.ts` and `src/spec.ts` reference the pending decision as `D-00X` in code
   comments — once D-007 above is accepted (or renumbered), those two comments need the
   real number.

**D-007 draft, for `wiki/decisions.md`:**

> ## D-007 — A split requires an architect-written interface contract before children exist; a container requires a second alignment pass before review
>
> **Date:** 2026-09-08
> **Status:** Proposed
>
> **Context:** The planner splits a task into subtasks with zero visibility into any
> sibling's plan (context is rationed per role/per task — see the rationale in
> `src/prompts.ts`). Observed in practice on the `book` project: one task's subtree
> produced seven incompatible reimplementations of the same shared accessor function
> and four separate, conflicting CDK bucket definitions, because nothing forced
> agreement on the shared interface before the subtasks existed independently.
>
> **Decision:** A planner's split proposal is provisional until `architect` has written
> an interface contract for the parent task (`hasArchitectContract`, `phase.ts`) — only
> then are children actually created, each seeded with that contract in its own
> `implementationNotes`. Once every child is Done, a second, distinctly-marked architect
> pass (`hasAlignmentCheck`) must confirm the finished siblings still agree with the
> contract before the container can reach `reviewer`; on `DRIFT` the container is
> blocked for a human, not merely annotated.
>
> **Consequences:** Every split costs at least two extra architect ticks (one before,
> one after) beyond today's one-shot planner split — acceptable because model time is
> free and both failure modes this catches (siblings reinventing a shared interface
> differently; siblings drifting from an agreed shape by the time they're all done) are
> silent otherwise. The alignment check's verdict is a single required token
> (`ALIGNED`/`DRIFT`) parsed the same way as `SPLIT`/`TYPE`, not a prose-parsed
> model summary — kept distinct from D-001's gate verdicts, which this doesn't touch;
> `tsc`/`biome`/`vitest` remain the only pass/fail signal for the executor and reviewer.
> A false `DRIFT` costs one human look; a missed one costs exactly what already happened
> on `book`'s `TASK-1.4` subtree.

**Next action:**
1. Get sign-off on D-007 above (or redirect it) before running the split-then-execute
   path against a real local model.
2. Once signed off: wipe the `book` project's current task tree ("take our learnings and
   start fresh"), keeping `state/book/journal.db` (baseline: 3.5 ticks per completed
   task, worth comparing the new split behavior against). Re-run planning from the
   original tickets, watch a task that has to split, and confirm the contract gets
   written, copied into every child, and checked for real drift at alignment time.
3. Only after that: resume the original goal of this session — testing the *executor*
   path for the first time against a real local model (`npm run report book` reads
   ticks/completed once there's real execution data).
