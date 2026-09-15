import { createModels } from "@earendil-works/pi-ai";
import { localProvider } from "./local-model.js";

/**
 * Optional second, lighter local model used for small text-in/text-out
 * chores (console condensing, draft titling) — never part of the task
 * pipeline itself. Unset OMLX_SUMMARY_MODEL_ID to disable entirely.
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

/** One text-in/text-out call against the summarizer model. Returns null if unconfigured or the call fails — never throws. */
async function complete(systemPrompt: string, text: string): Promise<string | null> {
  if (!summarizer || !text.trim()) return null;
  try {
    const model = summarizer.models.getModel("local", summarizer.modelId);
    if (!model) return null;
    const result = await summarizer.models.completeSimple(model, {
      systemPrompt,
      messages: [{ role: "user", content: text, timestamp: 0 }],
    });
    if (result.stopReason === "error") return null;
    const out = result.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Best-effort only: falls back to a plain truncated excerpt if unconfigured or the call fails. Never throws. */
export async function summarize(text: string): Promise<string> {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const fallback = oneLine ? (oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine) : "(empty)";
  const out = await complete(
    "Summarize the following in one short, plain sentence — no preamble, no quotes, just the sentence.",
    text,
  );
  return out ?? fallback;
}

/** Best-effort task-title generation from raw draft text. Falls back to a truncated excerpt if unconfigured or the call fails. Never throws. */
export async function deriveTitle(text: string): Promise<string> {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const fallback = oneLine ? oneLine.split(" ").slice(0, 8).join(" ") : "Untitled draft";
  const out = await complete(
    "Write a short, specific task title (max 8 words) for the following text. " +
      "Imperative or noun-phrase, no quotes, no trailing period, no preamble — just the title.",
    text,
  );
  return out ?? fallback;
}
