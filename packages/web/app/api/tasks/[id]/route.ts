import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";

const HOME = process.env.BAKLOOP_HOME ?? join(homedir(), ".bakloop");
const DB_PATH = join(HOME, "tasks.db");

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as {
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
  } | undefined;

  db.close();

  if (!row) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  function parseJson<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  return NextResponse.json({
    id: row.id,
    title: row.title,
    project: row.project,
    status: row.status,
    priority: row.priority,
    assignees: parseJson<string[]>(row.assignees, []),
    labels: parseJson<string[]>(row.labels, []),
    ordinal: row.ordinal,
    parentTaskId: row.parent_task_id,
    path: row.path,
    description: row.description,
    type: row.type,
    draftSource: row.draft_source,
    dependencies: parseJson<string[]>(row.dependencies, []),
    readiness: parseJson<{ isReady: boolean; isBlocked: boolean; blockingDependencies: string[]; missingDependencies: string[] }>(
      row.readiness,
      { isReady: false, isBlocked: false, blockingDependencies: [], missingDependencies: [] },
    ),
    acceptanceCriteria: parseJson<{ index: number; text: string; checked: boolean }[]>(row.acceptance_criteria, []),
    definitionOfDone: parseJson<{ index: number; text: string; checked: boolean }[]>(row.definition_of_done, []),
    implementationPlan: row.implementation_plan,
    implementationNotes: row.implementation_notes,
    finalSummary: row.final_summary,
    comments: parseJson<{ index: number; body: string; createdAt: string; author: string }[]>(row.comments, []),
    modifiedFiles: parseJson<string[]>(row.modified_files, []),
    subtasks: parseJson<{ id: string; title: string }[]>(row.subtasks, []),
    updatedAt: row.updated_at,
  });
}
