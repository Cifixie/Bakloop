import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
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

/** Which of bakloop's own checks this target repo's toolchain actually supports. */
export interface GateConfig {
  tsc: boolean;
  biome: boolean;
  vitest: boolean;
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

const SKIPPED = { code: 0, out: "" };

async function hasDependency(cwd: string, name: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}

/**
 * Every registered project drives its own repo, which may not share
 * bakloop's own toolchain — probe for what's actually there instead of
 * assuming tsc/biome/vitest and failing every gate unconditionally.
 */
export async function detectGateConfig(cwd: string): Promise<GateConfig> {
  const vitestConfig = ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs"].some(
    (f) => existsSync(join(cwd, f)),
  );
  return {
    tsc: existsSync(join(cwd, "tsconfig.json")),
    biome:
      (await hasDependency(cwd, "@biomejs/biome")) ||
      existsSync(join(cwd, "biome.json")) ||
      existsSync(join(cwd, "biome.jsonc")),
    vitest: (await hasDependency(cwd, "vitest")) || vitestConfig,
  };
}

/** Detected once per project and cached to disk — not re-probed every tick. */
export async function loadGateConfig(cwd: string, cachePath: string): Promise<GateConfig> {
  try {
    return JSON.parse(await readFile(cachePath, "utf-8")) as GateConfig;
  } catch {
    const detected = await detectGateConfig(cwd);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(detected, null, 2), "utf-8");
    return detected;
  }
}

/** Cumulative diff for this task's branch: everything committed since it forked, `A...B` diffs against the merge-base automatically. */
async function branchDiff(cwd: string, baseBranch: string) {
  return tryRun("git", ["diff", `${baseBranch}...HEAD`], cwd);
}

export async function captureBaseline(cwd: string, baseBranch: string, config: GateConfig): Promise<Baseline> {
  const tests = config.vitest ? await tryRun("npx", ["vitest", "run"], cwd) : SKIPPED;
  const diff = await branchDiff(cwd, baseBranch);
  return {
    testsPassing: countPassing(tests.out),
    diffHash: createHash("sha1").update(diff.out).digest("hex").slice(0, 12),
  };
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

/**
 * Runs after every executor tick. The model's summary is not read here,
 * and is not read anywhere: an overly positive report is harmless if
 * nothing parses it.
 */
export async function runGates(cwd: string, base: Baseline, config: GateConfig, baseBranch: string): Promise<GateResult> {
  const failures: string[] = [];

  // The executor is expected to commit its own work now (see prompts/executor.md);
  // a dirty tree means it either forgot or is still mid-edit, either way not done.
  const status = await tryRun("git", ["status", "--porcelain"], cwd);
  if (status.out.trim() !== "") failures.push("uncommitted-changes");

  const diff = await branchDiff(cwd, baseBranch);
  const diffHash = createHash("sha1").update(diff.out).digest("hex").slice(0, 12);

  // Highest-value single check: claimed done, changed nothing since this branch forked.
  if (diff.out.trim() === "") failures.push("empty-diff");

  // Cycling rather than progressing: no new commits since this attempt started.
  if (diffHash === base.diffHash && diff.out.trim() !== "") {
    failures.push("diff-unchanged-since-last-attempt");
  }

  const tsc = config.tsc ? await tryRun("npx", ["tsc", "--noEmit"], cwd) : SKIPPED;
  if (config.tsc && tsc.code !== 0) failures.push("tsc");

  const lint = config.biome ? await tryRun("npx", ["biome", "check", "."], cwd) : SKIPPED;
  if (config.biome && lint.code !== 0) failures.push("biome");

  const tests = config.vitest ? await tryRun("npx", ["vitest", "run"], cwd) : SKIPPED;
  const testsPassing = config.vitest ? countPassing(tests.out) : 0;
  if (config.vitest && tests.code !== 0) failures.push("vitest");

  // Deleting or skipping a failing test is how a model makes the loop
  // go green. A drop in pass count is a failure, never a pass.
  if (config.vitest && testsPassing < base.testsPassing) {
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
