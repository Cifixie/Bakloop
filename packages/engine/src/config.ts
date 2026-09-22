import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * One shared task store for every registered project, kept out of any
 * target repo's git history and its diff-based gates. Each task carries a
 * `project` tag (a monorepo-style lane); this file maps that tag to the
 * repo it drives and the branch new task branches fork from. No default
 * project — an unmapped cwd is a hard error, never a guess.
 */
const HOME = process.env.BAKLOOP_HOME ?? join(homedir(), ".bakloop");

export function bakloopHome(): string {
  return HOME;
}

export function tasksDbPath(): string {
  return join(HOME, "tasks.db");
}

export function stateDir(project: string): string {
  return join(HOME, "state", project);
}

function projectsFile(): string {
  return join(HOME, "projects.json");
}

export interface ProjectEntry {
  path: string;
  /** The branch each task's own branch forks from, and is diffed against for gates. */
  baseBranch: string;
  /** Short uppercase key used for task IDs (e.g. "BOOK" → BOOK-1). Defaults to key slug if omitted. */
  prefix: string;
  /**
   * Opt-in (D-012): on green review, the agent itself rebases the task branch onto
   * `baseBranch`, re-runs gates, squash-merges, and marks the task Done — no human
   * step. Implied automatically when a project is registered from a git URL (there's
   * no developer checkout at `path` to protect); requires `--autonomous` when
   * registered from an existing local path, since that's a known risk against a
   * real working checkout.
   */
  autonomous?: boolean;
}

export type ProjectMap = Record<string, ProjectEntry>;

export async function loadProjects(): Promise<ProjectMap> {
  try {
    const raw = await readFile(projectsFile(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string | ProjectEntry>;
    const migrated: ProjectMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      let entry: ProjectEntry = typeof value === "string" ? { path: value, baseBranch: "main", prefix: key.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase() } : value;
      if (!entry.prefix) entry = { ...entry, prefix: key.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase() };
      migrated[key] = entry;
    }
    return migrated;
  } catch {
    return {};
  }
}

export async function saveProjects(projects: ProjectMap): Promise<void> {
  await mkdir(HOME, { recursive: true });
  await writeFile(projectsFile(), JSON.stringify(projects, null, 2), "utf-8");
}

export function resolveProjectKey(cwd: string, projects: ProjectMap): string | null {
  const target = resolve(cwd);
  for (const [key, entry] of Object.entries(projects)) {
    if (resolve(entry.path) === target) return key;
  }
  return null;
}
