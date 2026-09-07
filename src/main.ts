import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAgent } from "./agent.js";
import { Backlog } from "./backlog.js";
import { backlogDir, loadProjects, resolveProjectKey, stateDir } from "./config.js";
import { createLogStore } from "./log.js";
import { renderPrompt } from "./prompts.js";
import { tick } from "./tick.js";

const run = promisify(execFile);

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
  const entry = projects[project];
  if (!entry) throw new Error(`BAKLOOP_PROJECT="${project}" is not a registered project.`);
  const { path: repoCwd, baseBranch } = entry;

  const backlog = new Backlog(backlogDir());
  const { loadLog, saveLog } = createLogStore(stateDir(project));
  const gateConfigPath = join(stateDir(project), "gates.json");

  try {
    for (;;) {
      const result = await tick({
        backlog,
        repoCwd,
        project,
        baseBranch,
        gateConfigPath,
        runAgent,
        loadLog,
        saveLog,
        renderPrompt,
      });
      console.info(`[main] ${result.note}`);
      if (result.done) break;
    }
  } finally {
    // Leave the working tree on the base branch, not mid-task, between runs.
    await run("git", ["checkout", baseBranch], { cwd: repoCwd }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
