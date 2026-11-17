import { Router } from "express";
import { createChatController } from "@/controllers/chat.controller";
import { authenticate } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { validate } from "@/middleware/validate.middleware";
import { chatRequestSchema } from "@/schemas/chat.schema";
import type { AuthService } from "@/services/auth.service";
import type { ChatService } from "@/services/chat.service";
import type { RateLimiter } from "@/services/rate-limit.service";

export interface ChatRouterDeps {
    chatService: ChatService;
    rateLimiter: RateLimiter;
    authService: AuthService;
}

export function createChatRouter({ chatService, rateLimiter, authService }: ChatRouterDeps): Router {
    const router = Router();

    router.post(
        "/",
        authenticate(authService),
        // Limit before validation: rejected requests still cost a round trip.
        rateLimitMiddleware(rateLimiter),
        validate(chatRequestSchema),
        createChatController(chatService),
    );

    return router;
}
