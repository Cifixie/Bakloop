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

  /** Replaces the entire acceptance-criteria list — never a partial merge. */
  async setAcceptanceCriteria(id: string, criteria: string[]): Promise<void> {
    const args = ["task", "edit", id];
    for (const c of criteria) args.push("--acceptance-criteria", c);
    await this.cli(args);
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

  /** The message board: attributed comments on the task itself. */
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
