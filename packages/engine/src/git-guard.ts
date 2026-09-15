import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { bakloopHome } from "./config.js";

const run = promisify(execFile);

let guardDirPromise: Promise<string> | null = null;

/**
 * Prepending this directory to the bash tool's PATH shadows the real
 * `git` with a wrapper that refuses any command containing `push`. This
 * is the only HARD enforcement of "the agent never pushes" — the
 * executor prompt says so too, but a prompt is advisory, and bash access
 * means the model can just run the normal command if nothing stops it
 * (which is exactly how it ended up committing directly to main before
 * the branch-based workflow existed).
 *
 * Not a real sandbox: an absolute path to the real git binary, or a git
 * alias, would bypass this. It closes the "did the ordinary thing because
 * nothing said not to" failure mode, not a deliberate attempt to evade it.
 */
export function gitGuardDir(): Promise<string> {
  if (!guardDirPromise) guardDirPromise = build();
  return guardDirPromise;
}

async function build(): Promise<string> {
  const { stdout } = await run("/usr/bin/which", ["git"]);
  const realGit = stdout.trim();
  const dir = join(bakloopHome(), "bin");
  await mkdir(dir, { recursive: true });
  const script = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "push" ]; then
    echo "bakloop: git push is blocked for automated agents. Branches are reviewed and pushed by a human, never the agent." >&2
    exit 1
  fi
done
exec "${realGit}" "$@"
`;
  const path = join(dir, "git");
  await writeFile(path, script, { mode: 0o755 });
  return dir;
}
