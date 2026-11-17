import { describe, expect, test } from "bun:test";
import { buildCacheKey, RedisCache, type KeyValueClient } from "@/services/cache.service";

describe("buildCacheKey", () => {
    const base = { provider: "openai", model: "gpt-4o-mini", prompt: "explain vectors" };

    test("is deterministic for identical input", () => {
        expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
    });

    test("separates providers", () => {
        expect(buildCacheKey(base)).not.toBe(buildCacheKey({ ...base, provider: "gemini" }));
    });

    test("separates models", () => {
        expect(buildCacheKey(base)).not.toBe(buildCacheKey({ ...base, model: "gpt-4o" }));
    });

    test("separates prompts", () => {
        expect(buildCacheKey(base)).not.toBe(buildCacheKey({ ...base, prompt: "explain matrices" }));
    });

    test("never leaks the raw prompt", () => {
        expect(buildCacheKey(base)).not.toContain("vectors");
        expect(buildCacheKey(base)).toMatch(/^llmgw:cache:v1:openai:[a-f0-9]{64}$/);
    });
});

describe("RedisCache", () => {
    class FakeClient implements KeyValueClient {
        readonly store = new Map<string, string>();
        readonly ttls: number[] = [];

        async get(key: string): Promise<string | null> {
            return this.store.get(key) ?? null;
        }

        async set(key: string, value: string, _mode: "EX", ttlSeconds: number): Promise<unknown> {
            this.store.set(key, value);
            this.ttls.push(ttlSeconds);
            return "OK";
        }

        async del(key: string): Promise<unknown> {
            return this.store.delete(key) ? 1 : 0;
        }
    }

    test("round-trips a value and honours the TTL argument", async () => {
        const client = new FakeClient();
        const cache = new RedisCache(client);

        await cache.set("k", { text: "hello", tokens: 3 }, 3_600);
        expect(await cache.get<{ text: string; tokens: number }>("k")).toEqual({ text: "hello", tokens: 3 });
        expect(client.ttls).toEqual([3_600]);
    });

    test("returns null on a miss", async () => {
        expect(await new RedisCache(new FakeClient()).get("missing")).toBeNull();
    });

    test("treats corrupt entries as a miss", async () => {
        const client = new FakeClient();
        client.store.set("broken", "{not json");
        expect(await new RedisCache(client).get("broken")).toBeNull();
    });

    test("deletes entries so a revoked value stops being served", async () => {
        const client = new FakeClient();
        const cache = new RedisCache(client);

        await cache.set("k", { text: "hello" }, 60);
        await cache.delete("k");

        expect(await cache.get("k")).toBeNull();
    });
});
