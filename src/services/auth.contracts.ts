/** Roles are coarse on purpose: an admin manages keys and can read any tenant's usage. */
export type ApiKeyRole = "admin" | "member";

export const API_KEY_ROLES = ["admin", "member"] as const satisfies readonly ApiKeyRole[];

/** Persisted credential. `keyHash` is the only form of the secret that is stored. */
export interface ApiKeyRecord {
    id: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    role: string;
    active: boolean;
    expiresAt: Date | null;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
}

export interface ApiKeyCreateInput {
    name: string;
    keyPrefix: string;
    keyHash: string;
    role: ApiKeyRole;
    expiresAt: Date | null;
}

/** Safe projection returned by the API - never contains the hash. */
export interface ApiKeySummary {
    id: string;
    name: string;
    keyPrefix: string;
    role: ApiKeyRole;
    active: boolean;
    createdAt: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

/** Persistence boundary for credentials, so AuthService stays storage-agnostic. */
export interface AuthRepository {
    findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
    create(input: ApiKeyCreateInput): Promise<ApiKeyRecord>;
    list(): Promise<ApiKeyRecord[]>;
    revoke(id: string): Promise<ApiKeyRecord | null>;
    touchLastUsed(id: string, at: Date): Promise<void>;
}

/** What middleware attaches to the request after a successful authentication. */
export interface AuthIdentity {
    /** Credential id, or `static:<hash prefix>` for keys from API_KEYS. */
    apiKeyId: string;
    name: string;
    role: ApiKeyRole;
    keyPrefix: string;
    expiresAt: Date | null;
    /** Raw key. Needed to scope rate limiting and the usage ledger per caller. */
    apiKey: string;
    /** True when the key came from the API_KEYS env allow-list, not the database. */
    static: boolean;
}

export interface IssuedApiKey {
    /** Plaintext key, returned exactly once at creation. */
    apiKey: string;
    record: ApiKeyRecord;
}
