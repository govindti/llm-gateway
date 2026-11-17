import type { ProviderName } from "./providers/types";

export type UsageStatus = "success" | "cached" | "error";

export interface UsageRecordInput {
    apiKey: string;
    provider: ProviderName | string;
    model: string;
    promptTokens: number;
    responseTokens: number;
    estimatedCost: number;
    status: UsageStatus;
    cached: boolean;
    fallback: boolean;
    latencyMs: number;
    requestId?: string;
}

/** Write side of the usage ledger. */
export interface UsageRecorder {
    record(entry: UsageRecordInput): Promise<void>;
}

export interface ProviderUsageSummary {
    provider: string;
    requests: number;
    promptTokens: number;
    responseTokens: number;
    estimatedCostUsd: number;
}

export interface UsageSummary {
    apiKey: string;
    totalRequests: number;
    totalPromptTokens: number;
    totalResponseTokens: number;
    totalTokens: number;
    totalEstimatedCostUsd: number;
    firstRequestAt: string | null;
    lastRequestAt: string | null;
    byProvider: ProviderUsageSummary[];
}

/** Read + write side of the usage ledger. */
export interface UsageRepository extends UsageRecorder {
    getSummary(apiKey: string): Promise<UsageSummary>;
}
