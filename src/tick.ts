import { Backlog } from "./backlog.js";
import { commitAll, ensureTaskBranch } from "./branch.js";
import {
  captureBaseline,
  docsRelevant,
  isStuck,
  loadGateConfig,
  runGates,
  type Baseline,
} from "./gates.js";
import type { Journal, TickOutcome, TickRecord } from "./journal.js";
import { APPROVED_LABEL, NEEDS_SPLIT_LABEL, resolvePhase, selectTask } from "./phase.js";
import { parseCriteriaOutput, parseOwnerOutput, parsePlannerOutput } from "./spec.js";
import { ROLE_TOOLS, STATUS, type Role, type Task, type TaskSummary } from "./types.js";

/** Attempt bookkeeping. Persisted to disk, not held in memory. */
export interface AttemptLog {
  taskId: string;
  attempts: number;
  signatures: string[];
  /** Consecutive model-call failures (transport/OOM/context-overflow), reset on any success. */
  modelErrors?: number;
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
  renderPrompt: (role: Role, task: Task) => string;
  /** Optional: omit to run without recording anything (tests, one-off scripts). */
  journal?: Journal;
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
    throw err;
  } finally {
    record.tickMs = Date.now() - startedAt;
    // Never let bookkeeping take down a run that otherwise worked.
    await opts.journal?.append(record).catch((e) => console.error("[journal] append failed:", e));
  }
}

async function runTick(opts: TickOptions, record: TickRecord): Promise<TickResult> {
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
      return { done: false, outcome: "container-blocked", note: `${t.id}: blocked — a subtask is blocked` };
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
  if (!picked) return { done: true, outcome: "no-ready-tasks", note: "no ready tasks" };

  const task = await backlog.view(picked.id);
  // Subtasks share their parent's branch — they're internal breakdown of one
  // task, not separate reviewable units — so a bad attempt still isolates
  // per top-level task, just not per subtask.
  await ensureTaskBranch(repoCwd, baseBranch, task.parentTaskId ?? task.id);
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
    `[tick] ${task.id} role=${phase.role} attempt=${log.attempts} — ${phase.reason}`,
  );
  if (phase.role === "documenter" || phase.role === "reviewer") {
    console.info(`[tick] documenter signal: ${docs.reason}`);
  }

  const isExecutor = phase.role === "executor";
  if (isExecutor && task.status !== STATUS.inProgress) {
    // The one and only promotion out of Waiting for Approval — gated
    // by resolvePhase already having required the approved label.
    await backlog.setStatus(task.id, STATUS.inProgress);
  }

  const gateConfig = isExecutor ? await loadGateConfig(repoCwd, gateConfigPath) : null;
  let base: Baseline | null = null;
  if (isExecutor) base = await captureBaseline(repoCwd, baseBranch, gateConfig!);

  const prompt = renderPrompt(phase.role, task);
  record.promptChars = prompt.length;

  let result: { text: string; metrics?: AgentMetrics };
  try {
    result = await runAgent({
      role: phase.role,
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
    // retries re-sending a prompt that is still too big. Excluded: subtasks
    // (splitting one again is the unbuilt nested-splits case, see
    // wiki/gotchas.md) and tasks already carrying the label, so a split
    // that didn't help can still reach the model-error ceiling.
    const resplittable =
      isContextOverflow(message) &&
      !task.parentTaskId &&
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
    .catch((e) => console.error("[journal] transcript failed:", e));

  // Non-executor roles write model-authored CONTENT into task fields.
  // Control flow stays deterministic; the content is versioned in git
  // and reviewable before it takes effect.
  switch (phase.role) {
    case "planner": {
      const forcedSplit = task.labels.includes(NEEDS_SPLIT_LABEL);
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
        if (forcedSplit) await backlog.removeLabel(task.id, NEEDS_SPLIT_LABEL);
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
      // Spec + plan complete: parked here until a human adds the approved label.
      await backlog.setStatus(task.id, STATUS.waitingForApproval);
      return { done: false, outcome: "plan-written", note: "plan written — waiting for approval" };
    }
    case "architect":
    case "researcher":
    case "senior":
      // These three are the ONLY writers of implementationNotes: the field is
      // guidance for the executor, and stays small enough to send every tick
      // precisely because machine bookkeeping goes to comments instead.
      await backlog.appendNotes(task.id, `**${phase.role}:** ${result.text}`);
      return { done: false, outcome: "notes-appended", note: `${phase.role} notes appended` };
    case "documenter": {
      // No `bash` in this role's allowlist (see ROLE_TOOLS) — its docsWrite/
      // docsEdit tools are the only way it can touch the repo, so the
      // orchestrator commits deterministically rather than trusting a git
      // command from the model, same reasoning as every other bookkeeping
      // step here. The comment doubles as this role's one-shot marker
      // (see `hasDocumented` in phase.ts).
      await backlog.comment(task.id, "documenter", result.text);
      const committed = await commitAll(repoCwd, `docs: update documentation for ${task.id}`);
      return { done: false, outcome: "docs-updated", note: committed ? "documentation updated" : "documentation already current" };
    }
    case "reviewer":
      // Not Done: a human still has to open, review, and merge the PR.
      // Done is a fact only they (or a future GitHub sync) can assert.
      await backlog.setFinalSummary(task.id, result.text);
      await backlog.setStatus(task.id, STATUS.review);
      return { done: false, outcome: "reviewed", note: "reviewed — awaiting human PR review" };
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
      return { done: false, outcome: "description-written", note: `owner wrote description${type ? ` (type: ${type})` : ""}` };
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
        note: `criteria wrote ${acceptanceCriteria.length} AC, ${definitionOfDone.length} DoD item(s)`,
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
    if (task.parentTaskId) {
      // A subtask doesn't get its own PR review — it finalizes here, and the
      // parent's single reviewer pass runs once every subtask is Done.
      await backlog.setStatus(task.id, STATUS.done);
      return { done: false, outcome: "subtask-done", note: "subtask complete" };
    }
    return { done: false, outcome: "gates-green", note: "gates green" };
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
      note: `blocked after ${log.attempts} attempts (${gates.failures.join(", ")})`,
    };
  }

  return { done: false, outcome: "gates-failed", note: `retrying: ${gates.failures.join(", ")}` };
}
