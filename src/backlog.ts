import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Task,
  TaskListResponse,
  TaskSummary,
  TaskViewResponse,
} from "./types.js";

const run = promisify(execFile);

/**
 * The ONLY path to task state. Never hand-edit task markdown: field
 * types and metadata stay consistent only if writes go through the CLI.
 *
 * The model is never given these as tools. The orchestrator does all
 * bookkeeping deterministically, so a tick's context holds one task's
 * text and nothing else.
 *
 * `cwd` is the shared backlog store (see config.ts), never a target
 * repo — task writes must never show up in a project's own git diff.
 */
export class Backlog {
  constructor(private readonly cwd: string) {}

  private async cli(args: string[]): Promise<string> {
    const { stdout } = await run("backlog", args, {
      cwd: this.cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  }

  private async json<T>(args: string[]): Promise<T> {
    const out = await this.cli([...args, "--json"]);
    const parsed = JSON.parse(out) as T & { schemaVersion?: number };
    if (parsed.schemaVersion !== 1) {
      throw new Error(
        `Unexpected Backlog.md schemaVersion ${parsed.schemaVersion}; ` +
          `orchestrator types are pinned to 1.`,
      );
    }
    return parsed;
  }

  /** `project` scopes every query to one lane — a loop must never see another project's tasks. */
  async list(status?: string, project?: string): Promise<TaskSummary[]> {
    const args = ["task", "list"];
    if (status) args.push("-s", status);
    if (project) args.push("--project", project);
    const res = await this.json<TaskListResponse>(args);
    return res.tasks;
  }

  async view(id: string): Promise<Task> {
    const res = await this.json<TaskViewResponse>(["task", "view", id]);
    return res.task;
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.cli(["task", "edit", id, "-s", status]);
  }

  async setDescription(id: string, description: string): Promise<void> {
    await this.cli(["task", "edit", id, "--description", description]);
  }

  async setType(id: string, type: string): Promise<void> {
    await this.cli(["task", "edit", id, "--type", type]);
  }

  /** Replaces the entire acceptance-criteria list — never a partial merge. */
  async setAcceptanceCriteria(id: string, criteria: string[]): Promise<void> {
    const args = ["task", "edit", id];
    for (const c of criteria) args.push("--acceptance-criteria", c);
    await this.cli(args);
  }

  /**
   * Appends Definition-of-Done items. Backlog.md has no replace-all flag for
   * DoD (unlike `--acceptance-criteria`), only `--dod`/`--remove-dod`, so
   * callers must only use this on a task whose DoD list is still empty —
   * `resolvePhase` guarantees that by routing to `criteria` only when it is.
   */
  async addDefinitionOfDone(id: string, items: string[]): Promise<void> {
    if (items.length === 0) return;
    const args = ["task", "edit", id];
    for (const item of items) args.push("--dod", item);
    await this.cli(args);
  }

  async checkDod(id: string, index: number): Promise<void> {
    await this.cli(["task", "edit", id, "--check-dod", String(index)]);
  }

  async addLabel(id: string, label: string): Promise<void> {
    await this.cli(["task", "edit", id, "--add-label", label]);
  }

  async removeLabel(id: string, label: string): Promise<void> {
    await this.cli(["task", "edit", id, "--remove-label", label]);
  }

  async setPlan(id: string, plan: string): Promise<void> {
    await this.cli(["task", "edit", id, "--plan", plan]);
  }

  async appendNotes(id: string, notes: string): Promise<void> {
    await this.cli(["task", "edit", id, "--append-notes", notes]);
  }

  async setFinalSummary(id: string, text: string): Promise<void> {
    await this.cli(["task", "edit", id, "--final-summary", text]);
  }

  async checkAc(id: string, index: number): Promise<void> {
    await this.cli(["task", "edit", id, "--check-ac", String(index)]);
  }

  /**
   * Splits a too-large task into a subtask on the same branch (see branch.ts),
   * created via Backlog.md's native `--parent`. Returns the new task's id,
   * parsed from `backlog task create`'s plain-text confirmation line.
   *
   * `project` MUST be passed through explicitly — Backlog.md does not infer
   * it from `--parent`. A child created without it has no `project` field at
   * all, which makes it invisible to `Backlog.list(status, project)` (the
   * project-scoped view `tick.ts` builds its whole worldview from) forever:
   * it can never be selected, and any "are all my children done" check over
   * the same scoped list vacuously passes with zero children in it. See the
   * orphaned-nested-split gotcha in wiki/gotchas.md.
   */
  async createChild(
    parentId: string,
    title: string,
    project: string,
    opts: { description?: string; acceptanceCriteria?: string[] } = {},
  ): Promise<string> {
    const args = ["task", "create", title, "--parent", parentId, "--project", project, "--plain"];
    if (opts.description) args.push("--description", opts.description);
    for (const ac of opts.acceptanceCriteria ?? []) args.push("--ac", ac);
    const out = await this.cli(args);
    const id = out.match(/^Task (\S+) -/m)?.[1];
    if (!id) throw new Error(`Could not parse new subtask id from create output:\n${out}`);
    return id;
  }

  /**
   * The append-only progress log (see `Comment` in types.ts). Every machine
   * observation about a tick — gate failures, model-call failures, a skipped
   * documenter, a forced split — lands here attributed to the role it came
   * from, instead of being concatenated into `implementationNotes`.
   */
  async comment(id: string, author: string, body: string): Promise<void> {
    await this.cli([
      "task",
      "edit",
      id,
      "--comment",
      body,
      "--comment-author",
      `@${author}`,
    ]);
  }
}
