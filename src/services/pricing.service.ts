export interface ModelPricing {
    /** USD per 1M input (prompt) tokens. */
    inputPerMillionTokens: number;
    /** USD per 1M output (completion) tokens. */
    outputPerMillionTokens: number;
}

/**
 * Published list prices, USD per 1M tokens.
 * Unknown models fall back to DEFAULT_PRICING so accounting never throws.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
    "gpt-4o": { inputPerMillionTokens: 2.5, outputPerMillionTokens: 10 },
    "gpt-4o-mini": { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6 },
    "gpt-4.1": { inputPerMillionTokens: 2, outputPerMillionTokens: 8 },
    "gpt-4.1-mini": { inputPerMillionTokens: 0.4, outputPerMillionTokens: 1.6 },
    "gpt-4.1-nano": { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.4 },
    "o4-mini": { inputPerMillionTokens: 1.1, outputPerMillionTokens: 4.4 },
    "gemini-2.5-pro": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
    "gemini-2.5-flash": { inputPerMillionTokens: 0.3, outputPerMillionTokens: 2.5 },
    "gemini-2.0-flash": { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.4 },
    "gemini-2.0-flash-lite": { inputPerMillionTokens: 0.075, outputPerMillionTokens: 0.3 },
    "gemini-1.5-flash": { inputPerMillionTokens: 0.075, outputPerMillionTokens: 0.3 },
    "gemini-1.5-pro": { inputPerMillionTokens: 1.25, outputPerMillionTokens: 5 },
};

const DEFAULT_PRICING: ModelPricing = { inputPerMillionTokens: 0.5, outputPerMillionTokens: 1.5 };

/**
 * Exact match first, then the longest version-less prefix so pinned snapshots
 * such as `gpt-4o-mini-2024-07-18` still resolve (`gpt-4o-mini`, never `gpt-4o`).
 */
export function getPricing(model: string): ModelPricing {
    const normalised = model.trim().toLowerCase();
    const exact = MODEL_PRICING[normalised];
    if (exact) return exact;

    let best: { key: string; pricing: ModelPricing } | undefined;
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
        const isPrefix = normalised === key || normalised.startsWith(`${key}-`) || normalised.startsWith(`${key}:`);
        if (isPrefix && (!best || key.length > best.key.length)) best = { key, pricing };
    }

    return best?.pricing ?? DEFAULT_PRICING;
}

export interface CostInput {
    model: string;
    promptTokens: number;
    responseTokens: number;
}

/** Estimated USD cost of a single completion, unrounded. */
export function estimateCostUsd({ model, promptTokens, responseTokens }: CostInput): number {
    const pricing = getPricing(model);
    const prompt = Math.max(0, promptTokens) / 1_000_000;
    const completion = Math.max(0, responseTokens) / 1_000_000;
    return prompt * pricing.inputPerMillionTokens + completion * pricing.outputPerMillionTokens;
}
