import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { sha256 } from "@/utils/hash";

export interface RateLimitResult {
    allowed: boolean;
    limit: number;
    /** Requests left inside the current window after this decision. */
    remaining: number;
    /** Requests counted in the window, including this one when allowed. */
    used: number;
    windowMs: number;
    retryAfterSeconds: number;
    resetAt: Date;
    /** True when the limiter could not reach Redis and applied its fail-open policy. */
    degraded: boolean;
}

export interface RateLimiter {
    check(apiKey: string): Promise<RateLimitResult>;
}

/** The single command the limiter needs from Redis. */
export interface SlidingWindowClient {
    eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RateLimiterOptions {
    limit: number;
    windowMs: number;
    /** Redis key namespace. */
    prefix?: string;
    /** Allow traffic when Redis is unavailable instead of failing closed. */
    failOpen?: boolean;
    /** Injectable clock, used by tests to advance the window. */
    now?: () => number;
}

/**
 * Sliding window counter backed by a Redis sorted set.
 *
 * Each admitted request is a member scored by its arrival timestamp (ms). A
 * request is admitted only if, after evicting entries older than the window,
 * the set holds fewer than `limit` members. Running the read-evict-insert
 * sequence inside Lua makes the whole check atomic, so concurrent requests can
 * never both observe "9 used" and both get admitted past the limit.
 *
 * KEYS[1] = per-key sorted set
 * ARGV[1] = now (ms), ARGV[2] = window (ms), ARGV[3] = limit, ARGV[4] = member
 * Returns { allowed (1|0), used, retryAfterMs }
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, 0, now - windowMs)

local used = redis.call("ZCARD", key)

if used >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retryAfterMs = windowMs
  if oldest[2] then
    retryAfterMs = math.max(0, math.ceil(tonumber(oldest[2]) + windowMs - now))
  end
  redis.call("PEXPIRE", key, windowMs)
  return { 0, used, retryAfterMs }
end

redis.call("ZADD", key, now, member)
redis.call("PEXPIRE", key, windowMs)
return { 1, used + 1, 0 }
`;

export class RedisSlidingWindowRateLimiter implements RateLimiter {
    private readonly prefix: string;
    private readonly failOpen: boolean;
    private readonly clock: () => number;

    constructor(
        private readonly client: SlidingWindowClient,
        private readonly options: RateLimiterOptions,
    ) {
        this.prefix = options.prefix ?? "llmgw:ratelimit";
        this.failOpen = options.failOpen ?? true;
        this.clock = options.now ?? Date.now;
    }

    async check(apiKey: string): Promise<RateLimitResult> {
        const now = this.clock();
        // Hash the key: raw API keys should never be written to Redis.
        const key = `${this.prefix}:${sha256(apiKey).slice(0, 40)}`;
        const member = `${now}-${randomUUID()}`;

        try {
            const raw = await this.client.eval(
                SLIDING_WINDOW_SCRIPT,
                1,
                key,
                now,
                this.options.windowMs,
                this.options.limit,
                member,
            );

            const [allowedFlag, usedRaw, retryAfterMsRaw] = Array.isArray(raw) ? raw : [];
            const allowed = Number(allowedFlag) === 1;
            const used = Number(usedRaw ?? 0);
            const retryAfterMs = Number(retryAfterMsRaw ?? 0);
            const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000));

            return {
                allowed,
                limit: this.options.limit,
                remaining: Math.max(0, this.options.limit - used),
                used,
                windowMs: this.options.windowMs,
                retryAfterSeconds,
                resetAt: new Date(now + (allowed ? this.options.windowMs : retryAfterMs)),
                degraded: false,
            };
        } catch (error) {
            logger.error("rate limiter unavailable", {
                error: error instanceof Error ? error.message : String(error),
                failOpen: this.failOpen,
            });

            if (!this.failOpen) throw error;

            return {
                allowed: true,
                limit: this.options.limit,
                remaining: this.options.limit,
                used: 0,
                windowMs: this.options.windowMs,
                retryAfterSeconds: 0,
                resetAt: new Date(now + this.options.windowMs),
                degraded: true,
            };
        }
    }
}
