import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import TaskTableClient from "./TaskTableClient";

export const dynamic = "force-dynamic";

const HOME = process.env.BAKLOOP_HOME ?? join(homedir(), ".bakloop");
const DB_PATH = join(HOME, "tasks.db");

function getTasks() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY ordinal").all() as Array<{
    id: string; title: string; type: string | null; status: string; priority: string | null; subtasks: string; updated_at: string;
  }>;
  db.close();
  return tasks;
}

export default function Home() {
  const tasks = getTasks();

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "32px 16px" }}>
      <h1 style={{ fontSize: "20px", fontWeight: 600, marginBottom: 24 }}>
        Bakloop Tasks
      </h1>
      <TaskTableClient tasks={tasks} />
    </main>
  );
}
