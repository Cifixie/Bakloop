import { runAgent } from "./agent.js";
import { Backlog } from "./backlog.js";
import { backlogDir, loadProjects, resolveProjectKey, stateDir } from "./config.js";
import { createLogStore } from "./log.js";
import { renderPrompt } from "./prompts.js";
import { tick } from "./tick.js";

async function main() {
  const projects = await loadProjects();
  const cwd = process.env.ORC_REPO_CWD ?? process.cwd();
  const project = process.env.BAKLOOP_PROJECT ?? resolveProjectKey(cwd, projects);
  if (!project) {
    throw new Error(
      `No project registered for ${cwd}. Run ` +
        `"tsx src/register-project.ts <key> [path]" first — there is no default project.`,
    );
  }
  const repoCwd = projects[project] ?? cwd;

  const backlog = new Backlog(backlogDir());
  const { loadLog, saveLog } = createLogStore(stateDir(project));

  for (;;) {
    const result = await tick({ backlog, repoCwd, project, runAgent, loadLog, saveLog, renderPrompt });
    console.info(`[main] ${result.note}`);
    if (result.done) break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
