import { PrismaClient } from "@prisma/client";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";

export const prisma = new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export async function pingDatabase(): Promise<boolean> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
    } catch (error) {
        logger.warn("database ping failed", { error: error instanceof Error ? error.message : String(error) });
        return false;
    }
}

export async function closeDatabase(): Promise<void> {
    await prisma.$disconnect();
}
