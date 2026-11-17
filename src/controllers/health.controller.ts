import type { RequestHandler } from "express";
import { pingDatabase } from "@/lib/prisma";
import { pingRedis } from "@/lib/redis";
import { asyncHandler } from "@/utils/async-handler";

/**
 * Liveness + dependency readiness. Kept unauthenticated so orchestrators can
 * probe it without credentials; it exposes no tenant data.
 */
export function createHealthController(): RequestHandler {
    return asyncHandler(async (_req, res) => {
        const [redisUp, databaseUp] = await Promise.all([pingRedis(), pingDatabase()]);
        const healthy = redisUp && databaseUp;

        res.status(healthy ? 200 : 503).json({
            status: healthy ? "ok" : "degraded",
            uptimeSeconds: Math.round(process.uptime()),
            checks: {
                redis: redisUp ? "up" : "down",
                database: databaseUp ? "up" : "down",
            },
            timestamp: new Date().toISOString(),
        });
    });
}
