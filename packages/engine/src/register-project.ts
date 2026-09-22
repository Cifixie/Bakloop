import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { error as colorError, warn } from "./colors.js";
import { bakloopHome, loadProjects, saveProjects } from "./config.js";

const run = promisify(execFile);

/** A source that isn't an existing local path: a URL, or a `git@host:...` /
 * `owner/repo` shorthand `gh repo clone` and plain `git clone` both accept. */
function looksLikeGitSource(s: string): boolean {
  return /^(https?:\/\/|git@|[\w.-]+\/[\w.-]+$)/.test(s);
}

function looksGitHubShaped(s: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(s) || /github\.com/.test(s);
}

/**
 * Clones a remote source into `dest` — via `gh repo clone` when the source
 * looks GitHub-shaped (rides whatever `gh auth` session already exists,
 * sidestepping local SSH-key/PAT setup), falling back to plain `git clone`
 * for anything `gh` can't or won't handle (not installed, fails, or a
 * GitLab/Bitbucket/generic URL). Returns the branch actually checked out.
 */
async function cloneRemote(source: string, dest: string): Promise<string> {
  const preferGh = looksGitHubShaped(source);
  if (preferGh) {
    try {
      await run("gh", ["repo", "clone", source, dest]);
    } catch {
      await run("git", ["clone", source, dest]);
    }
  } else {
    await run("git", ["clone", source, dest]);
  }
  const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dest });
  return stdout.trim();
}

/**
 * — maps a project lane to a repo in the shared registry. `--prefix` sets
 * * the short uppercase task-ID prefix (defaults to key slug).
 *
 * Two registration shapes (D-012):
 * - An existing local directory registers exactly as before: supervised —
 *   a human reviews and merges. `--autonomous` opts that same real checkout
 *   into unattended rebase+merge+Done; a plainly-flagged, known risk against
 *   a working directory the human may also be using, not something bakloop
 *   tries to soften.
 * - Anything else (a URL, or an `owner/repo` shorthand) is treated as a
 *   remote: bakloop clones its own copy under `$BAKLOOP_HOME/clones/<key>`
 *   and runs it fully autonomously by construction — there's no developer
 *   checkout at that path to protect.
 */
async function main() {
  const args = process.argv.slice(2);
  const autonomousFlag = args.includes("--autonomous");
  const prefixFlag = args.find((a) => a.startsWith("--prefix="))?.slice(9);
  const nonFlag = args.filter((a) => a !== "--autonomous" && !a.startsWith("--prefix="));
  const [key, sourceArg] = nonFlag;
  if (!key) {
    console.error(colorError("usage: tsx src/register-project.ts <key> [path|url] [--autonomous] [--prefix=ABC]"));
    process.exitCode = 1;
    return;
  }

  const projects = await loadProjects();
  const prefix = prefixFlag || key.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase();

  if (!prefix || prefix.includes("-")) {
    console.error(colorError("Prefix must be non-empty uppercase letters/numbers with no dashes (e.g. --prefix=BOOK)."));
    process.exitCode = 1;
    return;
  }
  const collision = Object.entries(projects).find(([k, e]) => k !== key && e.prefix === prefix);
  if (collision) {
    console.error(colorError(`Prefix "${prefix}" already used by "${collision[0]}".`));
    process.exitCode = 1;
    return;
  }

  const localPath = sourceArg ? resolve(sourceArg) : process.cwd();
  const isRemote = Boolean(sourceArg) && !existsSync(localPath) && looksLikeGitSource(sourceArg!);

  let repoPath: string;
  let baseBranch: string;
  let autonomous: boolean | undefined;

  if (isRemote) {
    repoPath = join(bakloopHome(), "clones", key);
    if (existsSync(repoPath)) {
      console.error(colorError(`${repoPath} already exists — remove it first to re-clone "${key}".`));
      process.exitCode = 1;
      return;
    }
    const defaultBranch = await cloneRemote(sourceArg!, repoPath);
    baseBranch = "bakloop/trunk";
    await run("git", ["checkout", "-b", baseBranch, defaultBranch], { cwd: repoPath });
    autonomous = true;
    console.info(`Cloned "${key}" from ${sourceArg} -> ${repoPath}`);
  } else {
    repoPath = localPath;
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    baseBranch = stdout.trim();
    if (autonomousFlag) {
      autonomous = true;
      console.warn(
        warn(
          `"${key}" is registered autonomous against your own checkout at ${repoPath}. ` +
            `bakloop will rebase, re-gate, and squash-merge finished task branches into ` +
            `"${baseBranch}" there with no review step. Known risk, your call.`,
        ),
      );
    }
  }

  projects[key] = { path: repoPath, baseBranch, prefix, ...(autonomous ? { autonomous } : {}) };
  await saveProjects(projects);
  console.info(`Registered "${key}" -> ${repoPath} (base branch: ${baseBranch}${autonomous ? ", autonomous" : ""})`);
}

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
