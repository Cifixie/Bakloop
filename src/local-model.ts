import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";

/** Everything needed to run against a local, OpenAI-compatible server instead of a cloud provider. */
export interface LocalModelConfig {
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  /** Whether this model does chain-of-thought reasoning (e.g. Qwen3.6's "thinking" mode). Default: false. */
  reasoning?: boolean;
}

/**
 * Points pi-ai at a local OpenAI-compatible server (e.g. oMLX at
 * http://localhost:8000/v1) instead of a hosted provider. No request ever
 * leaves the machine: same `openai-completions` wire format, just a
 * different `baseUrl` and a locally-issued bearer key.
 */
export function localProvider(config: LocalModelConfig): Provider<"openai-completions"> {
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: "local",
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.contextWindow,
  };

  return createProvider({
    id: "local",
    name: "Local (oMLX)",
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth("Local model API key", ["OMLX_API_KEY"]) },
    models: [model],
    api: openAICompletionsApi(),
  });
}
