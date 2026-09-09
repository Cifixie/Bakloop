import type { Role } from "./types.js";

/**
 * Plain ANSI painting, no dependency: bakloop's terminal output is one
 * process writing to its own stdout, not a library used elsewhere. Colors
 * are silently disabled when stdout isn't a TTY or NO_COLOR is set, so
 * piping to a file or log aggregator never gets escape codes.
 */
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const RESET = "\x1b[0m";

function paint(code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

// One color per role so a scrolling terminal can be scanned by eye — which
// role is talking — without reading the "[role]" tag itself.
const ROLE_COLORS: Record<Role, string> = {
  owner: "\x1b[36m", // cyan
  criteria: "\x1b[96m", // bright cyan
  architect: "\x1b[34m", // blue
  researcher: "\x1b[94m", // bright blue
  planner: "\x1b[35m", // magenta
  executor: "\x1b[32m", // green
  senior: "\x1b[95m", // bright magenta
  documenter: "\x1b[93m", // bright yellow
  reviewer: "\x1b[92m", // bright green
};

const GRAY = "\x1b[90m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[91m";

/** Colored "[role]" tag for a role's own output lines. */
export function roleTag(role: Role | string): string {
  const color = ROLE_COLORS[role as Role] ?? GRAY;
  return paint(color, `[${role}]`);
}

/** Colored "[tag]" for non-role sources (main, tick, journal, ai, ...). */
export function tag(name: string): string {
  return paint(GRAY, `[${name}]`);
}

export function warn(text: string): string {
  return paint(YELLOW, text);
}

export function error(text: string): string {
  return paint(RED, text);
}

export function dim(text: string): string {
  return paint(GRAY, text);
}
