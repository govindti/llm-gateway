import { logger } from "@/lib/logger";
import { sha256 } from "@/utils/hash";

/**
 * Minimal Redis surface used by the cache. Declaring it here keeps the service
 * unit-testable with an in-memory fake and decoupled from ioredis.
 */
export interface KeyValueClient {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
}

export interface CacheStore {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface CacheKeyInput {
    provider: string;
    model: string;
    prompt: string;
}

/**
 * Alias `cache:v1` so the whole namespace can be invalidated by bumping the version.
 * The model is part of the digest on top of prompt+provider: the same prompt sent
 * to two different models must not share a cached completion.
 */
export function buildCacheKey({ provider, model, prompt }: CacheKeyInput): string {
    const digest = sha256(JSON.stringify({ provider, model, prompt }));
    return `llmgw:cache:v1:${provider}:${digest}`;
}

export class RedisCache implements CacheStore {
    constructor(private readonly client: KeyValueClient) { }

    async get<T>(key: string): Promise<T | null> {
        const raw = await this.client.get(key);
        if (!raw) return null;

        try {
            return JSON.parse(raw) as T;
        } catch {
            // Corrupt entry: drop through to a cache miss rather than failing the request.
            logger.warn("discarding unparsable cache entry", { key });
            return null;
        }
    }

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
    }

    async delete(key: string): Promise<void> {
        await this.client.del(key);
    }
}
