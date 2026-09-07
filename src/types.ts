/**
 * Mirrors Backlog.md `--json` output, schemaVersion 1.
 * Verified against backlog.md v1.51.0. Only fields the orchestrator uses.
 */

export interface AcceptanceCriterion {
  index: number;
  text: string;
  checked: boolean;
}

export interface Readiness {
  isReady: boolean;
  isBlocked: boolean;
  blockingDependencies: string[];
  missingDependencies: string[];
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  assignees: string[];
  labels: string[];
  ordinal: number;
  acceptanceCriteriaCompleted: number;
  acceptanceCriteriaCount: number;
  isReady: boolean;
  /** Set when this task is a subtask created via `--parent`; null for a top-level or container task. */
  parentTaskId: string | null;
}

export interface Task extends TaskSummary {
  path: string;
  description: string | null;
  dependencies: string[];
  readiness: Readiness;
  acceptanceCriteria: AcceptanceCriterion[];
  implementationPlan: string | null;
  implementationNotes: string | null;
  finalSummary: string | null;
  comments: unknown[];
  modifiedFiles: string[];
  /** Non-empty once the planner has split this task; makes it a container, not an executable unit. */
  subtasks: { id: string; title: string }[];
}

export interface TaskListResponse {
  schemaVersion: 1;
  kind: "task-list";
  tasks: TaskSummary[];
}

export interface TaskViewResponse {
  schemaVersion: 1;
  kind: "task-view";
  task: Task;
}

/** Pipeline statuses. Must match backlog/config.yml statuses. */
export const STATUS = {
  /** Raw wishlist: unrefined, or refined but no plan yet. Owner/architect/researcher/planner work here. */
  backlog: "Backlog",
  /** Spec + plan complete; parked until a human adds the `approved` label. */
  waitingForApproval: "Waiting for Approval",
  /** Executor actively running the gate loop. At most one per project. */
  inProgress: "In Progress",
  /** A PR is open. Human-owned from here — the agent never touches it again. */
  review: "Review",
  blocked: "Blocked",
  /** PR approved and merged. Only ever set by a human (or a future GitHub sync), never the agent. */
  done: "Done",
} as const;

/**
 * A role is a phase, not an actor. Each writes one field and holds
 * one tool allowlist. If two roles share both, they are one role.
 */
export type Role =
  | "owner"      // -> description + acceptanceCriteria
  | "architect"  // -> notes (constraints), read-only
  | "researcher" // -> notes (findings), read + fetch
  | "planner"    // -> implementationPlan
  | "executor"   // -> files + notes
  | "senior"     // -> notes (advice), read-only
  | "reviewer";  // -> finalSummary + new tickets

export type ToolName = "read" | "write" | "edit" | "bash" | "fetch";

export const ROLE_TOOLS: Record<Role, readonly ToolName[]> = {
  owner: [],
  architect: ["read"],
  researcher: ["read", "fetch"],
  planner: ["read"],
  executor: ["read", "write", "edit", "bash"],
  senior: ["read"],
  reviewer: ["read", "bash"],
};
