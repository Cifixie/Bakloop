import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { backlogDir, loadProjects } from "./config.js";
import { deriveTitle } from "./summarize.js";

const run = promisify(execFile);

/**
 * `tsx src/create-draft.ts [project]` — quick capture, nothing more. Every
 * task pushed by hand (a roadmap entry, a GitHub issue, a stray idea) lands
 * here as a Backlog.md *draft*: raw title + raw pasted text, tagged for a
 * project via a `project:<key>` label (drafts have no structured `project`
 * field of their own). Drafts are invisible to bakloop's tick loop — only
 * `backlog task list` feeds it, never `backlog draft list` — so nothing
 * here can be picked up half-formed. `src/promote-draft.ts` is the only way
 * a draft becomes a real, AI-formatted task.
 */
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const projects = await loadProjects();

    let project = process.argv[2];
    if (!project) {
      console.info(`Registered projects: ${Object.keys(projects).join(", ") || "(none)"}`);
      project = (await rl.question("Project key: ")).trim();
    }
    if (!projects[project]) {
      throw new Error(
        `"${project}" is not registered. Run "tsx src/register-project.ts <key> [path]" first.`,
      );
    }

    let title = (await rl.question("Title (blank = let AI name it): ")).trim();

    const description = await readMultiline(rl, 'Description (end with a line containing just ".")');

    if (!title) {
      const heading = description.match(/^#\s+(.+?)\s*$/m);
      if (heading) {
        title = heading[1]!.trim();
      } else {
        console.info("[ai] naming this draft...");
        title = await deriveTitle(description);
      }
    }
    if (!title) throw new Error("Could not determine a title — type one manually.");

    const args = ["draft", "create", title, "--labels", `project:${project}`, "--plain"];
    if (description) args.push("--description", description);

    const { stdout } = await run("backlog", args, {
      cwd: backlogDir(),
      maxBuffer: 32 * 1024 * 1024,
    });
    console.info(stdout.trim());

    const id = stdout.match(/^Created draft (\S+)/m)?.[1];
    console.info(
      id
        ? `Still a draft — run "tsx src/promote-draft.ts ${id}" to have AI craft it into a real task.`
        : 'Still a draft — run "tsx src/promote-draft.ts <draft-id>" to have AI craft it into a real task.',
    );
  } finally {
    rl.close();
  }
}

async function readMultiline(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  console.info(prompt);
  const lines: string[] = [];
  for (;;) {
    const line = await rl.question("");
    if (line === ".") break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
