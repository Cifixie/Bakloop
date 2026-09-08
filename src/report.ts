import { createJournal, journalPath, type TickRecord } from "./journal.js";
import { loadProjects, stateDir } from "./config.js";

/**
 * `tsx src/report.ts <project>` — what the loop actually did, from
 * `state/<project>/journal.db`.
 *
 * The aggregation lives in `summarize` as a pure function over records so it
 * can be tested without a database; this file is the printer around it. For
 * anything not covered here, query the file directly — that's the reason it's
 * SQLite and not a log format only bakloop can read.
 */

export interface RoleStats {
  role: string;
  ticks: number;
  medianPromptChars: number;
  maxPromptChars: number;
  medianModelSec: number;
  totalModelSec: number;
  toolCalls: number;
}

export interface Summary {
  ticks: number;
  /** Ticks that actually called the model — excludes pure bookkeeping exits. */
  modelTicks: number;
  wallClockSec: number;
  modelSec: number;
  firstTs: string | null;
  lastTs: string | null;
  byRole: RoleStats[];
  byOutcome: { outcome: string; count: number }[];
  gateFailures: { failure: string; count: number }[];
  /** The headline efficiency number: ticks spent per task that reached review. */
  ticksPerCompletedTask: number | null;
  completedTasks: number;
  blockedTasks: number;
  /** Tasks whose ticks are still accumulating without a terminal outcome. */
  openTasks: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

const TERMINAL_OK = new Set(["reviewed", "subtask-done"]);
const TERMINAL_BAD = new Set(["blocked-attempts", "blocked-model-errors", "split-refused"]);

export function summarize(records: TickRecord[]): Summary {
  const withModel = records.filter((r) => r.modelMs !== null);

  const roles = new Map<string, TickRecord[]>();
  for (const r of withModel) {
    if (!r.role) continue;
    const list = roles.get(r.role) ?? [];
    list.push(r);
    roles.set(r.role, list);
  }

  const byRole: RoleStats[] = [...roles.entries()]
    .map(([role, rs]) => ({
      role,
      ticks: rs.length,
      medianPromptChars: median(rs.map((r) => r.promptChars ?? 0)),
      maxPromptChars: Math.max(...rs.map((r) => r.promptChars ?? 0)),
      medianModelSec: Math.round(median(rs.map((r) => r.modelMs ?? 0)) / 1000),
      totalModelSec: Math.round(rs.reduce((n, r) => n + (r.modelMs ?? 0), 0) / 1000),
      toolCalls: rs.reduce((n, r) => n + (r.toolCalls ?? 0), 0),
    }))
    .sort((a, b) => b.totalModelSec - a.totalModelSec);

  const outcomes = new Map<string, number>();
  for (const r of records) outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);

  const failures = new Map<string, number>();
  for (const r of records) {
    for (const f of r.gateFailures ?? []) {
      // Strip the counts off variable failures ("test-count-regression 4->3")
      // so they aggregate into one row.
      const key = f.split(" ")[0]!;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  }

  // Per-task accounting: a task is "completed" once any of its ticks reached a
  // terminal-good outcome. Ticks are attributed to the task they ran against,
  // so a split parent and its children each carry their own.
  const taskTicks = new Map<string, TickRecord[]>();
  for (const r of records) {
    if (!r.taskId) continue;
    const list = taskTicks.get(r.taskId) ?? [];
    list.push(r);
    taskTicks.set(r.taskId, list);
  }
  let completedTasks = 0;
  let blockedTasks = 0;
  let ticksOnCompleted = 0;
  for (const rs of taskTicks.values()) {
    if (rs.some((r) => TERMINAL_OK.has(r.outcome))) {
      completedTasks += 1;
      ticksOnCompleted += rs.filter((r) => r.modelMs !== null).length;
    } else if (rs.some((r) => TERMINAL_BAD.has(r.outcome))) {
      blockedTasks += 1;
    }
  }

  const stamps = records.map((r) => r.ts).sort();
  const first = stamps[0] ?? null;
  const last = stamps[stamps.length - 1] ?? null;

  return {
    ticks: records.length,
    modelTicks: withModel.length,
    wallClockSec: Math.round(records.reduce((n, r) => n + r.tickMs, 0) / 1000),
    modelSec: Math.round(withModel.reduce((n, r) => n + (r.modelMs ?? 0), 0) / 1000),
    firstTs: first,
    lastTs: last,
    byRole,
    byOutcome: [...outcomes.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count),
    gateFailures: [...failures.entries()]
      .map(([failure, count]) => ({ failure, count }))
      .sort((a, b) => b.count - a.count),
    ticksPerCompletedTask:
      completedTasks > 0 ? Math.round((ticksOnCompleted / completedTasks) * 10) / 10 : null,
    completedTasks,
    blockedTasks,
    openTasks: taskTicks.size - completedTasks - blockedTasks,
  };
}

const dur = (sec: number) =>
  sec < 90 ? `${sec}s` : sec < 5400 ? `${(sec / 60).toFixed(1)}m` : `${(sec / 3600).toFixed(1)}h`;

function pad(s: string | number, n: number) {
  return String(s).padEnd(n);
}
function padL(s: string | number, n: number) {
  return String(s).padStart(n);
}

export function render(s: Summary): string {
  const out: string[] = [];

  out.push(`ticks              ${s.ticks} (${s.modelTicks} model calls)`);
  if (s.firstTs) out.push(`window             ${s.firstTs} → ${s.lastTs}`);
  out.push(`time in ticks      ${dur(s.wallClockSec)} (${dur(s.modelSec)} in the model)`);
  out.push(
    `tasks              ${s.completedTasks} completed, ${s.blockedTasks} blocked, ${s.openTasks} open`,
  );
  out.push(
    `ticks/completed     ${s.ticksPerCompletedTask ?? "—"}   <- the number to watch across changes`,
  );

  if (s.byRole.length > 0) {
    out.push("");
    out.push(
      `${pad("role", 12)}${padL("ticks", 6)}${padL("prompt~", 9)}${padL("prompt max", 12)}${padL("model~", 8)}${padL("model tot", 11)}${padL("tools", 7)}`,
    );
    for (const r of s.byRole) {
      out.push(
        pad(r.role, 12) +
          padL(r.ticks, 6) +
          padL(r.medianPromptChars, 9) +
          padL(r.maxPromptChars, 12) +
          padL(`${r.medianModelSec}s`, 8) +
          padL(dur(r.totalModelSec), 11) +
          padL(r.toolCalls, 7),
      );
    }
  }

  if (s.byOutcome.length > 0) {
    out.push("");
    out.push("outcomes");
    for (const o of s.byOutcome) out.push(`  ${pad(o.outcome, 24)}${padL(o.count, 5)}`);
  }

  if (s.gateFailures.length > 0) {
    out.push("");
    out.push("gate failures");
    for (const f of s.gateFailures) out.push(`  ${pad(f.failure, 24)}${padL(f.count, 5)}`);
  }

  return out.join("\n");
}

async function main() {
  const projects = await loadProjects();
  const project = process.argv[2] ?? process.env.BAKLOOP_PROJECT;
  if (!project) {
    console.info(`Usage: pnpm run report <project>\nRegistered: ${Object.keys(projects).join(", ") || "(none)"}`);
    return;
  }

  const dir = stateDir(project);
  const journal = createJournal(dir, { transcripts: false });
  try {
    const records = journal.read();
    if (records.length === 0) {
      console.info(`No ticks recorded for "${project}" yet (${journalPath(dir)}).`);
      return;
    }
    console.info(render(summarize(records)));
    console.info(`\nraw: sqlite3 ${journalPath(dir)}`);
    console.info(`transcripts: ${dir}/transcripts/<task-id>/`);
  } finally {
    journal.close();
  }
}

// Only run as a script, so the pure helpers above stay importable from tests.
if (process.argv[1]?.endsWith("report.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
