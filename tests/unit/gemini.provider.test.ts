import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProviderError } from "@/services/providers/errors";
import { GeminiProvider } from "@/services/providers/gemini.provider";

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
    new GeminiProvider({
        apiKey: "gemini-test-key",
        defaultModel: "gemini-2.0-flash",
        baseUrl: "https://example.test/v1beta",
    });

beforeEach(() => {
    captured = undefined;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("GeminiProvider", () => {
    test("maps generateContent output and token usage", async () => {
        mockFetch(() =>
            jsonResponse({
                candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }],
                usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
            }),
        );

        const result = await provider().generate({ prompt: "hi", model: "gemini-2.0-flash" });

        expect(result).toEqual({
            text: "hello world",
            model: "gemini-2.0-flash",
            promptTokens: 9,
            responseTokens: 4,
        });
        expect(captured?.url).toBe("https://example.test/v1beta/models/gemini-2.0-flash:generateContent");
        const headers = captured?.init.headers as Record<string, string>;
        // Key travels in a header, never in the query string.
        expect(headers["x-goog-api-key"]).toBe("gemini-test-key");
        expect(captured?.url).not.toContain("key=");
        expect(JSON.parse(String(captured?.init.body))).toEqual({
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        });
    });

    test("reports a safety block as an invalid response", async () => {
        mockFetch(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));

        const error = await provider()
            .generate({ prompt: "hi", model: "gemini-2.0-flash" })
            .catch((caught: unknown) => caught);

        expect((error as ProviderError).kind).toBe("invalid_response");
        expect((error as ProviderError).message).toContain("SAFETY");
    });

    test("surfaces HTTP failures", async () => {
        mockFetch(() => jsonResponse({ error: { message: "quota" } }, 429));

        const error = await provider()
            .generate({ prompt: "hi", model: "gemini-2.0-flash" })
            .catch((caught: unknown) => caught);

        expect((error as ProviderError).kind).toBe("http_error");
        expect((error as ProviderError).statusCode).toBe(429);
    });

    test("refuses to call upstream without credentials", async () => {
        const unconfigured = new GeminiProvider({ defaultModel: "gemini-2.0-flash" });

        const error = await unconfigured
            .generate({ prompt: "hi", model: "gemini-2.0-flash" })
            .catch((caught: unknown) => caught);

        expect((error as ProviderError).kind).toBe("not_configured");
    });
});
