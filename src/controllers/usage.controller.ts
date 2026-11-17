import type { RequestHandler, Response } from "express";
import { requireAuth } from "@/middleware/auth.middleware";
import type { UsageParams } from "@/schemas/usage.schema";
import type { UsageRepository } from "@/services/contracts";
import { asyncHandler } from "@/utils/async-handler";
import { forbidden } from "@/utils/errors";
import { maskApiKey } from "@/utils/mask";

export function createUsageController(usage: UsageRepository): RequestHandler {
    return asyncHandler(async (req, res: Response) => {
        const identity = requireAuth(req);
        const { apiKey } = req.params as UsageParams;

        // Members may only read their own ledger; admins can read any tenant's.
        if (identity.role !== "admin" && apiKey !== identity.apiKey) {
            throw forbidden("You can only read usage for your own API key.", "usage_forbidden");
        }

        const summary = await usage.getSummary(apiKey);

        res.status(200).json({
            ...summary,
            apiKey: maskApiKey(summary.apiKey),
        });
    });
}
