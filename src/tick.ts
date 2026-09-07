import { Backlog } from "./backlog.js";
import { captureBaseline, isStuck, runGates, type Baseline } from "./gates.js";
import { resolvePhase, selectTask } from "./phase.js";
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
  runAgent: RunAgent;
  loadLog: (taskId: string) => Promise<AttemptLog>;
  saveLog: (log: AttemptLog) => Promise<void>;
  renderPrompt: (role: Role, task: Task) => string;
}): Promise<{ done: boolean; note: string }> {
  const { backlog, repoCwd, runAgent, loadLog, saveLog, renderPrompt } = opts;

  // Hard invariant. If this ever trips, stop and report — do not continue.
  const inProgress = await backlog.list(STATUS.inProgress);
  if (inProgress.length > 1) {
    throw new Error(
      `Invariant violated: ${inProgress.length} tasks In Progress ` +
        `(${inProgress.map((t) => t.id).join(", ")}). Agents must run sequentially.`,
    );
  }

  const candidates =
    inProgress.length === 1 ? inProgress : await backlog.list(STATUS.todo);
  const picked = selectTask(candidates);
  if (!picked) return { done: true, note: "no ready tasks" };

  const task = await backlog.view(picked.id);
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
  let base: Baseline | null = null;
  if (isExecutor) base = await captureBaseline(repoCwd);

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
    case "owner":
      await backlog.comment(task.id, "owner", result.text);
      return { done: false, note: "owner refined spec" };
  }

  // Executor: verdict comes from the machine, never from result.text.
  const gates = await runGates(repoCwd, base!);
  log.attempts += 1;
  log.signatures.push(gates.signature);
  await saveLog(log);

  if (gates.ok) {
    await backlog.setStatus(task.id, STATUS.review);
    return { done: false, note: "gates green" };
  }

  await backlog.appendNotes(
    task.id,
    `attempt ${log.attempts} failed: ${gates.failures.join(", ")}`,
  );

  if (log.attempts >= MAX_ATTEMPTS || isStuck(log.signatures)) {
    // Revert wholesale so a bad tick cannot contaminate the next task.
    await backlog.setStatus(task.id, STATUS.blocked);
    return {
      done: false,
      note: `blocked after ${log.attempts} attempts (${gates.failures.join(", ")})`,
    };
  }

  return { done: false, note: `retrying: ${gates.failures.join(", ")}` };
}
