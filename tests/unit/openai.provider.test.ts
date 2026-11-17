import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProviderError } from "@/services/providers/errors";
import { OpenAIProvider } from "@/services/providers/openai.provider";

const originalFetch = globalThis.fetch;

let captured: { url: string; init: RequestInit } | undefined;

function mockFetch(handler: () => Response | Promise<Response>): void {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return handler();
    }) as unknown as typeof fetch;
}

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const provider = () =>
    new OpenAIProvider({ apiKey: "sk-test-key", defaultModel: "gpt-4o-mini", baseUrl: "https://example.test/v1" });

beforeEach(() => {
    captured = undefined;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("OpenAIProvider", () => {
    test("maps a completion and its token usage", async () => {
        mockFetch(() =>
            jsonResponse({
                model: "gpt-4o-mini-2024-07-18",
                choices: [{ message: { content: "hello there" } }],
                usage: { prompt_tokens: 11, completion_tokens: 7 },
            }),
        );

        const result = await provider().generate({ prompt: "hi", model: "gpt-4o-mini" });

        expect(result).toEqual({
            text: "hello there",
            model: "gpt-4o-mini-2024-07-18",
            promptTokens: 11,
            responseTokens: 7,
        });
        expect(captured?.url).toBe("https://example.test/v1/chat/completions");
        const headers = captured?.init.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer sk-test-key");
        expect(JSON.parse(String(captured?.init.body))).toMatchObject({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
        });
    });

    test("surfaces upstream HTTP failures as retryable ProviderError", async () => {
        mockFetch(() => jsonResponse({ error: { message: "boom" } }, 503));

        const error = await provider()
            .generate({ prompt: "hi", model: "gpt-4o-mini" })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).kind).toBe("http_error");
        expect((error as ProviderError).statusCode).toBe(503);
        expect((error as ProviderError).retryable).toBe(true);
    });

    test("rejects an empty completion payload", async () => {
        mockFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));

        const error = await provider()
            .generate({ prompt: "hi", model: "gpt-4o-mini" })
            .catch((caught: unknown) => caught);

        expect((error as ProviderError).kind).toBe("invalid_response");
    });

    test("classifies aborted requests as timeouts", async () => {
        mockFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")));

        const error = await provider()
            .generate({ prompt: "hi", model: "gpt-4o-mini" })
            .catch((caught: unknown) => caught);

        expect((error as ProviderError).kind).toBe("timeout");
    });

    test("refuses to call upstream without credentials", async () => {
        const unconfigured = new OpenAIProvider({ defaultModel: "gpt-4o-mini" });
        expect(unconfigured.isConfigured()).toBe(false);

        const error = await unconfigured
            .generate({ prompt: "hi", model: "gpt-4o-mini" })
            .catch((caught: unknown) => caught);

        expect((error as ProviderError).kind).toBe("not_configured");
        expect(captured).toBeUndefined();
    });
});
