import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { error as colorError } from "./colors.js";
import { bakloopHome, backlogDir } from "./config.js";
import { STATUS } from "./types.js";

const run = promisify(execFile);

const PIPELINE_STATUSES = [
  STATUS.backlog,
  STATUS.todo,
  STATUS.inProgress,
  STATUS.review,
  STATUS.blocked,
  STATUS.done,
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent: safe to re-run. `backlog init` only runs once (when
 * config.yml is absent); the status/column fix-up always re-applies, so a
 * config hand-edited back to backlog.md's defaults heals on the next run.
 */
async function main() {
  // `backlog init` creates its own "backlog" subdirectory (backlogDir())
  // under whatever cwd it's given, so it must run from the home dir, one
  // level up — not from backlogDir() itself.
  const home = bakloopHome();
  await mkdir(home, { recursive: true });

  // `backlog init` prompts to create a git repo unless one already exists.
  // Pre-creating it here keeps this store on git (see CLAUDE.md: it must
  // never be inside a *target* repo's history, but its own is fine) while
  // making init fully non-interactive.
  if (!(await exists(join(home, ".git")))) {
    await run("git", ["init", "-b", "main"], { cwd: home });
  }

  const configPath = join(backlogDir(), "config.yml");
  if (!(await exists(configPath))) {
    await run(
      "backlog",
      ["init", "Bakloop", "--defaults", "--integration-mode", "cli", "--agent-instructions", "none"],
      { cwd: home },
    );
  }

  const raw = await readFile(configPath, "utf-8");
  const statusesLine = `statuses: [${PIPELINE_STATUSES.map((s) => `"${s}"`).join(", ")}]`;
  const updated = raw
    .replace(/^statuses:\s*\[.*\]\s*$/m, statusesLine)
    .replace(/^default_status:\s*.*$/m, `default_status: "${STATUS.backlog}"`)
    // Single local store, no remote configured; avoid backlog.md's remote warning.
    .replace(/^remote_operations:\s*.*$/m, "remote_operations: false")
    // The store is its own git repo (never the target repo's), so committing
    // every task write is safe and keeps its history durable.
    .replace(/^auto_commit:\s*.*$/m, "auto_commit: true");
  if (updated !== raw) {
    await writeFile(configPath, updated, "utf-8");
    console.info(`Set pipeline statuses in ${configPath}`);
  }

  console.info(`Backlog store ready at ${backlogDir()}`);
}

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
