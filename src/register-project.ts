import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { error as colorError, warn } from "./colors.js";
import { bakloopHome, backlogDir, loadProjects, saveProjects } from "./config.js";

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
 * `tsx src/register-project.ts <key> [path|url] [--autonomous]` — maps a
 * project lane to a repo in the shared registry, records the base branch
 * every task branch forks from and is diffed against, and best-effort
 * mirrors the key into backlog.md's own `projects` list (which the tool
 * itself requires you to edit directly; there is no `backlog config set`
 * for it). A fresh store's config.yml has no `projects:` line at all —
 * backlog.md omits it rather than writing `projects: []` — so this appends
 * one rather than assuming it exists.
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
  const [key, sourceArg] = args.filter((a) => a !== "--autonomous");
  if (!key) {
    console.error(colorError("usage: tsx src/register-project.ts <key> [path|url] [--autonomous]"));
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

  const projects = await loadProjects();
  projects[key] = { path: repoPath, baseBranch, ...(autonomous ? { autonomous } : {}) };
  await saveProjects(projects);
  console.info(`Registered "${key}" -> ${repoPath} (base branch: ${baseBranch}${autonomous ? ", autonomous" : ""})`);

  const configPath = join(backlogDir(), "config.yml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const match = raw.match(/^projects:\s*\[(.*)\]\s*$/m);
    const inner = match?.[1];
    if (inner === undefined) {
      const newLine = `projects: ["${key}"]`;
      await writeFile(configPath, `${raw.replace(/\n$/, "")}\n${newLine}\n`, "utf-8");
      console.info(`Added "${key}" to a new "projects:" line in ${configPath}`);
      return;
    }
    const existing = inner
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    if (existing.some((p) => p.toLowerCase() === key.toLowerCase())) return;
    existing.push(key);
    const updatedLine = `projects: [${existing.map((p) => `"${p}"`).join(", ")}]`;
    await writeFile(configPath, raw.replace(/^projects:\s*\[.*\]\s*$/m, updatedLine), "utf-8");
    console.info(`Added "${key}" to ${configPath}`);
  } catch {
    console.warn(
      warn(
        `No backlog config found at ${configPath}. Run "npm run setup" first, ` +
          `then add "${key}" to its projects list.`,
      ),
    );
  }
}

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
