"use client";

import { useState } from "react";
import { TaskModal } from "./TaskModal";

function StatusBadge({ status }: { status: string }) {
  const STATUS_COLORS: Record<string, string> = {
    "Backlog": "#6b7280",
    "ToDo": "#3b82f6",
    "In Progress": "#f59e0b",
    "Review": "#8b5cf6",
    "Blocked": "#ef4444",
    "Done": "#22c55e",
  };
  const bg = STATUS_COLORS[status] ?? "#6b7280";
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "9999px",
      fontSize: "12px",
      fontWeight: 600,
      color: "#fff",
      backgroundColor: bg,
    }}>
      {status}
    </span>
  );
}

function TaskRow({ task, onClick }: { task: { id: string; title: string; type: string | null; status: string; priority: string | null; subtasks: string; updated_at: string }; onClick: () => void }) {
  const subCount = (() => { try { return JSON.parse(task.subtasks ?? "[]").length; } catch { return 0; } })();
  return (
    <tr
      onClick={onClick}
      style={{
        borderBottom: "1px solid #f3f4f6",
        cursor: "pointer",
      }}
    >
      <td style={{ padding: "10px 16px", fontFamily: "monospace", fontSize: "13px", color: "#6b7280", whiteSpace: "nowrap" }}>
        {task.id}
      </td>
      <td style={{ padding: "10px 16px", maxWidth: 400 }}>
        <div style={{ fontSize: "14px", fontWeight: 500 }}>{task.title}</div>
      </td>
      <td style={{ padding: "10px 16px", fontSize: "13px", color: "#6b7280", whiteSpace: "nowrap" }}>
        {task.type ?? "—"}
      </td>
      <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
        <StatusBadge status={task.status} />
      </td>
      <td style={{ padding: "10px 16px", fontSize: "13px", color: "#6b7280", whiteSpace: "nowrap" }}>
        {task.priority ?? "—"}
      </td>
      <td style={{ padding: "10px 16px", fontSize: "13px", color: "#6b7280", textAlign: "center", whiteSpace: "nowrap" }}>
        {subCount > 0 && <span title={`${subCount} subtask${subCount > 1 ? "s" : ""}`}>[{subCount}]</span>}
      </td>
      <td style={{ padding: "10px 16px", fontSize: "12px", color: "#9ca3af", whiteSpace: "nowrap" }}>
        {new Date(task.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </td>
    </tr>
  );
}

export default function TaskTableClient({ tasks }: { tasks: Array<{ id: string; title: string; type: string | null; status: string; priority: string | null; subtasks: string; updated_at: string }> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (tasks.length === 0) {
    return <p style={{ padding: 32, color: "#6b7280", textAlign: "center" }}>No tasks yet.</p>;
  }

  return (
    <>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
            {["ID", "Title", "Type", "Status", "Priority", "#sub", "Updated"].map(h => (
              <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map(t => (
            <TaskRow
              key={t.id}
              task={t}
              onClick={() => setSelectedId(t.id)}
            />
          ))}
        </tbody>
      </table>
      <TaskModal taskId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}
