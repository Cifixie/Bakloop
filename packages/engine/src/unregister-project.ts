import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { error as colorError, warn } from "./colors.js";
import { bakloopHome, loadProjects, saveProjects, stateDir } from "./config.js";

/**
 * `tsx src/unregister-project.ts <key|prefix> [--remove-clones]` — removes a
 * project from the shared registry and optionally cleans up its clone + per-project
 * state directory. Accepts either the exact key or a prefix (first match wins).
 *
 * - With --remove-clones: deletes only bakloop-controlled clones
 *   (paths inside `$BAKLOOP_HOME/clones/`). Developer checkouts are
 *   never deleted, regardless of flags.
 */
async function main() {
  const args = process.argv.slice(2);
  const removeFlag = args.includes("--remove-clones");
  const [input] = args.filter((a) => a !== "--remove-clones");
  if (!input) {
    console.error(colorError("usage: tsx src/unregister-project.ts <key|prefix> [--remove-clones]"));
    process.exitCode = 1;
    return;
  }

  const projects = await loadProjects();
  let key: string;
  let entry: { path: string } | undefined;

  // Try exact key first, then prefix lookup
  entry = projects[input];
  if (entry) {
    key = input;
  } else {
    const matches = Object.entries(projects).filter(([, e]) => e.prefix === input);
    if (matches.length === 0) {
      console.error(colorError(`"${input}" is neither a registered key nor a known prefix.`));
      process.exitCode = 1;
      return;
    }
    if (matches.length > 1) {
      const keys = matches.map(([k]) => k).join(", ");
      console.error(colorError(`Prefix "${input}" matches multiple keys: ${keys}. Use the exact key.`));
      process.exitCode = 1;
      return;
    }
    const m = matches[0]!;
    key = m[0];
    entry = m[1];
  }

  // Per-project state is always cleaned (active task data, meaningless
  // once the project is unregistered).
  const projectState = stateDir(key);
  rmSync(resolve(projectState), { recursive: true, force: true });
  console.info(`Removed state directory: ${projectState}`);

  // --remove-clones strictly confined to bakloop-controlled clones
  let cloneRemoved = false;
  if (removeFlag && entry) {
    const clonesRoot = join(bakloopHome(), "clones");
    const absClone = resolve(entry.path);
    if (absClone.startsWith(clonesRoot + "/")) {
      rmSync(absClone, { recursive: true, force: true });
      cloneRemoved = true;
      console.info(`Removed project directory: ${entry.path}`);
    } else {
      console.warn(
        warn(
          `"${entry.path}" is not under ${clonesRoot} — not deleting. ` +
            "Only bakloop-controlled clones are removed with --remove-clones.",
        ),
      );
    }
  }

  delete projects[key];
  await saveProjects(projects);
  const summary = cloneRemoved
    ? " (clone + state removed)"
    : " (state removed; clone on disk)";
  console.info(`Unregistered "${key}"${summary}`);
}

main().catch((err) => {
  console.error(colorError("Fatal:"), err);
  process.exitCode = 1;
});
