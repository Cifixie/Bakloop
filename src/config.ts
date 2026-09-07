import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * One shared backlog store for every registered project, kept out of any
 * target repo's git history and its diff-based gates. Each task carries a
 * `project` tag (a monorepo-style lane); this file maps that tag to the
 * absolute repo path it drives. No default project, mirroring backlog.md's
 * own `projects` field: an unmapped cwd is a hard error, never a guess.
 */
const HOME = process.env.BAKLOOP_HOME ?? join(homedir(), ".bakloop");

export function bakloopHome(): string {
  return HOME;
}

export function backlogDir(): string {
  return join(HOME, "backlog");
}

/** Per-project derived state (attempt logs, etc.) — never lives in the target repo. */
export function stateDir(project: string): string {
  return join(HOME, "state", project);
}

function projectsFile(): string {
  return join(HOME, "projects.json");
}

export type ProjectMap = Record<string, string>;

export async function loadProjects(): Promise<ProjectMap> {
  try {
    const raw = await readFile(projectsFile(), "utf-8");
    return JSON.parse(raw) as ProjectMap;
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
  for (const [key, path] of Object.entries(projects)) {
    if (resolve(path) === target) return key;
  }
  return null;
}
