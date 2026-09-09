import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAgent } from "./agent.js";
import { Backlog } from "./backlog.js";
import { error as colorError, tag, warn as colorWarn } from "./colors.js";
import { backlogDir, loadProjects, resolveProjectKey, stateDir } from "./config.js";
import { createJournal } from "./journal.js";
import { createLogStore } from "./log.js";
import { readBatteryState, startCaffeinate } from "./power.js";
import { renderPrompt } from "./prompts.js";
import { tick } from "./tick.js";

const DEFAULT_BATTERY_FLOOR = 20;

/** 0 disables the check. Anything unparsable or out of range falls back to the default. */
function batteryFloorFromEnv(): number {
  const raw = process.env.BAKLOOP_BATTERY_FLOOR;
  if (raw === undefined) return DEFAULT_BATTERY_FLOOR;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    console.warn(
      colorWarn(`${tag("main")} BAKLOOP_BATTERY_FLOOR="${raw}" is not an integer in 0..100, using ${DEFAULT_BATTERY_FLOOR}`),
    );
    return DEFAULT_BATTERY_FLOOR;
  }
  return parsed;
}

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
  const { path: repoCwd, baseBranch, autonomous } = entry;

  if (autonomous) {
    // Best-effort, once per run, not per tick: the only chance an autonomous
    // project's own clone has to see upstream movement before a run of tasks
    // builds on it. Never blocks the run — a stale trunk is "at least
    // somewhat latest" and still better than refusing to start.
    await run("git", ["checkout", baseBranch], { cwd: repoCwd }).catch(() => {});
    await run("git", ["pull", "--rebase"], { cwd: repoCwd }).catch(async (err) => {
      await run("git", ["rebase", "--abort"], { cwd: repoCwd }).catch(() => {});
      console.warn(
        colorWarn(`${tag("main")} pre-run "git pull --rebase" on "${baseBranch}" failed, continuing on the existing tip: ${err instanceof Error ? err.message : err}`),
      );
    });
  }

  const backlog = new Backlog(backlogDir());
  const { loadLog, saveLog } = createLogStore(stateDir(project));
  const gateConfigPath = join(stateDir(project), "gates.json");
  // Records every tick to `state/<project>/journal.db` for `npm run report`.
  // `BAKLOOP_NO_TRANSCRIPTS=1` keeps the metrics but skips saving each
  // prompt/output pair to disk.
  const journal = createJournal(stateDir(project), {
    transcripts: process.env.BAKLOOP_NO_TRANSCRIPTS !== "1",
  });

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
    console.info(`${tag("main")} stopping after the current tick finishes (press again to force-quit)`);
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  // Holds a `caffeinate -i` for the run's lifetime so macOS doesn't idle-sleep
  // mid-run; released in the `finally` below. `BAKLOOP_NO_CAFFEINATE=1` opts out.
  const stopCaffeinate = startCaffeinate();
  const batteryFloor = batteryFloorFromEnv();

  // Last-resort backstop for a tick throwing something tick.ts's own
  // per-task model-error handling doesn't cover (e.g. a bug, not a known
  // local-model failure) — an unattended overnight run shouldn't die on
  // one unexpected exception when other tasks in the queue are still fine.
  // Bounded so a genuinely broken loop still gives up instead of spinning.
  const MAX_CONSECUTIVE_CRASHES = 5;
  let consecutiveCrashes = 0;

  try {
    for (;;) {
      // Checked at the iteration boundary, same as `stopRequested` — a tick is
      // one model call and shouldn't be torn in half mid-flight. On AC power
      // this never fires; on battery it stops cleanly like Ctrl+C.
      const battery = await readBatteryState();
      if (batteryFloor > 0 && battery && !battery.onAcPower && battery.percent <= batteryFloor) {
        console.warn(
          `${tag("main")} ${colorWarn(`battery at ${battery.percent}% (floor ${batteryFloor}%) — stopping`)}`,
        );
        break;
      }

      let result: { done: boolean; note: string };
      try {
        result = await tick({
          backlog,
          repoCwd,
          project,
          baseBranch,
          gateConfigPath,
          runAgent,
          loadLog,
          saveLog,
          renderPrompt,
          journal,
          autonomousIntegration: Boolean(autonomous),
        });
        consecutiveCrashes = 0;
      } catch (err) {
        consecutiveCrashes += 1;
        const taskId = err instanceof Error ? (err as Error & { taskId?: string }).taskId : undefined;
        console.error(
          colorError(`${tag("main")} ${taskId ?? "?"} tick threw (${consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES}):`),
          err,
        );
        if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES || stopRequested) throw err;
        continue;
      }
      console.info(`${tag("main")} ${result.note}`);
      if (result.done || stopRequested) break;
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    stopCaffeinate();
    journal.close();
    // Leave the working tree on the base branch, not mid-task, between runs.
    await run("git", ["checkout", baseBranch], { cwd: repoCwd }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
