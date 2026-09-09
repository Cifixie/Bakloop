import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { error as colorError, warn } from "./colors.js";
import { backlogDir, loadProjects, saveProjects } from "./config.js";

const run = promisify(execFile);

/**
 * `tsx src/register-project.ts <key> [path]` — maps a project lane to a
 * repo path in the shared registry, records whatever branch is currently
 * checked out there as the base every task branch forks from and is
 * diffed against, and best-effort mirrors the key into backlog.md's own
 * `projects` list (which the tool itself requires you to edit directly;
 * there is no `backlog config set` for it). A fresh store's config.yml has
 * no `projects:` line at all — backlog.md omits it rather than writing
 * `projects: []` — so this appends one rather than assuming it exists.
 */
async function main() {
  const [key, pathArg] = process.argv.slice(2);
  if (!key) {
    console.error(colorError("usage: tsx src/register-project.ts <key> [path]"));
    process.exitCode = 1;
    return;
  }
  const repoPath = resolve(pathArg ?? process.cwd());
  const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
  const baseBranch = stdout.trim();

  const projects = await loadProjects();
  projects[key] = { path: repoPath, baseBranch };
  await saveProjects(projects);
  console.info(`Registered "${key}" -> ${repoPath} (base branch: ${baseBranch})`);

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
