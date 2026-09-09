import { TASK_TYPES } from "./types.js";

/** Matches a numbered ("1.", "1)", "1:") or bulleted ("-", "*") list item. */
const AC_LINE = /^\s*(?:\d+[.):]|[-*])\s+(.*)$/;

const TYPE_LINE = /^\s*(?:\*\*)?Type(?:\*\*)?:\s*`?([A-Za-z-]+)`?\s*\.?\s*$/i;

/**
 * Splits the owner role's free-text output into a description and a task
 * type. The owner no longer writes acceptance criteria — that's the
 * `criteria` role's single job, deliberately run as its own tick against
 * the description alone (see `resolvePhase`).
 *
 * An unrecognised type is dropped rather than returned: Backlog.md rejects a
 * type outside its configured list, and killing a tick over a cosmetic field
 * would be a worse outcome than leaving `type` unset for a human to pick.
 */
export function parseOwnerOutput(text: string): {
  description: string;
  type: string | null;
} {
  const lines = text.split("\n");

  // Only the LAST non-blank line counts: the type line is requested last, and
  // the description itself may legitimately discuss "type:" in its prose.
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx]!.trim() === "") lastIdx--;
  const typeIdx = lastIdx >= 0 && TYPE_LINE.test(lines[lastIdx]!) ? lastIdx : -1;

  if (typeIdx === -1) return { description: text.trim(), type: null };

  const raw = lines[typeIdx]!.match(TYPE_LINE)![1]!.toLowerCase();
  const type = (TASK_TYPES as readonly string[]).includes(raw) ? raw : null;
  return { description: lines.slice(0, typeIdx).join("\n").trim(), type };
}

const DOD_HEADER = /^\s*(?:#{2,4}\s*)?\*{0,2}Definition of done\*{0,2}:\*{0,2}\s*$/i;

/**
 * Splits the `criteria` role's output into acceptance criteria and
 * Definition-of-Done items, on two literal header lines (same contract as
 * `parsePlannerOutput`). Header lookup rather than list-shape guessing, for
 * the reason recorded in git history: an earlier heuristic-only owner parser
 * truncated descriptions at their own first bullet.
 *
 * If the model omits the AC header entirely (local models don't always
 * follow formatting instructions), fall back to treating every list item
 * before any DoD header as acceptance criteria — an over-full AC list is
 * recoverable by a human, an empty one stalls the loop.
 */
export function parseCriteriaOutput(text: string): {
  acceptanceCriteria: string[];
  definitionOfDone: string[];
} {
  const lines = text.split("\n");
  const dodIdx = lines.findIndex((l) => DOD_HEADER.test(l));
  const acHeaderIdx = lines.findIndex((l) => AC_HEADER.test(l));

  const acEnd = dodIdx === -1 ? lines.length : dodIdx;
  const acStart = acHeaderIdx !== -1 && acHeaderIdx < acEnd ? acHeaderIdx + 1 : 0;

  const items = (from: number, to: number) =>
    lines
      .slice(from, to)
      .map((l) => l.match(AC_LINE)?.[1]?.trim())
      .filter((s): s is string => Boolean(s));

  return {
    acceptanceCriteria: items(acStart, acEnd),
    definitionOfDone: dodIdx === -1 ? [] : items(dodIdx + 1, lines.length),
  };
}

const ALIGNMENT_LINE = /^\s*(ALIGNED|DRIFT)\b/i;

/**
 * Parses the architect's post-split alignment verdict. Requires an explicit
 * token on the first non-blank line, the same contract as `SPLIT_MARKER` and
 * `TYPE_LINE` — not a prose scan, so a model can't accidentally trip it by
 * discussing "drift" in passing.
 *
 * Defaults to `drift: true` when the marker is missing or unparseable: an
 * architect that didn't follow the format is not evidence of alignment, and
 * this check exists specifically so silence reads as "unverified," not
 * "fine" (see D-007 — block-on-drift was the deliberate choice over
 * informational-only).
 */
export function parseAlignmentOutput(text: string): { drift: boolean; report: string } {
  const lines = text.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  const match = firstIdx === -1 ? null : lines[firstIdx]!.match(ALIGNMENT_LINE);
  if (!match) return { drift: true, report: text.trim() };
  return { drift: match[1]!.toUpperCase() === "DRIFT", report: text.trim() };
}

export interface PlannerSplit {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export type PlannerOutput =
  | { kind: "plan"; plan: string }
  | { kind: "split"; children: PlannerSplit[] }
  /**
   * A `SPLIT` marker whose blocks could not be read. Returned rather than
   * thrown: a throw propagates past tick.ts into main.ts's crash counter,
   * which takes down an unattended run over one badly formatted reply. The
   * caller blocks the one task and keeps the loop alive.
   */
  | { kind: "unparseable"; text: string };

const SPLIT_MARKER = /^\s*SPLIT\s*$/i;
/**
 * Deliberately tolerant of how a local model decorates a header it was told
 * to write literally: any of `## Subtask: x`, `### Subtask 3: x`,
 * `## Subtask 1.4 - x`, `## **Subtask:** x`. A run died five times over the
 * single digit in `## Subtask 1:` — see the header-format gotcha. The
 * *marker word* is still required; only its ornaments are optional.
 */
const SUBTASK_HEADER = /^\s*#{2,4}\s*(?:\*\*)?\s*Subtask\s*(?:\d+(?:\.\d+)*)?\s*(?:\*\*)?\s*[:\-\u2013\u2014]\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$/i;
const DESCRIPTION_LINE = /^\s*\*{0,2}Description\*{0,2}:\*{0,2}\s*(.*)$/i;
const AC_HEADER = /^\s*(?:#{2,4}\s*)?\*{0,2}Acceptance criteria\*{0,2}:\*{0,2}\s*$/i;

/**
 * Parses the planner's free-text output per prompts/planner.md's requested
 * shape: either a plan, or a `SPLIT` marker followed by one `## Subtask:`
 * block per child (title, description, numbered acceptance criteria).
 */
export function parsePlannerOutput(text: string): PlannerOutput {
  const lines = text.split("\n");
  const splitAt = lines.findIndex((l) => SPLIT_MARKER.test(l));
  if (splitAt === -1) return { kind: "plan", plan: text.trim() };

  const children: PlannerSplit[] = [];
  let current: { title: string; descLines: string[]; ac: string[] } | null = null;
  let inAc = false;

  const flush = () => {
    if (!current) return;
    children.push({
      title: current.title,
      description: current.descLines.join("\n").trim(),
      acceptanceCriteria: current.ac,
    });
  };

  for (const line of lines.slice(splitAt + 1)) {
    const header = line.match(SUBTASK_HEADER);
    if (header) {
      flush();
      current = { title: header[1]!.trim(), descLines: [], ac: [] };
      inAc = false;
      continue;
    }
    if (!current) continue;
    if (AC_HEADER.test(line)) {
      inAc = true;
      continue;
    }
    if (inAc) {
      const ac = line.match(AC_LINE)?.[1]?.trim();
      if (ac) current.ac.push(ac);
      continue;
    }
    const desc = line.match(DESCRIPTION_LINE);
    current.descLines.push(desc ? desc[1]! : line);
  }
  flush();

  if (children.length === 0) return { kind: "unparseable", text: text.trim() };
  return { kind: "split", children };
}
