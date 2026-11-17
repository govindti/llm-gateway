import { type Logger, errorMessage, logger as defaultLogger } from "@/lib/logger";
import { AppError } from "@/utils/errors";
import { roundCost } from "@/utils/money";
import { TimeoutError, withTimeout } from "@/utils/timeout";
import { type CacheStore, buildCacheKey } from "./cache.service";
import type { UsageRecordInput, UsageRecorder } from "./contracts";
import { estimateCostUsd } from "./pricing.service";
import { ProviderError } from "./providers/errors";
import type { ProviderRegistry } from "./providers/registry";
import type { LLMProvider, ProviderName } from "./providers/types";

export interface ChatServiceConfig {
    /** Hard deadline for one provider attempt before falling back. */
    timeoutMs: number;
    cacheTtlSeconds: number;
    cacheEnabled: boolean;
}

export interface ChatServiceDependencies {
    registry: ProviderRegistry;
    cache: CacheStore;
    usage: UsageRecorder;
    config: ChatServiceConfig;
    logger?: Logger;
}

export interface ChatInput {
    apiKey: string;
    prompt: string;
    provider: ProviderName;
    /** Optional model override; defaults to the provider's configured model. */
    model?: string;
    requestId?: string;
}

export interface ProviderAttempt {
    provider: ProviderName;
    model: string;
    status: "success" | "error";
    durationMs: number;
    error?: { kind: string; message: string };
}

export interface ChatResult {
    provider: ProviderName;
    model: string;
    text: string;
    promptTokens: number;
    responseTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    cached: boolean;
    fallback: boolean;
    latencyMs: number;
    attempts: ProviderAttempt[];
}

/** Shape persisted in Redis. Deliberately free of request-scoped data. */
interface CachedChatResponse {
    provider: ProviderName;
    model: string;
    text: string;
    promptTokens: number;
    responseTokens: number;
}

/** Thrown when every provider in the fallback chain failed. */
export class AllProvidersFailedError extends AppError {
    constructor(attempts: ProviderAttempt[]) {
        const summary = attempts
            .map((attempt) => `${attempt.provider}: ${attempt.error?.message ?? "failed"}`)
            .join("; ");
        super(502, "all_providers_failed", `All providers failed. ${summary}`, { attempts });
    }
}

const elapsedMs = (startedAt: number): number => Math.max(0, Math.round(Date.now() - startedAt));

/**
 * Request pipeline for POST /chat:
 *
 *   1. cache lookup (prompt+provider+model digest, 1h TTL)
 *   2. primary provider with a hard deadline
 *   3. fallback to the next configured provider on any failure/timeout
 *   4. usage row written to Postgres for every outcome
 *
 * Identical in-flight requests are coalesced so a burst of the same prompt
 * triggers one upstream call instead of N.
 */
export class ChatService {
    private readonly registry: ProviderRegistry;
    private readonly cache: CacheStore;
    private readonly usage: UsageRecorder;
    private readonly config: ChatServiceConfig;
    private readonly logger: Logger;
    private readonly inflight = new Map<string, Promise<ChatResult>>();

    constructor(deps: ChatServiceDependencies) {
        this.registry = deps.registry;
        this.cache = deps.cache;
        this.usage = deps.usage;
        this.config = deps.config;
        this.logger = deps.logger ?? defaultLogger;
    }

    async chat(input: ChatInput): Promise<ChatResult> {
        const cacheKey = this.cacheKeyFor(input);

        const pending = this.inflight.get(cacheKey);
        if (pending) {
            this.logger.debug("coalescing identical in-flight chat request", { requestId: input.requestId });
            return pending;
        }

        const promise = this.execute(input, cacheKey);
        this.inflight.set(cacheKey, promise);
        void promise
            .finally(() => this.inflight.delete(cacheKey))
            .catch(() => {
                // Rejection already propagated to the caller; swallow it here so the
                // cleanup chain does not surface as an unhandled rejection.
            });

        return promise;
    }

    private async execute(input: ChatInput, cacheKey: string): Promise<ChatResult> {
        const startedAt = Date.now();

        const cached = await this.readCache(cacheKey);
        if (cached) {
            const latencyMs = elapsedMs(startedAt);
            // A cache hit consumed no upstream tokens, so it is recorded at zero cost.
            // Cached token counts are still reported to the caller in the response.
            await this.persistUsage({
                apiKey: input.apiKey,
                provider: cached.provider,
                model: cached.model,
                promptTokens: 0,
                responseTokens: 0,
                estimatedCost: 0,
                status: "cached",
                cached: true,
                fallback: false,
                latencyMs,
                requestId: input.requestId,
            });

            this.logger.info("chat served from cache", {
                requestId: input.requestId,
                provider: cached.provider,
                model: cached.model,
                latencyMs,
            });

            return {
                provider: cached.provider,
                model: cached.model,
                text: cached.text,
                promptTokens: cached.promptTokens,
                responseTokens: cached.responseTokens,
                totalTokens: cached.promptTokens + cached.responseTokens,
                estimatedCostUsd: 0,
                cached: true,
                fallback: false,
                latencyMs,
                attempts: [],
            };
        }

        let chain: LLMProvider[];
        try {
            chain = this.registry.resolveChain(input.provider);
        } catch (error) {
            await this.persistUsage({
                apiKey: input.apiKey,
                provider: input.provider,
                model: input.model ?? "unknown",
                promptTokens: 0,
                responseTokens: 0,
                estimatedCost: 0,
                status: "error",
                cached: false,
                fallback: false,
                latencyMs: elapsedMs(startedAt),
                requestId: input.requestId,
            });
            throw error;
        }

        const attempts: ProviderAttempt[] = [];

        for (const [index, provider] of chain.entries()) {
            const model = input.model ?? provider.defaultModel;
            const attemptStartedAt = Date.now();

            try {
                const completion = await withTimeout(
                    provider.generate({
                        prompt: input.prompt,
                        model,
                        signal: AbortSignal.timeout(this.config.timeoutMs),
                    }),
                    // Small grace period: the signal should win first, this is a backstop
                    // for providers that ignore abort signals.
                    this.config.timeoutMs + 250,
                    `${provider.name} request`,
                );

                const durationMs = elapsedMs(attemptStartedAt);
                attempts.push({ provider: provider.name, model: completion.model, status: "success", durationMs });

                const result: ChatResult = {
                    provider: provider.name,
                    model: completion.model,
                    text: completion.text,
                    promptTokens: completion.promptTokens,
                    responseTokens: completion.responseTokens,
                    totalTokens: completion.promptTokens + completion.responseTokens,
                    estimatedCostUsd: roundCost(
                        estimateCostUsd({
                            model: completion.model,
                            promptTokens: completion.promptTokens,
                            responseTokens: completion.responseTokens,
                        }),
                    ),
                    cached: false,
                    fallback: index > 0,
                    latencyMs: elapsedMs(startedAt),
                    attempts,
                };

                await this.writeCache(cacheKey, result);
                await this.persistUsage({
                    apiKey: input.apiKey,
                    provider: result.provider,
                    model: result.model,
                    promptTokens: result.promptTokens,
                    responseTokens: result.responseTokens,
                    estimatedCost: result.estimatedCostUsd,
                    status: "success",
                    cached: false,
                    fallback: result.fallback,
                    latencyMs: result.latencyMs,
                    requestId: input.requestId,
                });

                if (result.fallback) {
                    this.logger.warn("chat served by fallback provider", {
                        requestId: input.requestId,
                        provider: result.provider,
                        model: result.model,
                        failedProviders: attempts.filter((attempt) => attempt.status === "error").map((a) => a.provider),
                    });
                }

                return result;
            } catch (error) {
                const durationMs = elapsedMs(attemptStartedAt);
                const failure = toFailure(error);
                attempts.push({ provider: provider.name, model, status: "error", durationMs, error: failure });

                this.logger.warn("provider attempt failed", {
                    requestId: input.requestId,
                    provider: provider.name,
                    model,
                    kind: failure.kind,
                    error: failure.message,
                    durationMs,
                    hasFallback: index < chain.length - 1,
                });
            }
        }

        await this.persistUsage({
            apiKey: input.apiKey,
            provider: input.provider,
            model: input.model ?? this.registry.get(input.provider)?.defaultModel ?? "unknown",
            promptTokens: 0,
            responseTokens: 0,
            estimatedCost: 0,
            status: "error",
            cached: false,
            fallback: false,
            latencyMs: elapsedMs(startedAt),
            requestId: input.requestId,
        });

        throw new AllProvidersFailedError(attempts);
    }

    /**
     * The model is part of the key because a provider default may change, and two
     * different models must never share a completion.
     */
    private cacheKeyFor(input: ChatInput): string {
        const model = input.model ?? this.registry.get(input.provider)?.defaultModel ?? "default";
        return buildCacheKey({ provider: input.provider, model, prompt: input.prompt });
    }

    private async readCache(key: string): Promise<CachedChatResponse | null> {
        if (!this.config.cacheEnabled) return null;

        try {
            const hit = await this.cache.get<CachedChatResponse>(key);
            if (hit && typeof hit.text === "string" && typeof hit.model === "string") return hit;
            return null;
        } catch (error) {
            // Redis outages degrade to cache misses; they must not fail the request.
            this.logger.warn("cache read failed", { error: errorMessage(error) });
            return null;
        }
    }

    private async writeCache(key: string, result: ChatResult): Promise<void> {
        if (!this.config.cacheEnabled) return;

        const entry: CachedChatResponse = {
            provider: result.provider,
            model: result.model,
            text: result.text,
            promptTokens: result.promptTokens,
            responseTokens: result.responseTokens,
        };

        try {
            await this.cache.set(key, entry, this.config.cacheTtlSeconds);
        } catch (error) {
            this.logger.warn("cache write failed", { error: errorMessage(error) });
        }
    }

    private async persistUsage(entry: UsageRecordInput): Promise<void> {
        try {
            await this.usage.record(entry);
        } catch (error) {
            // Accounting must never turn a successful completion into a failed request.
            this.logger.error("failed to persist usage record", {
                requestId: entry.requestId,
                status: entry.status,
                error: errorMessage(error),
            });
        }
    }
}

function toFailure(error: unknown): { kind: string; message: string } {
    if (error instanceof ProviderError) return { kind: error.kind, message: error.message };
    if (error instanceof TimeoutError) return { kind: "timeout", message: error.message };
    return { kind: "unknown", message: errorMessage(error) };
}
