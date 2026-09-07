import { STATUS, type Role, type Task } from "./types.js";

export interface Phase {
  role: Role;
  /** Logged on every tick so you can audit routing without a model. */
  reason: string;
}

const blank = (s: string | null): boolean => s === null || s.trim() === "";

/**
 * Routing is DERIVED from which fields are empty. It is never chosen by
 * a model: it is the one decision with no verification signal, so a bad
 * choice corrupts the loop silently instead of failing a task loudly.
 */
export function resolvePhase(task: Task, attempts: number): Phase | null {
  if (task.status === STATUS.done || task.status === STATUS.blocked) {
    return null;
  }

  if (task.readiness.isBlocked) {
    return null; // dependencies are the only ordering mechanism
  }

  if (blank(task.description) || task.acceptanceCriteria.length === 0) {
    return { role: "owner", reason: "no description or acceptance criteria" };
  }

  // Researcher is triggered by an explicit marker, never run "constantly":
  // unbounded background research is a context sink with nothing to attach to.
  if (task.labels.includes("needs-research")) {
    return { role: "researcher", reason: "needs-research label present" };
  }

  if (task.labels.includes("needs-architecture")) {
    return { role: "architect", reason: "needs-architecture label present" };
  }

  if (blank(task.implementationPlan)) {
    return { role: "planner", reason: "no implementation plan" };
  }

  // Senior is gated behind repeated machine failure, not opinion.
  if (attempts >= 2) {
    return { role: "senior", reason: `${attempts} failed attempts` };
  }

  const acDone =
    task.acceptanceCriteriaCount > 0 &&
    task.acceptanceCriteriaCompleted === task.acceptanceCriteriaCount;

  if (!acDone) {
    return { role: "executor", reason: "acceptance criteria incomplete" };
  }

  if (blank(task.finalSummary)) {
    return { role: "reviewer", reason: "criteria met, awaiting review" };
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
