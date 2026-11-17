import { createApp } from "@/app";
import { env } from "@/config/env";
import { errorMessage, logger } from "@/lib/logger";
import { closeDatabase, pingDatabase } from "@/lib/prisma";
import { closeRedis, pingRedis } from "@/lib/redis";

const app = createApp();

const server = app.listen(env.PORT, () => {
    logger.info("llm gateway listening", {
        port: env.PORT,
        environment: env.NODE_ENV,
        cacheEnabled: env.CACHE_ENABLED,
        rateLimit: `${env.RATE_LIMIT_MAX}/${Math.round(env.RATE_LIMIT_WINDOW_MS / 1000)}s`,
        providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
    });

    if (env.API_KEYS.length === 0) {
        // Without a static admin key nobody can mint credentials through the API.
        logger.warn(
            "API_KEYS is empty: no static admin key configured. Bootstrap one with `bun run auth:key --name bootstrap --role admin`.",
        );
    }
});

// Probe dependencies at boot. Serving continues either way: the rate limiter and
// cache degrade gracefully, and /health reports the real state.
void Promise.all([pingRedis(), pingDatabase()]).then(([redisUp, databaseUp]) => {
    if (!redisUp) logger.warn("redis unreachable at startup", { url: env.REDIS_URL });
    if (!databaseUp) logger.warn("postgres unreachable at startup");
});

let shuttingDown = false;

function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });

    const forceExit = setTimeout(() => {
        logger.error("graceful shutdown timed out, exiting");
        process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(() => {
        void Promise.allSettled([closeRedis(), closeDatabase()]).then(() => {
            logger.info("shutdown complete");
            process.exit(0);
        });
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", { error: errorMessage(reason) });
});

process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error: errorMessage(error), stack: error.stack });
    shutdown("uncaughtException");
});
