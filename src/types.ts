/**
 * Mirrors Backlog.md `--json` output, schemaVersion 1.
 * Verified against backlog.md v1.51.0. Only fields the orchestrator uses.
 */

export interface AcceptanceCriterion {
  index: number;
  text: string;
  checked: boolean;
}

/** Same shape as an acceptance criterion — Backlog.md's `--dod` list. */
export type DefinitionOfDoneItem = AcceptanceCriterion;

/**
 * The task's message board. bakloop uses it as the append-only PROGRESS LOG:
 * every entry is written by the orchestrator, never by a model directly, and
 * is attributed to the role whose tick produced it. Kept separate from
 * `implementationNotes` on purpose — see `src/prompts.ts` for which roles are
 * allowed to read it.
 */
export interface Comment {
  index: number;
  body: string;
  createdAt: string;
  author: string;
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
  /** One of Backlog.md's configured task types (bug/feature/chore/...); the owner role sets it. */
  type: string | null;
  dependencies: string[];
  readiness: Readiness;
  acceptanceCriteria: AcceptanceCriterion[];
  /** The standing bar this task must clear, written by the `criteria` role alongside the AC. */
  definitionOfDone: DefinitionOfDoneItem[];
  implementationPlan: string | null;
  /**
   * GUIDANCE for the executor, and nothing else. Written only by architect,
   * researcher, and senior. Machine bookkeeping (gate failures, model-call
   * failures) goes to `comments` instead, so this field stays small enough to
   * hand a local model every tick.
   */
  implementationNotes: string | null;
  finalSummary: string | null;
  comments: Comment[];
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

/**
 * Backlog.md's default task types. Mirrors `taskTypes` in the store's
 * config.yml — an owner-proposed type that isn't on this list is dropped
 * rather than passed to the CLI, which would reject it and kill the tick.
 */
export const TASK_TYPES = [
  "bug",
  "feature",
  "enhancement",
  "task",
  "chore",
  "docs",
  "spike",
] as const;

/** Pipeline statuses. Must match backlog/config.yml statuses. */
export const STATUS = {
  /** Raw wishlist: unrefined, or refined but no plan yet. Owner/architect/researcher/planner work here. */
  backlog: "Backlog",
  /** Spec + plan complete; parked here and picked up directly by the executor — no human move required (see D-014). */
  todo: "ToDo",
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
  | "owner"       // -> description + type
  | "criteria"    // -> acceptanceCriteria + definitionOfDone, reads the description ONLY
  | "architect"   // -> notes (constraints), read-only
  | "researcher"  // -> notes (findings), read + fetch
  | "planner"     // -> implementationPlan, or a SPLIT into subtasks
  | "executor"    // -> files
  | "senior"      // -> notes (advice), read-only
  | "documenter"  // -> doc files, only when the diff touches a documented surface
  | "critic"      // -> verdict (SHIP/CHANGES/RESPEC), read-only, gates reviewer (D-013)
  | "reviewer";   // -> finalSummary + new tickets

export type ToolName = "read" | "write" | "edit" | "bash" | "fetch" | "docsWrite" | "docsEdit";

export const ROLE_TOOLS: Record<Role, readonly ToolName[]> = {
  owner: [],
  // Deliberately toolless: giving `criteria` the codebase would let it write
  // criteria describing the implementation it can see rather than the outcome
  // the description asks for. Its whole value is that it reads one field.
  criteria: [],
  architect: ["read"],
  researcher: ["read", "fetch"],
  planner: ["read"],
  executor: ["read", "write", "edit", "bash"],
  senior: ["read"],
  documenter: ["read", "docsWrite", "docsEdit"],
  critic: ["read", "bash"],
  reviewer: ["read", "bash"],
};
