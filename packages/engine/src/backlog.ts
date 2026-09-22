import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AcceptanceCriterion, Comment, DefinitionOfDoneItem, Task, TaskSummary } from "./types.js";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  project               TEXT NOT NULL,
  status                TEXT NOT NULL,
  priority              TEXT,
  assignees             TEXT,
  labels                TEXT,
  ordinal               INTEGER NOT NULL,
  parent_task_id        TEXT,
  path                  TEXT NOT NULL,
  description           TEXT,
  draft_source          TEXT,
  type                  TEXT,
  dependencies          TEXT,
  readiness             TEXT NOT NULL,
  acceptance_criteria   TEXT,
  definition_of_done    TEXT,
  implementation_plan   TEXT,
  implementation_notes  TEXT,
  final_summary         TEXT,
  comments              TEXT,
  modified_files        TEXT,
  subtasks              TEXT,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
`;

const COLUMNS = [
  "id", "title", "project", "status", "priority", "assignees", "labels",
  "ordinal", "parent_task_id", "path", "description", "type", "draft_source", "dependencies",
  "readiness", "acceptance_criteria", "definition_of_done", "implementation_plan",
  "implementation_notes", "final_summary", "comments", "modified_files",
  "subtasks", "updated_at",
] as const;

const INSERT = `INSERT OR REPLACE INTO tasks (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;
const SELECT_BY_ID = `SELECT * FROM tasks WHERE id = ?`;

interface TaskRow {
  id: string;
  title: string;
  project: string;
  status: string;
  priority: string | null;
  assignees: string | null;
  labels: string | null;
  ordinal: number;
  parent_task_id: string | null;
  path: string;
  description: string | null;
  type: string | null;
  draft_source: string | null;
  dependencies: string | null;
  readiness: string;
  acceptance_criteria: string | null;
  definition_of_done: string | null;
  implementation_plan: string | null;
  implementation_notes: string | null;
  final_summary: string | null;
  comments: string | null;
  modified_files: string | null;
  subtasks: string | null;
  updated_at: string;
}

/**
 * The ONLY path to task state. All writes go directly into the SQLite store
 * — the model is never given these as tools. The orchestrator does all
 * bookkeeping deterministically, so a tick's context holds one task's
 * text and nothing else.
 *
 * `dbPath` is the shared task store (see config.ts).
 */
export class Backlog {
  private db: DatabaseSync;
  private insert: ReturnType<DatabaseSync["prepare"]>;
  private selectById: ReturnType<DatabaseSync["prepare"]>;

  /** Project prefix for monotonic task IDs (set via setPrefix before use). */
  private prefix: string = "";
  /** Monotonic counter for PREFIX-N IDs. */
  private counter = 0;

  /** Set the project prefix for this Backlog instance. Must be called once at start-up. */
  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  /** Derive next monotonic ID from existing tasks: PREFIX-N, DB-backed. */
  private nextId(): string {
    const stmt = this.db.prepare("SELECT id FROM tasks WHERE id LIKE ? ORDER BY id DESC LIMIT 1");
    const row = stmt.get(`${this.prefix || "TASK"}-%`);
    if (row) {
      const id = (row as { id: string }).id;
      const match = id.match(/^([A-Z]+)-(\d+)$/);
      if (match && match[1] === (this.prefix || "TASK")) {
        this.counter = Math.max(this.counter, Number(match[2]));
      }
    }
    return `${this.prefix || "TASK"}-${++this.counter}`;
  }

  constructor(dbPath: string) {
    const dir = join(dbPath, "..");
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    // Schema migrations — backward-compatible with existing DBs.
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "draft_source")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN draft_source TEXT");
    }
    this.insert = this.db.prepare(INSERT);
    this.selectById = this.db.prepare(SELECT_BY_ID);
  }

  list(project?: string, status?: string): TaskSummary[] {
    let sql = "SELECT id, title, status, priority, assignees, labels, ordinal, parent_task_id, acceptance_criteria, readiness FROM tasks";
    const conditions: string[] = [];
    const params: string[] = [];
    if (project) {
      conditions.push("project = ?");
      params.push(project);
    }
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY ordinal";
    const rows = this.db.prepare(sql).all(...params) as unknown as TaskRow[];
    return rows.map(toSummary);
  }

  view(id: string): Task {
    const row = this.selectById.get(id) as unknown as TaskRow | undefined;
    if (!row) throw new Error(`Task "${id}" not found in store.`);
    return toFull(row);
  }

  async setStatus(id: string, status: string): Promise<void> {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  }

  async setDescription(id: string, description: string): Promise<void> {
    this.db.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?").run(description, now(), id);
  }
  async setDraftSource(id: string, text: string): Promise<void> {
    this.db.prepare("UPDATE tasks SET draft_source = ?, updated_at = ? WHERE id = ?").run(text, now(), id);
  }

  async setType(id: string, type: string): Promise<void> {
    this.db.prepare("UPDATE tasks SET type = ?, updated_at = ? WHERE id = ?").run(type, now(), id);
  }

  async setAcceptanceCriteria(id: string, criteria: string[]): Promise<void> {
    const mapped = criteria.map((text, i) => ({ index: i, text, checked: false }));
    this.db.prepare("UPDATE tasks SET acceptance_criteria = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(mapped), now(), id);
  }

  async checkAc(id: string, index: number): Promise<void> {
    const row = this.selectById.get(id) as unknown as TaskRow;
    const items = parseJson(row.acceptance_criteria, []) as AcceptanceCriterion[];
    const updated = items.map((c) => c.index === index ? { ...c, checked: true } : c);
    this.db.prepare("UPDATE tasks SET acceptance_criteria = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(updated), now(), id);
  }
  async addDefinitionOfDone(id: string, items: string[]): Promise<void> {
    const row = this.selectById.get(id) as unknown as TaskRow;
    const existing = parseJson(row.definition_of_done, []) as DefinitionOfDoneItem[];
    const nextIndex = existing.length;
    const mapped = items.map((text, i) => ({ index: nextIndex + i, text, checked: false }));
    const merged = [...existing, ...mapped];
    this.db.prepare("UPDATE tasks SET definition_of_done = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), now(), id);
  }

  async checkDod(id: string, index: number): Promise<void> {
    const row = this.selectById.get(id) as unknown as TaskRow;
    const items = parseJson(row.definition_of_done, []) as DefinitionOfDoneItem[];
    const updated = items.map((c) => c.index === index ? { ...c, checked: true } : c);
    this.db.prepare("UPDATE tasks SET definition_of_done = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(updated), now(), id);
  }

  async addLabel(id: string, label: string): Promise<void> {
    const row = this.selectById.get(id) as unknown as TaskRow;
    const labels = [...parseJson(row.labels, []), label];
    this.db.prepare("UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(labels), now(), id);
  }

  async removeLabel(id: string, label: string): Promise<void> {
    const row = this.selectById.get(id) as unknown as TaskRow;
    const labels = parseJson(row.labels, []).filter((l: string) => l !== label);
    this.db.prepare("UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(labels), now(), id);
  }

  async setPlan(id: string, plan: string): Promise<void> {
    this.db.prepare("UPDATE tasks SET implementation_plan = ?, updated_at = ? WHERE id = ?")
      .run(plan, now(), id);
  }

  async appendNotes(id: string, notes: string): Promise<void> {
    const row = this.selectById.get(id) as unknown as TaskRow;
    const existing = row.implementation_notes ?? "";
    this.db.prepare("UPDATE tasks SET implementation_notes = ?, updated_at = ? WHERE id = ?")
      .run(existing ? `${existing}\n\n${notes}` : notes, now(), id);
  }

  async setFinalSummary(id: string, text: string): Promise<void> {
    this.db.prepare("UPDATE tasks SET final_summary = ?, updated_at = ? WHERE id = ?")
      .run(text, now(), id);
  }

  async createChild(parentId: string, title: string, project: string, opts: {
    description?: string;
    acceptanceCriteria?: string[];
    notes?: string;
    dependsOn?: string[];
    draftSource?: string;
  }): Promise<string> {
    const id = this.nextId();
    // Inherit draft_source from the parent task — the root draft text travels
    // with every subtask so criteria/planner can always see the original ask.
    const parentRow = this.selectById.get(parentId) as unknown as TaskRow | undefined;
    const draftSource = opts.draftSource ?? parentRow?.draft_source ?? null;
    const ac = opts.acceptanceCriteria
      ? opts.acceptanceCriteria.map((text, i) => ({ index: i, text, checked: false }))
      : [];
    this.insert.run(
      id,
      title, project, "Backlog", null, "[]", "[]", 0, parentId, ".",
      opts.description ?? "", null, draftSource,
      opts.dependsOn ? JSON.stringify(opts.dependsOn) : null,
      '{"isReady":true,"isBlocked":false,"blockingDependencies":[],"missingDependencies":[]}',
      JSON.stringify(ac), "[]", null, opts.notes ?? "", null, "[]", "[]", "[]", now(),
    );
    return id;
  }

  async comment(id: string, author: string, body: string): Promise<void> {
    const row = this.selectById.get(id) as unknown as TaskRow;
    const comments = parseJson(row.comments, []) as Comment[];
    comments.push({ index: comments.length, author, body, createdAt: now() });
    this.db.prepare("UPDATE tasks SET comments = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(comments), now(), id);
  }

  async createDraft(project: string, title: string, description: string): Promise<string> {
    const id = this.nextId();
    this.db.prepare(
      `INSERT OR REPLACE INTO tasks (
        id, title, project, status, priority, assignees, labels,
        ordinal, parent_task_id, path, description, type, draft_source, dependencies,
        readiness, acceptance_criteria, definition_of_done, implementation_plan,
        implementation_notes, final_summary, comments, modified_files,
        subtasks, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, title, project, "Draft", null, "[]", "[]", 0, null, ".",
      description, null, "", null,
      '{"isReady":true,"isBlocked":false,"blockingDependencies":[],"missingDependencies":[]}',
      "[]", "[]", null, null, null, "[]", "[]", "[]", now(),
    );
    return id;
  }
}
function toSummary(row: TaskRow): TaskSummary {
  const ac = parseJson(row.acceptance_criteria, []) as AcceptanceCriterion[];
  const readiness = JSON.parse(row.readiness) as { isReady: boolean };
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignees: parseJson(row.assignees, []) as string[],
    labels: parseJson(row.labels, []) as string[],
    ordinal: row.ordinal,
    parentTaskId: row.parent_task_id,
    acceptanceCriteriaCompleted: ac.filter((c) => c.checked).length,
    acceptanceCriteriaCount: ac.length,
    isReady: readiness.isReady,
  };
}

function toFull(row: TaskRow): Task {
  return {
    ...toSummary(row),
    path: row.path,
    description: row.description,
    type: row.type,
    draftSource: row.draft_source,
    dependencies: parseJson(row.dependencies, []) as string[],
    readiness: JSON.parse(row.readiness) as { isReady: boolean; isBlocked: boolean; blockingDependencies: string[]; missingDependencies: string[] },
    acceptanceCriteria: parseJson(row.acceptance_criteria, []) as AcceptanceCriterion[],
    definitionOfDone: parseJson(row.definition_of_done, []) as DefinitionOfDoneItem[],
    implementationPlan: row.implementation_plan,
    implementationNotes: row.implementation_notes,
    finalSummary: row.final_summary,
    comments: parseJson(row.comments, []) as Comment[],
    modifiedFiles: parseJson(row.modified_files, []) as string[],
    subtasks: parseJson(row.subtasks, []) as { id: string; title: string }[],
  };
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function now(): string {
  return new Date().toISOString();
}
