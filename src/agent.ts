import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { roleTag, warn } from "./colors.js";
import { localProvider } from "./local-model.js";
import { summarize } from "./summarize.js";
import type { RunAgent } from "./tick.js";
import { buildTools } from "./tools.js";
import type { ToolName } from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:8000/v1";
const DEFAULT_MODEL_ID = "mlx-community--Qwen3.6-35B-A3B-6bit";
const DEFAULT_CONTEXT_WINDOW = 262_144;

const modelId = process.env.OMLX_MODEL_ID ?? DEFAULT_MODEL_ID;

const models = createModels();
models.setProvider(
  localProvider({
    baseUrl: process.env.OMLX_BASE_URL ?? DEFAULT_BASE_URL,
    modelId,
    contextWindow: Number(process.env.OMLX_CONTEXT_WINDOW ?? DEFAULT_CONTEXT_WINDOW),
    reasoning: true,
  }),
);

/**
 * Wires the orchestrator's role/tools/prompt contract to pi-agent-core's
 * Agent class: one prompt() per call, no session persisted between ticks
 * (tick.ts already persists everything that matters to disk).
 *
 * Tools are the only enforcement of the read-only roles: `agent.state.tools`
 * is built solely from `input.tools`, so a role with an empty allowlist gets
 * an Agent with zero tools and the model has nothing to call.
 */
export const runAgent: RunAgent = async (input) => {
  const model = models.getModel("local", modelId);
  if (!model) throw new Error(`Unknown local model: ${modelId}`);

  const tag = `${roleTag(input.role)} ${input.taskId}`;

  const agent = new Agent({
    initialState: {
      systemPrompt: `You are the ${input.role} in an automated task pipeline. Your working directory is ${input.cwd} — every relative path in every tool is resolved against exactly that directory, and it already contains the checked-out repo; never explore outside it (no scanning "/", home, or other repos). Follow the instructions in the user message exactly; you will not get a chance to ask clarifying questions.`,
      model,
      tools: buildTools(input.tools as readonly ToolName[], input.cwd),
    },
    streamFn: models.streamSimple.bind(models),
  });

  // Ticks run for minutes against a local model with nothing else to show
  // for it; a progress line proves it's alive without dumping the raw
  // reasoning stream, and each block gets condensed to one line by a
  // second, lighter model (summarize.ts) once it finishes — falls back to
  // a plain truncated excerpt if that model isn't configured.
  let chars = 0;
  let started = 0;
  let lastPrint = 0;
  const progress = (label: string) => {
    if (Date.now() - lastPrint < 2000) return;
    lastPrint = Date.now();
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    process.stdout.write(`\r${tag} ${label}... ${secs}s, ${chars} chars   `);
  };

  // Totals for the tick journal (src/journal.ts). Accumulated across every
  // block in the call, since one tick may think and reply more than once.
  const callStarted = Date.now();
  let thinkingChars = 0;
  let toolCalls = 0;

  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      switch (e.type) {
        case "thinking_start":
          chars = 0;
          started = Date.now();
          lastPrint = 0;
          process.stdout.write(`${tag} thinking...`);
          break;
        case "thinking_delta":
          chars += e.delta.length;
          progress("thinking");
          break;
        case "thinking_end": {
          const secs = ((Date.now() - started) / 1000).toFixed(0);
          thinkingChars += e.content.length;
          const summary = await summarize(e.content);
          process.stdout.write(`\r${tag} thought for ${secs}s: ${summary}\n`);
          break;
        }
        case "text_start":
          chars = 0;
          started = Date.now();
          lastPrint = 0;
          break;
        case "text_delta":
          chars += e.delta.length;
          progress("replying");
          break;
        case "text_end": {
          const summary = await summarize(e.content);
          process.stdout.write(`\r${tag} reply: ${summary}\n`);
          break;
        }
      }
    } else if (event.type === "tool_execution_start") {
      toolCalls += 1;
      console.info(`${tag} tool ${event.toolName} ${JSON.stringify(event.args)}`);
    } else if (event.type === "tool_execution_end") {
      const status = event.isError ? warn("failed") : "done";
      console.info(`${tag} tool ${event.toolName} ${status}`);
    }
  });

  try {
    await agent.prompt(input.prompt);
  } finally {
    unsubscribe();
  }

  const lastAssistant = [...agent.state.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (lastAssistant?.role !== "assistant") {
    throw new Error(
      `${input.role}: agent produced no assistant response (error: ${agent.state.errorMessage ?? "none"})`,
    );
  }

  // A provider/transport failure still yields a message with role "assistant"
  // (just empty content) — that must not read as a legitimate empty reply.
  if (lastAssistant.stopReason === "error") {
    throw new Error(`${input.role}: model call failed: ${lastAssistant.errorMessage ?? "unknown error"}`);
  }

  const text = lastAssistant.content
    .filter(
      (block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");

  return {
    text,
    metrics: {
      promptChars: input.prompt.length,
      outputChars: text.length,
      thinkingChars,
      toolCalls,
      modelMs: Date.now() - callStarted,
    },
  };
};
