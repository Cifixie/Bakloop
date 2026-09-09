import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDocsRelevance } from "./gates.js";
import { extractPaths, findCollisions } from "./overlap.js";
import {
  NEEDS_CHANGES_LABEL,
  NEEDS_HUMAN_REVIEW_LABEL,
  NEEDS_REPLAN_LABEL,
  NEEDS_SPLIT_LABEL,
  resolvePhase,
  type Signals,
} from "./phase.js";
import {
  parseAlignmentOutput,
  parseCriteriaOutput,
  parseCriticOutput,
  parseOwnerOutput,
  parsePlannerOutput,
} from "./spec.js";
import { isContextOverflow, rootAncestorId, siblingScopeFor } from "./tick.js";
import { STATUS, type Comment, type Task, type TaskSummary } from "./types.js";

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

test("planner runs once the spec is complete, then parks in ToDo for execution", () => {
  const unplanned = task({ implementationPlan: null });
  assert.equal(resolvePhase(unplanned, 0, NO_DOCS)?.role, "planner");

  // Plan written, parked at ToDo: the executor can proceed immediately, no human move.
  assert.equal(
    resolvePhase(task({ status: STATUS.todo, acceptanceCriteriaCount: 1 }), 0, NO_DOCS)?.role,
    "executor",
  );
});

test("a plan-bearing task outside ToDo/In Progress never routes to executor", () => {
  for (const status of [STATUS.blocked, STATUS.review, STATUS.done, STATUS.backlog]) {
    assert.equal(resolvePhase(task({ status, acceptanceCriteriaCount: 1 }), 0, NO_DOCS), null);
  }
});

test("needs-split beats an existing plan, including for a subtask (nested split)", () => {
  // The plan is present and non-blank — the label still wins, because the
  // plan is exactly what turned out not to fit.
  const overflowed = task({ labels: [NEEDS_SPLIT_LABEL] });
  const phase = resolvePhase(overflowed, 0, NO_DOCS);
  assert.equal(phase?.role, "planner");
  assert.match(phase!.reason, /needs-split/);

  // A subtask that itself overflows can be split again — nested splits are
  // supported (see rootAncestorId in tick.ts for the branch side of this).
  const subtask = task({ labels: [NEEDS_SPLIT_LABEL], status: STATUS.todo, parentTaskId: "TASK-2" });
  const subPhase = resolvePhase(subtask, 0, NO_DOCS);
  assert.equal(subPhase?.role, "planner");
  assert.match(subPhase!.reason, /needs-split/);
});

test("executor runs while criteria are incomplete; senior takes over on repeated failure", () => {
  assert.equal(resolvePhase(executing(), 0, NO_DOCS)?.role, "executor");
  assert.equal(resolvePhase(executing(), 1, NO_DOCS)?.role, "executor");
  // Escalation is machine-triggered, not an opinion about the task.
  assert.equal(resolvePhase(executing(), 2, NO_DOCS)?.role, "senior");
});

test("documenter runs only when the diff touched a documented surface", () => {
  assert.equal(resolvePhase(gatesGreen(), 0, DOCS)?.role, "documenter");
  // Same task, nothing documented changed: skip straight to critic (D-013) — not reviewer directly.
  assert.equal(resolvePhase(gatesGreen(), 0, NO_DOCS)?.role, "critic");
  // One-shot: its own progress-log entry is the marker.
  const documented = gatesGreen({ comments: [comment("documenter")] });
  assert.equal(resolvePhase(documented, 0, DOCS)?.role, "critic");
  // Another role's comment must not be mistaken for the documenter's.
  const noisy = gatesGreen({ comments: [comment("executor"), comment("senior")] });
  assert.equal(resolvePhase(noisy, 0, DOCS)?.role, "documenter");
});

test("a reviewed task is finished; terminal and blocked states are never re-entered", () => {
  const shipped = gatesGreen({ finalSummary: "done", implementationNotes: "**critic:** looks good" });
  assert.equal(resolvePhase(shipped, 0, NO_DOCS), null);
  for (const status of [STATUS.done, STATUS.blocked, STATUS.review]) {
    assert.equal(resolvePhase(task({ status }), 0, DOCS), null);
  }
  const blockedByDeps = task({
    readiness: { isReady: false, isBlocked: true, blockingDependencies: ["TASK-9"], missingDependencies: [] },
  });
  assert.equal(resolvePhase(blockedByDeps, 0, NO_DOCS), null);
});

test("a container task skips implementation and goes to documenter/architect/reviewer", () => {
  const container = task({ subtasks: [{ id: "TASK-1.1", title: "child" }], description: null });
  // Description is null, but a container must not be routed to owner.
  assert.equal(resolvePhase(container, 0, DOCS)?.role, "documenter");
  // No alignment check yet: architect runs before reviewer, even with no docs signal.
  assert.equal(resolvePhase(container, 0, NO_DOCS)?.role, "architect");
  // One-shot, same pattern as hasDocumented: its own notes entry is the marker.
  // Aligned, but critic hasn't weighed in yet (D-013) — critic runs before reviewer.
  const checked = task({
    subtasks: [{ id: "TASK-1.1", title: "child" }],
    description: null,
    implementationNotes: "**architect (alignment check):** looks fine",
  });
  assert.equal(resolvePhase(checked, 0, NO_DOCS)?.role, "critic");
  // Aligned AND critic shipped: now it reaches reviewer.
  const shipped = task({
    subtasks: [{ id: "TASK-1.1", title: "child" }],
    description: null,
    implementationNotes: "**architect (alignment check):** looks fine\n\n**critic:** ship it",
  });
  assert.equal(resolvePhase(shipped, 0, NO_DOCS)?.role, "reviewer");
  // A pre-split contract's marker must not be mistaken for the alignment check's.
  const onlyContract = task({
    subtasks: [{ id: "TASK-1.1", title: "child" }],
    description: null,
    implementationNotes: "**architect:** pre-split constraints",
  });
  assert.equal(resolvePhase(onlyContract, 0, NO_DOCS)?.role, "architect");
});

test("parseAlignmentOutput requires an explicit first-line verdict, defaulting to drift", () => {
  assert.equal(parseAlignmentOutput("ALIGNED\nChecked source-content.ts, one definition.").drift, false);
  assert.equal(parseAlignmentOutput("DRIFT\nTwo incompatible getSourceContent signatures.").drift, true);
  // Case-insensitive, and leading blank lines don't defeat the check.
  assert.equal(parseAlignmentOutput("\n\naligned\nfine").drift, false);
  // No parseable verdict on the first non-blank line: fail safe, not fail open.
  assert.equal(parseAlignmentOutput("I think everything looks aligned here.").drift, true);
  assert.equal(parseAlignmentOutput("").drift, true);
});

test("parseCriticOutput requires an explicit first-line verdict, defaulting to changes", () => {
  assert.equal(parseCriticOutput("SHIP\nLooks right.").verdict, "ship");
  assert.equal(parseCriticOutput("CHANGES\nThe error path never releases the lock.").verdict, "changes");
  assert.equal(parseCriticOutput("RESPEC\nThe plan never accounted for concurrent writers.").verdict, "respec");
  // Case-insensitive, and leading blank lines don't defeat the check.
  assert.equal(parseCriticOutput("\n\nship\nfine").verdict, "ship");
  // No parseable verdict: fail toward "needs another look", not "ship it" or
  // "blow up the plan" — a formatting slip is far more likely than either extreme.
  assert.equal(parseCriticOutput("I think this looks fine overall.").verdict, "changes");
  assert.equal(parseCriticOutput("").verdict, "changes");
});

test("senior escalation is machine-failure-gated: it stops applying once acDone is true", () => {
  // Pre-success: attempts >= 2 still escalates, exactly as before.
  assert.equal(resolvePhase(executing(), 2, NO_DOCS)?.role, "senior");
  // Post-success: the same attempts count must route to critic, never senior —
  // otherwise a couple of legitimate critic/executor revision rounds (D-013)
  // would strand a fine task on the read-only senior role forever.
  assert.equal(resolvePhase(gatesGreen(), 2, NO_DOCS)?.role, "critic");
  assert.equal(resolvePhase(gatesGreen(), 5, NO_DOCS)?.role, "critic");
});

test("critic (D-013): SHIP reaches reviewer, CHANGES routes back to executor via a label", () => {
  // No verdict yet: critic runs before reviewer.
  assert.equal(resolvePhase(gatesGreen(), 0, NO_DOCS)?.role, "critic");
  // SHIP recorded: now reviewer.
  const shipped = gatesGreen({ implementationNotes: "**critic:** ship it" });
  assert.equal(resolvePhase(shipped, 0, NO_DOCS)?.role, "reviewer");
  // CHANGES: the label routes straight back to executor, bypassing the
  // acceptance-criteria-complete path entirely, even though AC are checked.
  const changesRequested = gatesGreen({ labels: [NEEDS_CHANGES_LABEL] });
  assert.equal(resolvePhase(changesRequested, 0, NO_DOCS)?.role, "executor");
  // ...and even with a high attempts count, since this is post-success territory.
  assert.equal(resolvePhase(changesRequested, 5, NO_DOCS)?.role, "executor");
});

test("critic (D-013): a container gets a binary SHIP-or-blocked gate, same shape as DRIFT", () => {
  const aligned = task({
    subtasks: [{ id: "TASK-1.1", title: "child" }],
    description: null,
    implementationNotes: "**architect (alignment check):** looks fine",
  });
  assert.equal(resolvePhase(aligned, 0, NO_DOCS)?.role, "critic");
  // A container blocked by a critic verdict (tick.ts sets NEEDS_REPLAN_LABEL
  // and STATUS.blocked) is never re-entered, same as an alignment DRIFT.
  const blocked = task({
    subtasks: [{ id: "TASK-1.1", title: "child" }],
    description: null,
    status: STATUS.blocked,
    labels: [NEEDS_REPLAN_LABEL],
    implementationNotes: "**architect (alignment check):** looks fine",
  });
  assert.equal(resolvePhase(blocked, 0, NO_DOCS), null);
});

test("NEEDS_HUMAN_REVIEW_LABEL is purely informational — status is what actually halts routing", () => {
  const exhausted = task({ status: STATUS.blocked, labels: [NEEDS_HUMAN_REVIEW_LABEL] });
  assert.equal(resolvePhase(exhausted, 0, NO_DOCS), null);
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

test("rootAncestorId walks a nested split all the way to the top-level task", () => {
  const summary = (id: string, parentTaskId: string | null): TaskSummary => ({
    id,
    title: id,
    status: STATUS.backlog,
    priority: null,
    assignees: [],
    labels: [],
    ordinal: 0,
    acceptanceCriteriaCompleted: 0,
    acceptanceCriteriaCount: 0,
    isReady: true,
    parentTaskId,
  });

  // TASK-6 -> TASK-6.3 -> TASK-6.3.1: a subtask split, then split again.
  const all: TaskSummary[] = [
    summary("TASK-6", null),
    summary("TASK-6.3", "TASK-6"),
    summary("TASK-6.3.1", "TASK-6.3"),
  ];
  assert.equal(rootAncestorId("TASK-6.3.1", all), "TASK-6");
  assert.equal(rootAncestorId("TASK-6.3", all), "TASK-6");
  assert.equal(rootAncestorId("TASK-6", all), "TASK-6");

  // A cycle (data corruption) fails loudly instead of looping forever.
  const cyclic: TaskSummary[] = [summary("A", "B"), summary("B", "A")];
  assert.throws(() => rootAncestorId("A", cyclic), /Cycle detected/);
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

test("planner split headers survive a local model's numbering and bolding", () => {
  // Verbatim shape from a real run that crashed the loop five times: the
  // planner numbers each header, which the original literal `## Subtask:`
  // matcher rejected wholesale.
  const numbered = parsePlannerOutput(
    [
      "I'll split it.",
      "",
      "SPLIT",
      "",
      "## Subtask 1: CDK S3 bucket provisioning",
      "Description: Add the bucket with versioning.",
      "Acceptance criteria:",
      "1. The stack creates an s3.Bucket",
      "2. pnpm typecheck passes",
      "",
      "### **Subtask 2** — Schema updates",
      "**Description:** Extend sourceSchema.",
      "**Acceptance criteria:**",
      "1. The Source type gains three fields",
    ].join("\n"),
  );
  assert.equal(numbered.kind, "split");
  assert(numbered.kind === "split");
  assert.deepEqual(
    numbered.children.map((c) => c.title),
    ["CDK S3 bucket provisioning", "Schema updates"],
  );
  assert.equal(numbered.children[0]!.description, "Add the bucket with versioning.");
  assert.deepEqual(numbered.children[0]!.acceptanceCriteria, [
    "The stack creates an s3.Bucket",
    "pnpm typecheck passes",
  ]);
  assert.deepEqual(numbered.children[1]!.acceptanceCriteria, ["The Source type gains three fields"]);

  // No SPLIT marker: everything is a plan, untouched.
  assert.deepEqual(parsePlannerOutput("Step 1. Edit foo.ts"), { kind: "plan", plan: "Step 1. Edit foo.ts" });

  // A SPLIT with no readable blocks REPORTS rather than throws — a throw
  // reaches main.ts's crash counter and ends the whole unattended run.
  const broken = parsePlannerOutput("SPLIT\n\nJust some prose, no subtask headers at all.");
  assert.equal(broken.kind, "unparseable");
});

test("siblingScopeFor names aunts and uncles, not a task's own children", async () => {
  const summary = (id: string, parentTaskId: string | null): TaskSummary => ({
    id,
    title: `title of ${id}`,
    status: STATUS.backlog,
    priority: null,
    assignees: [],
    labels: [],
    ordinal: 0,
    acceptanceCriteriaCompleted: 0,
    acceptanceCriteriaCount: 0,
    isReady: true,
    parentTaskId,
  });

  // The `book` tree that produced the duplication: TASK-1 split into 1.1-1.6,
  // then 1.4 split again into 1.4.1-1.4.2. 1.4's architect wrote a contract
  // re-specifying 1.1's and 1.2's work verbatim because it could not see them.
  const all: TaskSummary[] = [
    summary("TASK-1", null),
    summary("TASK-1.1", "TASK-1"),
    summary("TASK-1.2", "TASK-1"),
    summary("TASK-1.4", "TASK-1"),
    summary("TASK-1.4.1", "TASK-1.4"),
    summary("TASK-1.4.2", "TASK-1.4"),
  ];
  const view = async (id: string) => task({ id, title: `title of ${id}`, description: `desc of ${id}` });

  const scope = await siblingScopeFor(task({ id: "TASK-1.4", parentTaskId: "TASK-1" }), all, view);
  assert(scope);
  // Sees its siblings...
  assert.deepEqual(
    scope.owned.map((t) => t.id),
    ["TASK-1.1", "TASK-1.2"],
  );
  // ...and the original ask it was carved out of.
  assert.deepEqual(
    scope.ancestors.map((a) => a.id),
    ["TASK-1"],
  );

  // A leaf sees its cousins and its whole ancestor chain, root first.
  const leaf = await siblingScopeFor(task({ id: "TASK-1.4.1", parentTaskId: "TASK-1.4" }), all, view);
  assert(leaf);
  assert.deepEqual(
    leaf.owned.map((t) => t.id),
    ["TASK-1.1", "TASK-1.2", "TASK-1.4.2"],
  );
  assert.deepEqual(
    leaf.ancestors.map((a) => a.id),
    ["TASK-1", "TASK-1.4"],
  );

  // A top-level task with no tree costs zero lookups and yields nothing.
  let views = 0;
  const counted = async (id: string) => {
    views++;
    return task({ id });
  };
  assert.equal(await siblingScopeFor(task({ id: "TASK-9" }), [summary("TASK-9", null)], counted), undefined);
  assert.equal(views, 0);
});

test("findCollisions flags unrelated tasks claiming one file, not parent/child", () => {
  const summary = (id: string, parentTaskId: string | null): TaskSummary => ({
    id,
    title: id,
    status: STATUS.backlog,
    priority: null,
    assignees: [],
    labels: [],
    ordinal: 0,
    acceptanceCriteriaCompleted: 0,
    acceptanceCriteriaCount: 0,
    isReady: true,
    parentTaskId,
  });
  const claiming = (id: string, parentTaskId: string | null, ...paths: string[]) =>
    task({
      id,
      parentTaskId,
      description: null,
      implementationPlan: null,
      acceptanceCriteria: paths.map((p, i) => ({ index: i + 1, text: `Update ${p} to do the thing`, checked: false })),
    });

  const all = [
    summary("TASK-1", null),
    summary("TASK-1.1", "TASK-1"),
    summary("TASK-1.4", "TASK-1"),
    summary("TASK-1.4.1", "TASK-1.4"),
  ];

  // The `book` failure: a niece and an aunt both claiming the CDK stack.
  const collisions = findCollisions(
    [
      claiming("TASK-1", null, "apps/infra/lib/bookmark-digest-stack.ts"),
      claiming("TASK-1.1", "TASK-1", "apps/infra/lib/bookmark-digest-stack.ts"),
      claiming("TASK-1.4", "TASK-1", "packages/schemas/src/index.ts"),
      claiming("TASK-1.4.1", "TASK-1.4", "apps/infra/lib/bookmark-digest-stack.ts"),
    ],
    all,
  );
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]!.path, "apps/infra/lib/bookmark-digest-stack.ts");
  // TASK-1 is an ancestor of both, so it is not itself a colliding claimant.
  assert.deepEqual(collisions[0]!.taskIds, ["TASK-1.1", "TASK-1.4.1"]);

  // A container describing only its own child's file is normal, not a collision.
  assert.deepEqual(
    findCollisions(
      [claiming("TASK-1", null, "src/a.ts"), claiming("TASK-1.1", "TASK-1", "src/a.ts")],
      all,
    ),
    [],
  );

  // Distinct files across siblings: clean.
  assert.deepEqual(
    findCollisions(
      [claiming("TASK-1.1", "TASK-1", "src/a.ts"), claiming("TASK-1.4", "TASK-1", "src/b.ts")],
      all,
    ),
    [],
  );
});

test("extractPaths takes repo paths and leaves prose and URLs alone", () => {
  assert.deepEqual([...extractPaths("Edit `apps/infra/lib/dynamo.ts` and packages/schemas/src/index.ts.")], [
    "apps/infra/lib/dynamo.ts",
    "packages/schemas/src/index.ts",
  ]);
  // Needs a directory segment: a bare filename in prose is not a claim.
  assert.deepEqual([...extractPaths("Run pnpm typecheck, then check handler.ts")], []);
  // A URL's host/path is shaped like a repo path but never is one.
  assert.deepEqual([...extractPaths("See https://example.com/docs/guide.md for details")], []);
  assert.deepEqual([...extractPaths(null)], []);
});

test("a container with a known overlap stops instead of walking on to review", () => {
  const container = gatesGreen({
    subtasks: [{ id: "TASK-1.1", title: "child" }],
    finalSummary: null,
    labels: [NEEDS_REPLAN_LABEL],
  });
  assert.equal(resolvePhase(container, 0, NO_DOCS), null);
  // Without the label the same container proceeds to its alignment check.
  assert.equal(resolvePhase({ ...container, labels: [] }, 0, NO_DOCS)?.role, "architect");
});
