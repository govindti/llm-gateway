import { Router } from "express";
import { createAuthController } from "@/controllers/auth.controller";
import { authenticate, requireRole } from "@/middleware/auth.middleware";
import { validate } from "@/middleware/validate.middleware";
import { apiKeyIdParamsSchema, createApiKeySchema } from "@/schemas/auth.schema";
import type { AuthService } from "@/services/auth.service";

export interface AuthRouterDeps {
    authService: AuthService;
}

export function createAuthRouter({ authService }: AuthRouterDeps): Router {
    const router = Router();
    const controller = createAuthController(authService);

    router.get("/me", authenticate(authService), controller.me);

    // Key management is admin-only. Intentionally not rate limited: an operator
    // minting keys should never be blocked by a tenant's chat budget.
    router.post(
        "/keys",
        authenticate(authService),
        requireRole("admin"),
        validate(createApiKeySchema),
        controller.createKey,
    );
    router.get("/keys", authenticate(authService), requireRole("admin"), controller.listKeys);
    router.delete(
        "/keys/:id",
        authenticate(authService),
        requireRole("admin"),
        validate(apiKeyIdParamsSchema, "params"),
        controller.revokeKey,
    );

    return router;
}
