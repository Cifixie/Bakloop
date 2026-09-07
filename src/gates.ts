import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Baseline {
  testsPassing: number;
  diffHash: string;
}

export interface GateResult {
  ok: boolean;
  /** Stable identity of the failure, for detecting "stuck" vs "progressing". */
  signature: string;
  failures: string[];
  diffHash: string;
  testsPassing: number;
}

async function tryRun(cmd: string, args: string[], cwd: string) {
  try {
    const { stdout, stderr } = await run(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

/** First compiler error, normalized so line numbers don't mask a repeat. */
function errorSignature(out: string): string {
  const line = out
    .split("\n")
    .find((l) => /error/i.test(l))
    ?.replace(/:\d+:\d+/g, ":L:C")
    .replace(/\d+/g, "N")
    .trim();
  return line ? createHash("sha1").update(line).digest("hex").slice(0, 12) : "none";
}

function countPassing(out: string): number {
  const m = out.match(/(\d+)\s+pass(?:ed|ing)?/i);
  return m ? Number(m[1]) : 0;
}

export async function captureBaseline(cwd: string): Promise<Baseline> {
  const tests = await tryRun("npx", ["vitest", "run", "--reporter=basic"], cwd);
  const diff = await tryRun("git", ["diff", "HEAD"], cwd);
  return {
    testsPassing: countPassing(tests.out),
    diffHash: createHash("sha1").update(diff.out).digest("hex").slice(0, 12),
  };
}

/**
 * Runs after every executor tick. The model's summary is not read here,
 * and is not read anywhere: an overly positive report is harmless if
 * nothing parses it.
 */
export async function runGates(cwd: string, base: Baseline): Promise<GateResult> {
  const failures: string[] = [];

  const diff = await tryRun("git", ["diff", "HEAD"], cwd);
  const diffHash = createHash("sha1").update(diff.out).digest("hex").slice(0, 12);

  // Highest-value single check: claimed done, changed nothing.
  if (diff.out.trim() === "") failures.push("empty-diff");

  // Cycling rather than progressing.
  if (diffHash === base.diffHash && diff.out.trim() !== "") {
    failures.push("diff-unchanged-since-last-attempt");
  }

  const tsc = await tryRun("npx", ["tsc", "--noEmit"], cwd);
  if (tsc.code !== 0) failures.push("tsc");

  const lint = await tryRun("npx", ["biome", "check", "."], cwd);
  if (lint.code !== 0) failures.push("biome");

  const tests = await tryRun("npx", ["vitest", "run", "--reporter=basic"], cwd);
  const testsPassing = countPassing(tests.out);
  if (tests.code !== 0) failures.push("vitest");

  // Deleting or skipping a failing test is how a model makes the loop
  // go green. A drop in pass count is a failure, never a pass.
  if (testsPassing < base.testsPassing) {
    failures.push(`test-count-regression ${base.testsPassing}->${testsPassing}`);
  }

  return {
    ok: failures.length === 0,
    signature: errorSignature(tsc.out + tests.out),
    failures,
    diffHash,
    testsPassing,
  };
}

/** Same error twice = stuck (escalate). Different errors = progressing. */
export function isStuck(signatures: string[]): boolean {
  const n = signatures.length;
  return n >= 2 && signatures[n - 1] === signatures[n - 2] && signatures[n - 1] !== "none";
}
