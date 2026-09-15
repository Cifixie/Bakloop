import { mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { error as colorError } from "./colors.js";
import { bakloopHome, tasksDbPath } from "./config.js";
import { Backlog } from "./backlog.js";
/**
 * Initialize the bakloop task store: create directories, seed the SQLite DB,
 * and ensure a git repo for durability. Safe to re-run.
 */
async function main() {
  const home = bakloopHome();
  await mkdir(home, { recursive: true });

  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: home, stdio: "ignore" });
  } catch {
    execSync("git init -b main", { cwd: home });
  }

  // Touch the DB to trigger table creation.
  new Backlog(tasksDbPath());

  console.info(`Task store ready at ${tasksDbPath()}`);
}

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
