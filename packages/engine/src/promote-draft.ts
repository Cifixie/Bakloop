import { join } from "node:path";
import { runAgent } from "./agent.js";
import { Backlog } from "./backlog.js";
import { git } from "./branch.js";
import { error as colorError, tag } from "./colors.js";
import { tasksDbPath, loadProjects, stateDir } from "./config.js";
import { createJournal } from "./journal.js";
import { createLogStore } from "./log.js";
import { renderPrompt } from "./prompts.js";
import { rootAncestorId, tick } from "./tick.js";

/** Safety cap on the plan-mode loop below — real progress always stops well before this. */
const MAX_PLAN_TICKS = 40;

/**
 * `tsx src/promote-draft.ts [project]` — the only path from a raw draft
 * (`src/create-draft.ts`) to a real, fully spec'd task tree.
 *
 * Promotes all drafts for the project immediately, then drives each resulting
 * task through bakloop's own plan-mode roles (owner -> criteria ->
 * researcher/architect -> planner, including any split) exactly as the main
 * tick loop would, scoped to just each task's tree and never advancing into
 * execution. The verbatim draft text is injected into every one of those
 * ticks as extra context, not just used once to write a description — so a
 * split decision, in particular, is made with the human's full original ask
 * in hand, not a summary of a summary. By the time this returns, every task
 * in the tree is either planned or (if split) has spec'd children — ready
 * for a human to review before the main loop ever touches it.
 */
async function main() {
  const project = process.argv[2];
  if (!project) {
    console.error(colorError("usage: tsx src/promote-draft.ts <project>"));
    process.exitCode = 1;
    return;
  }

  const projects = await loadProjects();
  if (!projects[project]) {
    console.error(colorError(`"${project}" is not registered. Run "tsx src/register-project.ts <key> [path]" first.`));
    process.exitCode = 1;
    return;
  }

  const backlog = new Backlog(tasksDbPath());
  const entry = projects[project]!;

  const drafts = backlog.list(project, "Draft");
  if (drafts.length === 0) {
    console.info(`No drafts for "${project}".`);
    return;
  }

  for (const [i, draft] of drafts.entries()) {
    console.info(`\n=== [${i + 1}/${drafts.length}] ${draft.id} ===`);
    await promoteOne(draft.id, project, backlog, entry);
  }
}

async function promoteOne(
  draftId: string,
  project: string,
  backlog: Backlog,
  entry: { path: string; baseBranch: string },
): Promise<void> {
  const task = backlog.view(draftId);
  if (task.status !== "Draft") throw new Error(`Task "${draftId}" is not a draft (status: ${task.status}).`);

  await backlog.setDescription(draftId, "");
  await backlog.setStatus(draftId, "Backlog");

  console.info(`Promoted ${draftId}, project="${project}". Running the plan-mode loop...`);

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
        renderPrompt: (role, task) => {
          const base = renderPrompt(role, task);
          return task.description
            ? `${base}\n\n## Original request (verbatim — do not summarize further)\n\n${task.description}`
            : base;
        },
        journal,
        restrictToTree: draftId,
      });
      console.info(`${tag("plan")} ${result.note}`);
      if (result.done) break;
      if (i === MAX_PLAN_TICKS - 1) {
        console.warn(
          colorError(
            `${tag("plan")} hit the ${MAX_PLAN_TICKS}-tick safety cap without finishing — check ${draftId}'s tree by hand.`,
          ),
        );
      }
    }
  } finally {
    journal.close();
    // Leave the repo on its base branch, not mid-task, for the human to look at.
    await git(entry.path, ["checkout", entry.baseBranch]).catch(() => {});
  }

  await printTreeSummary(backlog, project, draftId);
}

async function printTreeSummary(backlog: Backlog, project: string, rootId: string): Promise<void> {
  const all = backlog.list(undefined, project);
  const inTree = all.filter((t) => rootAncestorId(t.id, all) === rootId).sort((a, b) => a.ordinal - b.ordinal);

  console.info(`\n--- ${rootId}'s tree, ready for review ---`);
  for (const t of inTree) {
    const full = backlog.view(t.id);
    const spec =
      full.subtasks.length > 0
        ? `split into ${full.subtasks.length} subtask(s)`
        : full.implementationPlan
          ? "plan written"
          : "NOT planned";
    console.info(`  ${t.id} [${t.status}] ${spec}${t.labels.length ? ` (${t.labels.join(", ")})` : ""} — ${t.title}`);
  }
}

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
