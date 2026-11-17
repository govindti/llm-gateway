import { env } from "@/config/env";
import { GeminiProvider } from "./gemini.provider";
import { OpenAIProvider } from "./openai.provider";
import { ProviderRegistry } from "./registry";

export { ProviderRegistry } from "./registry";
export { ProviderError, isAbortError } from "./errors";
export type { ProviderFailureKind } from "./errors";
export type { GenerateRequest, GenerateResponse, LLMProvider, ProviderName } from "./types";
export { PROVIDER_NAMES, isProviderName } from "./types";

/** Builds the registry from environment configuration. */
export function createProviderRegistry(): ProviderRegistry {
    return new ProviderRegistry([
        new OpenAIProvider({
            apiKey: env.OPENAI_API_KEY,
            defaultModel: env.OPENAI_MODEL,
            baseUrl: env.OPENAI_BASE_URL,
        }),
        new GeminiProvider({
            apiKey: env.GEMINI_API_KEY,
            defaultModel: env.GEMINI_MODEL,
            baseUrl: env.GEMINI_BASE_URL,
        }),
    ]);
}
