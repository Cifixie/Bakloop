import { Backlog } from "./backlog.js";
import { ensureTaskBranch } from "./branch.js";
import { captureBaseline, isStuck, loadGateConfig, runGates, type Baseline } from "./gates.js";
import { APPROVED_LABEL, resolvePhase, selectTask } from "./phase.js";
import { parseOwnerOutput, parsePlannerOutput } from "./spec.js";
import { ROLE_TOOLS, STATUS, type Role, type Task, type TaskSummary } from "./types.js";

/** Attempt bookkeeping. Persisted to disk, not held in memory. */
export interface AttemptLog {
  taskId: string;
  attempts: number;
  signatures: string[];
}

export interface RunAgent {
  /** Wire to pi-agent-core. Tools MUST be restricted to `tools`. */
  (input: {
    role: Role;
    tools: readonly string[];
    prompt: string;
    cwd: string;
  }): Promise<{ text: string }>;
}

const MAX_ATTEMPTS = 4;

/** Ids of tasks that have at least one subtask, derived from a full project listing. */
function containerIds(all: TaskSummary[]): Set<string> {
  return new Set(all.filter((t) => t.parentTaskId).map((t) => t.parentTaskId!));
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

/**
 * One tick = one model call. No parallelism, no sub-agents, nothing held
 * in memory between ticks: all state lives in the backlog files, so the
 * process can die on tick 400 and resume from git.
 */
export async function tick(opts: {
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
  renderPrompt: (role: Role, task: Task) => string;
}): Promise<{ done: boolean; note: string }> {
  const { backlog, repoCwd, project, baseBranch, gateConfigPath, runAgent, loadLog, saveLog, renderPrompt } = opts;

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
      return { done: false, note: `${t.id}: blocked — a subtask is blocked` };
    }
  }

  // Approved execution work always comes first; backlog spec/plan work is
  // filler that keeps the Waiting-for-Approval queue stocked whenever
  // there's nothing greenlit to actually build yet.
  let candidates: TaskSummary[];
  if (inProgress.length === 1) {
    candidates = inProgress;
  } else {
    const rfi = all.filter((t) => t.status === STATUS.waitingForApproval);
    const approved = rfi.filter((t) => t.labels.includes(APPROVED_LABEL));
    candidates = approved.length > 0 ? approved : all.filter((t) => t.status === STATUS.backlog);
  }
  candidates = excludeInFlightContainers(candidates, containers, all);
  const picked = selectTask(candidates);
  if (!picked) return { done: true, note: "no ready tasks" };

  const task = await backlog.view(picked.id);
  // Subtasks share their parent's branch — they're internal breakdown of one
  // task, not separate reviewable units — so a bad attempt still isolates
  // per top-level task, just not per subtask.
  await ensureTaskBranch(repoCwd, baseBranch, task.parentTaskId ?? task.id);
  const log = await loadLog(task.id);
  const phase = resolvePhase(task, log.attempts);
  if (!phase) return { done: false, note: `${task.id}: nothing to do` };

  console.info(
    `[tick] ${task.id} role=${phase.role} attempt=${log.attempts} — ${phase.reason}`,
  );

  const isExecutor = phase.role === "executor";
  if (isExecutor && task.status !== STATUS.inProgress) {
    // The one and only promotion out of Waiting for Approval — gated
    // by resolvePhase already having required the approved label.
    await backlog.setStatus(task.id, STATUS.inProgress);
  }

  const gateConfig = isExecutor ? await loadGateConfig(repoCwd, gateConfigPath) : null;
  let base: Baseline | null = null;
  if (isExecutor) base = await captureBaseline(repoCwd, baseBranch, gateConfig!);

  const result = await runAgent({
    role: phase.role,
    tools: ROLE_TOOLS[phase.role],
    prompt: renderPrompt(phase.role, task),
    cwd: repoCwd,
  });

  // Non-executor roles write model-authored CONTENT into task fields.
  // Control flow stays deterministic; the content is versioned in git
  // and reviewable before it takes effect.
  switch (phase.role) {
    case "planner": {
      const parsed = parsePlannerOutput(result.text);
      if (parsed.kind === "split") {
        // Deliberately no approval gate here: splitting is planning, not
        // execution — the same reasoning that lets owner/planner run
        // unapproved today. Each child still needs its own `approved`
        // label before its own executor phase can start.
        for (const child of parsed.children) {
          await backlog.createChild(task.id, child.title, {
            description: child.description,
            acceptanceCriteria: child.acceptanceCriteria,
          });
        }
        return { done: false, note: `${task.id}: split into ${parsed.children.length} subtask(s)` };
      }
      await backlog.setPlan(task.id, parsed.plan);
      // Spec + plan complete: parked here until a human adds the approved label.
      await backlog.setStatus(task.id, STATUS.waitingForApproval);
      return { done: false, note: "plan written — waiting for approval" };
    }
    case "architect":
    case "researcher":
    case "senior":
      await backlog.appendNotes(task.id, `**${phase.role}:** ${result.text}`);
      return { done: false, note: `${phase.role} notes appended` };
    case "reviewer":
      // Not Done: a human still has to open, review, and merge the PR.
      // Done is a fact only they (or a future GitHub sync) can assert.
      await backlog.setFinalSummary(task.id, result.text);
      await backlog.setStatus(task.id, STATUS.review);
      return { done: false, note: "reviewed — awaiting human PR review" };
    case "owner": {
      const { description, acceptanceCriteria } = parseOwnerOutput(result.text);
      await backlog.setDescription(task.id, description);
      if (acceptanceCriteria.length === 0) {
        // Nothing parseable: routing would just re-select owner forever on
        // an empty AC list, so fail loudly instead of spinning silently.
        throw new Error(
          `${task.id}: owner output had no parseable acceptance criteria:\n${result.text}`,
        );
      }
      await backlog.setAcceptanceCriteria(task.id, acceptanceCriteria);
      return { done: false, note: "owner refined spec" };
    }
  }

  // Executor: verdict comes from the machine, never from result.text.
  const gates = await runGates(repoCwd, base!, gateConfig!, baseBranch);
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
    if (task.parentTaskId) {
      // A subtask doesn't get its own PR review — it finalizes here, and the
      // parent's single reviewer pass runs once every subtask is Done.
      await backlog.setStatus(task.id, STATUS.done);
      return { done: false, note: "subtask complete" };
    }
    return { done: false, note: "gates green" };
  }

  await backlog.appendNotes(
    task.id,
    `attempt ${log.attempts} failed: ${gates.failures.join(", ")}`,
  );

  if (log.attempts >= MAX_ATTEMPTS || isStuck(log.signatures)) {
    // Nothing to revert: the failed attempts are commits on this task's
    // own branch, left in place for a human to inspect.
    await backlog.setStatus(task.id, STATUS.blocked);
    return {
      done: false,
      note: `blocked after ${log.attempts} attempts (${gates.failures.join(", ")})`,
    };
  }

  return { done: false, note: `retrying: ${gates.failures.join(", ")}` };
}
