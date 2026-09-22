import { join, resolve } from "node:path";
import { dim } from "./colors.js";
import { bakloopHome, loadProjects } from "./config.js";
/**
 * `tsx src/list-projects.ts` — prints all registered projects as a
 * key → path (baseBranch) table, one per line.
 */
async function main() {
  const projects = await loadProjects();
  const keys = Object.keys(projects);

  if (keys.length === 0) {
    console.log(dim("No projects registered. Run `tsx src/register-project.ts` to add one."));
    return;
  }

  const home = bakloopHome();
  const clonesRoot = resolve(join(home, "clones"));

  for (const key of keys) {
    const entry = projects[key];
    if (!entry) continue;
    const cloneMarker = entry.path.startsWith(clonesRoot + "/") ? " 🤖" : "";
    const auto = entry.autonomous ? ", autonomous" : "";
    console.log(`${key} → ${entry.path} (${entry.prefix}/*${entry.baseBranch}${auto})${cloneMarker}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
