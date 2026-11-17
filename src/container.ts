import { env } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { PrismaAuthRepository } from "@/services/auth.repository";
import { AuthService } from "@/services/auth.service";
import { RedisCache } from "@/services/cache.service";
import { ChatService } from "@/services/chat.service";
import { createProviderRegistry } from "@/services/providers";
import { RedisSlidingWindowRateLimiter } from "@/services/rate-limit.service";
import { PrismaUsageRepository } from "@/services/usage.service";

/**
 * Composition root. Every collaborator is constructed once here and injected,
 * which keeps services testable (swap Redis for a fake) and makes wiring changes
 * a single-file edit.
 */
const cacheStore = new RedisCache(redis);
const usageRepository = new PrismaUsageRepository(prisma);
const providerRegistry = createProviderRegistry();

export const authService = new AuthService(new PrismaAuthRepository(prisma), cacheStore, {
    staticAdminKeys: env.API_KEYS,
    cacheTtlSeconds: env.AUTH_CACHE_TTL_SECONDS,
});

export const chatService = new ChatService({
    registry: providerRegistry,
    cache: cacheStore,
    usage: usageRepository,
    config: {
        timeoutMs: env.PROVIDER_TIMEOUT_MS,
        cacheTtlSeconds: env.CACHE_TTL_SECONDS,
        cacheEnabled: env.CACHE_ENABLED,
    },
});

export const rateLimiter = new RedisSlidingWindowRateLimiter(redis, {
    limit: env.RATE_LIMIT_MAX,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    failOpen: env.RATE_LIMIT_FAIL_OPEN,
});

export const container = {
    authService,
    chatService,
    rateLimiter,
    usageRepository,
};
