import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJournal, type TickRecord } from "./journal.js";
import { render, summarize } from "./report.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bakloop-journal-"));
}

function rec(over: Partial<TickRecord> = {}): TickRecord {
  return {
    ts: "2026-09-08T09:00:00.000Z",
    project: "demo",
    taskId: "TASK-1",
    role: "executor",
    reason: "acceptance criteria incomplete",
    attempt: 0,
    statusBefore: "In Progress",
    outcome: "gates-failed",
    note: "retrying: tsc",
    promptChars: 1200,
    outputChars: 300,
    thinkingChars: 900,
    toolCalls: 4,
    modelMs: 30_000,
    tickMs: 45_000,
    gateFailures: ["tsc"],
    testsPassing: 12,
    docsRelevant: false,
    error: null,
    ...over,
  };
}

test("a record survives the round trip through SQLite unchanged", () => {
  const dir = tempDir();
  try {
    const j = createJournal(dir, { transcripts: false });
    const written = rec();
    j.append(written);
    const read = j.read();
    j.close();

    assert.equal(read.length, 1);
    // Types matter here: SQLite has no boolean and no array, so these are the
    // fields most likely to come back subtly wrong.
    assert.deepEqual(read[0], written);
    assert.equal(read[0]!.docsRelevant, false);
    assert.deepEqual(read[0]!.gateFailures, ["tsc"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nulls round-trip as null, not as zero or false", () => {
  const dir = tempDir();
  try {
    const j = createJournal(dir, { transcripts: false });
    j.append(rec({ taskId: null, role: null, modelMs: null, docsRelevant: null, gateFailures: null }));
    const [read] = j.read();
    j.close();

    assert.equal(read!.taskId, null);
    assert.equal(read!.modelMs, null);
    assert.equal(read!.docsRelevant, null);
    assert.equal(read!.gateFailures, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reopened journal appends rather than truncating", () => {
  const dir = tempDir();
  try {
    const a = createJournal(dir, { transcripts: false });
    a.append(rec());
    a.close();
    const b = createJournal(dir, { transcripts: false });
    b.append(rec({ outcome: "gates-green" }));
    assert.equal(b.read().length, 2);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcripts record the prompt and output verbatim", async () => {
  const dir = tempDir();
  try {
    const j = createJournal(dir);
    await j.transcript("TASK-1", "criteria", "2026-09-08T09:00:00.000Z", "PROMPT_BODY", "OUTPUT_BODY");
    j.close();

    const taskDir = join(dir, "transcripts", "TASK-1");
    const files = readdirSync(taskDir);
    assert.equal(files.length, 1);
    // Sortable, filesystem-safe, and names the role that produced it.
    assert.equal(files[0], "20260908T090000Z-criteria.md");
    const body = readFileSync(join(taskDir, files[0]!), "utf-8");
    assert.match(body, /PROMPT_BODY/);
    assert.match(body, /OUTPUT_BODY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcripts can be turned off without losing metrics", async () => {
  const dir = tempDir();
  try {
    const j = createJournal(dir, { transcripts: false });
    await j.transcript("TASK-1", "executor", "2026-09-08T09:00:00.000Z", "p", "o");
    j.append(rec());
    assert.equal(j.read().length, 1);
    j.close();
    assert.equal(readdirSync(dir).includes("transcripts"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarize computes ticks-per-completed-task from terminal outcomes", () => {
  const s = summarize([
    // TASK-1: three model ticks, reaches review.
    rec({ taskId: "TASK-1", role: "owner", outcome: "description-written", modelMs: 10_000 }),
    rec({ taskId: "TASK-1", role: "executor", outcome: "gates-failed", modelMs: 20_000 }),
    rec({ taskId: "TASK-1", role: "reviewer", outcome: "reviewed", modelMs: 30_000 }),
    // TASK-2: blocked, so it must not dilute the completed-task average.
    rec({ taskId: "TASK-2", role: "executor", outcome: "blocked-attempts", modelMs: 5_000 }),
    // Bookkeeping tick: no model call, so it counts as a tick but not a model tick.
    rec({ taskId: null, role: null, outcome: "no-ready-tasks", modelMs: null, promptChars: null }),
  ]);

  assert.equal(s.ticks, 5);
  assert.equal(s.modelTicks, 4);
  assert.equal(s.completedTasks, 1);
  assert.equal(s.blockedTasks, 1);
  assert.equal(s.ticksPerCompletedTask, 3);
  assert.equal(s.modelSec, 65);
});

test("summarize groups prompt sizes by role, which is what #1 has to be judged on", () => {
  const s = summarize([
    rec({ role: "criteria", promptChars: 500, modelMs: 1000 }),
    rec({ role: "criteria", promptChars: 700, modelMs: 1000 }),
    rec({ role: "executor", promptChars: 4000, modelMs: 9000 }),
  ]);

  const criteria = s.byRole.find((r) => r.role === "criteria")!;
  assert.equal(criteria.ticks, 2);
  assert.equal(criteria.medianPromptChars, 600);
  assert.equal(criteria.maxPromptChars, 700);
  // Sorted by total model time, so the expensive role is the first thing read.
  assert.equal(s.byRole[0]!.role, "executor");
});

test("summarize is safe on an empty journal and renders without throwing", () => {
  const s = summarize([]);
  assert.equal(s.ticks, 0);
  assert.equal(s.ticksPerCompletedTask, null);
  assert.equal(s.byRole.length, 0);
  assert.match(render(s), /ticks\s+0/);
});
