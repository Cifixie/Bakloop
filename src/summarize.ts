import { createModels } from "@earendil-works/pi-ai";
import { localProvider } from "./local-model.js";

/**
 * Optional second, lighter local model used only to condense a finished
 * thinking/reply block to one line for the console — never part of the
 * task pipeline itself. Unset OMLX_SUMMARY_MODEL_ID to disable entirely.
 */
const SUMMARY_MODEL_ID = process.env.OMLX_SUMMARY_MODEL_ID;

const summarizer = SUMMARY_MODEL_ID
  ? (() => {
      const models = createModels();
      models.setProvider(
        localProvider({
          baseUrl: process.env.OMLX_SUMMARY_BASE_URL ?? process.env.OMLX_BASE_URL ?? "http://localhost:8000/v1",
          modelId: SUMMARY_MODEL_ID,
          contextWindow: Number(process.env.OMLX_SUMMARY_CONTEXT_WINDOW ?? 32_768),
          reasoning: false,
        }),
      );
      return { models, modelId: SUMMARY_MODEL_ID };
    })()
  : null;

function fallback(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty)";
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

/** Best-effort only: falls back to a plain truncated excerpt if unconfigured or the call fails. Never throws. */
export async function summarize(text: string): Promise<string> {
  if (!summarizer || !text.trim()) return fallback(text);
  try {
    const model = summarizer.models.getModel("local", summarizer.modelId);
    if (!model) return fallback(text);
    const result = await summarizer.models.completeSimple(model, {
      systemPrompt:
        "Summarize the following in one short, plain sentence — no preamble, no quotes, just the sentence.",
      messages: [{ role: "user", content: text, timestamp: 0 }],
    });
    if (result.stopReason === "error") return fallback(text);
    const summaryText = result.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return summaryText || fallback(text);
  } catch {
    return fallback(text);
  }
}
