# Split workflow — decomposition, children, alignment

A split partitions one large task into independently-planned and independently-executed subtasks. Subtasks share their top-level ancestor's branch (`bakloop/<ROOT-ID>`), so many subtasks add up to one PR (D-004).

## Trigger conditions

A task gets split two ways:

**1. Planner-initiated.** `resolvePhase` runs `planner` (blank plan → planner). The planner responds with `SPLIT` containing child definitions (`src/prompts.ts` parser).

**2. Machine-initiated (context overflow).** Any tick fails because the prompt exceeded the context window. `tick.ts:449-462`: if the error matches `CONTEXT_OVERFLOW` AND the task has no existing children (`task.subtasks.length === 0`) AND does not already carry `needs-split` label, it gets labelled `needs-split`. If it was `In Progress`, it is pulled back to `Backlog` (tick.ts:457). On the next tick, `resolvePhase:186` selects `planner` explicitly because the label is present — the prompt is now smaller (split-only branch), so it fits.

## Pre-split: architect contract

When `planner` produces `parsed.kind === "split"`, `tick.ts:518-539` checks `hasArchitectContract(task)`:

- **No contract yet** → proposal is discarded (not persisted). Task is labelled `needs-architecture`. Next tick routes to `architect`.
- **Contract exists** → proceed to child creation.

The `architect` phase writes an interface contract into `implementationNotes`: which sibling creates which shared artifact, signature contracts, resource IDs. This is the only cross-sibling context any subtask ever gets — each child's own planner tick sees only its own task.

The contract pass clears the `needs-architecture` label on completion (`tick.ts:630`). It runs once.

## Children creation

Back at `planner`, with the contract now in `task.implementationNotes`, children are created:

```js
for (const child of parsed.children) {
  await backlog.createChild(task.id, child.title, project, {
    notes: contract,                                    // interface contract
    dependsOn: [previous_child_id],                     // linear chain
    draftSource: root.draftSource + "\n\n---\n\n" + child.desc,
  });
}
```

Three fields per child:

- **`notes`** = architect's interface contract. Seeds the child's `implementationNotes` so its planner/executor knows the shared surface from the start.
- **`dependsOn`** = `[previous_child_id]` for all but the first. Creates a strict linear execution chain — child N+1 cannot start until child N is `Done`. Driven by `readiness.isBlocked` (the loop's only ordering mechanism, `resolvePhase`). Safe because subtasks self-finalize to `Done` on green gates and never wait for a human (D-008).
- **`draftSource`** = root's verbatim draft text + this child's split proposal. When the child's own `criteria` tick runs (description blank → `criteria` routes), it re-derives acceptance criteria from this compound `draftSource`, keeping the child grounded in the original ask.

Each child starts in status `Backlog` with a blank description, so its own plan-mode pass runs: `owner → criteria → planner → ToDo`.

## Overlap detection

Right after children are created, `tick.ts:576-596` runs `findCollisions` on the entire root-ancestor tree. Extracts repo-relative paths from descriptions, plans, acceptance criteria, and DoD. Reports any path claimed by two or more non-ancestor/descendant tasks.

- **Blocking collisions** (code paths) → container labelled `needs-replan` (`NEEDS_REPLAN_LABEL`), set to `Blocked` (`tick.ts:590`), children stay blocked. Human must re-plan.
- **Non-blocking** (manifests, lockfiles, append-only docs) → just commented.

This check runs automatically after every split creation. It also exists as `pnpm run overlap <project>` for ad-hoc tree inspection.

## Child execution

Each child runs its own full pipeline independently: `owner → criteria → planner → ToDo → executor (gate loop)`. They execute strictly in dependency chain order — child N+1 is `isBlocked: true` until child N is `Done`.

Subtasks **self-finalize** to `Done` on green gates (`tick.ts:813-817`):

```js
if (task.parentTaskId) {
  await backlog.setStatus(task.id, STATUS.done);
  return { done: false, outcome: "subtask-done", note: `${task.id}: subtask complete` };
}
```

No separate review, no critic, no reviewer. The parent only proceeds once every child is `Done`.

## Post-split: container alignment

Once every child is `Done`, `excludeInFlightContainers` (tick.ts:203-212) stops excluding the parent. The loop picks it up again. The container's own role sequence:

1. **`architect` alignment pass** — `resolvePhase:142` checks `hasAlignmentCheck`. If not yet seen, routes to architect. The alignment prompt references the pre-split contract. Checks finished siblings against it. `DRIFT` → `Blocked` for human (`tick.ts:631-644`).
2. **`critic`** — judges the combined diff of all subtasks. For containers, any non-SHIP verdict (`CHANGES` or `RESPEC`) blocks for human — no single executor to hand `CHANGES` to (`tick.ts:684-694`). `SHIP` proceeds.
3. **`reviewer`** — writes `finalSummary`, sets status to `Review`.

## Container overlap check

If `alignCheck` fails (alignment drift), the container is blocked. A subsequent `critic` on the same container also blocks on non-SHIP. These two gates exist because a container has no single executor to receive `CHANGES` feedback — a human resolves the mismatch before the container reaches reviewer (same pattern as `DRIFT`).

## Special cases

**Nested splits:** a subtask can itself be split. Same flow — `rootAncestorId` walks to the root, so nested children share the same top-level branch (`bakloop/<ROOT-ID>`). One PR total. Supported but never exercised end-to-end in practice (`gotchas.md`).

**Split refused after overflow:** if `NEEDS_SPLIT_LABEL` is present and the planner writes a plan instead of another split, the task is `Blocked` for human (`tick.ts:599-613`). Decomposition failed — structural problem.

**Unparseable split:** if the split proposal doesn't parse (`parsed.kind === "unparseable"`), the task is `Blocked` and the verbatim output is preserved in comments for debugging (`tick.ts:505-516`).

**Pre-existing children:** a task that already has `subtasks.length > 0` is treated as a container. The planner cannot split it again — it routes through the alignment/critic/reviewer sequence instead. To split further, the container itself would need to be re-planned and re-split, which requires a human.
