import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAgent } from "./agent.js";
import { Backlog } from "./backlog.js";
import { git } from "./branch.js";
import { error as colorError, tag, warn as colorWarn } from "./colors.js";
import { backlogDir, loadProjects, stateDir } from "./config.js";
import { createJournal } from "./journal.js";
import { createLogStore } from "./log.js";
import { renderPrompt, type SiblingScope } from "./prompts.js";
import { rootAncestorId, tick } from "./tick.js";
import type { Role, Task } from "./types.js";

const run = promisify(execFile);

/** Safety cap on the plan-mode loop below — real progress always stops well before this. */
const MAX_PLAN_TICKS = 40;

/**
 * `tsx src/promote-draft.ts [draft-id] [project]` — the only path from a
 * raw draft (`src/create-draft.ts`) to a real, fully spec'd task tree.
 *
 * Promotes the draft immediately, then drives the resulting task through
 * bakloop's own plan-mode roles (owner -> criteria -> researcher/architect
 * -> planner, including any split) exactly as the main tick loop would,
 * scoped to just this task's tree and never advancing into execution. The
 * verbatim draft text is injected into every one of those ticks as extra
 * context, not just used once to write a description — so a split decision,
 * in particular, is made with the human's full original ask in hand, not a
 * summary of a summary. By the time this returns, every task in the tree is
 * either planned or (if split) has spec'd children — ready for a human to
 * read in Backlog.md before the main loop ever touches it.
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

  const backlog = new Backlog(backlogDir());
  const before = new Set((await backlog.list()).map((t) => t.id));
  await cli(["draft", "promote", draftId]);
  const created = (await backlog.list()).find((t) => !before.has(t.id));
  if (!created) throw new Error("Could not determine the new task id after promotion.");

  // Force the owner phase to run next, on the real task — the verbatim
  // draft reaches it (and every later planning role) as extra context via
  // renderWithDraft below, not by pre-seeding this field.
  await backlog.setDescription(created.id, "");
  if (labelProject) await cli(["task", "edit", created.id, "--remove-label", `project:${labelProject}`]);

  console.info(`Promoted ${draftId} -> ${created.id}, project="${project}". Running the plan-mode loop...`);

  const draftText = draft.description;
  const renderWithDraft = (role: Role, task: Task, scope?: SiblingScope): string => {
    const base = renderPrompt(role, task, scope);
    return draftText
      ? `${base}\n\n## Original request (verbatim — do not summarize further)\n\n${draftText}`
      : base;
  };

  const { loadLog, saveLog } = createLogStore(stateDir(project));
  const journal = createJournal(stateDir(project), {
    transcripts: process.env.BAKLOOP_NO_TRANSCRIPTS !== "1",
  });
  const gateConfigPath = join(stateDir(project), "gates.json");

  try {
    for (let i = 0; i < MAX_PLAN_TICKS; i++) {
      const result = await tick({
        backlog,
        repoCwd: entry.path,
        project,
        baseBranch: entry.baseBranch,
        gateConfigPath,
        runAgent,
        loadLog,
        saveLog,
        renderPrompt: renderWithDraft,
        journal,
        restrictToTree: created.id,
      });
      console.info(`${tag("plan")} ${result.note}`);
      if (result.done) break;
      if (i === MAX_PLAN_TICKS - 1) {
        console.warn(
          colorWarn(
            `${tag("plan")} hit the ${MAX_PLAN_TICKS}-tick safety cap without finishing — check ${created.id}'s tree by hand.`,
          ),
        );
      }
    }
  } finally {
    journal.close();
    // Leave the repo on its base branch, not mid-task, for the human to look at.
    await git(entry.path, ["checkout", entry.baseBranch]).catch(() => {});
  }

  await printTreeSummary(backlog, project, created.id);
}

async function printTreeSummary(backlog: Backlog, project: string, rootId: string): Promise<void> {
  const all = await backlog.list(undefined, project);
  const inTree = all.filter((t) => rootAncestorId(t.id, all) === rootId).sort((a, b) => a.ordinal - b.ordinal);

  console.info(`\n--- ${rootId}'s tree, ready for review ---`);
  for (const t of inTree) {
    const full = await backlog.view(t.id);
    const spec =
      full.subtasks.length > 0
        ? `split into ${full.subtasks.length} subtask(s)`
        : full.implementationPlan
          ? "plan written"
          : "NOT planned";
    console.info(`  ${t.id} [${t.status}] ${spec}${t.labels.length ? ` (${t.labels.join(", ")})` : ""} — ${t.title}`);
  }
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

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
