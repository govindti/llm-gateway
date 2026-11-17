/** Costs are stored as Decimal(18, 8); keep arithmetic aligned with that precision. */
const COST_PRECISION = 8;

export function roundCost(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const factor = 10 ** COST_PRECISION;
    return Math.round(value * factor) / factor;
}

/**
 * Prisma hands back Decimal instances for `estimatedCost`. Normalise anything
 * numeric-ish (Decimal, bigint, string, number, null) into a plain number.
 */
export function toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
        return (value as { toNumber: () => number }).toNumber();
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
