import type { RequestHandler } from "express";
import { requireAuth } from "@/middleware/auth.middleware";
import type { ApiKeyIdParams, CreateApiKeyBody } from "@/schemas/auth.schema";
import type { AuthService } from "@/services/auth.service";
import { asyncHandler } from "@/utils/async-handler";

export interface AuthController {
    me: RequestHandler;
    createKey: RequestHandler;
    listKeys: RequestHandler;
    revokeKey: RequestHandler;
}

export function createAuthController(authService: AuthService): AuthController {
    return {
        me: asyncHandler(async (req, res) => {
            const identity = requireAuth(req);

            res.status(200).json({
                apiKeyId: identity.apiKeyId,
                name: identity.name,
                role: identity.role,
                keyPrefix: identity.keyPrefix,
                expiresAt: identity.expiresAt?.toISOString() ?? null,
                static: identity.static,
            });
        }),

        createKey: asyncHandler(async (req, res) => {
            const body = req.body as CreateApiKeyBody;
            const issued = await authService.createKey(body);

            res.status(201).json({
                id: issued.record.id,
                name: issued.record.name,
                role: issued.record.role,
                keyPrefix: issued.record.keyPrefix,
                apiKey: issued.apiKey,
                expiresAt: issued.record.expiresAt?.toISOString() ?? null,
                createdAt: issued.record.createdAt.toISOString(),
                warning: "Store this key now: only its SHA-256 hash is persisted, it cannot be shown again.",
            });
        }),

        listKeys: asyncHandler(async (_req, res) => {
            const keys = await authService.listKeys();
            res.status(200).json({ keys });
        }),

        revokeKey: asyncHandler(async (req, res) => {
            const { id } = req.params as ApiKeyIdParams;
            const key = await authService.revokeKey(id);

            res.status(200).json({ revoked: true, key });
        }),
    };
}
