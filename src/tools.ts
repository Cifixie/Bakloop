import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { gitGuardDir } from "./git-guard.js";
import type { ToolName } from "./types.js";

const run = promisify(execFile);

/**
 * Plain AgentTool implementations, kept independent of pi's harness tool
 * types: those are wired to Context/ExecutionEnv from the full harness
 * runtime, which this orchestrator deliberately does not use (one model
 * call per tick, no session/compaction machinery).
 */
function resolveInCwd(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function createReadTool(cwd: string): AgentTool {
  return {
    name: "read",
    label: "Read",
    description: `Read the contents of a text file. Relative paths resolve against ${cwd} — that is the repo root; do not read outside it.`,
    parameters: Type.Object({
      path: Type.String({ description: `Path to the file, relative to ${cwd}` }),
    }),
    execute: async (_toolCallId, params) => {
      const path = (params as { path: string }).path;
      const content = await readFile(resolveInCwd(cwd, path), "utf-8");
      return { content: [{ type: "text", text: content }], details: { path } };
    },
  };
}

export function createWriteTool(cwd: string): AgentTool {
  return {
    name: "write",
    label: "Write",
    description: `Write content to a file, creating it if missing and overwriting it if present. Creates parent directories as needed. Relative paths resolve against ${cwd} — that is the repo root; do not write outside it.`,
    parameters: Type.Object({
      path: Type.String({ description: `Path to the file, relative to ${cwd}` }),
      content: Type.String({ description: "Full content to write" }),
    }),
    execute: async (_toolCallId, params) => {
      const { path, content } = params as { path: string; content: string };
      const absolute = resolveInCwd(cwd, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf-8");
      return { content: [{ type: "text", text: `Wrote ${path}` }], details: { path } };
    },
  };
}

export function createEditTool(cwd: string): AgentTool {
  return {
    name: "edit",
    label: "Edit",
    description: `Replace one exact occurrence of text in a file. oldText must match uniquely and exactly, including whitespace. Relative paths resolve against ${cwd} — that is the repo root; do not edit outside it.`,
    parameters: Type.Object({
      path: Type.String({ description: `Path to the file, relative to ${cwd}` }),
      oldText: Type.String({ description: "Exact text to replace; must be unique in the file" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
    execute: async (_toolCallId, params) => {
      const { path, oldText, newText } = params as { path: string; oldText: string; newText: string };
      const absolute = resolveInCwd(cwd, path);
      const original = await readFile(absolute, "utf-8");
      const occurrences = original.split(oldText).length - 1;
      if (occurrences === 0) throw new Error(`oldText not found in ${path}`);
      if (occurrences > 1) throw new Error(`oldText matches ${occurrences} times in ${path}; must be unique`);
      const updated = original.replace(oldText, newText);
      await writeFile(absolute, updated, "utf-8");
      return { content: [{ type: "text", text: `Edited ${path}` }], details: { path } };
    },
  };
}

/**
 * The documenter role's whole reason to exist is a smaller blast radius than
 * the executor's — this is the actual enforcement, not just a prompt
 * instruction. README* (any extension), anything under docs/ or wiki/, and
 * any *.md/*.mdx file anywhere in the repo. A path that resolves outside
 * `cwd` (e.g. via `../`) is never a doc path, regardless of name.
 */
const DOC_PATH_PATTERN = /(^|\/)(README(\.[^/]*)?|docs\/.*|wiki\/.*|.*\.mdx?)$/i;

function isDocPath(cwd: string, rawPath: string): boolean {
  const absolute = resolveInCwd(cwd, rawPath);
  const rel = relative(cwd, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return DOC_PATH_PATTERN.test(rel);
}

function assertDocPath(cwd: string, path: string): void {
  if (!isDocPath(cwd, path)) {
    throw new Error(
      `Refusing to write "${path}" — the documenter role is restricted to documentation ` +
        `files (README*, docs/**, wiki/**, *.md/*.mdx).`,
    );
  }
}

export function createDocsWriteTool(cwd: string): AgentTool {
  const write = createWriteTool(cwd);
  return {
    ...write,
    name: "docsWrite",
    description: `Write content to a documentation file (README*, docs/**, wiki/**, *.md/*.mdx), creating it if missing and overwriting it if present. Creates parent directories as needed. Relative paths resolve against ${cwd}. Refuses any path that isn't a documentation file.`,
    execute: async (toolCallId, params, signal) => {
      const { path } = params as { path: string };
      assertDocPath(cwd, path);
      return write.execute(toolCallId, params, signal);
    },
  };
}

export function createDocsEditTool(cwd: string): AgentTool {
  const edit = createEditTool(cwd);
  return {
    ...edit,
    name: "docsEdit",
    description: `Replace one exact occurrence of text in a documentation file (README*, docs/**, wiki/**, *.md/*.mdx). oldText must match uniquely and exactly, including whitespace. Relative paths resolve against ${cwd}. Refuses any path that isn't a documentation file.`,
    execute: async (toolCallId, params, signal) => {
      const { path } = params as { path: string };
      assertDocPath(cwd, path);
      return edit.execute(toolCallId, params, signal);
    },
  };
}

export function createBashTool(cwd: string): AgentTool {
  return {
    name: "bash",
    label: "Bash",
    description: `Run a bash command with cwd ${cwd} — that is the repo root, already checked out and ready to work in. Never cd out of it or scan other directories (e.g. "/", $HOME). git push is blocked and will fail — branches are reviewed and pushed by a human. Returns combined stdout/stderr.`,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { command } = params as { command: string };
      try {
        const guardDir = await gitGuardDir();
        const { stdout, stderr } = await run("/bin/bash", ["-c", command], {
          cwd,
          signal,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PATH: `${guardDir}:${process.env.PATH ?? ""}` },
        });
        return { content: [{ type: "text", text: stdout + stderr }], details: { command } };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        const out = (err.stdout ?? "") + (err.stderr ?? "");
        return {
          content: [{ type: "text", text: `${out}\n(exit code ${err.code ?? "unknown"})` }],
          details: { command },
        };
      }
    },
  };
}

export function createFetchTool(): AgentTool {
  return {
    name: "fetch",
    label: "Fetch",
    description: "Fetch a URL over HTTP(S) and return its body as text, truncated to 50KB.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { url } = params as { url: string };
      const res = await fetch(url, { signal });
      const text = await res.text();
      const truncated = text.length > 50_000 ? `${text.slice(0, 50_000)}\n... [truncated]` : text;
      return {
        content: [{ type: "text", text: `HTTP ${res.status}\n${truncated}` }],
        details: { url, status: res.status },
      };
    },
  };
}

const TOOL_FACTORIES: Record<ToolName, (cwd: string) => AgentTool> = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
  fetch: createFetchTool,
  docsWrite: createDocsWriteTool,
  docsEdit: createDocsEditTool,
};

/** Builds the concrete tool set for a role's allowlist. Nothing outside this list is ever handed to the model. */
export function buildTools(names: readonly ToolName[], cwd: string): AgentTool[] {
  return names.map((name) => TOOL_FACTORIES[name](cwd));
}
