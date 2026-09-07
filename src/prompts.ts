import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Role, Task } from "./types.js";

const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

const templateCache = new Map<Role, string>();

function loadTemplate(role: Role): string {
  const cached = templateCache.get(role);
  if (cached) return cached;
  const template = readFileSync(`${PROMPTS_DIR}${role}.md`, "utf-8");
  templateCache.set(role, template);
  return template;
}

function formatContext(task: Task): string {
  const sections: string[] = [];

  if (task.description) sections.push(`Description:\n${task.description}`);

  if (task.acceptanceCriteria.length > 0) {
    const list = task.acceptanceCriteria
      .map((ac) => `- [${ac.checked ? "x" : " "}] ${ac.text}`)
      .join("\n");
    sections.push(`Acceptance criteria:\n${list}`);
  }

  if (task.implementationPlan) sections.push(`Implementation plan:\n${task.implementationPlan}`);
  if (task.implementationNotes) sections.push(`Notes so far:\n${task.implementationNotes}`);
  if (task.finalSummary) sections.push(`Final summary:\n${task.finalSummary}`);
  if (task.dependencies.length > 0) sections.push(`Dependencies: ${task.dependencies.join(", ")}`);

  return sections.length > 0 ? sections.join("\n\n") : "(no further context)";
}

/** Loads a role's paragraph template from disk and fills in this task's fields. */
export function renderPrompt(role: Role, task: Task): string {
  const template = loadTemplate(role);
  return template
    .replaceAll("{{id}}", task.id)
    .replaceAll("{{title}}", task.title)
    .replaceAll("{{context}}", formatContext(task));
}
