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
  const project = process.env.BAKLOOP_PROJECT ?? process.argv[2] ?? resolveProjectKey(cwd, projects);
  if (!project) {
    throw new Error(
      `No project registered for ${cwd}. Pass a project key ("pnpm start <key>"), set ` +
        `BAKLOOP_PROJECT, or run "tsx src/register-project.ts <key> [path]" first — there ` +
        `is no default project.`,
    );
  }
  const entry = projects[project];
  if (!entry) throw new Error(`BAKLOOP_PROJECT="${project}" is not a registered project.`);
  const { path: repoCwd, baseBranch } = entry;

  const backlog = new Backlog(backlogDir());
  const { loadLog, saveLog } = createLogStore(stateDir(project));
  const gateConfigPath = join(stateDir(project), "gates.json");

  // Ctrl+C (or a `kill`) sets this instead of tearing the process down mid-tick:
  // the in-flight tick finishes — commits, gate results, and attempt log all
  // land — and the loop exits cleanly on the next iteration boundary.
  let stopRequested = false;
  const requestStop = () => {
    if (stopRequested) {
      // Already asked once and it's still running a tick — a second signal means "now".
      process.exit(130);
    }
    stopRequested = true;
    console.info("[main] stopping after the current tick finishes (press again to force-quit)");
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

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
      if (result.done || stopRequested) break;
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    // Leave the working tree on the base branch, not mid-task, between runs.
    await run("git", ["checkout", baseBranch], { cwd: repoCwd }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
