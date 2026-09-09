import { Backlog } from "./backlog.js";
import { branchNameFor, commitAll, ensureTaskBranch, git } from "./branch.js";
import { error as colorError, roleTag, tag } from "./colors.js";
import {
  captureBaseline,
  docsRelevant,
  isStuck,
  loadGateConfig,
  runGates,
  type Baseline,
} from "./gates.js";
import type { Journal, TickOutcome, TickRecord } from "./journal.js";
import {
  hasArchitectContract,
  NEEDS_CHANGES_LABEL,
  NEEDS_HUMAN_REVIEW_LABEL,
  NEEDS_MANUAL_MERGE_LABEL,
  NEEDS_REPLAN_LABEL,
  NEEDS_SPLIT_LABEL,
  resolvePhase,
  selectTask,
} from "./phase.js";
import { findCollisions, render as renderCollisions } from "./overlap.js";
import type { SiblingScope } from "./prompts.js";
import {
  parseAlignmentOutput,
  parseCriteriaOutput,
  parseCriticOutput,
  parseOwnerOutput,
  parsePlannerOutput,
} from "./spec.js";
import { ROLE_TOOLS, STATUS, type Role, type Task, type TaskSummary } from "./types.js";

/** D-013: how many times critic is allowed to say `CHANGES` on one leaf task before it blocks for a human. */
const MAX_CRITIC_ROUNDS = 3;

/**
 * The roles a plan-mode-only call (`TickOptions.restrictToTree`) is allowed
 * to run. Everything else — executor, senior, critic, reviewer, documenter —
 * is real execution or a judgment pass on finished execution; a promotion
 * run must never reach any of them.
 */
const PLANNING_ROLES = new Set<Role>(["owner", "criteria", "researcher", "architect", "planner"]);

/** Attempt bookkeeping. Persisted to disk, not held in memory. */
export interface AttemptLog {
  taskId: string;
  attempts: number;
  signatures: string[];
  /** Consecutive model-call failures (transport/OOM/context-overflow), reset on any success. */
  modelErrors?: number;
  /**
   * D-013: how many times critic has said `CHANGES` for this task.
   * Deliberately separate from `attempts` — that counter drives senior
   * escalation for raw pre-first-success gate failures; reusing it here
   * would strand a legitimate critic/executor revision cycle on the
   * read-only `senior` role once it crossed that threshold.
   */
  criticRounds?: number;
}

/** What one model call cost, for the tick journal. Never used for control flow. */
export interface AgentMetrics {
  promptChars: number;
  outputChars: number;
  thinkingChars: number;
  toolCalls: number;
  modelMs: number;
}

export interface RunAgent {
  /** Wire to pi-agent-core. Tools MUST be restricted to `tools`. */
  (input: {
    role: Role;
    taskId: string;
    tools: readonly string[];
    prompt: string;
    cwd: string;
  }): Promise<{ text: string; metrics?: AgentMetrics }>;
}

/**
 * Every exit from `runTick` declares what it did, so the journal's `outcome`
 * is a value the code chose rather than something a report re-derives by
 * pattern-matching on prose. `note` stays the human-facing line.
 */
interface TickResult {
  done: boolean;
  note: string;
  outcome: TickOutcome;
}

const MAX_ATTEMPTS = 4;
/**
 * A local model refusing a call (context-overflow, transport drop, server
 * OOM) says nothing about the task's own correctness — it's not a gate
 * verdict (see D-001) — so it gets its own small, consecutive-failure
 * counter rather than feeding the gate-attempt/senior-escalation logic.
 * Reset to 0 on any successful call for that task.
 */
const MAX_MODEL_ERRORS = 3;

/**
 * A local model refusing a call because the prompt didn't fit is the one
 * model error with a real remedy: the task is too big, so split it. Matched
 * against the thrown message because that's all the transport gives us —
 * deliberately broad, since the cost of a false positive is one extra
 * planning tick and the cost of a false negative is a dead task.
 */
const CONTEXT_OVERFLOW =
  /context (?:length|window|size)|too many tokens|token limit|prompt is too (?:long|large)|exceed\w* (?:the )?(?:maximum )?context|out of memory|\boom\b|kv cache/i;

export function isContextOverflow(message: string): boolean {
  return CONTEXT_OVERFLOW.test(message);
}

/** Ids of tasks that have at least one subtask, derived from a full project listing. */
function containerIds(all: TaskSummary[]): Set<string> {
  return new Set(all.filter((t) => t.parentTaskId).map((t) => t.parentTaskId!));
}

/**
 * Walks `parentTaskId` all the way up, not just one level, so a subtask of a
 * subtask (a nested split — see D-004 and the nested-splits entry in
 * wiki/gotchas.md) still lands on its top-level ancestor's branch instead of
 * forking a new one at whatever level it was split. `all` must be the full
 * project-scoped listing so every ancestor in the chain is resolvable.
 */
export function rootAncestorId(taskId: string, all: TaskSummary[]): string {
  const byId = new Map(all.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let current = taskId;
  while (true) {
    if (seen.has(current)) {
      throw new Error(`Cycle detected in parentTaskId chain starting at ${taskId} (revisited ${current})`);
    }
    seen.add(current);
    const parentId = byId.get(current)?.parentTaskId;
    if (!parentId) return current;
    current = parentId;
  }
}

/**
 * What the rest of this task's breakdown already owns, for the two roles that
 * decide scope. Computed here rather than in `prompts.ts` because it needs a
 * project listing and one `view` per ancestor.
 *
 * The set is "everything in my root ancestor's tree that is neither me, nor
 * my own descendants, nor my ancestors" — i.e. my siblings, aunts, uncles and
 * cousins. Excluding descendants matters: my own children are work I am
 * delegating, not work already spoken for. Ancestors are reported separately,
 * with their descriptions, since they're the original ask this task is a
 * piece of. See D-008.
 */
export async function siblingScopeFor(
  task: Task,
  all: TaskSummary[],
  view: (id: string) => Promise<Task>,
): Promise<SiblingScope | undefined> {
  const rootId = rootAncestorId(task.id, all);
  // A top-level task with no tree around it has no scope to conflict with,
  // and this is the common case — skip the ancestor `view` calls entirely.
  if (rootId === task.id && !all.some((t) => t.parentTaskId === task.id)) return undefined;

  const ancestorIds: string[] = [];
  const byId = new Map(all.map((t) => [t.id, t]));
  for (let cur = byId.get(task.id)?.parentTaskId; cur; cur = byId.get(cur)?.parentTaskId) {
    ancestorIds.push(cur);
  }

  const descendants = new Set<string>();
  const collect = (id: string) => {
    for (const t of all) {
      if (t.parentTaskId === id && !descendants.has(t.id)) {
        descendants.add(t.id);
        collect(t.id);
      }
    }
  };
  collect(task.id);

  const inTree = all.filter((t) => rootAncestorId(t.id, all) === rootId);
  const owned = inTree
    .filter((t) => t.id !== task.id && !descendants.has(t.id) && !ancestorIds.includes(t.id))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));

  const ancestors = [];
  // Root first: the chain should read as a narrowing of the original ask.
  for (const id of [...ancestorIds].reverse()) {
    const full = await view(id);
    ancestors.push({ id: full.id, title: full.title, description: full.description });
  }

  return owned.length === 0 && ancestors.length === 0 ? undefined : { owned, ancestors };
}

/**
 * A container (has subtasks) is only a valid candidate once every subtask
 * has reached Done — otherwise it would out-rank its own children (lower
 * ordinal, created first) on every tick and starve them forever.
 */
function excludeInFlightContainers(
  tasks: TaskSummary[],
  containers: Set<string>,
  all: TaskSummary[],
): TaskSummary[] {
  return tasks.filter((t) => {
    if (!containers.has(t.id)) return true;
    return all.filter((c) => c.parentTaskId === t.id).every((c) => c.status === STATUS.done);
  });
}

export interface TickOptions {
  backlog: Backlog;
  repoCwd: string;
  /** Which lane of the shared backlog this loop is allowed to touch. */
  project: string;
  /** Branch each task's own branch forks from, and is diffed against for gates. */
  baseBranch: string;
  /** Where the detected-once gate config (tsc/biome/vitest presence) is cached for this project. */
  gateConfigPath: string;
  runAgent: RunAgent;
  loadLog: (taskId: string) => Promise<AttemptLog>;
  saveLog: (log: AttemptLog) => Promise<void>;
  renderPrompt: (role: Role, task: Task, scope?: SiblingScope) => string;
  /** Optional: omit to run without recording anything (tests, one-off scripts). */
  journal?: Journal;
  /**
   * D-012: on green review, rebase the task branch onto `baseBranch`, re-run
   * gates against the rebased tip, squash-merge, and mark the task Done —
   * no human step. Set from `ProjectEntry.autonomous` in `main.ts`; defaults
   * to false so every other project keeps today's exact "reviewer stops,
   * a human merges" behavior.
   */
  autonomousIntegration?: boolean;
  /**
   * Scope this call to one task's split tree (the root task's id) and never
   * let it run a role outside `PLANNING_ROLES` — used by promote-draft.ts's
   * plan-mode loop so a freshly-promoted draft's whole tree is spec'd out
   * before the main loop ever sees it. The tree filter is what stops the
   * loop from wandering onto an unrelated ToDo task mid-run; the role guard
   * is what stops it from starting real execution on a sibling that
   * happened to finish planning first while others in the same tree are
   * still being spec'd.
   */
  restrictToTree?: string;
}

/**
 * One tick = one model call. No parallelism, no sub-agents, nothing held
 * in memory between ticks: all state lives in the backlog files, so the
 * process can die on tick 400 and resume from git.
 *
 * This wrapper exists only to record what happened. `runTick` below has many
 * exits, and a `finally` here is the one place guaranteed to see every one of
 * them — including a throw, which is exactly the case a run needs recorded
 * and the case an exit-by-exit approach always misses.
 */
export async function tick(opts: TickOptions): Promise<{ done: boolean; note: string }> {
  const startedAt = Date.now();
  const record: TickRecord = {
    ts: new Date().toISOString(),
    project: opts.project,
    taskId: null,
    role: null,
    reason: null,
    attempt: null,
    statusBefore: null,
    outcome: "crashed",
    note: "",
    promptChars: null,
    outputChars: null,
    thinkingChars: null,
    toolCalls: null,
    modelMs: null,
    tickMs: 0,
    gateFailures: null,
    testsPassing: null,
    docsRelevant: null,
    error: null,
  };

  try {
    const result = await runTick(opts, record);
    record.outcome = result.outcome;
    record.note = result.note;
    return { done: result.done, note: result.note };
  } catch (err) {
    record.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    record.note = err instanceof Error ? err.message : String(err);
    // main.ts's crash log has no other way to know which task was in
    // flight when a tick throws outside runTick's own per-task handling.
    if (err instanceof Error && record.taskId) (err as Error & { taskId?: string }).taskId = record.taskId;
    throw err;
  } finally {
    record.tickMs = Date.now() - startedAt;
    // Never let bookkeeping take down a run that otherwise worked.
    await opts.journal
      ?.append(record)
      .catch((e) => console.error(colorError(`${tag("journal")} ${record.taskId ?? "?"} append failed:`), e));
  }
}

async function runTick(opts: TickOptions, record: TickRecord): Promise<TickResult> {
  const {
    backlog,
    repoCwd,
    project,
    baseBranch,
    gateConfigPath,
    runAgent,
    loadLog,
    saveLog,
    renderPrompt,
    autonomousIntegration,
  } = opts;

  const all = await backlog.list(undefined, project);
  const containers = containerIds(all);

  // Hard invariant, scoped to this project. If this ever trips, stop and report — do not continue.
  const inProgress = all.filter((t) => t.status === STATUS.inProgress);
  if (inProgress.length > 1) {
    throw new Error(
      `Invariant violated: ${inProgress.length} tasks In Progress in project "${project}" ` +
        `(${inProgress.map((t) => t.id).join(", ")}). Agents must run sequentially.`,
    );
  }

  // A container whose subtasks blocked propagates that up immediately —
  // the shared branch is stuck either way. Bookkeeping only, no model call.
  for (const t of all) {
    if (!containers.has(t.id) || t.status === STATUS.done || t.status === STATUS.blocked) continue;
    const anyChildBlocked = all.some((c) => c.parentTaskId === t.id && c.status === STATUS.blocked);
    if (anyChildBlocked) {
      await backlog.setStatus(t.id, STATUS.blocked);
      return { done: false, outcome: "container-blocked", note: `${t.id}: blocked — a subtask is blocked` };
    }
  }

  // Execution-ready work always comes first; backlog spec/plan work is
  // filler that keeps the ToDo queue stocked whenever there's nothing to
  // actually build yet.
  let candidates: TaskSummary[];
  if (inProgress.length === 1) {
    candidates = inProgress;
  } else {
    const ready = all.filter((t) => t.status === STATUS.todo);
    candidates = ready.length > 0 ? ready : all.filter((t) => t.status === STATUS.backlog);
  }
  candidates = excludeInFlightContainers(candidates, containers, all);
  if (opts.restrictToTree) {
    candidates = candidates.filter((t) => rootAncestorId(t.id, all) === opts.restrictToTree);
  }
  const picked = selectTask(candidates);
  if (!picked) return { done: true, outcome: "no-ready-tasks", note: "no ready tasks" };

  const task = await backlog.view(picked.id);
  // Subtasks share their top-level ancestor's branch — they're internal
  // breakdown of one task, not separate reviewable units — so a bad attempt
  // still isolates per top-level task, not per subtask, no matter how many
  // levels of splitting produced it (see D-004, and rootAncestorId's doc).
  await ensureTaskBranch(repoCwd, baseBranch, rootAncestorId(task.id, all));
  const log = await loadLog(task.id);
  // One cheap `git diff` so the documenter is triggered by evidence rather
  // than running on every task. Computed here, not in resolvePhase, so that
  // function stays pure and testable.
  const docs = await docsRelevant(repoCwd, baseBranch);
  record.taskId = task.id;
  record.attempt = log.attempts;
  record.statusBefore = task.status;
  record.docsRelevant = docs.relevant;

  const phase = resolvePhase(task, log.attempts, { docsRelevant: docs.relevant });
  if (!phase) return { done: false, outcome: "nothing-to-do", note: `${task.id}: nothing to do` };
  record.role = phase.role;
  record.reason = phase.reason;

  console.info(
    `${tag("tick")} ${task.id} role=${roleTag(phase.role)} attempt=${log.attempts} — ${phase.reason}`,
  );
  if (phase.role === "documenter" || phase.role === "reviewer") {
    console.info(`${tag("tick")} documenter signal: ${docs.reason}`);
  }

  if (opts.restrictToTree && !PLANNING_ROLES.has(phase.role)) {
    // Planning is done for this task — stop here rather than starting real
    // execution (or a judgment pass on execution that hasn't happened yet).
    // `done: true` tells the promotion loop's driver there's nothing more
    // for it to do right now.
    return {
      done: true,
      outcome: "planning-complete",
      note: `${task.id}: fully specced for the main loop (next role would be ${phase.role})`,
    };
  }

  const isExecutor = phase.role === "executor";
  if (isExecutor && task.status !== STATUS.inProgress) {
    // The one and only promotion out of ToDo — gated by resolvePhase
    // already having required that status.
    await backlog.setStatus(task.id, STATUS.inProgress);
  }

  const gateConfig = isExecutor ? await loadGateConfig(repoCwd, gateConfigPath) : null;
  let base: Baseline | null = null;
  if (isExecutor) base = await captureBaseline(repoCwd, baseBranch, gateConfig!);

  // Only the two scope-deciding roles have a policy for this, so don't pay
  // for the ancestor lookups on any other role's tick.
  const scope =
    phase.role === "planner" || phase.role === "architect"
      ? await siblingScopeFor(task, all, (id) => backlog.view(id))
      : undefined;
  const prompt = renderPrompt(phase.role, task, scope);
  record.promptChars = prompt.length;

  let result: { text: string; metrics?: AgentMetrics };
  try {
    result = await runAgent({
      role: phase.role,
      taskId: task.id,
      tools: ROLE_TOOLS[phase.role],
      prompt,
      cwd: repoCwd,
    });
  } catch (err) {
    const modelErrors = (log.modelErrors ?? 0) + 1;
    const message = err instanceof Error ? err.message : String(err);
    record.error = message;
    await saveLog({ ...log, modelErrors });
    await backlog.comment(
      task.id,
      phase.role,
      `${phase.role} call failed (model error ${modelErrors}/${MAX_MODEL_ERRORS}): ${message}`,
    );

    // The task didn't fit. That's a statement about the task's size, not
    // about its correctness, and decomposition is the answer to it — so
    // hand it back to the planner instead of spending the remaining
    // retries re-sending a prompt that is still too big. Nested splits (a
    // subtask splitting again) are now supported — see rootAncestorId and
    // Backlog.createChild's `project` propagation — so this isn't restricted
    // to top-level tasks any more. Still excluded: a task that already has
    // subtasks (already a container) or already carries the label, so a
    // split that didn't help can still reach the model-error ceiling.
    const resplittable =
      isContextOverflow(message) &&
      task.subtasks.length === 0 &&
      !task.labels.includes(NEEDS_SPLIT_LABEL);
    if (resplittable) {
      await backlog.addLabel(task.id, NEEDS_SPLIT_LABEL);
      // Back out of In Progress: a container is excluded from selection
      // until its children finish, so leaving it In Progress would make the
      // loop's one-task-in-flight slot permanently unfillable.
      if (task.status === STATUS.inProgress) await backlog.setStatus(task.id, STATUS.backlog);
      return {
        done: false,
        outcome: "needs-split",
        note: `${task.id}: context overflow — labelled ${NEEDS_SPLIT_LABEL} for re-planning`,
      };
    }

    if (modelErrors >= MAX_MODEL_ERRORS) {
      await backlog.setStatus(task.id, STATUS.blocked);
      return {
        done: false,
        outcome: "blocked-model-errors",
        note: `${task.id}: blocked after ${modelErrors} local-model failures (${message})`,
      };
    }
    return {
      done: false,
      outcome: "model-error",
      note: `${task.id}: local-model call failed (${modelErrors}/${MAX_MODEL_ERRORS}), will retry — ${message}`,
    };
  }
  if (log.modelErrors) await saveLog({ ...log, modelErrors: 0 });

  if (result.metrics) {
    record.outputChars = result.metrics.outputChars;
    record.thinkingChars = result.metrics.thinkingChars;
    record.toolCalls = result.metrics.toolCalls;
    record.modelMs = result.metrics.modelMs;
  }
  // The exact text the model produced, kept verbatim. Task fields only ever
  // hold what a parser managed to extract; when a local model ignores a
  // prompt's format, the difference between the two IS the bug report.
  await opts.journal
    ?.transcript(task.id, phase.role, record.ts, prompt, result.text)
    .catch((e) => console.error(colorError(`${tag("journal")} ${task.id} transcript failed:`), e));

  // Non-executor roles write model-authored CONTENT into task fields.
  // Control flow stays deterministic; the content is versioned in git
  // and reviewable before it takes effect.
  switch (phase.role) {
    case "planner": {
      const forcedSplit = task.labels.includes(NEEDS_SPLIT_LABEL);
      const parsed = parsePlannerOutput(result.text);
      // The planner decided to split but its blocks didn't parse. Keep the
      // verbatim proposal — it is usually good work with a bad header — and
      // block this one task. Never rethrow: that reaches main.ts's crash
      // counter and ends the whole unattended run.
      if (parsed.kind === "unparseable") {
        await backlog.comment(
          task.id,
          "planner",
          `proposed a split in an unreadable format; no subtasks were created. Verbatim output:\n${parsed.text}`,
        );
        await backlog.setStatus(task.id, STATUS.blocked);
        return {
          done: false,
          outcome: "split-unparseable",
          note: `${task.id}: blocked — planner requested a split but no subtasks were parseable`,
        };
      }
      if (parsed.kind === "split") {
        // No architect contract yet: don't create children off this
        // proposal at all. Two siblings independently re-deriving a shared
        // interface (the same file, incompatible signatures) is exactly the
        // failure this gate exists to prevent — see hasArchitectContract and
        // the split-alignment decision proposal in wiki/current-work.md.
        // The proposal itself is discarded, not persisted: it's provisional,
        // and the planner re-decides the split next tick with the contract
        // in hand, informed by constraints it didn't have the first time.
        if (!hasArchitectContract(task)) {
          await backlog.comment(
            task.id,
            "planner",
            `proposed a split, deferred pending an architect contract:\n${result.text}`,
          );
          await backlog.addLabel(task.id, "needs-architecture");
          return {
            done: false,
            outcome: "split-pending-architecture",
            note: `${task.id}: split proposed — routing through architect for an interface contract first`,
          };
        }
        // Deliberately no gate here either: splitting is planning, not execution
        // — the same reasoning that lets owner/planner run unapproved today. Each
        // child still needs its own planner pass (blank plan -> planner) before it
        // reaches `ToDo` and becomes eligible for its own executor phase.
        const contract = task.implementationNotes ?? "";
        // Chain each child on its immediate predecessor. Both planner
        // prompts already ask for subtasks "in the order they should be
        // implemented", and architect.md already names which single child
        // creates each shared artifact — that intent was being generated and
        // then discarded, leaving every sibling simultaneously ready and
        // ordered only by ordinal. A linear chain is the strongest ordering
        // derivable without a model, and `readiness.isBlocked` (the loop's
        // only ordering mechanism, see resolvePhase) enforces it for free.
        // Safe against stalling because a subtask self-finalizes to Done on
        // green gates rather than waiting for a human. See D-008.
        const created: string[] = [];
        for (const child of parsed.children) {
          const id = await backlog.createChild(task.id, child.title, project, {
            description: child.description,
            acceptanceCriteria: child.acceptanceCriteria,
            notes: contract,
            dependsOn: created.length > 0 ? [created[created.length - 1]!] : [],
          });
          created.push(id);
        }
        if (forcedSplit) await backlog.removeLabel(task.id, NEEDS_SPLIT_LABEL);

        // Deterministic overlap check, right at the moment the tree changes
        // shape — the earliest point the question is answerable and the
        // cheapest point to act on it. No model: two tasks naming the same
        // path in their own criteria will write that file twice. See D-009.
        const freshAll = await backlog.list(undefined, project);
        const inTree = freshAll.filter((t) => rootAncestorId(t.id, freshAll) === rootAncestorId(task.id, freshAll));
        const collisions = findCollisions(await Promise.all(inTree.map((t) => backlog.view(t.id))), freshAll);
        // Only real code collisions stop the loop. A manifest or an
        // append-only doc claimed by several tasks is normal — it's reported
        // in the comment for context, but blocking on it would stop nearly
        // every split (nine tasks shared one `package.json` on `book`).
        const blocking = collisions.filter((c) => c.blocking);
        if (blocking.length > 0) {
          await backlog.comment(task.id, "overlap", renderCollisions(collisions, inTree.length));
          await backlog.addLabel(task.id, NEEDS_REPLAN_LABEL);
          // Same deterministic-stop treatment as split-refused and
          // alignment-drift: a guaranteed double-write earns a human look.
          // Children stay blocked so none of them can execute.
          await backlog.setStatus(task.id, STATUS.blocked);
          return {
            done: false,
            outcome: "split-overlapping",
            note: `${task.id}: split into ${parsed.children.length} subtask(s) — ${blocking.length} blocking path collision(s), labelled ${NEEDS_REPLAN_LABEL}`,
          };
        }
        return { done: false, outcome: "split", note: `${task.id}: split into ${parsed.children.length} subtask(s)` };
      }
      if (forcedSplit) {
        // Asked to decompose a task that had already proved too big to send,
        // the planner wrote another plan instead. Accepting it would route
        // straight back into the same overflow, and leaving the label on
        // would re-select the planner forever — so stop and let a human look
        // at what is, at this point, a structural problem.
        await backlog.removeLabel(task.id, NEEDS_SPLIT_LABEL);
        await backlog.comment(
          task.id,
          "planner",
          "Asked to split after a context overflow, the planner returned a plan instead. " +
            "Blocking: the task is too large to execute and could not be decomposed automatically.",
        );
        await backlog.setStatus(task.id, STATUS.blocked);
        return { done: false, outcome: "split-refused", note: `${task.id}: blocked — could not be split after context overflow` };
      }
      await backlog.setPlan(task.id, parsed.plan);
      // Spec + plan complete: parked in ToDo, ready for the executor to pick
      // up directly — no human move required (see D-014).
      await backlog.setStatus(task.id, STATUS.todo);
      return { done: false, outcome: "plan-written", note: `${task.id}: plan written — ready for execution` };
    }
    case "architect": {
      // A container (subtasks present) means this call is the post-split
      // alignment pass, not the pre-split contract — see templateFor in
      // prompts.ts, which picks the prompt on the same distinction.
      const isAlignmentCheck = task.subtasks.length > 0;
      const marker = isAlignmentCheck ? "architect (alignment check)" : "architect";
      await backlog.appendNotes(task.id, `**${marker}:** ${result.text}`);
      // One-shot per call site (hasArchitectContract / hasAlignmentCheck):
      // clear the label so a task doesn't loop back into architect forever.
      if (task.labels.includes("needs-architecture")) await backlog.removeLabel(task.id, "needs-architecture");
      if (isAlignmentCheck) {
        const { drift } = parseAlignmentOutput(result.text);
        if (drift) {
          // Block-on-drift was the deliberate choice (see decision proposal
          // in wiki/current-work.md): a human resolves the mismatch before
          // this container can reach reviewer, rather than relying on them
          // to notice it inside a PR summary.
          await backlog.setStatus(task.id, STATUS.blocked);
          return {
            done: false,
            outcome: "alignment-drift-blocked",
            note: `${task.id}: sibling drift detected — blocked for human review`,
          };
        }
      }
      return { done: false, outcome: "notes-appended", note: `${task.id}: ${marker} notes appended` };
    }
    case "researcher":
    case "senior":
      // These two are the other writers of implementationNotes: the field is
      // guidance for the executor, and stays small enough to send every tick
      // precisely because machine bookkeeping goes to comments instead.
      await backlog.appendNotes(task.id, `**${phase.role}:** ${result.text}`);
      return { done: false, outcome: "notes-appended", note: `${task.id}: ${phase.role} notes appended` };
    case "documenter": {
      // No `bash` in this role's allowlist (see ROLE_TOOLS) — its docsWrite/
      // docsEdit tools are the only way it can touch the repo, so the
      // orchestrator commits deterministically rather than trusting a git
      // command from the model, same reasoning as every other bookkeeping
      // step here. The comment doubles as this role's one-shot marker
      // (see `hasDocumented` in phase.ts).
      await backlog.comment(task.id, "documenter", result.text);
      const committed = await commitAll(repoCwd, `docs: update documentation for ${task.id}`);
      return {
        done: false,
        outcome: "docs-updated",
        note: `${task.id}: ${committed ? "documentation updated" : "documentation already current"}`,
      };
    }
    case "critic": {
      // D-013: an independent verdict on the actual diff, never the
      // executor's own account of it (D-001) — this only ever adds a gate
      // on top of gates already green, never bypasses them.
      const { verdict, report } = parseCriticOutput(result.text);
      const isContainer = task.subtasks.length > 0;

      if (verdict === "ship") {
        // One-shot marker (hasCriticVerdict) — never written on CHANGES/
        // RESPEC, so critic runs again once a revision or re-plan lands.
        await backlog.appendNotes(task.id, `**critic:** ${report}`);
        return { done: false, outcome: "critic-shipped", note: `${task.id}: critic shipped` };
      }

      if (isContainer) {
        // No single executor to hand feedback to at this level — same
        // "a human resolves it before reviewer" pattern DRIFT already uses.
        await backlog.comment(task.id, "critic", report);
        await backlog.addLabel(task.id, NEEDS_REPLAN_LABEL);
        await backlog.setStatus(task.id, STATUS.blocked);
        return {
          done: false,
          outcome: "critic-blocked",
          note: `${task.id}: critic blocked the container (${verdict})`,
        };
      }

      if (verdict === "respec") {
        await backlog.comment(task.id, "critic", report);
        await backlog.setPlan(task.id, "");
        // Blank plan alone would already route to planner regardless of
        // status, but resetting status back to ToDo here keeps a re-spec'd
        // task in the same normal queue as any other backlog item once
        // planning finishes — no gate to re-impose anymore (see D-014,
        // supersedes D-002).
        await backlog.setStatus(task.id, STATUS.todo);
        return { done: false, outcome: "critic-respec", note: `${task.id}: critic requested a re-spec` };
      }

      // CHANGES
      log.criticRounds = (log.criticRounds ?? 0) + 1;
      await saveLog(log);
      // Posted as a comment, not notes: the executor's own CONTEXT policy
      // already includes the last few progress-log comments, so this is
      // what actually gets the feedback in front of it next tick.
      await backlog.comment(task.id, "critic", report);
      if (log.criticRounds > MAX_CRITIC_ROUNDS) {
        await backlog.setStatus(task.id, STATUS.blocked);
        await backlog.addLabel(task.id, NEEDS_HUMAN_REVIEW_LABEL);
        return {
          done: false,
          outcome: "critic-changes-exhausted",
          note: `${task.id}: ${log.criticRounds} critic rounds, blocked for human review`,
        };
      }
      await backlog.addLabel(task.id, NEEDS_CHANGES_LABEL);
      return {
        done: false,
        outcome: "critic-changes-requested",
        note: `${task.id}: critic requested changes (round ${log.criticRounds})`,
      };
    }
    case "reviewer": {
      // Not Done: a human still has to open, review, and merge the PR —
      // unless this project opted into D-012's autonomous integration,
      // in which case the rebase-then-regate-then-merge below is what
      // decides Done, never the model's review text.
      await backlog.setFinalSummary(task.id, result.text);
      await backlog.setStatus(task.id, STATUS.review);
      if (!autonomousIntegration || task.parentTaskId) {
        return { done: false, outcome: "reviewed", note: `${task.id}: reviewed — awaiting human PR review` };
      }
      return await integrate(opts, task, rootAncestorId(task.id, all));
    }
    case "owner": {
      const { description, type } = parseOwnerOutput(result.text);
      if (description === "") {
        // Routing would re-select owner forever on an empty description,
        // so fail loudly instead of spinning silently.
        throw new Error(`${task.id}: owner output had no parseable description:\n${result.text}`);
      }
      await backlog.setDescription(task.id, description);
      // Cosmetic and optional — never worth failing a tick over, so an
      // unrecognised type simply arrives here as null (see parseOwnerOutput).
      if (type && !task.type) await backlog.setType(task.id, type);
      return {
        done: false,
        outcome: "description-written",
        note: `${task.id}: owner wrote description${type ? ` (type: ${type})` : ""}`,
      };
    }
    case "criteria": {
      const { acceptanceCriteria, definitionOfDone } = parseCriteriaOutput(result.text);
      if (acceptanceCriteria.length === 0) {
        // Same reasoning as the owner case: an empty AC list is the one
        // outcome routing cannot recover from on its own.
        throw new Error(
          `${task.id}: criteria output had no parseable acceptance criteria:\n${result.text}`,
        );
      }
      await backlog.setAcceptanceCriteria(task.id, acceptanceCriteria);
      // `addDefinitionOfDone` appends (Backlog.md has no replace-all flag for
      // DoD), which is safe only because this phase runs solely on a task
      // whose criteria are still empty.
      if (task.definitionOfDone.length === 0) {
        await backlog.addDefinitionOfDone(task.id, definitionOfDone);
      }
      return {
        done: false,
        outcome: "criteria-written",
        note: `${task.id}: criteria wrote ${acceptanceCriteria.length} AC, ${definitionOfDone.length} DoD item(s)`,
      };
    }
  }

  // Executor: verdict comes from the machine, never from result.text.
  const gates = await runGates(repoCwd, base!, gateConfig!, baseBranch);
  record.gateFailures = gates.failures;
  record.testsPassing = gates.testsPassing;
  log.attempts += 1;
  log.signatures.push(gates.signature);
  await saveLog(log);

  if (gates.ok) {
    // Gates are the only verdict that counts, so a green run is treated as
    // every criterion being met — without this, acDone in phase.ts never
    // becomes true and the task can never reach the reviewer phase. Status
    // stays In Progress: the reviewer phase (next tick) is what moves it
    // to Review, once it has actually written a summary.
    for (const ac of task.acceptanceCriteria) {
      if (!ac.checked) await backlog.checkAc(task.id, ac.index);
    }
    // Same reasoning applied to the Definition of Done: the gates are the
    // verdict (D-001), so a green run means the standing bar was cleared.
    // DoD is context for the executor and reviewer, never a routing input —
    // `acDone` in phase.ts stays acceptance-criteria only.
    for (const item of task.definitionOfDone) {
      if (!item.checked) await backlog.checkDod(task.id, item.index);
    }
    // D-013: a critic-requested revision that now passes gates clears the
    // flag that routed it back here, so the next tick goes to critic for a
    // fresh verdict rather than looping back to executor again.
    if (task.labels.includes(NEEDS_CHANGES_LABEL)) await backlog.removeLabel(task.id, NEEDS_CHANGES_LABEL);
    if (task.parentTaskId) {
      // A subtask doesn't get its own PR review — it finalizes here, and the
      // parent's single reviewer pass runs once every subtask is Done.
      await backlog.setStatus(task.id, STATUS.done);
      return { done: false, outcome: "subtask-done", note: `${task.id}: subtask complete` };
    }
    return { done: false, outcome: "gates-green", note: `${task.id}: gates green` };
  }

  // Progress log, not guidance: a failure record is evidence for the senior
  // role and for a human reading back, and would otherwise accumulate in
  // implementationNotes until the executor's own prompt stopped fitting.
  await backlog.comment(
    task.id,
    "executor",
    `attempt ${log.attempts} failed: ${gates.failures.join(", ")}`,
  );

  if (log.attempts >= MAX_ATTEMPTS || isStuck(log.signatures)) {
    // Nothing to revert: the failed attempts are commits on this task's
    // own branch, left in place for a human to inspect.
    await backlog.setStatus(task.id, STATUS.blocked);
    return {
      done: false,
      outcome: "blocked-attempts",
      note: `${task.id}: blocked after ${log.attempts} attempts (${gates.failures.join(", ")})`,
    };
  }

  return {
    done: false,
    outcome: "gates-failed",
    note: `${task.id}: retrying: ${gates.failures.join(", ")}`,
  };
}

/**
 * D-012: the model-free half of autonomous integration, run once a
 * top-level task has passed review with `autonomousIntegration` set.
 * "Gates were green before rebase" says nothing about after — rebasing
 * onto a `baseBranch` that moved since the task's branch was cut is
 * exactly the shape of the cross-task collision that motivated this
 * (see wiki/decisions.md D-011): a real compile+test run is the check
 * that matters here, not a static path guess. Never force-resolves a
 * conflict or a broken rebase — either always rewinds back to the task
 * branch's original tip and blocks for a human, exactly as an executor
 * attempt does today (`STATUS.blocked`), just with a distinct label so
 * it's clear this failed at integration, not implementation.
 */
async function integrate(opts: TickOptions, task: Task, rootId: string): Promise<TickResult> {
  const { backlog, repoCwd, baseBranch, gateConfigPath } = opts;
  const branch = branchNameFor(rootId);

  await backlog.comment(task.id, "bakloop", `autonomous integration: rebasing ${branch} onto ${baseBranch}`);
  const { stdout: savedTip } = await git(repoCwd, ["rev-parse", branch]);

  await git(repoCwd, ["checkout", branch]);
  const rebased = await git(repoCwd, ["rebase", baseBranch]).then(
    () => true,
    () => false,
  );
  if (!rebased) {
    await git(repoCwd, ["rebase", "--abort"]).catch(() => {});
    await backlog.comment(
      task.id,
      "bakloop",
      `autonomous integration: rebase conflict against ${baseBranch}, branch left at ${savedTip.trim()}`,
    );
    await backlog.setStatus(task.id, STATUS.blocked);
    await backlog.addLabel(task.id, NEEDS_MANUAL_MERGE_LABEL);
    return {
      done: false,
      outcome: "integration-conflict",
      note: `${task.id}: rebase conflict integrating onto ${baseBranch}`,
    };
  }

  const gateConfig = await loadGateConfig(repoCwd, gateConfigPath);
  const base = await captureBaseline(repoCwd, baseBranch, gateConfig);
  const gates = await runGates(repoCwd, base, gateConfig, baseBranch);
  if (!gates.ok) {
    await git(repoCwd, ["reset", "--hard", savedTip.trim()]);
    await backlog.comment(
      task.id,
      "bakloop",
      `autonomous integration: gates failed after rebase onto ${baseBranch} (${gates.failures.join(", ")}); rebase undone, branch reset to ${savedTip.trim()}`,
    );
    await backlog.setStatus(task.id, STATUS.blocked);
    await backlog.addLabel(task.id, NEEDS_MANUAL_MERGE_LABEL);
    return {
      done: false,
      outcome: "integration-gate-failure",
      note: `${task.id}: gates failed after rebase onto ${baseBranch} (${gates.failures.join(", ")})`,
    };
  }

  await git(repoCwd, ["checkout", baseBranch]);
  await git(repoCwd, ["merge", "--squash", branch]);
  await git(repoCwd, ["commit", "-m", `${task.id}: ${task.title}`]);
  const { stdout: mergedSha } = await git(repoCwd, ["rev-parse", "HEAD"]);
  await backlog.comment(
    task.id,
    "bakloop",
    `autonomous integration: squash-merged ${branch} onto ${baseBranch} as ${mergedSha.trim()}`,
  );
  await backlog.setStatus(task.id, STATUS.done);
  return {
    done: false,
    outcome: "integrated",
    note: `${task.id}: integrated onto ${baseBranch} as ${mergedSha.trim()}`,
  };
}
