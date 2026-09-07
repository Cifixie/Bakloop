import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { runAgent } from "./agent.js";
import { Backlog } from "./backlog.js";
import { backlogDir, loadProjects } from "./config.js";
import { renderPrompt } from "./prompts.js";
import { parseOwnerOutput } from "./spec.js";
import type { Task } from "./types.js";

const run = promisify(execFile);

/**
 * `tsx src/promote-draft.ts [draft-id] [project]` — the only path from a
 * raw draft (`src/create-draft.ts`) to a real task. Runs the same `owner`
 * prompt the tick loop itself uses (`prompts/owner.md`) against the
 * draft's raw text to get a description + acceptance criteria, shows it
 * for review, then lets you also set type/priority before promoting.
 * Reviewed by a human before it becomes real — same reason
 * `src/create-draft.ts` never formats anything itself.
 *
 * `tsx src/promote-draft.ts --all` loops this over every existing draft in
 * one run, one still-interactive review per draft — the per-draft y/N gate
 * isn't skipped, only the need to re-invoke the script for each id.
 */
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
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
        await promoteOne(draftId, undefined, rl);
      }
      return;
    }

    await promoteOne(arg, process.argv[3], rl);
  } finally {
    rl.close();
  }
}

async function listDraftIds(): Promise<string[]> {
  const out = await cli(["draft", "list", "--plain"]);
  return [...out.matchAll(/^\s*(DRAFT-\S+)\s+-/gm)].map((m) => m[1]!);
}

async function promoteOne(
  draftId: string,
  projectArg: string | undefined,
  rl: ReturnType<typeof createInterface>,
): Promise<void> {
  const draft = parseDraftView(await cli(["draft", "view", draftId, "--plain"]));
  if (!draft.title) throw new Error(`Could not read draft "${draftId}".`);

  const projects = await loadProjects();
  const labelProject = draft.labels
    .find((l) => l.startsWith("project:"))
    ?.slice("project:".length);

  let project = projectArg ?? labelProject;
  if (!project || !projects[project]) {
    console.info(`Registered projects: ${Object.keys(projects).join(", ") || "(none)"}`);
    const answer = await rl.question(`Project key${labelProject ? ` [${labelProject}]` : ""}: `);
    project = answer.trim() || labelProject;
  }
  if (!project || !projects[project]) {
    throw new Error(
      `"${project}" is not registered. Run "tsx src/register-project.ts <key> [path]" first.`,
    );
  }
  const entry = projects[project]!;

  console.info(`[owner] drafting description + acceptance criteria for "${draft.title}"...`);
  const prompt = renderPrompt("owner", fakeTask(draftId, draft.title, draft.description));
  const result = await runAgent({
    role: "owner",
    tools: [],
    prompt,
    cwd: entry.path,
  });
  const { description, acceptanceCriteria } = parseOwnerOutput(result.text);

  console.info(`\n--- AI-drafted description ---\n${description}`);
  console.info("\n--- Acceptance criteria ---");
  if (acceptanceCriteria.length === 0) {
    console.info("(none — the tick loop's owner phase will retry this once it's a task)");
  }
  acceptanceCriteria.forEach((ac, i) => console.info(`${i + 1}. ${ac}`));

  const proceed = (await rl.question("\nPromote with this content? [y/N] ")).trim().toLowerCase();
  if (proceed !== "y" && proceed !== "yes") {
    console.info("Left as a draft — nothing changed.");
    return;
  }

  const type = (await rl.question("Type (blank to skip): ")).trim();
  const priority = (await rl.question("Priority (blank to skip): ")).trim();

  const backlog = new Backlog(backlogDir());
  const before = new Set((await backlog.list()).map((t) => t.id));
  await cli(["draft", "promote", draftId]);
  const created = (await backlog.list()).find((t) => !before.has(t.id));
  if (!created) throw new Error("Could not determine the new task id after promotion.");

  const editArgs = ["task", "edit", created.id, "--project", project, "--description", description];
  for (const ac of acceptanceCriteria) editArgs.push("--ac", ac);
  if (type) editArgs.push("--type", type);
  if (priority) editArgs.push("--priority", priority);
  if (labelProject) editArgs.push("--remove-label", `project:${labelProject}`);
  await cli(editArgs);

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
    dependencies: [],
    readiness: { isReady: true, isBlocked: false, blockingDependencies: [], missingDependencies: [] },
    acceptanceCriteria: [],
    implementationPlan: null,
    implementationNotes: rawText || null,
    finalSummary: null,
    comments: [],
    modifiedFiles: [],
    subtasks: [],
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
