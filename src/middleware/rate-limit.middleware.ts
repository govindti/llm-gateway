import type { RequestHandler } from "express";
import type { RateLimiter } from "@/services/rate-limit.service";
import { unauthorized } from "@/utils/errors";

/**
 * Enforces the per-API-key sliding window budget and exposes the state through
 * standard `X-RateLimit-*` headers. Exceeding it answers 429 with `Retry-After`.
 */
export function rateLimitMiddleware(limiter: RateLimiter): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const apiKey = req.apiKey;
      if (!apiKey) throw unauthorized("Missing API key.", "missing_api_key");

      const result = await limiter.check(apiKey);
      const windowSeconds = Math.round(result.windowMs / 1000);

      res.setHeader("X-RateLimit-Limit", String(result.limit));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetAt.getTime() / 1000)));
      res.setHeader("X-RateLimit-Window", String(windowSeconds));
      if (result.degraded) res.setHeader("X-RateLimit-Degraded", "redis-unavailable");

      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        res.status(429).json({
          error: {
            code: "rate_limit_exceeded",
            message: `Rate limit exceeded: ${result.limit} requests per ${windowSeconds}s. Retry in ${result.retryAfterSeconds}s.`,
            details: {
              limit: result.limit,
              windowSeconds,
              retryAfterSeconds: result.retryAfterSeconds,
              resetAt: result.resetAt.toISOString(),
            },
          },
          requestId: req.requestId,
        });
        return;
      }

      next();
    })().catch(next);
  };
}
