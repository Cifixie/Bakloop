import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * One shared backlog store for every registered project, kept out of any
 * target repo's git history and its diff-based gates. Each task carries a
 * `project` tag (a monorepo-style lane); this file maps that tag to the
 * repo it drives and the branch new task branches fork from. No default
 * project, mirroring backlog.md's own `projects` field: an unmapped cwd is
 * a hard error, never a guess.
 */
const HOME = process.env.BAKLOOP_HOME ?? join(homedir(), ".bakloop");

export function bakloopHome(): string {
  return HOME;
}

export function backlogDir(): string {
  return join(HOME, "backlog");
}

/** Per-project derived state (attempt logs, gate config, etc.) — never lives in the target repo. */
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
}

export type ProjectMap = Record<string, ProjectEntry>;

export async function loadProjects(): Promise<ProjectMap> {
  try {
    const raw = await readFile(projectsFile(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string | ProjectEntry>;
    const migrated: ProjectMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      // Pre-branching registrations stored a bare path string.
      migrated[key] = typeof value === "string" ? { path: value, baseBranch: "main" } : value;
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

/** Reverse lookup: which registered project (if any) owns this cwd. */
export function resolveProjectKey(cwd: string, projects: ProjectMap): string | null {
  const target = resolve(cwd);
  for (const [key, entry] of Object.entries(projects)) {
    if (resolve(entry.path) === target) return key;
  }
  return null;
}
