/** Matches a numbered ("1.", "1)", "1:") or bulleted ("-", "*") list item. */
const AC_LINE = /^\s*(?:\d+[.):]|[-*])\s+(.*)$/;

/**
 * Splits the owner role's free-text output into a description and a list
 * of acceptance criteria, per prompts/owner.md's requested shape: prose,
 * then a numbered list. Everything before the first list-like line is the
 * description; every subsequent matching line is one criterion.
 */
export function parseOwnerOutput(text: string): {
  description: string;
  acceptanceCriteria: string[];
} {
  const lines = text.split("\n");
  const acStart = lines.findIndex((l) => AC_LINE.test(l));
  if (acStart === -1) {
    return { description: text.trim(), acceptanceCriteria: [] };
  }
  const description = lines.slice(0, acStart).join("\n").trim();
  const acceptanceCriteria = lines
    .slice(acStart)
    .map((l) => l.match(AC_LINE)?.[1]?.trim())
    .filter((s): s is string => Boolean(s));
  return { description, acceptanceCriteria };
}
