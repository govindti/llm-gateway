import { describe, expect, test } from "bun:test";
import { estimateCostUsd, getPricing, MODEL_PRICING, type ModelPricing } from "@/services/pricing.service";

/** Table lookups below are known-good keys, so the assertion short-circuit is safe. */
const table = (model: string): ModelPricing => {
    const pricing = MODEL_PRICING[model];
    if (!pricing) throw new Error(`missing fixture for ${model}`);
    return pricing;
};

describe("getPricing", () => {
    test("resolves an exact model name", () => {
        expect(getPricing("gpt-4o-mini")).toEqual(table("gpt-4o-mini"));
    });

    test("resolves pinned snapshots by longest prefix", () => {
        // `gpt-4o` is also a prefix; the longer `gpt-4o-mini` must win.
        expect(getPricing("gpt-4o-mini-2024-07-18")).toEqual(table("gpt-4o-mini"));
        expect(getPricing("gemini-2.0-flash-exp")).toEqual(table("gemini-2.0-flash"));
    });

    test("is case insensitive", () => {
        expect(getPricing("GPT-4O-MINI")).toEqual(table("gpt-4o-mini"));
    });

    test("falls back to default pricing for unknown models", () => {
        expect(getPricing("totally-unknown-model")).toEqual({
            inputPerMillionTokens: 0.5,
            outputPerMillionTokens: 1.5,
        });
    });
});

describe("estimateCostUsd", () => {
    test("prices prompt and completion tokens separately", () => {
        // gpt-4o-mini: $0.15/1M input, $0.60/1M output
        const cost = estimateCostUsd({ model: "gpt-4o-mini", promptTokens: 1_000_000, responseTokens: 1_000_000 });
        expect(cost).toBeCloseTo(0.75, 10);
    });

    test("scales with token counts", () => {
        const cost = estimateCostUsd({ model: "gemini-2.0-flash", promptTokens: 1_000, responseTokens: 500 });
        expect(cost).toBeCloseTo((1_000 * 0.1 + 500 * 0.4) / 1_000_000, 12);
    });

    test("treats negative token counts as zero", () => {
        expect(estimateCostUsd({ model: "gpt-4o-mini", promptTokens: -10, responseTokens: 0 })).toBe(0);
    });
});
