import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDocsRelevance } from "./gates.js";
import { APPROVED_LABEL, NEEDS_SPLIT_LABEL, resolvePhase, type Signals } from "./phase.js";
import { parseCriteriaOutput, parseOwnerOutput } from "./spec.js";
import { isContextOverflow } from "./tick.js";
import { STATUS, type Comment, type Task } from "./types.js";

/**
 * Covers `resolvePhase`, which CLAUDE.md singles out as the one piece of
 * logic with no other verification signal: a bad routing choice corrupts the
 * loop silently instead of failing a task loudly. Everything else here is a
 * parser whose output feeds a task field directly.
 */

const NO_DOCS: Signals = { docsRelevant: false };
const DOCS: Signals = { docsRelevant: true };

function task(over: Partial<Task> = {}): Task {
  return {
    id: "TASK-1",
    title: "t",
    status: STATUS.backlog,
    priority: null,
    assignees: [],
    labels: [],
    ordinal: 0,
    acceptanceCriteriaCompleted: 0,
    acceptanceCriteriaCount: 0,
    isReady: true,
    parentTaskId: null,
    path: "",
    description: "a description",
    type: null,
    dependencies: [],
    readiness: { isReady: true, isBlocked: false, blockingDependencies: [], missingDependencies: [] },
    acceptanceCriteria: [{ index: 1, text: "ac", checked: false }],
    definitionOfDone: [],
    implementationPlan: "a plan",
    implementationNotes: null,
    finalSummary: null,
    comments: [],
    modifiedFiles: [],
    subtasks: [],
    ...over,
  };
}

/** A task mid-execution: approved, In Progress, criteria not yet met. */
const executing = (over: Partial<Task> = {}) =>
  task({
    status: STATUS.inProgress,
    labels: [APPROVED_LABEL],
    acceptanceCriteriaCount: 1,
    acceptanceCriteriaCompleted: 0,
    ...over,
  });

/** Green gates force-check every criterion, so "done" is what the executor leaves behind. */
const gatesGreen = (over: Partial<Task> = {}) =>
  executing({ acceptanceCriteriaCompleted: 1, ...over });

const comment = (author: string): Comment => ({
  index: 1,
  body: "x",
  createdAt: "",
  author: `@${author}`,
});

test("spec phases: owner writes the description, criteria writes the AC — separately", () => {
  assert.equal(resolvePhase(task({ description: null }), 0, NO_DOCS)?.role, "owner");
  assert.equal(resolvePhase(task({ description: "   " }), 0, NO_DOCS)?.role, "owner");

  // The point of the split: a task WITH a description but no criteria must
  // not go back to owner, or one context authors both.
  const noAc = task({ acceptanceCriteria: [], implementationPlan: null });
  assert.equal(resolvePhase(noAc, 0, NO_DOCS)?.role, "criteria");
});

test("planner runs once the spec is complete, then parks for approval", () => {
  const unplanned = task({ implementationPlan: null });
  assert.equal(resolvePhase(unplanned, 0, NO_DOCS)?.role, "planner");

  // Plan written but no `approved` label: execution never starts on field state alone.
  assert.equal(resolvePhase(task({ status: STATUS.waitingForApproval }), 0, NO_DOCS), null);
});

test("needs-split beats an existing plan, and never applies to a subtask", () => {
  // The plan is present and non-blank — the label still wins, because the
  // plan is exactly what turned out not to fit.
  const overflowed = task({ labels: [NEEDS_SPLIT_LABEL] });
  const phase = resolvePhase(overflowed, 0, NO_DOCS);
  assert.equal(phase?.role, "planner");
  assert.match(phase!.reason, /needs-split/);

  // Splitting a subtask again is the unbuilt nested-splits case.
  const subtask = task({ labels: [NEEDS_SPLIT_LABEL, APPROVED_LABEL], parentTaskId: "TASK-2" });
  assert.notEqual(resolvePhase(subtask, 0, NO_DOCS)?.reason, "needs-split label present");
});

test("executor runs while criteria are incomplete; senior takes over on repeated failure", () => {
  assert.equal(resolvePhase(executing(), 0, NO_DOCS)?.role, "executor");
  assert.equal(resolvePhase(executing(), 1, NO_DOCS)?.role, "executor");
  // Escalation is machine-triggered, not an opinion about the task.
  assert.equal(resolvePhase(executing(), 2, NO_DOCS)?.role, "senior");
});

test("documenter runs only when the diff touched a documented surface", () => {
  assert.equal(resolvePhase(gatesGreen(), 0, DOCS)?.role, "documenter");
  // Same task, nothing documented changed: skip straight to the reviewer.
  assert.equal(resolvePhase(gatesGreen(), 0, NO_DOCS)?.role, "reviewer");
  // One-shot: its own progress-log entry is the marker.
  const documented = gatesGreen({ comments: [comment("documenter")] });
  assert.equal(resolvePhase(documented, 0, DOCS)?.role, "reviewer");
  // Another role's comment must not be mistaken for the documenter's.
  const noisy = gatesGreen({ comments: [comment("executor"), comment("senior")] });
  assert.equal(resolvePhase(noisy, 0, DOCS)?.role, "documenter");
});

test("a reviewed task is finished; terminal and blocked states are never re-entered", () => {
  assert.equal(resolvePhase(gatesGreen({ finalSummary: "done" }), 0, NO_DOCS), null);
  for (const status of [STATUS.done, STATUS.blocked, STATUS.review]) {
    assert.equal(resolvePhase(task({ status }), 0, DOCS), null);
  }
  const blockedByDeps = task({
    readiness: { isReady: false, isBlocked: true, blockingDependencies: ["TASK-9"], missingDependencies: [] },
  });
  assert.equal(resolvePhase(blockedByDeps, 0, NO_DOCS), null);
});

test("a container task skips implementation and goes to documenter/reviewer", () => {
  const container = task({ subtasks: [{ id: "TASK-1.1", title: "child" }], description: null });
  // Description is null, but a container must not be routed to owner.
  assert.equal(resolvePhase(container, 0, DOCS)?.role, "documenter");
  assert.equal(resolvePhase(container, 0, NO_DOCS)?.role, "reviewer");
});

test("context overflow is distinguished from an ordinary transport failure", () => {
  for (const message of [
    "context length exceeded",
    "prompt is too long for this model",
    "server returned out of memory",
    "KV cache allocation failed",
    "exceeds the maximum context",
  ]) {
    assert.equal(isContextOverflow(message), true, message);
  }
  for (const message of ["ECONNRESET", "socket hang up", "500 Internal Server Error"]) {
    assert.equal(isContextOverflow(message), false, message);
  }
});

test("the documenter signal fires on docs, declared interfaces, and moved exports", () => {
  const yes = (paths: string[], diff = "") => classifyDocsRelevance(paths, diff).relevant;

  assert.equal(yes(["README.md"]), true);
  assert.equal(yes(["docs/setup.md"]), true);
  assert.equal(yes(["wiki/gotchas.md"]), true);
  assert.equal(yes(["package.json"]), true);
  assert.equal(yes(["vitest.config.ts"]), true);
  assert.equal(yes(["api/openapi.yaml"]), true);

  // Internals only, with no export moved: nothing for the documenter to say.
  assert.equal(yes(["src/internal.ts"], "+  const helper = 1;\n-  const helper = 0;"), false);
  // Same files, but the public surface moved.
  assert.equal(yes(["src/internal.ts"], "+export function helper() {}"), true);
  assert.equal(yes(["src/internal.ts"], "-export function gone() {}"), true);

  // The diff's own +++/--- file headers must not be read as export changes.
  assert.equal(yes(["src/a.ts"], "--- a/src/export-utils.ts\n+++ b/src/export-utils.ts\n+  return 1;"), false);
});

test("owner output yields a description and a validated type", () => {
  const parsed = parseOwnerOutput("Some description.\nMore of it.\n\nType: feature\n");
  assert.equal(parsed.description, "Some description.\nMore of it.");
  assert.equal(parsed.type, "feature");

  // A type outside Backlog.md's configured list is dropped, not passed through.
  assert.equal(parseOwnerOutput("Desc.\nType: epic").type, null);
  // No type line at all: the whole text is the description.
  const bare = parseOwnerOutput("Just a description, no type line.");
  assert.equal(bare.type, null);
  assert.equal(bare.description, "Just a description, no type line.");
  // A description that discusses types in prose must not be truncated.
  const prose = parseOwnerOutput("We must handle Type: bug reports.\nAnd more.\n\nType: chore");
  assert.equal(prose.type, "chore");
  assert.match(prose.description, /^We must handle/);
  assert.match(prose.description, /And more\.$/);
});

test("criteria output splits acceptance criteria from the definition of done", () => {
  const parsed = parseCriteriaOutput(
    ["Acceptance criteria:", "1. First thing", "2. Second thing", "Definition of done:", "- tsc passes", "- docs updated"].join("\n"),
  );
  assert.deepEqual(parsed.acceptanceCriteria, ["First thing", "Second thing"]);
  assert.deepEqual(parsed.definitionOfDone, ["tsc passes", "docs updated"]);

  // Header omitted (local models don't always follow formatting): still recover the AC.
  const headerless = parseCriteriaOutput("1. First thing\n2. Second thing");
  assert.deepEqual(headerless.acceptanceCriteria, ["First thing", "Second thing"]);
  assert.deepEqual(headerless.definitionOfDone, []);
});
