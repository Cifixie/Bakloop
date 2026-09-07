/** Matches a numbered ("1.", "1)", "1:") or bulleted ("-", "*") list item. */
const AC_LINE = /^\s*(?:\d+[.):]|[-*])\s+(.*)$/;

/**
 * Splits the owner role's free-text output into a description and a list
 * of acceptance criteria. prompts/owner.md asks for an explicit `Acceptance
 * criteria:` header line (same contract as AC_HEADER/parsePlannerOutput
 * below) so the split is a literal header lookup, not a guess at where a
 * list "starts" — the description itself often contains its own list-like
 * lines (e.g. "supports: 1. X 2. Y"), which made an earlier heuristic-only
 * version of this function truncate the description at its own first
 * bullet. If the model ignores the header (local models don't always
 * follow formatting instructions), fall back to treating the trailing
 * contiguous run of list-item/blank lines as the AC block.
 */
export function parseOwnerOutput(text: string): {
  description: string;
  acceptanceCriteria: string[];
} {
  const lines = text.split("\n");

  const headerIdx = lines.findIndex((l) => AC_HEADER.test(l));
  if (headerIdx !== -1) {
    const description = lines.slice(0, headerIdx).join("\n").trim();
    const acceptanceCriteria = lines
      .slice(headerIdx + 1)
      .map((l) => l.match(AC_LINE)?.[1]?.trim())
      .filter((s): s is string => Boolean(s));
    return { description, acceptanceCriteria };
  }

  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;

  let start = end;
  while (start > 0 && (lines[start - 1]!.trim() === "" || AC_LINE.test(lines[start - 1]!))) start--;

  const block = lines.slice(start, end);
  if (!block.some((l) => AC_LINE.test(l))) {
    return { description: text.trim(), acceptanceCriteria: [] };
  }
  const description = lines.slice(0, start).join("\n").trim();
  const acceptanceCriteria = block
    .map((l) => l.match(AC_LINE)?.[1]?.trim())
    .filter((s): s is string => Boolean(s));
  return { description, acceptanceCriteria };
}

export interface PlannerSplit {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export type PlannerOutput = { kind: "plan"; plan: string } | { kind: "split"; children: PlannerSplit[] };

const SPLIT_MARKER = /^\s*SPLIT\s*$/i;
const SUBTASK_HEADER = /^\s*##\s*Subtask:\s*(.+?)\s*$/i;
const DESCRIPTION_LINE = /^\s*Description:\s*(.*)$/i;
const AC_HEADER = /^\s*Acceptance criteria:\s*$/i;

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

  if (children.length === 0) {
    throw new Error(`Planner requested a split but no subtasks were parseable:\n${text}`);
  }
  return { kind: "split", children };
}
