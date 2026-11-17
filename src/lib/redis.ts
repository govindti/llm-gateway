import { Redis } from "ioredis";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";

/**
 * Single shared Redis connection for the process. ioredis pipelines commands
 * over one socket, which is what the gateway needs for rate limiting + caching.
 */
export const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5_000,
    enableOfflineQueue: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 3_000),
});

redis.on("connect", () => logger.info("redis connected"));
redis.on("ready", () => logger.info("redis ready"));
redis.on("error", (error) => logger.error("redis error", { error: error.message }));

export async function pingRedis(): Promise<boolean> {
    try {
        const reply = await redis.ping();
        return reply === "PONG";
    } catch (error) {
        logger.warn("redis ping failed", { error: error instanceof Error ? error.message : String(error) });
        return false;
    }
}

export async function closeRedis(): Promise<void> {
    try {
        await redis.quit();
    } catch {
        redis.disconnect();
    }
}
