import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NEEDS_SPLIT_LABEL } from "./phase.js";
import type { Role, Task } from "./types.js";

const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

const templateCache = new Map<string, string>();

function loadTemplate(name: string): string {
  const cached = templateCache.get(name);
  if (cached) return cached;
  const template = readFileSync(`${PROMPTS_DIR}${name}.md`, "utf-8");
  templateCache.set(name, template);
  return template;
}

/**
 * Which template a role's tick actually uses. Normally one per role; the
 * planner is the exception, because a task carrying `needs-split` is being
 * re-planned specifically BECAUSE it didn't fit, and must not be offered the
 * "write a plan instead" branch that `prompts/planner.md` allows.
 */
function templateFor(role: Role, task: Task): string {
  if (role === "planner" && task.labels.includes(NEEDS_SPLIT_LABEL)) return "planner-split";
  // Same distinction tick.ts makes to pick the notes marker: a container
  // (subtasks present) means this architect call is the post-split
  // sibling-alignment pass, not the pre-split interface contract.
  if (role === "architect" && task.subtasks.length > 0) return "architect-alignment";
  // `status: "Draft"` only ever appears on promote-draft's fake stand-in
  // task (see fakeTask in promote-draft.ts) — never a real task in the tick
  // loop. There, "notes" is the whole human (or human+AI) draft, not
  // incremental machine bookkeeping, so it must be preserved, not
  // paraphrased down like prompts/owner.md tells the tick-loop owner to do.
  if (role === "owner" && task.status === "Draft") return "owner-from-draft";
  return role;
}

/**
 * Scope that lives on OTHER tasks in the same split tree. Passed in rather
 * than read from `task`, because `formatContext` has no IO and a Task carries
 * no view of its relatives.
 *
 * This exists because a contract seeded into one task's notes cannot fix
 * duplication across BRANCHES of a tree: when a subtask is itself split, its
 * architect writes a contract knowing nothing about what its aunts and uncles
 * already own, and re-specifies their work verbatim. Observed on `book`:
 * `TASK-1.4.1` duplicated `TASK-1.1` word for word. See D-008.
 */
export interface SiblingScope {
  /**
   * Tasks elsewhere in this tree that already own scope. Titles only — they
   * come free from the project listing `tick.ts` already holds, and a title
   * is enough to recognise "the bucket is already someone else's job."
   */
  owned: { id: string; title: string; status: string }[];
  /** The ancestor chain, root first: the original task this one was carved out of. */
  ancestors: { id: string; title: string; description: string | null }[];
}

/** Which of a task's fields a given role's prompt is allowed to contain. */
interface ContextPolicy {
  description?: boolean;
  acceptanceCriteria?: boolean;
  definitionOfDone?: boolean;
  plan?: boolean;
  /** `implementationNotes` — architect/researcher/senior guidance. */
  notes?: boolean;
  /** How many of the most recent progress-log comments to include; 0 = none. */
  comments?: number;
  finalSummary?: boolean;
  dependencies?: boolean;
  /**
   * Only the two roles that decide scope get this. Deliberately NOT given to
   * the executor: knowing what a sibling owns would invite it to reach into
   * that sibling's files, which is the opposite of the isolation the split
   * exists to create.
   */
  siblingScope?: boolean;
}

/**
 * Context is RATIONED PER ROLE, not handed out whole.
 *
 * Two independent reasons, and both matter:
 *
 * 1. Cost. Every tick is one call to a small local model. Concatenating
 *    every field of a long-running task into every prompt is what pushes a
 *    tick into context overflow, which is bakloop's most common failure mode.
 *
 * 2. Independence. A role that reads another role's account of the work
 *    inherits its framing. `criteria` gets the description and NOTHING else,
 *    precisely so it writes criteria for the outcome rather than restating a
 *    description it just watched itself write. `reviewer` is kept off the
 *    progress log for the same reason — its job is to summarise the change,
 *    not to relay the executor's story about it.
 *
 * `senior` is the one role that gets the failure log in full: repeated
 * machine failure is exactly the evidence it was called in to diagnose.
 */
const CONTEXT: Record<Role, ContextPolicy> = {
  // Sees only the raw capture it is refining (carried in notes by
  // promote-draft's stand-in task) plus dependencies for scope.
  owner: { notes: true, dependencies: true },
  criteria: { description: true },
  // `notes: true` matters for the alignment-check call specifically: it's
  // how the architect sees the contract it wrote before the split, without
  // a live parent lookup. Harmless for the pre-split call, where notes is
  // always still empty.
  architect: { description: true, acceptanceCriteria: true, dependencies: true, notes: true, siblingScope: true },
  researcher: { description: true, acceptanceCriteria: true, dependencies: true },
  planner: {
    description: true,
    acceptanceCriteria: true,
    definitionOfDone: true,
    notes: true,
    dependencies: true,
    siblingScope: true,
  },
  executor: {
    description: true,
    acceptanceCriteria: true,
    definitionOfDone: true,
    plan: true,
    notes: true,
    // Enough to avoid repeating the last failure, not the whole history.
    comments: 3,
    dependencies: true,
  },
  senior: {
    description: true,
    acceptanceCriteria: true,
    plan: true,
    notes: true,
    comments: 10,
  },
  documenter: { description: true, acceptanceCriteria: true, plan: true, notes: true },
  reviewer: {
    description: true,
    acceptanceCriteria: true,
    definitionOfDone: true,
    plan: true,
    notes: true,
    dependencies: true,
  },
};

function checklist(items: { text: string; checked: boolean }[]): string {
  return items.map((i) => `- [${i.checked ? "x" : " "}] ${i.text}`).join("\n");
}

function formatContext(role: Role, task: Task, scope?: SiblingScope): string {
  const policy = CONTEXT[role];
  const sections: string[] = [];

  if (policy.description && task.description) {
    sections.push(`Description:\n${task.description}`);
  }
  if (policy.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    sections.push(`Acceptance criteria:\n${checklist(task.acceptanceCriteria)}`);
  }
  if (policy.definitionOfDone && task.definitionOfDone.length > 0) {
    sections.push(`Definition of done:\n${checklist(task.definitionOfDone)}`);
  }
  if (policy.plan && task.implementationPlan) {
    sections.push(`Implementation plan:\n${task.implementationPlan}`);
  }
  if (policy.notes && task.implementationNotes) {
    sections.push(`Notes so far:\n${task.implementationNotes}`);
  }
  if (policy.comments && task.comments.length > 0) {
    const recent = task.comments.slice(-policy.comments);
    const log = recent.map((c) => `${c.author}: ${c.body}`).join("\n");
    const elided = task.comments.length - recent.length;
    const header = elided > 0 ? `Progress log (most recent ${recent.length}, ${elided} older omitted):` : "Progress log:";
    sections.push(`${header}\n${log}`);
  }
  if (policy.finalSummary && task.finalSummary) {
    sections.push(`Final summary:\n${task.finalSummary}`);
  }
  if (policy.dependencies && task.dependencies.length > 0) {
    sections.push(`Dependencies: ${task.dependencies.join(", ")}`);
  }
  if (policy.siblingScope && scope) {
    // Root first, so the chain reads as a narrowing of the original ask.
    for (const a of scope.ancestors) {
      const body = a.description?.trim();
      sections.push(
        `This task is one piece of ${a.id} ("${a.title}"), whose full scope is:\n${body || "(no description)"}`,
      );
    }
    if (scope.owned.length > 0) {
      const list = scope.owned.map((t) => `- ${t.id} [${t.status}]: ${t.title}`).join("\n");
      sections.push(
        "Already owned by other tasks in this same breakdown — do NOT re-specify, " +
          `re-create, or plan this work; treat it as done or being done elsewhere:\n${list}`,
      );
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : "(no further context)";
}

/**
 * Loads a role's paragraph template from disk and fills in this task's fields.
 *
 * `scope` is optional and only reaches the two roles whose policy asks for it
 * (`planner`, `architect`); callers outside the tick loop — `promote-draft` —
 * simply omit it.
 */
export function renderPrompt(role: Role, task: Task, scope?: SiblingScope): string {
  const template = loadTemplate(templateFor(role, task));
  return template
    .replaceAll("{{id}}", task.id)
    .replaceAll("{{title}}", task.title)
    .replaceAll("{{context}}", formatContext(role, task, scope));
}
