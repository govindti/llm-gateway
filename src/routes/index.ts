import { Router } from "express";
import { type AuthRouterDeps, createAuthRouter } from "./auth.routes";
import { type ChatRouterDeps, createChatRouter } from "./chat.routes";
import { createHealthRouter } from "./health.routes";
import { createUsageRouter, type UsageRouterDeps } from "./usage.routes";

export type ApiRouterDeps = ChatRouterDeps & UsageRouterDeps & AuthRouterDeps;

/** Mounts every feature router under its public path. */
export function createApiRouter(deps: ApiRouterDeps): Router {
    const router = Router();

    router.use("/health", createHealthRouter());
    router.use("/auth", createAuthRouter(deps));
    router.use("/chat", createChatRouter(deps));
    router.use("/usage", createUsageRouter(deps));

    return router;
}
