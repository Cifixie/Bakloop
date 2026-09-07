import { Backlog } from "./backlog.js";
import { ensureTaskBranch } from "./branch.js";
import { captureBaseline, isStuck, loadGateConfig, runGates, type Baseline } from "./gates.js";
import { resolvePhase, selectTask } from "./phase.js";
import { parseOwnerOutput } from "./spec.js";
import { ROLE_TOOLS, STATUS, type Role, type Task } from "./types.js";

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

  // Hard invariant, scoped to this project. If this ever trips, stop and report — do not continue.
  const inProgress = await backlog.list(STATUS.inProgress, project);
  if (inProgress.length > 1) {
    throw new Error(
      `Invariant violated: ${inProgress.length} tasks In Progress in project "${project}" ` +
        `(${inProgress.map((t) => t.id).join(", ")}). Agents must run sequentially.`,
    );
  }

  const candidates =
    inProgress.length === 1 ? inProgress : await backlog.list(STATUS.todo, project);
  const picked = selectTask(candidates);
  if (!picked) return { done: true, note: "no ready tasks" };

  const task = await backlog.view(picked.id);
  // Every task gets its own branch: isolates a bad attempt from the next
  // task and gives the human a set of branches to review, not one shared
  // working tree of commingled changes.
  await ensureTaskBranch(repoCwd, baseBranch, task.id);
  const log = await loadLog(task.id);
  const phase = resolvePhase(task, log.attempts);
  if (!phase) return { done: false, note: `${task.id}: nothing to do` };

  console.info(
    `[tick] ${task.id} role=${phase.role} attempt=${log.attempts} — ${phase.reason}`,
  );

  if (task.status === STATUS.todo) {
    await backlog.setStatus(task.id, STATUS.inProgress);
  }

  const isExecutor = phase.role === "executor";
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
    case "planner":
      await backlog.setPlan(task.id, result.text);
      return { done: false, note: "plan written" };
    case "architect":
    case "researcher":
    case "senior":
      await backlog.appendNotes(task.id, `**${phase.role}:** ${result.text}`);
      return { done: false, note: `${phase.role} notes appended` };
    case "reviewer":
      await backlog.setFinalSummary(task.id, result.text);
      await backlog.setStatus(task.id, STATUS.done);
      return { done: false, note: "reviewed and closed" };
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
    // becomes true and the task can never reach the reviewer phase.
    for (const ac of task.acceptanceCriteria) {
      if (!ac.checked) await backlog.checkAc(task.id, ac.index);
    }
    await backlog.setStatus(task.id, STATUS.review);
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
