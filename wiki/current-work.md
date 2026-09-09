# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**D-015, shipped this session: draft promotion now runs the full plan-mode loop.**
`promote-draft.ts` used to run one summarization pass (`fakeTask` + `owner-from-draft.md`)
before the real task existed, then archive the verbatim draft as a `@draft` comment no
planning role ever read again. Now it promotes the draft immediately, blanks the new
task's description, and drives it through a tree-scoped, planning-only run of the normal
tick loop (`TickOptions.restrictToTree` in `src/tick.ts`) — owner, criteria,
researcher/architect, planner, including any split — with the verbatim draft text
injected as extra context into every one of those ticks (`renderWithDraft` in
`promote-draft.ts`), not just used once. The loop never advances past planning: any tick
whose `resolvePhase` role falls outside `owner|criteria|researcher|architect|planner`
returns `outcome: "planning-complete"` immediately instead of running it. `fakeTask`,
`owner-from-draft.md`, and the `@draft` comment-archiving step are all deleted — fully
subsumed by the new loop. Typechecked and unit-tested (all 36 existing tests still pass
unchanged — this only adds an opt-in code path the main loop never exercises). See D-015
in `wiki/decisions.md`.

**Next action:** this has not yet been run end-to-end against a real draft and a live
local model. Do that next: write a draft whose description clearly implies two related
pieces of work sharing an interface (the D-007 case), run `pnpm run promote-draft <id>
<project>`, and confirm (a) no task outside the tree is touched, (b) the run stops on its
own once every task in the tree is planned or split with spec'd children, never reaching
`executor`, and (c) if it splits, the architect's contract and children's descriptions
show real awareness of the original draft's specifics rather than the parent's condensed
description. Then `npm run report <project>` before/after to record ticks-per-promoted-
task and per-role prompt size now that promotion costs more ticks up front (per CLAUDE.md:
numbers, not impressions).

**Needs your sign-off:** none currently open.

---

**Prior state, for reference (superseded or already resolved — kept only until the next
pass through this file, per its own "overwrite, don't append" rule):**

- D-012/D-013 (autonomous integration, critic gate) are built, typechecked, unit-tested,
  and manually verified against scratch repos with a stubbed model, but neither has been
  run through a real `npm start` loop against a live local model end to end together.
  Worth doing once, registering a throwaway repo by URL, to see a real model's `critic`
  output land correctly.
- D-011 (overlap across independently-created top-level tasks) is still an open,
  not-urgent question: nothing runs `findCollisions` automatically outside one split's own
  tree. Not decided.
- `book` project state as of the D-014 session: TASK-1 unblocked but needed the manual
  `ToDo` migration off the retired `Waiting for Approval` status; TASK-2 was
  `Blocked`/`needs-replan` from a suspected false-positive collision finding
  (`lambdas/extraction/handler.ts`, TASK-2.4 creates it, TASK-2.5 only references its
  path) — still undecided whether to clear the label by hand or teach `findCollisions` to
  tell "creates" from "references" apart.
