import { ProviderError, isAbortError } from "./errors";
import { safeReadText, trimTrailingSlash, truncate } from "./http-utils";
import type { GenerateRequest, GenerateResponse, LLMProvider } from "./types";

interface OpenAICompletionResponse {
    model?: string;
    choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
    };
}

export interface OpenAIProviderOptions {
    apiKey?: string;
    defaultModel: string;
    /** Override for proxies / Azure-compatible gateways. */
    baseUrl?: string;
}

export class OpenAIProvider implements LLMProvider {
    readonly name = "openai" as const;
    readonly defaultModel: string;

    private readonly apiKey?: string;
    private readonly endpoint: string;

    constructor(options: OpenAIProviderOptions) {
        this.apiKey = options.apiKey;
        this.defaultModel = options.defaultModel;
        this.endpoint = `${trimTrailingSlash(options.baseUrl ?? "https://api.openai.com/v1")}/chat/completions`;
    }

    isConfigured(): boolean {
        return Boolean(this.apiKey);
    }

    async generate({ prompt, model, signal }: GenerateRequest): Promise<GenerateResponse> {
        if (!this.apiKey) {
            throw new ProviderError("openai", "not_configured", "OPENAI_API_KEY is not configured");
        }

        let response: Response;
        try {
            response = await fetch(this.endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: "user", content: prompt }],
                }),
                signal,
            });
        } catch (error) {
            throw this.transportError(error);
        }

        if (!response.ok) {
            const body = await safeReadText(response);
            throw new ProviderError(
                "openai",
                "http_error",
                `OpenAI returned HTTP ${response.status}: ${truncate(body)}`,
                response.status,
            );
        }

        let payload: OpenAICompletionResponse;
        try {
            payload = (await response.json()) as OpenAICompletionResponse;
        } catch (error) {
            throw new ProviderError("openai", "invalid_response", "OpenAI returned a non-JSON body", response.status, {
                cause: error,
            });
        }

        const text = payload.choices?.[0]?.message?.content;
        if (typeof text !== "string" || text.length === 0) {
            throw new ProviderError("openai", "invalid_response", "OpenAI response contained no completion text");
        }

        return {
            text,
            model: payload.model ?? model,
            promptTokens: payload.usage?.prompt_tokens ?? 0,
            responseTokens: payload.usage?.completion_tokens ?? 0,
        };
    }

    private transportError(error: unknown): ProviderError {
        if (isAbortError(error)) {
            return new ProviderError("openai", "timeout", "OpenAI request exceeded the configured timeout", undefined, {
                cause: error,
            });
        }

        return new ProviderError(
            "openai",
            "network",
            `OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            { cause: error },
        );
    }
}
