export type ProviderName = "openai" | "gemini";

export const PROVIDER_NAMES = ["openai", "gemini"] as const satisfies readonly ProviderName[];

export function isProviderName(value: string): value is ProviderName {
    return (PROVIDER_NAMES as readonly string[]).includes(value);
}

export interface GenerateRequest {
    prompt: string;
    model: string;
    /** Aborted when the per-provider deadline elapses. */
    signal?: AbortSignal;
}

export interface GenerateResponse {
    text: string;
    model: string;
    promptTokens: number;
    responseTokens: number;
}

/** Contract every upstream LLM integration must satisfy. */
export interface LLMProvider {
    readonly name: ProviderName;
    readonly defaultModel: string;
    /** False when the provider has no credentials; it is then skipped by the fallback chain. */
    isConfigured(): boolean;
    generate(request: GenerateRequest): Promise<GenerateResponse>;
}
