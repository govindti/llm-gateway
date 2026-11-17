import { describe, expect, test } from "bun:test";
import type { CacheStore } from "@/services/cache.service";
import { type ChatInput, ChatService } from "@/services/chat.service";
import type { UsageRecordInput, UsageRecorder } from "@/services/contracts";
import { ProviderError } from "@/services/providers/errors";
import { ProviderRegistry } from "@/services/providers/registry";
import type { GenerateRequest, GenerateResponse, LLMProvider, ProviderName } from "@/services/providers/types";

class FakeCache implements CacheStore {
    readonly entries = new Map<string, string>();

    async get<T>(key: string): Promise<T | null> {
        const raw = this.entries.get(key);
        return raw === undefined ? null : (JSON.parse(raw) as T);
    }

    async set<T>(key: string, value: T): Promise<void> {
        this.entries.set(key, JSON.stringify(value));
    }

    async delete(key: string): Promise<void> {
        this.entries.delete(key);
    }
}

class FakeUsage implements UsageRecorder {
    readonly records: UsageRecordInput[] = [];

    async record(entry: UsageRecordInput): Promise<void> {
        this.records.push(entry);
    }
}

class FakeProvider implements LLMProvider {
    calls = 0;

    constructor(
        readonly name: ProviderName,
        readonly defaultModel: string,
        private readonly respond: (request: GenerateRequest) => Promise<GenerateResponse>,
        private readonly configured = true,
    ) { }

    isConfigured(): boolean {
        return this.configured;
    }

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
        this.calls += 1;
        return this.respond(request);
    }
}

const silentLogger = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
    child: () => silentLogger,
};

const completion = (text: string, promptTokens = 10, responseTokens = 5): GenerateResponse => ({
    text,
    model: "gpt-4o-mini",
    promptTokens,
    responseTokens,
});

const input = (overrides: Partial<ChatInput> = {}): ChatInput => ({
    apiKey: "test-key-123456",
    prompt: "what is a vector?",
    provider: "openai",
    ...overrides,
});

function build(options: {
    openai?: LLMProvider;
    gemini?: LLMProvider;
    cache?: FakeCache;
    usage?: FakeUsage;
    timeoutMs?: number;
    cacheEnabled?: boolean;
}) {
    const cache = options.cache ?? new FakeCache();
    const usage = options.usage ?? new FakeUsage();
    const registry = new ProviderRegistry(
        [options.openai, options.gemini].filter((provider): provider is LLMProvider => Boolean(provider)),
    );

    const service = new ChatService({
        registry,
        cache,
        usage,
        config: { timeoutMs: options.timeoutMs ?? 5_000, cacheTtlSeconds: 3_600, cacheEnabled: options.cacheEnabled ?? true },
        logger: silentLogger,
    });

    return { service, cache, usage };
}

describe("ChatService", () => {
    test("calls the primary provider and records billable usage", async () => {
        const openai = new FakeProvider("openai", "gpt-4o-mini", async () => completion("openai answer"));
        const { service, cache, usage } = build({ openai });

        const result = await service.chat(input());

        expect(openai.calls).toBe(1);
        expect(result.provider).toBe("openai");
        expect(result.text).toBe("openai answer");
        expect(result.cached).toBe(false);
        expect(result.fallback).toBe(false);
        expect(result.totalTokens).toBe(15);
        expect(result.estimatedCostUsd).toBeGreaterThan(0);
        expect(cache.entries.size).toBe(1);
        expect(usage.records).toHaveLength(1);
        expect(usage.records[0]).toMatchObject({
            status: "success",
            cached: false,
            fallback: false,
            promptTokens: 10,
            responseTokens: 5,
            apiKey: "test-key-123456",
        });
    });

    test("serves a repeated prompt from cache without touching the provider", async () => {
        const openai = new FakeProvider("openai", "gpt-4o-mini", async () => completion("openai answer"));
        const { service, usage } = build({ openai });

        const first = await service.chat(input());
        const second = await service.chat(input());

        expect(openai.calls).toBe(1);
        expect(second.cached).toBe(true);
        expect(second.text).toBe(first.text);
        expect(second.estimatedCostUsd).toBe(0);
        // Cached hits are logged with zero tokens because nothing was billed upstream.
        expect(usage.records).toHaveLength(2);
        expect(usage.records[1]).toMatchObject({ status: "cached", cached: true, promptTokens: 0, estimatedCost: 0 });
    });

    test("does not share cache entries across providers", async () => {
        const openai = new FakeProvider("openai", "gpt-4o-mini", async () => completion("from openai"));
        const gemini = new FakeProvider("gemini", "gemini-2.0-flash", async () => ({
            text: "from gemini",
            model: "gemini-2.0-flash",
            promptTokens: 3,
            responseTokens: 2,
        }));
        const { service } = build({ openai, gemini });

        expect((await service.chat(input({ provider: "openai" }))).text).toBe("from openai");
        expect((await service.chat(input({ provider: "gemini" }))).text).toBe("from gemini");
    });

    test("falls back to the other provider when the primary fails", async () => {
        const openai = new FakeProvider("openai", "gpt-4o-mini", async () => {
            throw new ProviderError("openai", "http_error", "OpenAI returned HTTP 500", 500);
        });
        const gemini = new FakeProvider("gemini", "gemini-2.0-flash", async () => ({
            text: "fallback answer",
            model: "gemini-2.0-flash",
            promptTokens: 7,
            responseTokens: 3,
        }));
        const { service, usage } = build({ openai, gemini });

        const result = await service.chat(input());

        expect(openai.calls).toBe(1);
        expect(gemini.calls).toBe(1);
        expect(result.provider).toBe("gemini");
        expect(result.fallback).toBe(true);
        expect(result.text).toBe("fallback answer");
        expect(result.attempts.map((attempt) => attempt.status)).toEqual(["error", "success"]);
        expect(usage.records[0]).toMatchObject({ provider: "gemini", status: "success", fallback: true });
    });

    test("falls back when the primary exceeds the deadline", async () => {
        const openai = new FakeProvider("openai", "gpt-4o-mini", () => new Promise<GenerateResponse>(() => { }));
        const gemini = new FakeProvider("gemini", "gemini-2.0-flash", async () => ({
            text: "fast fallback",
            model: "gemini-2.0-flash",
            promptTokens: 1,
            responseTokens: 1,
        }));
        const { service } = build({ openai, gemini, timeoutMs: 30 });

        const result = await service.chat(input());

        expect(result.provider).toBe("gemini");
        expect(result.fallback).toBe(true);
        expect(result.attempts[0]?.error?.kind).toBe("timeout");
    });

    test("skips an unconfigured primary and uses the provider that is configured", async () => {
        const openai = new FakeProvider("openai", "gpt-4o-mini", async () => completion("never"), false);
        const gemini = new FakeProvider("gemini", "gemini-2.0-flash", async () => ({
            text: "only option",
            model: "gemini-2.0-flash",
            promptTokens: 1,
            responseTokens: 1,
        }));
        const { service } = build({ openai, gemini });

        const result = await service.chat(input());

        expect(openai.calls).toBe(0);
        expect(result.provider).toBe("gemini");
    });

    test("reports 502 and logs a failure row when every provider fails", async () => {
        const openai = new FakeProvider("openai", "gpt-4o-mini", async () => {
            throw new ProviderError("openai", "network", "socket hang up");
        });
        const gemini = new FakeProvider("gemini", "gemini-2.0-flash", async () => {
            throw new ProviderError("gemini", "http_error", "Gemini returned HTTP 503", 503);
        });
        const { service, cache, usage } = build({ openai, gemini });

        const error = await service.chat(input()).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ statusCode: 502, code: "all_providers_failed" });
        expect(cache.entries.size).toBe(0);
        expect(usage.records).toHaveLength(1);
        expect(usage.records[0]).toMatchObject({ status: "error", estimatedCost: 0, promptTokens: 0 });
    });

    test("reports 503 and logs a failure row when no provider is configured", async () => {
        const { service, usage } = build({});

        const error = await service.chat(input()).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ statusCode: 503, code: "no_provider_configured" });
        expect(usage.records).toHaveLength(1);
        expect(usage.records[0]?.status).toBe("error");
    });

    test("honours a per-request model override", async () => {
        const seen: string[] = [];
        const openai = new FakeProvider("openai", "gpt-4o-mini", async (request) => {
            seen.push(request.model);
            return { text: "ok", model: request.model, promptTokens: 1, responseTokens: 1 };
        });
        const { service } = build({ openai });

        await service.chat(input({ model: "gpt-4o" }));

        expect(seen).toEqual(["gpt-4o"]);
    });

    test("keeps working when the cache layer throws", async () => {
        const openai = new FakeProvider("openai", "gpt-4o-mini", async () => completion("resilient"));
        const brokenCache: CacheStore = {
            get: async () => {
                throw new Error("redis down");
            },
            set: async () => {
                throw new Error("redis down");
            },
            delete: async () => {
                throw new Error("redis down");
            },
        };
        const usage = new FakeUsage();

        const service = new ChatService({
            registry: new ProviderRegistry([openai]),
            cache: brokenCache,
            usage,
            config: { timeoutMs: 1_000, cacheTtlSeconds: 60, cacheEnabled: true },
            logger: silentLogger,
        });

        const result = await service.chat(input());

        expect(result.text).toBe("resilient");
        expect(usage.records[0]?.status).toBe("success");
    });

    test("coalesces identical in-flight requests into one upstream call", async () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const openai = new FakeProvider("openai", "gpt-4o-mini", async () => {
            await gate;
            return completion("single flight");
        });
        const { service } = build({ openai });

        const first = service.chat(input());
        const second = service.chat(input());
        release?.();

        const [a, b] = await Promise.all([first, second]);

        expect(openai.calls).toBe(1);
        expect(a.text).toBe("single flight");
        expect(b.text).toBe("single flight");
    });
});
