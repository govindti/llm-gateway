import { randomBytes, timingSafeEqual } from "node:crypto";
import { type Logger, errorMessage, logger as defaultLogger } from "@/lib/logger";
import { notFound, unauthorized } from "@/utils/errors";
import { sha256 } from "@/utils/hash";
import type {
    ApiKeyRecord,
    ApiKeyRole,
    ApiKeySummary,
    AuthIdentity,
    AuthRepository,
    IssuedApiKey,
} from "./auth.contracts";
import type { CacheStore } from "./cache.service";

/** Every generated key is prefixed so it is recognisable in logs and secret scanners. */
export const API_KEY_PREFIX = "llmgw_sk_";

/** Characters of the key shown in listings, e.g. `llmgw_sk_A1b2C3`. */
const PREFIX_DISPLAY_LENGTH = API_KEY_PREFIX.length + 6;

interface CachedIdentity {
    apiKeyId: string;
    name: string;
    role: ApiKeyRole;
    keyPrefix: string;
    expiresAt: string | null;
}

interface CachedInvalid {
    invalid: true;
}

type CachedAuth = CachedIdentity | CachedInvalid;

const isInvalidMarker = (value: CachedAuth): value is CachedInvalid => "invalid" in value;

export interface AuthServiceOptions {
    /** Operator-provisioned keys from API_KEYS. Always admin, never hit the database. */
    staticAdminKeys: string[];
    /** How long a successful validation is cached before re-reading Postgres. */
    cacheTtlSeconds: number;
    /** Short TTL for rejected keys so bad credentials cannot hammer Postgres. */
    negativeCacheTtlSeconds?: number;
    /** Minimum gap between `lastUsedAt` writes for the same key. */
    lastUsedThrottleMs?: number;
    now?: () => Date;
    logger?: Logger;
}

/**
 * Owns the credential lifecycle: issuing keys, validating them and revoking them.
 *
 * Security properties:
 *  - only the SHA-256 hash of a key is stored; lookup is by that hash, so no
 *    secret is ever compared with `===`.
 *  - validation results are cached in Redis for a short TTL, and revocation
 *    deletes the cache entry so a revoked key stops working immediately.
 *  - static env keys are compared through SHA-256 digests in constant time.
 */
export class AuthService {
    private readonly staticKeys: string[];
    private readonly cacheTtlSeconds: number;
    private readonly negativeCacheTtlSeconds: number;
    private readonly lastUsedThrottleMs: number;
    private readonly clock: () => Date;
    private readonly logger: Logger;

    constructor(
        private readonly repository: AuthRepository,
        private readonly cache: CacheStore,
        options: AuthServiceOptions,
    ) {
        this.staticKeys = options.staticAdminKeys;
        this.cacheTtlSeconds = options.cacheTtlSeconds;
        this.negativeCacheTtlSeconds = options.negativeCacheTtlSeconds ?? 30;
        this.lastUsedThrottleMs = options.lastUsedThrottleMs ?? 300_000;
        this.clock = options.now ?? (() => new Date());
        this.logger = options.logger ?? defaultLogger;
    }

    static generateKey(): string {
        // 32 random bytes -> 43 char base64url body; unguessable and URL safe.
        return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    }

    static keyPrefixOf(apiKey: string): string {
        return apiKey.slice(0, PREFIX_DISPLAY_LENGTH);
    }

    static isWellFormed(apiKey: string): boolean {
        return apiKey.startsWith(API_KEY_PREFIX) && apiKey.length >= PREFIX_DISPLAY_LENGTH + 16;
    }

    /** Resolves a raw key to an identity, or throws a 401 AppError. */
    async authenticate(rawKey: string): Promise<AuthIdentity> {
        const apiKey = rawKey.trim();
        if (apiKey.length === 0) throw unauthorized("Missing API key.", "missing_api_key");

        if (this.matchesStaticKey(apiKey)) {
            return {
                apiKeyId: `static:${sha256(apiKey).slice(0, 12)}`,
                name: "static-env-key",
                role: "admin",
                keyPrefix: AuthService.keyPrefixOf(apiKey),
                expiresAt: null,
                apiKey,
                static: true,
            };
        }

        if (!AuthService.isWellFormed(apiKey)) {
            throw unauthorized("API key is not valid.", "invalid_api_key");
        }

        const keyHash = sha256(apiKey);
        const cacheKey = this.cacheKey(keyHash);

        const cached = await this.readCache(cacheKey);
        if (cached && isInvalidMarker(cached)) throw unauthorized("API key is not valid.", "invalid_api_key");
        if (cached) {
            const identity = this.identityFromCached(cached, apiKey);
            // Re-check expiry: the snapshot may outlive the credential by one TTL.
            if (identity.expiresAt && identity.expiresAt.getTime() <= this.clock().getTime()) {
                await this.invalidate(keyHash);
                throw unauthorized("API key has expired.", "invalid_api_key");
            }
            return identity;
        }

        const record = await this.repository.findByHash(keyHash);
        if (!record) {
            await this.cacheInvalid(cacheKey);
            throw unauthorized("API key is not valid.", "invalid_api_key");
        }

        const rejection = this.rejectionFor(record);
        if (rejection) {
            await this.cacheInvalid(cacheKey);
            this.logger.warn("rejected api key", {
                apiKeyId: record.id,
                keyPrefix: record.keyPrefix,
                reason: rejection,
            });
            throw unauthorized(rejection, "invalid_api_key");
        }

        await this.cacheIdentity(cacheKey, record);
        this.touchLastUsed(record);

        return this.identityFromRecord(record, apiKey);
    }

    /** Issues a key. The plaintext value exists only in this return value. */
    async createKey(input: { name: string; role?: ApiKeyRole; expiresInDays?: number }): Promise<IssuedApiKey> {
        const apiKey = AuthService.generateKey();
        const expiresAt = input.expiresInDays
            ? new Date(this.clock().getTime() + input.expiresInDays * 24 * 60 * 60 * 1000)
            : null;

        const record = await this.repository.create({
            name: input.name,
            keyPrefix: AuthService.keyPrefixOf(apiKey),
            keyHash: sha256(apiKey),
            role: input.role ?? "member",
            expiresAt,
        });

        this.logger.info("api key created", {
            apiKeyId: record.id,
            keyPrefix: record.keyPrefix,
            role: record.role,
        });

        return { apiKey, record };
    }

    async listKeys(): Promise<ApiKeySummary[]> {
        const records = await this.repository.list();
        return records.map((record) => this.toSummary(record));
    }

    async revokeKey(id: string): Promise<ApiKeySummary> {
        const record = await this.repository.revoke(id);
        if (!record) throw notFound("API key not found.", "api_key_not_found");

        // Drop the cached validation so the key stops working immediately rather
        // than after the cache TTL.
        await this.invalidate(record.keyHash);
        this.logger.info("api key revoked", { apiKeyId: record.id, keyPrefix: record.keyPrefix });

        return this.toSummary(record);
    }

    // ------------------------------------------------------------------ internals

    private cacheKey(keyHash: string): string {
        return `llmgw:auth:v1:${keyHash}`;
    }

    private rejectionFor(record: ApiKeyRecord): string | null {
        if (!record.active || record.revokedAt) return "API key has been revoked.";
        if (record.expiresAt && record.expiresAt.getTime() <= this.clock().getTime()) return "API key has expired.";
        return null;
    }

    /** Compares digests in constant time and never short-circuits the loop. */
    private matchesStaticKey(candidate: string): boolean {
        if (this.staticKeys.length === 0) return false;

        const candidateDigest = Buffer.from(sha256(candidate), "hex");
        let matched = false;

        for (const staticKey of this.staticKeys) {
            const digest = Buffer.from(sha256(staticKey), "hex");
            if (digest.length === candidateDigest.length && timingSafeEqual(digest, candidateDigest)) {
                matched = true;
            }
        }

        return matched;
    }

    private identityFromRecord(record: ApiKeyRecord, apiKey: string): AuthIdentity {
        return {
            apiKeyId: record.id,
            name: record.name,
            role: record.role === "admin" ? "admin" : "member",
            keyPrefix: record.keyPrefix,
            expiresAt: record.expiresAt,
            apiKey,
            static: false,
        };
    }

    private identityFromCached(cached: CachedIdentity, apiKey: string): AuthIdentity {
        return {
            apiKeyId: cached.apiKeyId,
            name: cached.name,
            role: cached.role === "admin" ? "admin" : "member",
            keyPrefix: cached.keyPrefix,
            expiresAt: cached.expiresAt ? new Date(cached.expiresAt) : null,
            apiKey,
            static: false,
        };
    }

    private toSummary(record: ApiKeyRecord): ApiKeySummary {
        return {
            id: record.id,
            name: record.name,
            keyPrefix: record.keyPrefix,
            role: record.role === "admin" ? "admin" : "member",
            active: record.active,
            createdAt: record.createdAt.toISOString(),
            expiresAt: record.expiresAt?.toISOString() ?? null,
            lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
            revokedAt: record.revokedAt?.toISOString() ?? null,
        };
    }

    private async readCache(cacheKey: string): Promise<CachedAuth | null> {
        try {
            return await this.cache.get<CachedAuth>(cacheKey);
        } catch (error) {
            // Redis is only an optimisation here: fall through to Postgres.
            this.logger.warn("auth cache read failed", { error: errorMessage(error) });
            return null;
        }
    }

    private async cacheIdentity(cacheKey: string, record: ApiKeyRecord): Promise<void> {
        await this.writeCache(
            cacheKey,
            {
                apiKeyId: record.id,
                name: record.name,
                role: record.role === "admin" ? "admin" : "member",
                keyPrefix: record.keyPrefix,
                expiresAt: record.expiresAt?.toISOString() ?? null,
            },
            this.cacheTtlSeconds,
        );
    }

    private async cacheInvalid(cacheKey: string): Promise<void> {
        await this.writeCache(cacheKey, { invalid: true }, this.negativeCacheTtlSeconds);
    }

    private async writeCache(key: string, value: CachedAuth, ttlSeconds: number): Promise<void> {
        try {
            await this.cache.set(key, value, ttlSeconds);
        } catch (error) {
            this.logger.warn("auth cache write failed", { error: errorMessage(error) });
        }
    }

    private async invalidate(keyHash: string): Promise<void> {
        try {
            await this.cache.delete(this.cacheKey(keyHash));
        } catch (error) {
            this.logger.warn("auth cache invalidation failed", { error: errorMessage(error) });
        }
    }

    private touchLastUsed(record: ApiKeyRecord): void {
        const lastUsed = record.lastUsedAt?.getTime() ?? 0;
        if (this.clock().getTime() - lastUsed < this.lastUsedThrottleMs) return;

        // Fire and forget: auditing must not add latency to the request path.
        void this.repository.touchLastUsed(record.id, this.clock()).catch((error: unknown) => {
            this.logger.warn("failed to update api key lastUsedAt", {
                apiKeyId: record.id,
                error: errorMessage(error),
            });
        });
    }
}
