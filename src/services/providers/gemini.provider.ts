import { ProviderError, isAbortError } from "./errors";
import { safeReadText, trimTrailingSlash, truncate } from "./http-utils";
import type { GenerateRequest, GenerateResponse, LLMProvider } from "./types";

interface GeminiContentResponse {
    candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
    }>;
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
    };
    promptFeedback?: { blockReason?: string };
}

export interface GeminiProviderOptions {
    apiKey?: string;
    defaultModel: string;
    baseUrl?: string;
}

export class GeminiProvider implements LLMProvider {
    readonly name = "gemini" as const;
    readonly defaultModel: string;

    private readonly apiKey?: string;
    private readonly baseUrl: string;

    constructor(options: GeminiProviderOptions) {
        this.apiKey = options.apiKey;
        this.defaultModel = options.defaultModel;
        this.baseUrl = trimTrailingSlash(options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta");
    }

    isConfigured(): boolean {
        return Boolean(this.apiKey);
    }

    async generate({ prompt, model, signal }: GenerateRequest): Promise<GenerateResponse> {
        if (!this.apiKey) {
            throw new ProviderError("gemini", "not_configured", "GEMINI_API_KEY is not configured");
        }

        const endpoint = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

        let response: Response;
        try {
            response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    // Header auth keeps the key out of URLs, access logs and proxies.
                    "x-goog-api-key": this.apiKey,
                },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                }),
                signal,
            });
        } catch (error) {
            throw this.transportError(error);
        }

        if (!response.ok) {
            const body = await safeReadText(response);
            throw new ProviderError(
                "gemini",
                "http_error",
                `Gemini returned HTTP ${response.status}: ${truncate(body)}`,
                response.status,
            );
        }

        let payload: GeminiContentResponse;
        try {
            payload = (await response.json()) as GeminiContentResponse;
        } catch (error) {
            throw new ProviderError("gemini", "invalid_response", "Gemini returned a non-JSON body", response.status, {
                cause: error,
            });
        }

        const text = (payload.candidates?.[0]?.content?.parts ?? [])
            .map((part) => part.text ?? "")
            .join("")
            .trim();

        if (text.length === 0) {
            const blocked = payload.promptFeedback?.blockReason;
            throw new ProviderError(
                "gemini",
                "invalid_response",
                blocked ? `Gemini blocked the prompt (${blocked})` : "Gemini response contained no completion text",
            );
        }

        return {
            text,
            model,
            promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
            responseTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
        };
    }

    private transportError(error: unknown): ProviderError {
        if (isAbortError(error)) {
            return new ProviderError("gemini", "timeout", "Gemini request exceeded the configured timeout", undefined, {
                cause: error,
            });
        }

        return new ProviderError(
            "gemini",
            "network",
            `Gemini request failed: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            { cause: error },
        );
    }
}
