import { error as colorError, tag } from "./colors.js";
import { backlogDir, loadProjects } from "./config.js";
import { Backlog } from "./backlog.js";
import type { Task, TaskSummary } from "./types.js";

/**
 * `tsx src/overlap.ts <project>` — does any pair of tasks in the same
 * breakdown claim the same file?
 *
 * The one overlap check with no model in it. D-007's alignment pass asks an
 * architect whether finished siblings still agree, which is a judgement made
 * after the work exists; this asks a much narrower question much earlier, and
 * answers it the same way every time: two tasks naming the same path in their
 * own acceptance criteria are going to write that file twice.
 *
 * Deliberately NOT a role (see D-009). The "friendkeeper" shape — one prompt
 * holding the whole tree — is the context-overflow shape bakloop already dies
 * on, and a model asked to compare N tasks gives a different answer each run.
 * Path collision is decidable, so it is decided.
 */

/**
 * Path-shaped tokens: one or more `dir/` segments followed by `name.ext`.
 *
 * Deliberately conservative — requiring a directory segment means a bare
 * `handler.ts` in prose is ignored, and a path with a placeholder segment
 * (`sources/<hash>/raw.html`) is missed rather than half-matched. A missed
 * collision costs what already happens today; a false one costs trust in the
 * only overlap signal that doesn't need a human to read the tree.
 */
const PATH_TOKEN = /(?:@?[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w{0,4}/g;

/**
 * Files that more than one task legitimately touches, by convention rather
 * than by mistake: a manifest every task adds a dependency to, a lockfile, an
 * append-only doc. Two tasks editing these is normal and does not produce the
 * clobber this check exists to catch, so they are reported and never blocked.
 *
 * Discovered by running the check against `book`'s real tree, where
 * `apps/infra/package.json` was claimed by nine tasks and `wiki/gotchas.md`
 * by three — burying the two collisions that actually mattered.
 */
const SHARED_BY_CONVENTION = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "biome.json",
]);

const isSharedByConvention = (path: string): boolean =>
  SHARED_BY_CONVENTION.has(path.split("/").pop() ?? "") || path.endsWith(".md");

/** Repo-relative file paths named anywhere in `text`, lowercased and de-duped. */
export function extractPaths(text: string | null): Set<string> {
  if (!text) return new Set();
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const raw = match[0].replace(/^\.\//, "").toLowerCase();
    // A URL's host/path looks exactly like a repo path; it never is one.
    if (text.slice(Math.max(0, match.index - 3), match.index).includes("//")) continue;
    // An npm specifier (`@aws-sdk/client-s3`) is not a file this task edits,
    // and neither is anything an install puts under node_modules. Both showed
    // up as collisions on `book`: two tasks each verifying that
    // `node_modules/@aws-sdk/client-s3/package.json` exists after install.
    if (raw.startsWith("@") || raw.includes("node_modules/")) continue;
    found.add(raw);
  }
  return found;
}

/**
 * Collapses a path that is a suffix of a fuller one claimed elsewhere:
 * `lib/dynamo.ts` and `apps/infra/lib/dynamo.ts` are one file, and reporting
 * them separately splits one collision into two half-collisions — which is
 * how `book`'s tree produced 16 findings for 11 distinct files. Only merges on
 * a segment boundary, so `db.ts` never absorbs `mydb.ts`.
 */
function canonicalize(byPath: Map<string, string[]>): Map<string, string[]> {
  const paths = [...byPath.keys()].sort((a, b) => b.length - a.length);
  const merged = new Map<string, string[]>();
  for (const path of paths) {
    const fuller = paths.find((other) => other !== path && other.endsWith(`/${path}`));
    const target = fuller ?? path;
    merged.set(target, [...new Set([...(merged.get(target) ?? []), ...byPath.get(path)!])]);
  }
  return merged;
}

/** Every field where a task states which files it intends to touch. */
export function pathsClaimedBy(task: Task): Set<string> {
  const texts = [
    task.description,
    task.implementationPlan,
    ...task.acceptanceCriteria.map((c) => c.text),
    ...task.definitionOfDone.map((d) => d.text),
  ];
  const all = new Set<string>();
  for (const t of texts) for (const p of extractPaths(t)) all.add(p);
  return all;
}

export interface Collision {
  path: string;
  /** Task ids claiming it — always two or more, in listing order. */
  taskIds: string[];
  /**
   * `false` for a file two tasks are simply expected to share (see
   * `SHARED_BY_CONVENTION`). Only blocking collisions stop a split.
   */
  blocking: boolean;
}

/**
 * `id -> ancestor ids`, so an ancestor/descendant pair can be excluded below.
 */
function ancestorsOf(all: TaskSummary[]): Map<string, Set<string>> {
  const byId = new Map(all.map((t) => [t.id, t]));
  const out = new Map<string, Set<string>>();
  for (const t of all) {
    const chain = new Set<string>();
    for (let cur = t.parentTaskId; cur && !chain.has(cur); cur = byId.get(cur)?.parentTaskId ?? null) {
      chain.add(cur);
    }
    out.set(t.id, chain);
  }
  return out;
}

/**
 * Paths claimed by two or more tasks that are NOT in an ancestor/descendant
 * relationship. That exclusion is the whole subtlety: a container legitimately
 * describes the files its own children will touch, and flagging that would
 * make every split look like a collision. A parent overlapping its *niece*,
 * on the other hand, is exactly the `book` failure — `TASK-1.4.1` and
 * `TASK-1.1` both claiming the CDK stack.
 */
export function findCollisions(tasks: Task[], all: TaskSummary[]): Collision[] {
  const ancestors = ancestorsOf(all);
  const raw = new Map<string, string[]>();
  for (const t of tasks) {
    for (const p of pathsClaimedBy(t)) {
      raw.set(p, [...(raw.get(p) ?? []), t.id]);
    }
  }
  const byPath = canonicalize(raw);

  const related = (a: string, b: string) =>
    (ancestors.get(a)?.has(b) ?? false) || (ancestors.get(b)?.has(a) ?? false);

  const collisions: Collision[] = [];
  for (const [path, ids] of byPath) {
    if (ids.length < 2) continue;
    // Keep only ids that collide with at least one UNRELATED claimant.
    const unrelated = ids.filter((id) => ids.some((other) => other !== id && !related(id, other)));
    if (unrelated.length >= 2) {
      collisions.push({ path, taskIds: unrelated, blocking: !isSharedByConvention(path) });
    }
  }
  return collisions.sort(
    (a, b) =>
      Number(b.blocking) - Number(a.blocking) ||
      b.taskIds.length - a.taskIds.length ||
      a.path.localeCompare(b.path),
  );
}

/** Blocking collisions first, then the shared-by-convention ones for context. */
export function render(collisions: Collision[], scanned: number): string {
  const blocking = collisions.filter((c) => c.blocking);
  const shared = collisions.filter((c) => !c.blocking);
  if (collisions.length === 0) return `no path collisions across ${scanned} task(s)`;

  const lines: string[] = [];
  const list = (cs: Collision[]) => {
    for (const c of cs) {
      lines.push(`  ${c.path}`);
      lines.push(`    claimed by ${c.taskIds.join(", ")}`);
    }
  };
  if (blocking.length === 0) {
    lines.push(`no blocking collisions across ${scanned} task(s)`);
  } else {
    lines.push(`${blocking.length} blocking path collision(s) across ${scanned} task(s):`, "");
    list(blocking);
  }
  if (shared.length > 0) {
    lines.push("", `also shared, expected by convention (not blocking):`, "");
    list(shared);
  }
  return lines.join("\n");
}

async function main() {
  const projects = await loadProjects();
  const project = process.argv[2] ?? process.env.BAKLOOP_PROJECT;
  if (!project) {
    console.info(`Usage: npm run overlap <project>\nRegistered: ${Object.keys(projects).join(", ") || "(none)"}`);
    return;
  }

  const backlog = new Backlog(backlogDir());
  const all = await backlog.list(undefined, project);
  if (all.length === 0) {
    console.info(`No tasks for "${project}".`);
    return;
  }
  // One `view` per task: the listing carries no description or criteria, and
  // this is a human-invoked check, not something on the tick path.
  const tasks = await Promise.all(all.map((t) => backlog.view(t.id)));
  const collisions = findCollisions(tasks, all);
  console.info(`${tag("overlap")} ${render(collisions, tasks.length)}`);
  if (collisions.length > 0) process.exitCode = 1;
}

// Only run as a script, so the pure helpers above stay importable from tests.
if (process.argv[1]?.endsWith("overlap.ts")) {
  main().catch((err) => {
    console.error(colorError("Fatal:"), err);
    process.exitCode = 1;
  });
}
