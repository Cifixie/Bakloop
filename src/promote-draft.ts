import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAgent } from "./agent.js";
import { Backlog } from "./backlog.js";
import { error as colorError, roleTag } from "./colors.js";
import { backlogDir, loadProjects } from "./config.js";
import { renderPrompt } from "./prompts.js";
import { parseCriteriaOutput, parseOwnerOutput } from "./spec.js";
import type { Task } from "./types.js";

const run = promisify(execFile);

/**
 * `tsx src/promote-draft.ts [draft-id] [project]` — the only path from a
 * raw draft (`src/create-draft.ts`) to a real task. Runs the same `owner`
 * and `criteria` prompts the tick loop itself uses to get a description +
 * acceptance criteria, prints them, and promotes fully automatically — no
 * interactive prompts anywhere in this path. Type is whatever `owner`
 * drafted; priority is left unset (a human can set either on the task
 * afterward). The task still lands in `ToDo` and is picked up by the
 * executor on its own next tick — no human step in between (see D-014) —
 * so review, if wanted, has to happen before promotion, not after.
 *
 * `tsx src/promote-draft.ts --all` loops this over every existing draft in
 * one run.
 */
async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.info(await cli(["draft", "list", "--plain"]));
    console.info(
      '\nRe-run as "tsx src/promote-draft.ts <draft-id>" or "tsx src/promote-draft.ts --all".',
    );
    return;
  }

  if (arg === "--all") {
    const draftIds = await listDraftIds();
    if (draftIds.length === 0) {
      console.info("No drafts to promote.");
      return;
    }
    for (const [i, draftId] of draftIds.entries()) {
      console.info(`\n=== [${i + 1}/${draftIds.length}] ${draftId} ===`);
      await promoteOne(draftId, undefined);
    }
    return;
  }

  await promoteOne(arg, process.argv[3]);
}

async function listDraftIds(): Promise<string[]> {
  const out = await cli(["draft", "list", "--plain"]);
  return [...out.matchAll(/^\s*(DRAFT-\S+)\s+-/gm)].map((m) => m[1]!);
}

async function promoteOne(draftId: string, projectArg: string | undefined): Promise<void> {
  const draft = parseDraftView(await cli(["draft", "view", draftId, "--plain"]));
  if (!draft.title) throw new Error(`Could not read draft "${draftId}".`);

  const projects = await loadProjects();
  const labelProject = draft.labels
    .find((l) => l.startsWith("project:"))
    ?.slice("project:".length);

  const project = projectArg ?? labelProject;
  if (!project || !projects[project]) {
    throw new Error(
      project
        ? `"${project}" is not registered. Run "tsx src/register-project.ts <key> [path]" first.`
        : `No project given and draft has no "project:" label. Run as "tsx src/promote-draft.ts ${draftId} <project>".`,
    );
  }
  const entry = projects[project]!;

  const base = fakeTask(draftId, draft.title, draft.description);

  console.info(`${roleTag("owner")} drafting description for "${draft.title}"...`);
  const ownerResult = await runAgent({
    role: "owner",
    taskId: draftId,
    tools: [],
    prompt: renderPrompt("owner", base),
    cwd: entry.path,
  });
  const { description, type: draftedType } = parseOwnerOutput(ownerResult.text);

  // Two calls, not one, for the same reason the tick loop splits these into
  // separate phases: the criteria role must read the description rather than
  // remember having written it (see resolvePhase).
  console.info(`${roleTag("criteria")} drafting acceptance criteria + definition of done...`);
  const criteriaResult = await runAgent({
    role: "criteria",
    taskId: draftId,
    tools: [],
    prompt: renderPrompt("criteria", { ...base, description }),
    cwd: entry.path,
  });
  const { acceptanceCriteria, definitionOfDone } = parseCriteriaOutput(criteriaResult.text);

  console.info(`\n--- AI-drafted description ---\n${description}`);
  console.info("\n--- Acceptance criteria ---");
  if (acceptanceCriteria.length === 0) {
    console.info("(none — the tick loop's criteria phase will retry this once it's a task)");
  }
  acceptanceCriteria.forEach((ac, i) => console.info(`${i + 1}. ${ac}`));
  if (definitionOfDone.length > 0) {
    console.info("\n--- Definition of done ---");
    definitionOfDone.forEach((item) => console.info(`- ${item}`));
  }

  const backlog = new Backlog(backlogDir());
  const before = new Set((await backlog.list()).map((t) => t.id));
  await cli(["draft", "promote", draftId]);
  const created = (await backlog.list()).find((t) => !before.has(t.id));
  if (!created) throw new Error("Could not determine the new task id after promotion.");

  const editArgs = ["task", "edit", created.id, "--project", project, "--description", description];
  for (const ac of acceptanceCriteria) editArgs.push("--ac", ac);
  for (const item of definitionOfDone) editArgs.push("--dod", item);
  if (draftedType) editArgs.push("--type", draftedType);
  if (labelProject) editArgs.push("--remove-label", `project:${labelProject}`);
  await cli(editArgs);

  // The task's `description` is the owner role's rewrite, not the human's
  // original words — preserve the verbatim draft as a comment so nothing is
  // lost if the rewrite paraphrased or dropped something. Comments (not
  // implementationNotes) because every future tick reads notes in full,
  // while comments are pulled as a bounded recent window (see CONTEXT in
  // prompts.ts) — this is a one-time reference, not ongoing guidance.
  if (draft.description) await backlog.comment(created.id, "draft", draft.description);

  console.info(`Promoted ${draftId} -> ${created.id}, project="${project}".`);
}

async function cli(args: string[]): Promise<string> {
  const { stdout } = await run("backlog", args, { cwd: backlogDir(), maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function parseDraftView(text: string): { title: string; description: string; labels: string[] } {
  const title = text.match(/^Task \S+ - (.+)$/m)?.[1]?.trim() ?? "";
  const description =
    text.match(/^Description:\n-+\n([\s\S]*?)\n\nAcceptance Criteria:/m)?.[1]?.trim() ?? "";
  const labels = (text.match(/^Labels:\s*(.*)$/m)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { title, description, labels };
}

/** Minimal stand-in Task so `renderPrompt("owner", ...)` can run outside the tick loop. */
function fakeTask(id: string, title: string, rawText: string): Task {
  return {
    id,
    title,
    status: "Draft",
    priority: null,
    assignees: [],
    labels: [],
    ordinal: 0,
    acceptanceCriteriaCompleted: 0,
    acceptanceCriteriaCount: 0,
    isReady: true,
    parentTaskId: null,
    path: "",
    description: null,
    type: null,
    dependencies: [],
    readiness: { isReady: true, isBlocked: false, blockingDependencies: [], missingDependencies: [] },
    acceptanceCriteria: [],
    definitionOfDone: [],
    implementationPlan: null,
    implementationNotes: rawText || null,
    finalSummary: null,
    comments: [],
    modifiedFiles: [],
    subtasks: [],
  };
}

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
