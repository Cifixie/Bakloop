import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { localProvider } from "./local-model.js";
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
  // reasoning stream, and the reply is printed once, complete, at the end.
  let chars = 0;
  let started = 0;
  let lastPrint = 0;
  const progress = (label: string) => {
    if (Date.now() - lastPrint < 2000) return;
    lastPrint = Date.now();
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    process.stdout.write(`\r[${input.role}] ${label}... ${secs}s, ${chars} chars   `);
  };

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      switch (e.type) {
        case "thinking_start":
          chars = 0;
          started = Date.now();
          lastPrint = 0;
          process.stdout.write(`[${input.role}] thinking...`);
          break;
        case "thinking_delta":
          chars += e.delta.length;
          progress("thinking");
          break;
        case "thinking_end":
          process.stdout.write(`\r[${input.role}] thought for ${((Date.now() - started) / 1000).toFixed(0)}s (${chars} chars)\n`);
          break;
        case "text_start":
          chars = 0;
          started = Date.now();
          lastPrint = 0;
          break;
        case "text_delta":
          chars += e.delta.length;
          progress("replying");
          break;
        case "text_end":
          process.stdout.write(`\r[${input.role}] reply:\n${e.content}\n`);
          break;
      }
    } else if (event.type === "tool_execution_start") {
      console.info(`[${input.role}] tool ${event.toolName} ${JSON.stringify(event.args)}`);
    } else if (event.type === "tool_execution_end") {
      console.info(`[${input.role}] tool ${event.toolName} ${event.isError ? "failed" : "done"}`);
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

  return { text };
};
