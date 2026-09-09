import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Role } from "./types.js";

/**
 * What a tick did, one row per tick.
 *
 * Derived state, not source of truth — safe to delete, the backlog remains
 * authoritative — and written under `stateDir(project)`, never inside the
 * target repo, for the same reason attempt logs are (`src/log.ts`).
 *
 * The point of this file is that stdout is prose. Prose is fine for watching
 * a run and useless for answering "did rationing the context actually shrink
 * the executor's prompts, and did that reduce ticks per completed task."
 * Every field here exists to answer a question of that shape; add fields when
 * you have such a question, not because a value happened to be in scope.
 *
 * SQLite via `node:sqlite` — built into Node, so this costs no dependency,
 * and it means the useful queries are ones you can run by hand against the
 * file without going through bakloop at all (see `npm run report`).
 */
export interface TickRecord {
  ts: string;
  project: string;
  taskId: string | null;
  role: Role | null;
  /** `resolvePhase`'s own reason string — why this role, not another. */
  reason: string | null;
  /** Gate attempts already recorded for this task when the tick began. */
  attempt: number | null;
  statusBefore: string | null;
  /** Machine-readable end state. Never parse `note` for this. */
  outcome: TickOutcome;
  note: string;
  promptChars: number | null;
  outputChars: number | null;
  thinkingChars: number | null;
  toolCalls: number | null;
  /** Wall-clock inside `runAgent` — the model call itself. */
  modelMs: number | null;
  /** Wall-clock for the whole tick, including gates and backlog writes. */
  tickMs: number;
  gateFailures: string[] | null;
  testsPassing: number | null;
  docsRelevant: boolean | null;
  error: string | null;
}

/**
 * Closed vocabulary of how a tick can end. Exhaustive by construction: every
 * `return` in `tick.ts` carries one, so the compiler catches a new exit path
 * that forgot to declare what it did.
 */
export type TickOutcome =
  | "no-ready-tasks"
  | "nothing-to-do"
  | "container-blocked"
  | "description-written"
  | "criteria-written"
  | "plan-written"
  | "split"
  | "split-refused"
  | "split-unparseable"
  | "split-overlapping"
  | "split-pending-architecture"
  | "alignment-drift-blocked"
  | "notes-appended"
  | "docs-updated"
  | "reviewed"
  | "integrated"
  | "integration-conflict"
  | "integration-gate-failure"
  | "gates-green"
  | "subtask-done"
  | "gates-failed"
  | "blocked-attempts"
  | "model-error"
  | "blocked-model-errors"
  | "needs-split"
  | "crashed";

export interface Journal {
  append(record: TickRecord): Promise<void>;
  /** The exact prompt sent and text returned, for prompt iteration. */
  transcript(taskId: string, role: Role, ts: string, prompt: string, output: string): Promise<void>;
  read(): TickRecord[];
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT    NOT NULL,
  project        TEXT    NOT NULL,
  task_id        TEXT,
  role           TEXT,
  reason         TEXT,
  attempt        INTEGER,
  status_before  TEXT,
  outcome        TEXT    NOT NULL,
  note           TEXT    NOT NULL,
  prompt_chars   INTEGER,
  output_chars   INTEGER,
  thinking_chars INTEGER,
  tool_calls     INTEGER,
  model_ms       INTEGER,
  tick_ms        INTEGER NOT NULL,
  gate_failures  TEXT,
  tests_passing  INTEGER,
  docs_relevant  INTEGER,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS ticks_task ON ticks(task_id);
CREATE INDEX IF NOT EXISTS ticks_ts   ON ticks(ts);
`;

const COLUMNS = [
  "ts", "project", "task_id", "role", "reason", "attempt", "status_before",
  "outcome", "note", "prompt_chars", "output_chars", "thinking_chars",
  "tool_calls", "model_ms", "tick_ms", "gate_failures", "tests_passing",
  "docs_relevant", "error",
] as const;

const INSERT = `INSERT INTO ticks (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;

/** SQLite has no boolean; null must survive the round trip as null, not 0. */
const bit = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

interface Row {
  ts: string;
  project: string;
  task_id: string | null;
  role: string | null;
  reason: string | null;
  attempt: number | null;
  status_before: string | null;
  outcome: string;
  note: string;
  prompt_chars: number | null;
  output_chars: number | null;
  thinking_chars: number | null;
  tool_calls: number | null;
  model_ms: number | null;
  tick_ms: number;
  gate_failures: string | null;
  tests_passing: number | null;
  docs_relevant: number | null;
  error: string | null;
}

function toRecord(row: Row): TickRecord {
  return {
    ts: row.ts,
    project: row.project,
    taskId: row.task_id,
    role: row.role as Role | null,
    reason: row.reason,
    attempt: row.attempt,
    statusBefore: row.status_before,
    outcome: row.outcome as TickOutcome,
    note: row.note,
    promptChars: row.prompt_chars,
    outputChars: row.output_chars,
    thinkingChars: row.thinking_chars,
    toolCalls: row.tool_calls,
    modelMs: row.model_ms,
    tickMs: row.tick_ms,
    gateFailures: row.gate_failures ? (JSON.parse(row.gate_failures) as string[]) : null,
    testsPassing: row.tests_passing,
    docsRelevant: row.docs_relevant === null ? null : row.docs_relevant === 1,
    error: row.error,
  };
}

/** Filesystem-safe, sortable stamp from an ISO timestamp. */
function stamp(ts: string): string {
  return ts.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function journalPath(baseDir: string): string {
  return join(baseDir, "journal.db");
}

export function createJournal(baseDir: string, opts: { transcripts?: boolean } = {}): Journal {
  mkdirSync(baseDir, { recursive: true });
  const db = new DatabaseSync(journalPath(baseDir));
  // WAL: an overnight run that is killed mid-tick leaves a readable database
  // rather than a half-written final record.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const insert = db.prepare(INSERT);
  const transcriptsEnabled = opts.transcripts ?? true;

  return {
    async append(r) {
      insert.run(
        r.ts, r.project, r.taskId, r.role, r.reason, r.attempt, r.statusBefore,
        r.outcome, r.note, r.promptChars, r.outputChars, r.thinkingChars,
        r.toolCalls, r.modelMs, r.tickMs,
        r.gateFailures ? JSON.stringify(r.gateFailures) : null,
        r.testsPassing, bit(r.docsRelevant), r.error,
      );
    },

    async transcript(taskId, role, ts, prompt, output) {
      if (!transcriptsEnabled) return;
      // Deliberately files, not blobs in the database: these exist to be read
      // by a person iterating on a prompt, and `less` beats a SELECT for that.
      const dir = join(baseDir, "transcripts", taskId);
      await mkdir(dir, { recursive: true });
      const body = [
        `# ${taskId} — ${role} — ${ts}`,
        "",
        `## Prompt (${prompt.length} chars)`,
        "",
        prompt,
        "",
        `## Output (${output.length} chars)`,
        "",
        output,
        "",
      ].join("\n");
      await writeFile(join(dir, `${stamp(ts)}-${role}.md`), body, "utf-8");
    },

    read() {
      return (db.prepare("SELECT * FROM ticks ORDER BY id").all() as unknown as Row[]).map(toRecord);
    },

    close() {
      db.close();
    },
  };
}
