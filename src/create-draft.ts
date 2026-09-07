import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  let project: string;
  let title: string;
  {
    // Scoped tightly around the two line-prompts and closed before the
    // editor spawns below — readline puts the tty in raw mode for its own
    // line-editing and doesn't hand it cleanly back until `close()` runs.
    // Leaving it open across the `spawnSync` handed vim (or any full-screen
    // $EDITOR) a terminal still in Node's raw-mode state instead of a
    // normal starting one, which is what broke paste handling and made
    // `:wq` not register.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const projects = await loadProjects();

      project = process.argv[2] ?? "";
      if (!project) {
        console.info(`Registered projects: ${Object.keys(projects).join(", ") || "(none)"}`);
        project = (await rl.question("Project key: ")).trim();
      }
      if (!projects[project]) {
        throw new Error(
          `"${project}" is not registered. Run "tsx src/register-project.ts <key> [path]" first.`,
        );
      }

      title = (await rl.question("Title (blank = let AI name it): ")).trim();
    } finally {
      rl.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    }
  }

  {
    const description = await readMultiline("Paste or write the description below.");
    if (description === null) {
      console.info("Cancelled — no draft created.");
      return;
    }

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
  }
}

// A description may legitimately start with its own markdown "# Heading"
// (main()'s title-detection regex relies on that), so instructions can't be
// stripped by a "starts with #" line filter — that would eat the user's own
// heading. An exact sentinel line, cut at rather than filtered line-by-line,
// can't collide with real content.
const EDITOR_SENTINEL = "# ---- everything below this line is ignored ----";

/**
 * Captures multi-line/pasted text via `$EDITOR` rather than reading it
 * line-by-line over readline (as this used to): a loop of `rl.question()`
 * calls redraws its prompt with cursor-position math on every call, and a
 * large paste of long/wrapped lines arriving in one burst can get those
 * redraws interleaved, splicing fragments of different lines together —
 * silent corruption of the captured text, not just a display glitch. An
 * editor buffer sidesteps this entirely: the paste lands in the user's own
 * editor, never in Node's line-based redraw logic.
 *
 * A non-zero editor exit is treated as an intentional cancel (`null`), the
 * same convention `git commit`/`crontab -e` use with `:cq` — it's the only
 * way to discard unconditionally, since a plain `:q`/`:qa` is refused by
 * the editor itself once the buffer has unsaved changes.
 */
async function readMultiline(prompt: string): Promise<string | null> {
  console.info(`${prompt} (opening $EDITOR)`);
  const dir = await mkdtemp(join(tmpdir(), "bakloop-draft-"));
  const file = join(dir, "description.md");
  try {
    await writeFile(
      file,
      `\n${EDITOR_SENTINEL}\n# ${prompt}\n# Everything below this line, including it, is discarded.\n#\n# Done? In Vim: press Esc, then type :wq and Enter, to save and finish.\n# Changed your mind? In Vim: press Esc, then type :cq and Enter, to cancel\n# without creating a draft — plain :q/:qa is refused while there are\n# unsaved changes, since it would otherwise silently discard them.\n`,
      "utf-8",
    );
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const result = spawnSync(editor, [file], { stdio: "inherit", shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) return null;
    const raw = await readFile(file, "utf-8");
    const sentinelIdx = raw.indexOf(EDITOR_SENTINEL);
    return (sentinelIdx === -1 ? raw : raw.slice(0, sentinelIdx)).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
