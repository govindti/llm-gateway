import { Prisma, type PrismaClient } from "@prisma/client";
import type { ApiKeyCreateInput, ApiKeyRecord, AuthRepository } from "./auth.contracts";

/** Postgres-backed credential store. */
export class PrismaAuthRepository implements AuthRepository {
    constructor(private readonly db: PrismaClient) {}

    async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
        return this.db.apiKey.findUnique({ where: { keyHash } });
    }

    async create(input: ApiKeyCreateInput): Promise<ApiKeyRecord> {
        return this.db.apiKey.create({ data: input });
    }

    async list(): Promise<ApiKeyRecord[]> {
        return this.db.apiKey.findMany({ orderBy: { createdAt: "desc" } });
    }

    async revoke(id: string): Promise<ApiKeyRecord | null> {
        try {
            return await this.db.apiKey.update({
                where: { id },
                data: { active: false, revokedAt: new Date() },
            });
        } catch (error) {
            // P2025 = "record not found"; the service turns this into a 404.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return null;
            throw error;
        }
    }

    async touchLastUsed(id: string, at: Date): Promise<void> {
        await this.db.apiKey.update({ where: { id }, data: { lastUsedAt: at } });
    }
}
