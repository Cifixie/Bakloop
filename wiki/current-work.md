# Current work

Current state only — not a changelog. Overwrite this file, don't append to it.
History lives in git.

---

**Bug fixed this session: promoted drafts had no `project` field, invisible to the main
loop.** D-015 (draft promotion running the full plan-mode loop, shipped previous session —
see `decisions.md`) got its first real end-to-end test this session: 3 drafts
promoted into TASK-1/2/3 against the `book` project. The plan-mode loop ran fine against
each, but the *main* `npm start` loop then logged `no-ready-tasks` for 3 straight ticks —
`backlog task list --project book` returned nothing even though the tasks existed in
`Backlog`. Cause and fix are in `gotchas.md`'s newest entry; short version:
`promote-draft.ts` removed the temporary `project:<key>` label but never set the real
`--project` field on the promoted task, so `Backlog.list` filtered it out forever. Fixed,
typechecked, all 36 tests still pass. The 3 stray tasks from this session were patched by
hand (`backlog task edit <id> --project book`) rather than re-promoted.

**Next action:** run `npm start` against `book` for real now that TASK-1/2/3 are visible
to the loop, and confirm it actually picks one up (owner/criteria/etc.) instead of
`no-ready-tasks` — the fix has only been verified at the `backlog task list --project`
level, not by watching a live tick pick a task. This is also the first real end-to-end run
of D-015's promotion path against a live local model — record ticks-per-promoted-task and
per-role prompt size per CLAUDE.md once it runs, and confirm (a) no task outside the tree
was touched during promotion, (b) the promotion run stopped on its own once every task in
the tree was planned/split, never reaching `executor`, and (c) if it split, the
architect's contract and children's descriptions show real awareness of the original
draft's specifics rather than the parent's condensed description.

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
</content>
