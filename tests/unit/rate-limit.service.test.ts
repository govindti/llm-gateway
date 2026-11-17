import { describe, expect, test } from "bun:test";
import {
    RedisSlidingWindowRateLimiter,
    type SlidingWindowClient,
} from "@/services/rate-limit.service";

/** Scripted stand-in for the Lua script's return value. */
class ScriptedClient implements SlidingWindowClient {
    readonly calls: { keys: (string | number)[] }[] = [];

    constructor(private readonly scripted: unknown) { }

    async eval(_script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
        this.calls.push({ keys: args });
        return this.scripted;
    }
}

class FailingClient implements SlidingWindowClient {
    async eval(): Promise<unknown> {
        throw new Error("ECONNREFUSED");
    }
}

const limiter = (client: SlidingWindowClient, overrides: { failOpen?: boolean; now?: () => number } = {}) =>
    new RedisSlidingWindowRateLimiter(client, {
        limit: 10,
        windowMs: 60_000,
        failOpen: overrides.failOpen ?? true,
        now: overrides.now ?? (() => 1_000_000),
    });

describe("RedisSlidingWindowRateLimiter", () => {
    test("allows a request inside the budget", async () => {
        const client = new ScriptedClient([1, 3, 0]);
        const result = await limiter(client).check("key-abcdefgh");

        expect(result.allowed).toBe(true);
        expect(result.used).toBe(3);
        expect(result.remaining).toBe(7);
        expect(result.degraded).toBe(false);
    });

    test("rejects once the window budget is exhausted", async () => {
        const client = new ScriptedClient([0, 10, 42_000]);
        const result = await limiter(client).check("key-abcdefgh");

        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
        expect(result.retryAfterSeconds).toBe(42);
        expect(result.resetAt.getTime()).toBe(1_000_000 + 42_000);
    });

    test("never reports a retry-after below one second", async () => {
        const result = await limiter(new ScriptedClient([0, 10, 10])).check("key-abcdefgh");
        expect(result.retryAfterSeconds).toBe(1);
    });

    test("hashes the API key before it reaches Redis", async () => {
        const client = new ScriptedClient([1, 1, 0]);
        await limiter(client).check("super-secret-api-key");

        const redisKey = String(client.calls[0]?.keys[0]);
        expect(redisKey).not.toContain("super-secret-api-key");
        expect(redisKey).toMatch(/^llmgw:ratelimit:[a-f0-9]{40}$/);
    });

    test("fails open when Redis is unreachable and failOpen is set", async () => {
        const result = await limiter(new FailingClient(), { failOpen: true }).check("key-abcdefgh");

        expect(result.allowed).toBe(true);
        expect(result.degraded).toBe(true);
    });

    test("fails closed when Redis is unreachable and failOpen is disabled", async () => {
        const error = await limiter(new FailingClient(), { failOpen: false })
            .check("key-abcdefgh")
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("ECONNREFUSED");
    });
});
