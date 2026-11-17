import { Prisma, type PrismaClient } from "@prisma/client";
import { roundCost, toNumber } from "@/utils/money";
import type { UsageRecordInput, UsageRepository, UsageSummary } from "./contracts";

export class PrismaUsageRepository implements UsageRepository {
    constructor(private readonly db: PrismaClient) { }

    async record(entry: UsageRecordInput): Promise<void> {
        await this.db.apiUsage.create({
            data: {
                apiKey: entry.apiKey,
                provider: entry.provider,
                model: entry.model,
                promptTokens: entry.promptTokens,
                responseTokens: entry.responseTokens,
                estimatedCost: new Prisma.Decimal(roundCost(entry.estimatedCost)),
                status: entry.status,
                cached: entry.cached,
                fallback: entry.fallback,
                latencyMs: entry.latencyMs,
                requestId: entry.requestId ?? null,
            },
        });
    }

    async getSummary(apiKey: string): Promise<UsageSummary> {
        const where = { apiKey } as const;

        const [totals, byProvider, window] = await Promise.all([
            this.db.apiUsage.aggregate({
                where,
                _count: { _all: true },
                _sum: { promptTokens: true, responseTokens: true, estimatedCost: true },
            }),
            this.db.apiUsage.groupBy({
                by: ["provider"],
                where,
                _count: { _all: true },
                _sum: { promptTokens: true, responseTokens: true, estimatedCost: true },
            }),
            this.db.apiUsage.aggregate({
                where,
                _min: { timestamp: true },
                _max: { timestamp: true },
            }),
        ]);

        const promptTokens = totals._sum.promptTokens ?? 0;
        const responseTokens = totals._sum.responseTokens ?? 0;

        return {
            apiKey,
            totalRequests: totals._count._all,
            totalPromptTokens: promptTokens,
            totalResponseTokens: responseTokens,
            totalTokens: promptTokens + responseTokens,
            totalEstimatedCostUsd: roundCost(toNumber(totals._sum.estimatedCost)),
            firstRequestAt: window._min.timestamp?.toISOString() ?? null,
            lastRequestAt: window._max.timestamp?.toISOString() ?? null,
            byProvider: byProvider
                .map((row) => ({
                    provider: row.provider,
                    requests: row._count._all,
                    promptTokens: row._sum.promptTokens ?? 0,
                    responseTokens: row._sum.responseTokens ?? 0,
                    estimatedCostUsd: roundCost(toNumber(row._sum.estimatedCost)),
                }))
                .sort((a, b) => b.requests - a.requests),
        };
    }
}
