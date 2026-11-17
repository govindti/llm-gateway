import { z } from "zod";
import { API_KEY_ROLES } from "@/services/auth.contracts";

export const createApiKeySchema = z.object({
    name: z.string().trim().min(1, "name must not be empty").max(80),
    role: z.enum(API_KEY_ROLES).default("member"),
    expiresInDays: z.number().int().min(1).max(3_650).optional(),
});

export type CreateApiKeyBody = z.infer<typeof createApiKeySchema>;

export const apiKeyIdParamsSchema = z.object({
    id: z.string().trim().min(1).max(64),
});

export type ApiKeyIdParams = z.infer<typeof apiKeyIdParamsSchema>;
