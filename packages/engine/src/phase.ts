import { STATUS, type Role, type Task } from "./types.js";

export interface Phase {
  role: Role;
  /** Logged on every tick so you can audit routing without a model. */
  reason: string;
}

/**
 * Machine observations the router needs but cannot derive from the task file
 * alone. Computed by `tick.ts` (which is allowed to do IO) and passed in, so
 * `resolvePhase` stays a pure function of its inputs and can be tested
 * without a repo — see CLAUDE.md on why this is the one routing decision
 * with no other verification signal.
 */
export interface Signals {
  /** Does this branch's diff touch anything a reader of the docs would notice? */
  docsRelevant: boolean;
}

const blank = (s: string | null): boolean => s === null || s.trim() === "";

/** Comment authors are stored `@`-prefixed by `Backlog.comment`. */
const authoredBy = (task: Task, role: Role): boolean =>
  task.comments.some((c) => c.author === `@${role}`);

/**
 * The documenter's progress-log entry is its one-shot marker: once it's run
 * for this task, don't run it again. There's no dedicated Backlog.md field
 * for this (unlike `finalSummary`/`implementationPlan`), so the log entry is
 * the record.
 */
const hasDocumented = (task: Task): boolean => authoredBy(task, "documenter");

/**
 * Marker for the architect's pre-split interface contract (see D-007):
 * `tick.ts` writes this
 * before ever creating children from a planner split, so every sibling is
 * seeded with the same shared shape instead of each independently
 * reinventing it. One-shot per task, same pattern as `hasDocumented` — no
 * dedicated field, so the notes entry itself is the record.
 */
export const hasArchitectContract = (task: Task): boolean =>
  (task.implementationNotes ?? "").includes("**architect:**");

/**
 * Marker for the post-split sibling-alignment pass: a second, distinctly
 * tagged architect call that runs once all of a container's children are
 * Done, before the container is allowed to reach `reviewer`. Distinct from
 * `hasArchitectContract` so the alignment check isn't skipped just because
 * the pre-split contract already satisfied that marker.
 */
export const hasAlignmentCheck = (task: Task): boolean =>
  (task.implementationNotes ?? "").includes("**architect (alignment check):**");

/**
 * Set by `tick.ts` when a task's own size is what broke the tick (a local
 * model refusing the call for context overflow). It forces the planner down
 * its SPLIT branch on the next tick instead of letting the task die at the
 * model-error ceiling.
 */
export const NEEDS_SPLIT_LABEL = "needs-split";

/**
 * Set by the deterministic overlap check when a fresh split leaves two
 * unrelated tasks claiming the same file (`findCollisions`, `overlap.ts`).
 * The container is Blocked at the same time, so this label is the *reason*
 * rather than the mechanism — but it is checked here too, so a human who
 * unblocks the status without resolving the collision doesn't silently get a
 * container walked through to `reviewer`. Remove the label to say "looked at
 * it, the paths are fine." See D-009.
 */
export const NEEDS_REPLAN_LABEL = "needs-replan";

/**
 * Set on a task whose D-012 autonomous integration hit a rebase conflict or
 * a post-rebase gate failure. Purely informational — `status` is already
 * `Blocked`, which is what actually stops `resolvePhase` from touching it
 * again, so this label carries no routing logic of its own.
 */
export const NEEDS_MANUAL_MERGE_LABEL = "needs-manual-merge";

/**
 * Marker for the critic's verdict (D-013): written to `implementationNotes`
 * only on `SHIP` — same one-shot idiom as `hasArchitectContract`. `CHANGES`
 * and `RESPEC` deliberately do NOT set this marker, so critic runs again
 * once the requested revision (or re-plan) lands.
 */
export const hasCriticVerdict = (task: Task): boolean =>
  (task.implementationNotes ?? "").includes("**critic:**");

/**
 * Set by the critic (D-013) on a `CHANGES` verdict: routes the task straight
 * back to `executor`, bypassing the acceptance-criteria/plan checks that
 * would otherwise treat it as already finished. Cleared by the executor
 * itself once its next gates-green pass lands.
 */
export const NEEDS_CHANGES_LABEL = "needs-changes";

/**
 * Set when a leaf task's critic-requested revisions have run out
 * (`MAX_CRITIC_ROUNDS` in `tick.ts`) without ever reaching `SHIP`. Purely
 * informational, like `NEEDS_MANUAL_MERGE_LABEL` — `status` is already
 * `Blocked`, which is what actually halts routing.
 */
export const NEEDS_HUMAN_REVIEW_LABEL = "needs-human-review";

/**
 * Routing is DERIVED from which fields are empty, plus machine `Signals`.
 * It is never chosen by a model: it is the one decision with no verification
 * signal, so a bad choice corrupts the loop silently instead of failing a
 * task loudly.
 */
export function resolvePhase(task: Task, attempts: number, signals: Signals): Phase | null {
  if (task.status === STATUS.done || task.status === STATUS.blocked || task.status === STATUS.review) {
    return null; // terminal, or human-owned — the agent never touches these again
  }

  if (task.readiness.isBlocked) {
    return null; // dependencies are the only ordering mechanism
  }

  // Container task: the planner split it into subtasks sharing this task's
  // branch. Implementation happens entirely in the children — this task's own
  // owner/planner/executor phases are skipped for good. tick.ts only lets a
  // task with subtasks reach here once every one of them is Done.
  if (task.subtasks.length > 0) {
    // A known-overlapping breakdown is a human's problem, not the next
    // role's: every downstream phase would be summarising work that two
    // siblings are about to write twice.
    if (task.labels.includes(NEEDS_REPLAN_LABEL)) {
      return null;
    }
    if (signals.docsRelevant && !hasDocumented(task)) {
      return { role: "documenter", reason: "all subtasks complete, documented surface changed" };
    }
    // A container never reaches reviewer on its children's word alone: one
    // architect pass checks the finished siblings against the contract
    // written before they existed, so drift between them (e.g. two children
    // independently inventing incompatible shapes for the same shared file)
    // surfaces before a human sees a clean-looking summary.
    if (blank(task.finalSummary) && !hasAlignmentCheck(task)) {
      return { role: "architect", reason: "all subtasks complete, verifying sibling alignment before review" };
    }
    // A container has no single executor to hand `CHANGES` feedback to, so
    // critic gets a binary gate here: `SHIP` proceeds, anything else blocks
    // the same way `DRIFT` already does (`tick.ts`'s `case "critic":`) — see
    // D-013.
    if (blank(task.finalSummary) && !hasCriticVerdict(task)) {
      return { role: "critic", reason: "all subtasks complete, aligned, awaiting critic verdict" };
    }
    if (blank(task.finalSummary)) {
      return { role: "reviewer", reason: "all subtasks complete, awaiting review" };
    }
    return null;
  }

  if (blank(task.description)) {
    return { role: "owner", reason: "no description" };
  }

  // Deliberately a SEPARATE tick from `owner`, with a prompt that sees the
  // description and nothing else. A context that just wrote the description
  // writes acceptance criteria that restate it; a context that only reads it
  // has to commit to something checkable.
  if (task.acceptanceCriteria.length === 0) {
    return { role: "criteria", reason: "no acceptance criteria" };
  }

  // Researcher is triggered by an explicit marker, never run "constantly":
  // unbounded background research is a context sink with nothing to attach to.
  if (task.labels.includes("needs-research")) {
    return { role: "researcher", reason: "needs-research label present" };
  }

  if (task.labels.includes("needs-architecture")) {
    return { role: "architect", reason: "needs-architecture label present" };
  }

  // Checked BEFORE the empty-plan test: a task sent back for splitting
  // usually already has a plan, and that plan is exactly the thing that
  // turned out not to fit. Nested splits (splitting a subtask again) are
  // supported — see rootAncestorId in tick.ts and Backlog.createChild's
  // `project` propagation — so this is no longer restricted to top-level
  // tasks.
  if (task.labels.includes(NEEDS_SPLIT_LABEL)) {
    return { role: "planner", reason: `${NEEDS_SPLIT_LABEL} label present` };
  }

  if (blank(task.implementationPlan)) {
    return { role: "planner", reason: "no implementation plan" };
  }

  // Spec + plan complete: this task is in ToDo. The executor is free to
  // pick it up on the very next tick — see D-014 (supersedes D-002, which
  // required a human to move it here first). This check only guards against
  // a plan-bearing task sitting somewhere else entirely (Review, Blocked,
  // Done) ever routing to executor; it is not a human gate.
  if (task.status !== STATUS.inProgress && task.status !== STATUS.todo) {
    return null;
  }

  const acDone =
    task.acceptanceCriteriaCount > 0 &&
    task.acceptanceCriteriaCompleted === task.acceptanceCriteriaCount;

  if (!acDone) {
    // Senior is gated behind repeated machine failure, not opinion — and
    // "machine failure" means pre-first-success specifically. Checked here,
    // not unconditionally, because nothing ever resets `attempts`: once a
    // task has passed gates at least once, `attempts` staying at or above 2
    // must never re-trip this and strand a critic/executor revision cycle
    // (D-013) on the read-only `senior` role instead of routing back to
    // `critic`/`executor`.
    if (attempts >= 2) {
      return { role: "senior", reason: `${attempts} failed attempts` };
    }
    return { role: "executor", reason: "acceptance criteria incomplete" };
  }

  // From here on, acDone is true — post-success territory. A critic
  // `CHANGES` verdict (D-013) routes straight back to executor, ahead of
  // the documenter/critic/reviewer sequence below.
  if (task.labels.includes(NEEDS_CHANGES_LABEL)) {
    return { role: "executor", reason: "critic requested changes" };
  }

  // Green gates alone don't earn a documenter tick — a change that moved no
  // documented surface has nothing for it to write, and every skipped tick
  // is a local-model call saved on an overnight run.
  if (signals.docsRelevant && !hasDocumented(task)) {
    return { role: "documenter", reason: "criteria met, documented surface changed" };
  }

  // A task never reaches reviewer on the executor's word alone (D-013): an
  // independent critic pass judges the actual diff first. `CHANGES`/`RESPEC`
  // are handled by `tick.ts`'s `case "critic":` and never set this marker,
  // so critic runs again once a revision (or re-plan) lands.
  if (!hasCriticVerdict(task)) {
    return { role: "critic", reason: "criteria met, awaiting critic verdict" };
  }

  if (blank(task.finalSummary)) {
    return { role: "reviewer", reason: "criteria met, critic shipped, awaiting review" };
  }

  return null;
}

/** Highest priority, then ordinal. Ready tasks only. */
export function selectTask<
  T extends { isReady: boolean; priority: string | null; ordinal: number },
>(tasks: T[]): T | null {
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const ready = tasks.filter((t) => t.isReady);
  if (ready.length === 0) return null;
  return ready.sort((a, b) => {
    const pa = rank[a.priority ?? "medium"] ?? 1;
    const pb = rank[b.priority ?? "medium"] ?? 1;
    return pa !== pb ? pa - pb : a.ordinal - b.ordinal;
  })[0]!;
}
