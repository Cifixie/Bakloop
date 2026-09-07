import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Deterministic, not model-chosen — one task always maps to the same branch. */
export function branchNameFor(taskId: string): string {
  return `bakloop/${taskId.toLowerCase()}`;
}

/**
 * Every task gets its own branch off the project's base branch, created
 * once and reused across attempts and ticks. This is the isolation
 * mechanism: a bad or blocked task's commits stay on its own branch, and
 * the next task simply checks out a different one — nothing is reverted.
 *
 * Deliberately never merges, rebases, or pushes anything: that stays a
 * human decision, made by looking at the branches left behind.
 *
 * Uses plain `git checkout`, not `-f`: if uncommitted changes would be
 * clobbered by switching branches, git refuses and this throws — it must
 * never silently discard work that isn't this task's own.
 */
export async function ensureTaskBranch(cwd: string, baseBranch: string, taskId: string): Promise<string> {
  const branch = branchNameFor(taskId);
  const { stdout: current } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (current.trim() === branch) return branch;

  const exists = await run("git", ["rev-parse", "--verify", "--quiet", branch], { cwd }).then(
    () => true,
    () => false,
  );
  if (exists) {
    await run("git", ["checkout", branch], { cwd });
  } else {
    await run("git", ["checkout", "-b", branch, baseBranch], { cwd });
  }
  return branch;
}
