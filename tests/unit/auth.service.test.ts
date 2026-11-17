import { describe, expect, test } from "bun:test";
import type { ApiKeyCreateInput, ApiKeyRecord, AuthRepository } from "@/services/auth.contracts";
import { API_KEY_PREFIX, AuthService } from "@/services/auth.service";
import type { CacheStore } from "@/services/cache.service";
import { sha256 } from "@/utils/hash";

class InMemoryAuthRepository implements AuthRepository {
    readonly records = new Map<string, ApiKeyRecord>();
    findCalls = 0;
    touchCalls = 0;
    private sequence = 0;

    async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
        this.findCalls += 1;
        return [...this.records.values()].find((record) => record.keyHash === keyHash) ?? null;
    }

    async create(input: ApiKeyCreateInput): Promise<ApiKeyRecord> {
        const record: ApiKeyRecord = {
            id: `key-${(this.sequence += 1)}`,
            name: input.name,
            keyPrefix: input.keyPrefix,
            keyHash: input.keyHash,
            role: input.role,
            active: true,
            expiresAt: input.expiresAt,
            revokedAt: null,
            lastUsedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        this.records.set(record.id, record);
        return record;
    }

    async list(): Promise<ApiKeyRecord[]> {
        return [...this.records.values()];
    }

    async revoke(id: string): Promise<ApiKeyRecord | null> {
        const record = this.records.get(id);
        if (!record) return null;

        const revoked: ApiKeyRecord = { ...record, active: false, revokedAt: new Date() };
        this.records.set(id, revoked);
        return revoked;
    }

    async touchLastUsed(id: string, at: Date): Promise<void> {
        this.touchCalls += 1;
        const record = this.records.get(id);
        if (record) this.records.set(id, { ...record, lastUsedAt: at });
    }
}

class FakeCache implements CacheStore {
    readonly entries = new Map<string, { value: unknown; ttlSeconds: number }>();

    async get<T>(key: string): Promise<T | null> {
        return (this.entries.get(key)?.value as T | undefined) ?? null;
    }

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        this.entries.set(key, { value, ttlSeconds });
    }

    async delete(key: string): Promise<void> {
        this.entries.delete(key);
    }
}

const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => silentLogger,
};

let now = new Date("2026-06-01T00:00:00.000Z");
const clock = () => now;

function build(options: { staticAdminKeys?: string[]; cache?: CacheStore } = {}) {
    const repository = new InMemoryAuthRepository();
    const cache = options.cache ?? new FakeCache();

    const service = new AuthService(repository, cache, {
        staticAdminKeys: options.staticAdminKeys ?? [],
        cacheTtlSeconds: 60,
        lastUsedThrottleMs: 300_000,
        now: clock,
        logger: silentLogger,
    });

    return { service, repository, cache };
}

describe("AuthService", () => {
    test("issues a prefixed key and persists only its hash", async () => {
        const { service, repository } = build();

        const issued = await service.createKey({ name: "billing job" });

        expect(issued.apiKey.startsWith(API_KEY_PREFIX)).toBe(true);
        expect(issued.record.keyHash).toBe(sha256(issued.apiKey));
        expect(issued.record.keyPrefix).toBe(issued.apiKey.slice(0, issued.record.keyPrefix.length));
        expect(Object.values(issued.record)).not.toContain(issued.apiKey);

        const stored = [...repository.records.values()][0];
        expect(stored?.keyHash).toBe(sha256(issued.apiKey));
        expect(JSON.stringify(stored)).not.toContain(issued.apiKey);
    });

    test("authenticates a valid key and caches the result", async () => {
        const { service, repository } = build();
        const { apiKey, record } = await service.createKey({ name: "svc" });

        const first = await service.authenticate(apiKey);
        expect(first).toMatchObject({
            apiKeyId: record.id,
            name: "svc",
            role: "member",
            keyPrefix: record.keyPrefix,
            static: false,
        });
        expect(repository.findCalls).toBe(1);

        // Second call is served from the cache: Postgres is not consulted again.
        const second = await service.authenticate(apiKey);
        expect(second.apiKeyId).toBe(record.id);
        expect(repository.findCalls).toBe(1);
    });

    test("rejects an unknown well-formed key and negative caches it", async () => {
        const { service, repository } = build();
        const unknown = AuthService.generateKey();

        const first = await service.authenticate(unknown).catch((error: unknown) => error);
        expect(first).toMatchObject({ statusCode: 401, code: "invalid_api_key" });

        const second = await service.authenticate(unknown).catch((error: unknown) => error);
        expect(second).toMatchObject({ statusCode: 401 });

        // The negative cache entry absorbs the repeated lookup.
        expect(repository.findCalls).toBe(1);
    });

    test("rejects malformed keys without touching the database", async () => {
        const { service, repository } = build();

        const error = await service.authenticate("not-a-gateway-key").catch((caught: unknown) => caught);

        expect(error).toMatchObject({ statusCode: 401, code: "invalid_api_key" });
        expect(repository.findCalls).toBe(0);
    });

    test("rejects an expired key", async () => {
        const { service } = build();
        const { apiKey } = await service.createKey({ name: "short lived", expiresInDays: 1 });

        now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
        const error = await service.authenticate(apiKey).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ statusCode: 401, code: "invalid_api_key" });
        expect((error as Error).message).toContain("expired");
    });

    test("serves an expiry check even when the identity came from cache", async () => {
        const { service } = build();
        const { apiKey } = await service.createKey({ name: "short lived", expiresInDays: 1 });

        await service.authenticate(apiKey); // primes the cache

        now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
        const error = await service.authenticate(apiKey).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ statusCode: 401 });
    });

    test("revocation takes effect immediately by dropping the cache entry", async () => {
        const { service } = build();
        const { apiKey, record } = await service.createKey({ name: "svc" });

        await service.authenticate(apiKey);
        expect(service).toBeDefined();

        await service.revokeKey(record.id);
        const error = await service.authenticate(apiKey).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ statusCode: 401, code: "invalid_api_key" });
    });

    test("accepts static env keys as admins without touching the database", async () => {
        const { service, repository } = build({ staticAdminKeys: ["env-admin-key-123"] });

        const identity = await service.authenticate("env-admin-key-123");

        expect(identity).toMatchObject({ role: "admin", static: true, name: "static-env-key" });
        expect(repository.findCalls).toBe(0);
    });

    test("throttles lastUsedAt writes", async () => {
        const { service, repository } = build();
        const { apiKey } = await service.createKey({ name: "svc" });

        await service.authenticate(apiKey);
        expect(repository.touchCalls).toBe(1);

        // A second authenticated request within the throttle window (and served
        // from cache) must not write again.
        await service.authenticate(apiKey);
        expect(repository.touchCalls).toBe(1);
    });

    test("falls back to the repository when the cache fails", async () => {
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
        const { service } = build({ cache: brokenCache });
        const { apiKey } = await service.createKey({ name: "svc" });

        const identity = await service.authenticate(apiKey);

        expect(identity.role).toBe("member");
    });

    test("lists keys without exposing hashes and flags revocation", async () => {
        const { service } = build();
        const { apiKey, record } = await service.createKey({ name: "svc", role: "admin" });

        const before = await service.listKeys();
        expect(before).toHaveLength(1);
        expect(before[0]).not.toHaveProperty("keyHash");
        expect(JSON.stringify(before)).not.toContain(apiKey);
        expect(before[0]).toMatchObject({ id: record.id, role: "admin", active: true });

        const revoked = await service.revokeKey(record.id);
        expect(revoked).toMatchObject({ active: false });
        expect(revoked.revokedAt).not.toBeNull();
    });

    test("returns 404 when revoking an unknown key", async () => {
        const { service } = build();

        const error = await service.revokeKey("missing-id").catch((caught: unknown) => caught);

        expect(error).toMatchObject({ statusCode: 404, code: "api_key_not_found" });
    });
});
