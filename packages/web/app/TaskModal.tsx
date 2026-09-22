"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Modal } from "./Modal";

interface TaskData {
  id: string;
  title: string;
  project: string;
  status: string;
  priority: string | null;
  assignees: string[];
  labels: string[];
  ordinal: number;
  parentTaskId: string | null;
  path: string;
  description: string | null;
  type: string | null;
  draftSource: string | null;
  dependencies: string[];
  readiness: {
    isReady: boolean;
    isBlocked: boolean;
    blockingDependencies: string[];
    missingDependencies: string[];
  };
  acceptanceCriteria: { index: number; text: string; checked: boolean }[];
  definitionOfDone: { index: number; text: string; checked: boolean }[];
  implementationPlan: string | null;
  implementationNotes: string | null;
  finalSummary: string | null;
  comments: { index: number; body: string; createdAt: string; author: string }[];
  modifiedFiles: string[];
  subtasks: { id: string; title: string }[];
  updatedAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  "Backlog": "#6b7280",
  "ToDo": "#3b82f6",
  "In Progress": "#f59e0b",
  "Review": "#8b5cf6",
  "Blocked": "#ef4444",
  "Done": "#22c55e",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af", marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function MarkdownField({ value }: { value: string | null }) {
  if (!value) return <div style={{ color: "#9ca3af", fontStyle: "italic" }}>—</div>;
  return (
    <div style={{
      fontSize: "14px",
      lineHeight: 1.7,
      color: "#374151",
    }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {value}
      </ReactMarkdown>
    </div>
  );
}

function TagList({ items }: { items: string[] }) {
  if (!items.length) return <span style={{ color: "#9ca3af" }}>—</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {items.map(tag => (
        <span key={tag} style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: 9999,
          fontSize: "12px",
          backgroundColor: "#f3f4f6",
          color: "#374151",
        }}>
          {tag}
        </span>
      ))}
    </div>
  );
}

function Checklist({ items }: { items: { index: number; text: string; checked: boolean }[] }) {
  if (!items.length) return <span style={{ color: "#9ca3af" }}>—</span>;
  return (
    <div>
      {items.map(item => (
        <div key={item.index} style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          fontSize: "14px",
          lineHeight: 1.6,
          marginBottom: 4,
          color: item.checked ? "#6b7280" : "#374151",
        }}>
          <span style={{ color: item.checked ? "#22c55e" : "#d1d5db", fontSize: 14, lineHeight: 1.5, flexShrink: 0 }}>
            {item.checked ? "✓" : "○"}
          </span>
          <span style={{
            flex: 1,
            ...(item.checked ? { textDecoration: "line-through", color: "#9ca3af" } : {}),
          }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          </span>
        </div>
      ))}
    </div>
  );
}

function SubtaskList({ items }: { items: { id: string; title: string }[] }) {
  if (!items.length) return <span style={{ color: "#9ca3af" }}>—</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }}>
      {items.map(st => (
        <li key={st.id} style={{ fontSize: "14px", lineHeight: 1.6, marginBottom: 2 }}>
          {st.title}
        </li>
      ))}
    </ul>
  );
}

function CommentList({ items }: { items: { index: number; body: string; createdAt: string; author: string }[] }) {
  if (!items.length) return <span style={{ color: "#9ca3af" }}>—</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {items.map(c => (
        <div key={c.index} style={{
          borderTop: "1px solid #f3f4f6",
          paddingTop: 12,
        }}>
          <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: 6 }}>
            <strong>{c.author}</strong> · {new Date(c.createdAt).toLocaleString()}
          </div>
          <div style={{ fontSize: "14px", lineHeight: 1.7, color: "#374151" }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TaskModal({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const [task, setTask] = useState<TaskData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let stale = false;
    fetch(`/api/tasks/${taskId}`)
      .then(r => {
        if (!r.ok) throw new Error(r.status === 404 ? "Task not found" : "Failed to load");
        return r.json();
      })
      .then(data => {
        if (!stale) setTask(data);
      })
      .catch(e => {
        if (!stale) setError(e.message);
      });
    return () => { stale = true; };
  }, [taskId]);

  return (
    <Modal open={taskId !== null} onClose={onClose}>
      {error ? (
        <div style={{ color: "#ef4444", padding: 24, textAlign: "center" }}>{error}</div>
      ) : task ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
            <span style={{ fontFamily: "monospace", fontSize: "13px", color: "#9ca3af" }}>{task.id}</span>
            <span style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: 9999,
              fontSize: "12px",
              fontWeight: 600,
              color: "#fff",
              backgroundColor: STATUS_COLORS[task.status] ?? "#6b7280",
            }}>
              {task.status}
            </span>
            {task.type && (
              <span style={{ fontSize: "12px", color: "#9ca3af" }}>{task.type}</span>
            )}
          </div>

          <h2 style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 20px", color: "#111827" }}>
            {task.title}
          </h2>

          <Field label="Description">
            <MarkdownField value={task.description} />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 24px" }}>
            <Field label="Priority">
              <span>{task.priority ?? "—"}</span>
            </Field>
            <Field label="Assignees">
              <TagList items={task.assignees} />
            </Field>
            <Field label="Labels">
              <TagList items={task.labels} />
            </Field>
            <Field label="Project">
              <span>{task.project}</span>
            </Field>
          </div>

          <Field label="Dependencies">
            <TagList items={task.dependencies} />
          </Field>

          <Field label="Readiness">
            <div style={{ fontSize: "14px", color: "#374151" }}>
              <div>Ready: <strong>{task.readiness.isReady ? "Yes" : "No"}</strong></div>
              {task.readiness.isBlocked && (
                <div style={{ marginTop: 4 }}>
                  Blocked: <strong>Yes</strong>
                  {task.readiness.blockingDependencies.length > 0 && (
                    <div style={{ marginLeft: 20, color: "#ef4444" }}>
                      Blocked by: {task.readiness.blockingDependencies.join(", ")}
                    </div>
                  )}
                </div>
              )}
              {task.readiness.missingDependencies.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  Missing dependencies: {task.readiness.missingDependencies.join(", ")}
                </div>
              )}
            </div>
          </Field>

          <Field label={`Acceptance Criteria (${task.acceptanceCriteria.filter(a => a.checked).length}/${task.acceptanceCriteria.length})`}>
            <Checklist items={task.acceptanceCriteria} />
          </Field>

          <Field label={`Definition of Done (${task.definitionOfDone.filter(d => d.checked).length}/${task.definitionOfDone.length})`}>
            <Checklist items={task.definitionOfDone} />
          </Field>

          <Field label="Implementation Plan">
            <MarkdownField value={task.implementationPlan} />
          </Field>

          <Field label="Implementation Notes">
            <MarkdownField value={task.implementationNotes} />
          </Field>

          <Field label="Final Summary">
            <MarkdownField value={task.finalSummary} />
          </Field>

          <Field label="Subtasks">
            <SubtaskList items={task.subtasks} />
          </Field>

          <Field label="Modified Files">
            <TagList items={task.modifiedFiles} />
          </Field>

          <Field label="Progress Log (Comments)">
            <CommentList items={task.comments} />
          </Field>

          <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: 24, paddingTop: 16, borderTop: "1px solid #f3f4f6" }}>
            Path: {task.path}
            {task.parentTaskId && <> · Parent: {task.parentTaskId}</>}
            {task.draftSource && <> · Draft: {task.draftSource}</>}
          </div>
        </>
      ) : (
        <div style={{ padding: 32, textAlign: "center", color: "#6b7280" }}>Loading…</div>
      )}
    </Modal>
  );
}
