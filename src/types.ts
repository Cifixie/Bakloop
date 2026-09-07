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
  todo: "To Do",
  inProgress: "In Progress",
  review: "Review",
  blocked: "Blocked",
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
