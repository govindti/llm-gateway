import { Router } from "express";
import { createUsageController } from "@/controllers/usage.controller";
import { authenticate } from "@/middleware/auth.middleware";
import { validate } from "@/middleware/validate.middleware";
import { usageParamsSchema } from "@/schemas/usage.schema";
import type { AuthService } from "@/services/auth.service";
import type { UsageRepository } from "@/services/contracts";

export interface UsageRouterDeps {
    usageRepository: UsageRepository;
    authService: AuthService;
}

export function createUsageRouter({ usageRepository, authService }: UsageRouterDeps): Router {
    const router = Router();

    router.get(
        "/:apiKey",
        authenticate(authService),
        validate(usageParamsSchema, "params"),
        createUsageController(usageRepository),
    );

    return router;
}
