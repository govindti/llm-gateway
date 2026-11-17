import type { RequestHandler, Response } from "express";
import { requireApiKey } from "@/middleware/auth.middleware";
import type { ChatRequestBody } from "@/schemas/chat.schema";
import type { ChatService } from "@/services/chat.service";
import { asyncHandler } from "@/utils/async-handler";

export function createChatController(chatService: ChatService): RequestHandler {
    return asyncHandler(async (req, res: Response) => {
        const apiKey = requireApiKey(req);
        const { prompt, provider, model } = req.body as ChatRequestBody;

        const result = await chatService.chat({
            apiKey,
            prompt,
            provider,
            model,
            requestId: req.requestId,
        });

        res.status(200).json({
            requestId: req.requestId,
            provider: result.provider,
            model: result.model,
            response: result.text,
            cached: result.cached,
            fallback: result.fallback,
            latencyMs: result.latencyMs,
            usage: {
                promptTokens: result.promptTokens,
                responseTokens: result.responseTokens,
                totalTokens: result.totalTokens,
            },
            estimatedCostUsd: result.estimatedCostUsd,
            attempts: result.attempts,
        });
    });
}
